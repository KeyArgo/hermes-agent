""""Regression for #115607 — multiplexed gateway session.resume heals a custom
provider against the LAUNCH profile's config instead of the session's profile_home.

``_resume_deferred`` and ``_resume_cold`` call ``_stored_session_runtime_overrides``
OUTSIDE ``_profile_build_scope(ctx.profile_home)``, while ``_resume_eager`` wraps the
same call. That computation (is_routable_provider / canonical_custom_identity) reads
config from get_hermes_home() — unscoped that is the LAUNCH profile — so a secondary
profile's routable stored provider is "healed" to the launch profile's differently-named
provider and the resumed build fails with ``Unknown provider``.

The contract asserted: a cold / deferred resume of a secondary-profile session evaluates
the stored override computation under that session's profile_home, not the launch home.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
import yaml

URL = "https://example.invalid/v1"


@pytest.fixture()
def homes(tmp_path):
    """Two REAL HERMES_HOMEs: launch ``a`` and secondary ``b``, sharing one endpoint URL
    under DIFFERENT provider names (the shape that trips the cross-profile heal)."""
    out = {}
    for name, prov in (("a", "langchain"), ("b", "vllm")):
        home = tmp_path / name
        home.mkdir(parents=True)
        (home / "config.yaml").write_text(yaml.safe_dump({
            "model": {"default": "test-model-live", "provider": f"custom:{prov}"},
            "custom_providers": [
                {"name": prov, "base_url": URL, "api_key": "sk-test", "api_mode": "chat_completions"}]}))
        out[name] = home
    return out


def _resume_override_home(launch_home, homes, monkeypatch, *, defer_history: bool):
    """Drive session.resume for a session seeded in profile B through the REAL dispatch;
    return the HERMES_HOME the stored-override computation observed."""
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB
    from hermes_state_registry import acquire
    from tui_gateway import server

    db = SessionDB(db_path=homes["b"] / "state.db")
    sid = uuid.uuid4().hex[:12]
    db.create_session(sid, source="desktop", model="test-model-live",
                      model_config={"model": "test-model-live", "provider": "custom:vllm",
                                    "base_url": URL, "api_mode": "chat_completions"},
                      session_key=f"scope-test:{sid}")
    db.close()

    monkeypatch.setattr(server, "_profile_home",
                        lambda profile: None if not (profile or "").strip() else homes[profile])
    monkeypatch.setattr(server, "_profile_session_db",
                        lambda p: ((acquire(Path(p) / "state.db"), True) if p
                                   else (SessionDB(db_path=launch_home / "state.db"), False)))

    observed: list = []
    real = server._stored_session_runtime_overrides
    monkeypatch.setattr(server, "_stored_session_runtime_overrides",
                        lambda row: (observed.append(str(get_hermes_home())) or real(row)))

    params = {"session_id": sid, "source": "desktop", "profile": "b", "omit_messages": True}
    if defer_history:
        params["defer_history"] = True
    resp = server.handle_request({"id": "rid-1", "method": "session.resume", "params": params})
    return observed, resp


@pytest.mark.parametrize("defer_history", [False, True], ids=["cold", "deferred"])
def test_resume_override_runs_under_session_profile_scope(homes, monkeypatch, defer_history):
    """Deferred/cold resume of a SECONDARY-profile session scopes the stored provider
    override computation to that session's home — never the launch profile's."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    for var in list(__import__("os").environ):
        if var.endswith("_API_KEY") or var in ("OPENROUTER_KEY", "NOUS_KEY"):
            monkeypatch.delenv(var, raising=False)
    token = set_hermes_home_override(str(homes["a"]))
    monkeypatch.setenv("HERMES_HOME", str(homes["a"]))
    try:
        observed, resp = _resume_override_home(homes["a"], homes, monkeypatch,
                                               defer_history=defer_history)
        assert observed, f"override computation never ran; resume response: {resp.get('error') or resp}"
        assert observed[0] == str(homes["b"]), (
            f"resume override evaluated against {observed[0]!r} (launch); "
            f"expected the session's profile_home {str(homes['b'])!r}"
        )
    finally:
        try:
            reset_hermes_home_override(token)
        except Exception:
            pass
