import json
import importlib.util
import sys
from pathlib import Path


def _load_eval_module():
    path = Path("scripts/session_compression_eval.py")
    spec = importlib.util.spec_from_file_location("session_compression_eval", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_session_compression_eval_exercises_real_ledger(tmp_path):
    eval_mod = _load_eval_module()
    fixture = Path("tests/fixtures/compression/synthetic_ledger_replay.jsonl")
    out_json = tmp_path / "eval.json"
    out_md = tmp_path / "eval.md"

    rc = eval_mod.main_args(
        [
            str(fixture),
            "--passes",
            "5,10",
            "--gold-per-category",
            "20",
            "--out-json",
            str(out_json),
            "--out-md",
            str(out_md),
            "--require-ledger-retention",
            "0.95",
        ]
    )

    assert rc == 0
    report = json.loads(out_json.read_text())
    strategies = {row["strategy"] for row in report["runs"]}
    assert "ledger_sqlite_roundtrip" in strategies
    for row in report["runs"]:
        if row["strategy"] == "ledger_sqlite_roundtrip":
            assert row["score"]["overall"]["retention"] >= 0.95
