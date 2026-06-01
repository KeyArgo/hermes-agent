import json
from types import SimpleNamespace

from agent.compression_memory import (
    CompressionMemoryLedger,
    extract_atoms_from_summary,
)
from agent.context_compressor import (
    ContextCompressor,
    _LEDGER_CONTEXT_END,
    _LEDGER_CONTEXT_START,
)


SUMMARY = """## Active Task
- User asked: continue implementing the ledger.

## Completed Actions
1. TEST `pytest tests/agent/test_compression_memory.py` -- passed.

## Active State
- Working directory `/tmp/hermes-agent` on branch `fix/context`.

## Blocked
- SQLite database was locked during one attempted write.

## Key Decisions
- Use a sibling compression_memory.db rather than expanding state.db.

## Relevant Files
- /tmp/hermes-agent/agent/context_compressor.py

## Remaining Work
- Run the wider compression test suite.
"""


DONE_SUMMARY = """## Active Task
None.

## Completed Actions
1. Implemented the ledger lifecycle fix -- verified.

## Active State
- Current session has its own later compaction state.
"""


def test_extract_atoms_from_summary_is_typed_and_hash_referenced():
    turns = [
        {"role": "user", "content": "please remember raw private body"},
        {"role": "assistant", "content": "working on it"},
    ]

    atoms = extract_atoms_from_summary(
        SUMMARY,
        turns,
        session_id="sid-1",
        start_turn=10,
    )

    kinds = {(atom.atom_type, atom.status) for atom in atoms}
    assert ("task", "active") in kinds
    assert ("decision", "active") in kinds
    assert ("blocker", "blocked") in kinds
    assert ("verification", "done") in kinds
    assert all(atom.source_refs for atom in atoms)
    assert atoms[0].source_refs[0]["turn"] == 10
    assert "raw private body" not in json.dumps(atoms[0].source_refs)


def test_ledger_records_retrieves_and_avoids_raw_turn_storage(tmp_path):
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    turns = [{"role": "user", "content": "super secret raw transcript body"}]

    segment_id = ledger.record_segment(
        session_id="sid-1",
        parent_session_id="parent-1",
        summary_text=SUMMARY,
        turns=turns,
        start_turn=0,
        end_turn=1,
    )

    assert segment_id == 1
    atoms = ledger.retrieve_for_prompt(session_id="sid-1", query="ledger", limit=10)
    rendered = ledger.format_for_prompt(atoms, limit=10)
    assert "[active/task]" in rendered
    assert "sibling compression_memory.db" in rendered
    assert "super secret raw transcript body" not in rendered

    row = ledger._conn.execute(
        "SELECT source_refs_json FROM memory_atoms LIMIT 1"
    ).fetchone()
    assert row is not None
    assert "super secret raw transcript body" not in row["source_refs_json"]
    assert "content_hash" in row["source_refs_json"]


def test_ledger_forces_redaction_even_when_global_redaction_disabled(tmp_path, monkeypatch):
    from agent import redact as redact_mod

    monkeypatch.setattr(redact_mod, "_REDACT_ENABLED", False)
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    secret = "OPENAI_API_KEY=sk-test1234567890abcdef"
    summary = f"""## Active Task
- Store this safely.

## Critical Context
- {secret}
"""

    ledger.record_segment(
        session_id="sid-1",
        summary_text=summary,
        turns=[{"role": "user", "content": secret}],
        start_turn=0,
        end_turn=1,
    )

    segment = ledger._conn.execute(
        "SELECT summary_text FROM compression_segments LIMIT 1"
    ).fetchone()
    atoms = ledger._conn.execute("SELECT text FROM memory_atoms").fetchall()
    persisted = segment["summary_text"] + "\n" + "\n".join(row["text"] for row in atoms)
    assert "sk-test1234567890abcdef" not in persisted
    assert "OPENAI_API_KEY" in persisted


def test_compressor_records_private_ledger_segment(tmp_path, monkeypatch):
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    compressor = ContextCompressor(model="test-model", quiet_mode=True, memory_ledger_enabled=True)
    compressor.on_session_start("sid-1")
    compressor._memory_ledger = ledger

    monkeypatch.setattr(
        "agent.context_compressor.call_llm",
        lambda **_kwargs: SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=SUMMARY))]
        ),
    )

    result = compressor._generate_summary(
        [{"role": "user", "content": "please continue implementing the ledger"}]
    )

    assert result is not None
    assert _LEDGER_CONTEXT_START in result
    rows = ledger.retrieve_for_prompt(session_id="sid-1", query="ledger", limit=10)
    assert any(row["atom_type"] == "task" for row in rows)


def test_compressor_memory_ledger_is_opt_in(tmp_path, monkeypatch):
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    compressor = ContextCompressor(model="test-model", quiet_mode=True)
    compressor.on_session_start("sid-1")
    compressor._memory_ledger = ledger

    monkeypatch.setattr(
        "agent.context_compressor.call_llm",
        lambda **_kwargs: SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=SUMMARY))]
        ),
    )

    compressor._generate_summary(
        [{"role": "user", "content": "please continue implementing the ledger"}]
    )

    rows = ledger.retrieve_for_prompt(session_id="sid-1", query="ledger", limit=10)
    assert rows == []


