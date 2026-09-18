"""Regression for #114720 — a spawn-boundary infrastructure failure must not
consume a card's retry budget or park it.

The kanban spawn path hard-requires a restart-safe systemd scope; with no
reachable user D-Bus session that is refused before any worker exists, yet the
refusal used to count as a card failure and gave the card up for good.
"""
from __future__ import annotations

import json

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_db_dispatch as kbd


@pytest.fixture()
def board(tmp_path, monkeypatch):
    """A private board — never the developer's own."""
    (tmp_path / ".hermes").mkdir()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    for var in ("HERMES_KANBAN_DB", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_TASK"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HERMES_KANBAN_RATE_LIMIT_COOLDOWN_SECONDS", "0")  # retry every tick
    with kbc.connect_closing():
        pass
    assert kb.kanban_db_path().is_relative_to(tmp_path)


def _ticks(conn, spawn_fn, times, failure_limit=2):
    for _ in range(times):
        kbd.dispatch_once(
            conn, spawn_fn=spawn_fn, failure_limit=failure_limit, reconcile_orphans=False,
        )


def _state(conn, task_id):
    row = conn.execute(
        "SELECT status, block_kind, consecutive_failures FROM tasks WHERE id = ?", (task_id,),
    ).fetchone()
    runs = [
        (r["outcome"], json.loads(r["metadata"] or "{}"))
        for r in conn.execute(
            "SELECT outcome, metadata FROM task_runs WHERE task_id = ? ORDER BY id", (task_id,),
        ).fetchall()
    ]
    return row, runs


@pytest.mark.linux_only
def test_host_scope_refusal_does_not_consume_the_retry_budget(
    board, all_assignees_spawnable, monkeypatch,
):
    """Three real host refusals > failure_limit must not park or count the card."""
    from tools import process_registry as pr

    monkeypatch.setattr(pr, "_systemd_run_user_scope_available", lambda: False)
    monkeypatch.setattr(pr, "_is_supervised_gateway_process", lambda: True)
    monkeypatch.setenv("INVOCATION_ID", "repro")
    attempts = []

    def refusing_spawn(task, workspace, board=None):
        attempts.append(task.id)
        # Only the gateway-identity gate is stubbed; probe, _degrade() and raise are real.
        pr.restart_safe_gateway_child_argv(
            ["/bin/sh", "-c", "exit 0"], unit_suffix=f"k-{task.id}",
            require_restart_safe_scope=True,
        )

    with kbc.connect_closing() as conn:
        task_id = kb.create_task(conn, title="no worker", assignee="builder")
        _ticks(conn, refusing_spawn, 3)
        row, runs = _state(conn, task_id)

        assert (row["consecutive_failures"], row["status"], row["block_kind"]) == (0, "ready", None)
        assert len(attempts) == 3, "a parked card is never attempted again"
        assert [outcome for outcome, _ in runs] == ["spawn_failed"] * 3
        assert all(meta.get("infrastructure") for _, meta in runs)

        # Still transient: with the cooldown on, retries are spaced, not per-tick.
        monkeypatch.setenv("HERMES_KANBAN_RATE_LIMIT_COOLDOWN_SECONDS", "300")
        assert kbd.check_respawn_guard(conn, task_id) == "infrastructure_cooldown"


def test_ordinary_spawn_failure_still_trips_the_breaker(board, all_assignees_spawnable):
    """The exclusion is narrow: a card-level spawn failure keeps the unified budget."""
    def broken_spawn(task, workspace, board=None):
        raise RuntimeError("worker command not found")

    with kbc.connect_closing() as conn:
        task_id = kb.create_task(conn, title="broken worker", assignee="builder")
        _ticks(conn, broken_spawn, 2)
        row, runs = _state(conn, task_id)

    assert (row["consecutive_failures"], row["status"]) == (2, "blocked")
    assert "gave_up" in [outcome for outcome, _ in runs]