def test_ledger_write_failure_falls_back_to_summary_only(monkeypatch):
    class BrokenLedger:
        def record_segment(self, **_kwargs):
            raise RuntimeError("database is locked")

        def retrieve_for_prompt(self, **_kwargs):
            return []

        def format_for_prompt(self, *_args, **_kwargs):
            return ""

        def has_segments(self, _session_id):
            return False

        def lineage_session_ids(self, session_id, **_kwargs):
            return [session_id]

    compressor = ContextCompressor(model="test-model", quiet_mode=True, memory_ledger_enabled=True)
    compressor.on_session_start("sid-1")
    compressor._memory_ledger = BrokenLedger()

    monkeypatch.setattr(
        "agent.context_compressor.call_llm",
        lambda **_kwargs: SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=SUMMARY))]
        ),
    )

    result = compressor._generate_summary(
        [{"role": "user", "content": "please continue implementing the ledger"}]
    )

    assert result is not None
    assert "continue implementing the ledger" in result
    assert compressor._last_memory_ledger_error == "database is locked"


def test_compressor_injects_and_strips_private_ledger_context(tmp_path):
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    ledger.record_segment(
        session_id="sid-1",
        summary_text=SUMMARY,
        turns=[{"role": "user", "content": "raw body not persisted in refs"}],
        start_turn=0,
        end_turn=1,
    )

    compressor = ContextCompressor(model="test-model", quiet_mode=True, memory_ledger_enabled=True)
    compressor.on_session_start("sid-1")
    compressor._memory_ledger = ledger
    compressor._previous_summary = "## Active Task\nUse ordinary summary too."

    context = compressor._context_for_new_turns()
    assert _LEDGER_CONTEXT_START in context
    assert "Use ordinary summary too." in context

    prefixed = compressor._with_summary_prefix(context)
    stripped = compressor._strip_summary_prefix(prefixed)
    assert _LEDGER_CONTEXT_START not in stripped
    assert _LEDGER_CONTEXT_END not in stripped
    assert "Use ordinary summary too." in stripped


def test_compressor_retrieves_parent_session_ledger_after_rotation(tmp_path):
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    ledger.record_segment(
        session_id="old-session",
        summary_text=SUMMARY,
        turns=[{"role": "user", "content": "parent session raw body"}],
        start_turn=0,
        end_turn=1,
    )

    compressor = ContextCompressor(model="test-model", quiet_mode=True, memory_ledger_enabled=True)
    compressor.on_session_start("new-session", old_session_id="old-session")
    compressor._memory_ledger = ledger

    context = compressor._context_for_new_turns()
    assert _LEDGER_CONTEXT_START in context
    assert "continue implementing the ledger" in context


def test_pre_compression_session_start_preserves_existing_parent_lineage():
    compressor = ContextCompressor(model="test-model", quiet_mode=True, memory_ledger_enabled=True)
    compressor.on_session_start("child-session", old_session_id="parent-session")
    compressor.on_session_start("child-session", boundary_reason="pre_compression")
    assert compressor._parent_session_id == "parent-session"


def test_current_session_state_prevents_parent_active_task_resurrection(tmp_path):
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    ledger.record_segment(
        session_id="old-session",
        summary_text=SUMMARY,
        turns=[{"role": "user", "content": "old active work"}],
        start_turn=0,
        end_turn=1,
    )
    ledger.record_segment(
        session_id="new-session",
        parent_session_id="old-session",
        summary_text=DONE_SUMMARY,
        turns=[{"role": "assistant", "content": "done now"}],
        start_turn=1,
        end_turn=2,
    )

    compressor = ContextCompressor(model="test-model", quiet_mode=True, memory_ledger_enabled=True)
    compressor.on_session_start("new-session", old_session_id="old-session")
    compressor._memory_ledger = ledger

    context = compressor._context_for_new_turns()
    assert "continue implementing the ledger" not in context
    assert "Current session has its own later compaction state" in context


def test_ledger_lineage_follows_multiple_compression_rotations(tmp_path):
    ledger = CompressionMemoryLedger(tmp_path / "compression_memory.db")
    ledger.record_segment(
        session_id="s1",
        summary_text=SUMMARY,
        turns=[{"role": "user", "content": "first"}],
        start_turn=0,
        end_turn=1,
    )
    ledger.record_segment(
        session_id="s2",
        parent_session_id="s1",
        summary_text=DONE_SUMMARY,
        turns=[{"role": "assistant", "content": "second"}],
        start_turn=1,
        end_turn=2,
    )
    ledger.record_segment(
        session_id="s3",
        parent_session_id="s2",
        summary_text=DONE_SUMMARY,
        turns=[{"role": "assistant", "content": "third"}],
        start_turn=2,
        end_turn=3,
    )

    assert ledger.lineage_session_ids("s3") == ["s3", "s2", "s1"]
