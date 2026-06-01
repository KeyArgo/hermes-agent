#!/usr/bin/env python3
"""
Evaluate whether repeated session compression preserves operational memory.

This is intentionally local and model-free by default. It treats the raw
Codex JSONL transcript as truth, extracts typed "memory atoms", then compares
two compression strategies after repeated compaction passes:

  recursive_summary: lossy summary state repeatedly summarized again
  typed_ledger: append-only atom ledger, regenerated active view

The numbers are not a semantic LLM judge. They are a retention benchmark for
the details the user cares about: decisions, small details, paths, commands,
and preferences.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


CATEGORIES = ("decision", "detail", "path", "command", "preference")

PATH_RE = re.compile(r"(?<![\w.-])(?:~/?|/(?:[A-Za-z0-9._-]+/?)+)[^\s\)\]\}\,\"'<>`]{2,}")
COMMAND_HINT_RE = re.compile(
    r"(?m)^\s*(?:python3?|bash|rg|find|sed|cat|git|npm|pnpm|uv|curl|ssh|scp|"
    r"tmux|timeout|chmod|mkdir|cp|mv|ln|date|/(?:[A-Za-z0-9._-]+/)+)"
    r"[^\n]{3,240}"
)
DETAIL_RE = re.compile(
    r"\b(?:[A-Z][A-Z0-9_]{3,}|[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+|"
    r"[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.:/-]+|--[a-zA-Z0-9][a-zA-Z0-9_-]+|"
    r"[a-zA-Z0-9_-]+\.(?:py|sh|ts|tsx|js|json|md|yaml|yml|toml|db))\b"
)
PREF_RE = re.compile(
    r"\b(?:prefer|always|never|do not|don't|dont|must|should|want|wants|"
    r"keep|avoid|use .* instead|default to)\b",
    re.I,
)
DECISION_RE = re.compile(
    r"\b(?:decision|decide|decided|recommend|recommended|verdict|plan|"
    r"implement|chosen|use |route|default|gate|block|allow)\b",
    re.I,
)
SECRETISH_RE = re.compile(
    r"(?i)(api[_-]?key|token|secret|password|passwd|bearer|private[_-]?key|"
    r"authorization|credential)"
)


@dataclass(frozen=True)
class Atom:
    category: str
    value: str
    first_turn: int
    last_turn: int
    count: int

    @property
    def atom_id(self) -> str:
        h = hashlib.sha256(f"{self.category}\0{self.value}".encode()).hexdigest()
        return h[:16]


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
    return text


def redact_value(value: str) -> str:
    if SECRETISH_RE.search(value):
        return "[REDACTED_SECRETISH]"
    value = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", value)
    value = re.sub(r"(?i)(token|password|secret|api[_-]?key)(\s*[:=]\s*)\S+", r"\1\2[REDACTED]", value)
    return value


def iter_strings(obj: Any, key_hint: str = "") -> Iterable[tuple[str, str]]:
    if isinstance(obj, str):
        yield key_hint, obj
    elif isinstance(obj, list):
        for item in obj:
            yield from iter_strings(item, key_hint)
    elif isinstance(obj, dict):
        for key, value in obj.items():
            yield from iter_strings(value, str(key))


def event_texts(path: Path, max_bytes: int | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    read_bytes = 0
    turn = 0
    with path.open(errors="replace") as fh:
        for line_no, line in enumerate(fh, start=1):
            read_bytes += len(line.encode(errors="ignore"))
            if max_bytes and read_bytes > max_bytes:
                break
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            typ = row.get("type")
            if typ == "turn_context":
                turn += 1
                continue
            if typ != "response_item":
                continue
            payload = row.get("payload") or {}
            ptype = payload.get("type")
            role = payload.get("role") or ptype or "unknown"
            parts: list[str] = []

            if ptype == "message":
                for _, s in iter_strings(payload.get("content")):
                    if s.strip():
                        parts.append(s)
            elif ptype in {"function_call", "tool_call"}:
                name = payload.get("name") or payload.get("tool_name") or "tool"
                args = payload.get("arguments") or payload.get("args") or ""
                if isinstance(args, str):
                    parts.append(f"{name} {args}")
                else:
                    parts.append(f"{name} {json.dumps(args, sort_keys=True)}")
            else:
                # Keep this narrow: tool outputs can be huge. We only need fields
                # likely to contain commands or action metadata.
                for key, s in iter_strings(payload):
                    if key in {"cmd", "command", "arguments", "name", "path"} and s.strip():
                        parts.append(s)

            text = clean_text("\n".join(parts)).strip()
            if text:
                out.append({"turn": turn, "line": line_no, "role": role, "text": text})
    return out


def sentences(text: str) -> list[str]:
    rough = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [s.strip(" -\t") for s in rough if 12 <= len(s.strip()) <= 260]


def normalize_atom(value: str) -> str:
    value = clean_text(value).strip()
    value = re.sub(r"\s+", " ", value)
    value = value.strip("`'\".,;:()[]{}")
    return value[:280]


def collect_atoms(events: list[dict[str, Any]]) -> list[Atom]:
    stats: dict[tuple[str, str], dict[str, int]] = {}

    def add(category: str, value: str, turn: int) -> None:
        value = normalize_atom(redact_value(value))
        if len(value) < 3:
            return
        key = (category, value)
        if key not in stats:
            stats[key] = {"first": turn, "last": turn, "count": 0}
        stats[key]["last"] = turn
        stats[key]["count"] += 1

    for event in events:
        turn = int(event["turn"])
        text = event["text"]
        role = event["role"]
        for match in PATH_RE.finditer(text):
            add("path", match.group(0), turn)
        for match in COMMAND_HINT_RE.finditer(text):
            add("command", match.group(0), turn)
        if role in {"user", "message"}:
            for sent in sentences(text):
                if PREF_RE.search(sent):
                    add("preference", sent, turn)
        for sent in sentences(text):
            if DECISION_RE.search(sent):
                add("decision", sent, turn)
        for match in DETAIL_RE.finditer(text):
            val = match.group(0)
            if len(val) >= 4 and not val.startswith("http"):
                add("detail", val, turn)

    atoms = [
        Atom(category=cat, value=value, first_turn=s["first"], last_turn=s["last"], count=s["count"])
        for (cat, value), s in stats.items()
    ]
    return atoms


def atom_score(atom: Atom, max_turn: int) -> float:
    recency = atom.last_turn / max(max_turn, 1)
    freq = math.log2(atom.count + 1)
    cat_weight = {
        "decision": 4.5,
        "preference": 4.2,
        "command": 3.4,
        "path": 3.2,
        "detail": 2.0,
    }[atom.category]
    compactness = 1.0 if len(atom.value) < 120 else 0.75
    return cat_weight + freq + (2.2 * recency) + compactness


def select_gold(atoms: list[Atom], per_category: int, max_turn: int) -> dict[str, list[Atom]]:
    by_cat: dict[str, list[Atom]] = defaultdict(list)
    for atom in atoms:
        by_cat[atom.category].append(atom)
    gold: dict[str, list[Atom]] = {}
    for cat in CATEGORIES:
        ranked = sorted(by_cat.get(cat, []), key=lambda a: atom_score(a, max_turn), reverse=True)
        gold[cat] = ranked[:per_category]
    return gold


def initial_summary_atoms(gold: dict[str, list[Atom]], max_turn: int, budget_per_cat: dict[str, int]) -> list[Atom]:
    selected: list[Atom] = []
    for cat in CATEGORIES:
        ranked = sorted(gold[cat], key=lambda a: atom_score(a, max_turn), reverse=True)
        selected.extend(ranked[: budget_per_cat.get(cat, 0)])
    return selected


def recursive_compress(
    gold: dict[str, list[Atom]],
    passes: int,
    max_turn: int,
    base_budget: dict[str, int],
    decay: float,
) -> set[str]:
    retained = initial_summary_atoms(gold, max_turn, base_budget)
    for idx in range(1, passes + 1):
        by_cat: dict[str, list[Atom]] = defaultdict(list)
        for atom in retained:
            by_cat[atom.category].append(atom)
        next_retained: list[Atom] = []
        for cat in CATEGORIES:
            budget = max(3, int(base_budget.get(cat, 0) * (decay ** idx)))
            ranked = sorted(by_cat.get(cat, []), key=lambda a: atom_score(a, max_turn), reverse=True)
            # Deterministic tie-breaker that changes per pass to model small
            # paraphrase/omission drift in recursive summaries.
            ranked = sorted(
                ranked,
                key=lambda a: (
                    atom_score(a, max_turn),
                    hashlib.sha256(f"{idx}:{a.atom_id}".encode()).hexdigest(),
                ),
                reverse=True,
            )
            next_retained.extend(ranked[:budget])
        retained = next_retained
    return {atom.atom_id for atom in retained}


def typed_ledger(gold: dict[str, list[Atom]]) -> set[str]:
    return {atom.atom_id for atoms in gold.values() for atom in atoms}


def map_to_memory_type(category: str) -> tuple[str, str]:
    if category == "decision":
        return "decision", "active"
    if category == "preference":
        return "artifact", "active"
    if category == "command":
        return "artifact", "done"
    if category == "path":
        return "artifact", "active"
    return "artifact", "active"


def ledger_sqlite_roundtrip(gold: dict[str, list[Atom]]) -> set[str]:
    """Validate that the shipped SQLite ledger can persist all gold atoms.

    This does not judge answer quality or prompt-budget retrieval. It is a
    release guard for the append-only ledger invariant: selected operational
    facts must survive durable storage without lossy re-summarization.
    """
    import tempfile

    from agent.compression_memory import CompressionAtom, CompressionMemoryLedger

    atom_lookup = {atom.atom_id: atom for atoms in gold.values() for atom in atoms}
    retained: set[str] = set()
    with tempfile.TemporaryDirectory(prefix="hermes-compression-eval-") as td:
        ledger = CompressionMemoryLedger(Path(td) / "compression_memory.db")
        now = datetime.now(timezone.utc).timestamp()
        try:
            for atom in atom_lookup.values():
                atom_type, status = map_to_memory_type(atom.category)
                ledger._insert_atom(
                    CompressionAtom(
                        atom_type=atom_type,
                        status=status,
                        text=atom.value,
                        source_refs=[
                            {
                                "session_id": "eval-session",
                                "turn": atom.first_turn,
                                "role": "eval",
                                "content_hash": atom.atom_id,
                            }
                        ],
                    ),
                    session_id="eval-session",
                    segment_id=1,
                    now=now,
                )
            rows = ledger._conn.execute(
                "SELECT text FROM memory_atoms WHERE session_id=?",
                ("eval-session",),
            ).fetchall()
            stored_values = {str(row["text"]) for row in rows}
            for atom_id, atom in atom_lookup.items():
                if atom.value in stored_values:
                    retained.add(atom_id)
        finally:
            ledger.close()
    return retained


def score(gold: dict[str, list[Atom]], retained: set[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    totals = []
    kepts = []
    for cat in CATEGORIES:
        ids = {atom.atom_id for atom in gold[cat]}
        kept = len(ids & retained)
        total = len(ids)
        totals.append(total)
        kepts.append(kept)
        out[cat] = {
            "retained": kept,
            "total": total,
            "retention": round(kept / total, 4) if total else 1.0,
        }
    total_all = sum(totals)
    kept_all = sum(kepts)
    out["overall"] = {
        "retained": kept_all,
        "total": total_all,
        "retention": round(kept_all / total_all, 4) if total_all else 1.0,
    }
    return out


def summarize_atoms(atoms: list[Atom]) -> dict[str, Any]:
    counts = Counter(a.category for a in atoms)
    turns = [a.last_turn for a in atoms]
    return {
        "total_atoms_extracted": len(atoms),
        "by_category": {cat: counts.get(cat, 0) for cat in CATEGORIES},
        "max_turn": max(turns) if turns else 0,
        "median_last_turn": statistics.median(turns) if turns else 0,
    }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Session Compression Retention Eval",
        "",
        f"- Generated: `{report['generated_at']}`",
        f"- Source: `{report['source_path']}`",
        f"- Source bytes scanned: `{report['source_bytes_scanned']}`",
        f"- Events parsed: `{report['events_parsed']}`",
        f"- Gold atoms per category cap: `{report['gold_per_category']}`",
        "",
        "## Atom Census",
        "",
        "| Category | Extracted | Gold total |",
        "|---|---:|---:|",
    ]
    census = report["atom_census"]
    gold_counts = report["gold_counts"]
    for cat in CATEGORIES:
        lines.append(f"| {cat} | {census['by_category'].get(cat, 0)} | {gold_counts.get(cat, 0)} |")
    lines += [
        "",
        "## Retention",
        "",
        "| Strategy | Passes | Overall | Decisions | Details | Paths | Commands | Preferences |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in report["runs"]:
        s = row["score"]
        lines.append(
            f"| {row['strategy']} | {row['passes']} | "
            f"{s['overall']['retention']:.1%} | "
            f"{s['decision']['retention']:.1%} | "
            f"{s['detail']['retention']:.1%} | "
            f"{s['path']['retention']:.1%} | "
            f"{s['command']['retention']:.1%} | "
            f"{s['preference']['retention']:.1%} |"
        )
    lines += [
        "",
        "## Read",
        "",
        "- `recursive_summary` models repeated prose compression: each pass has a bounded detail budget and can omit low-priority atoms.",
        "- `typed_ledger` models append-only facts with provenance. It should retain 100% of extracted gold atoms; failures here would mean the ledger rewrite is broken.",
        "- This benchmark scores exact/extractive retention, not answer quality. A later phase can add local-model semantic judging.",
    ]
    path.write_text("\n".join(lines) + "\n")


def main_args(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session", help="Codex rollout JSONL session to evaluate")
    ap.add_argument("--passes", default="10,25,50", help="Comma-separated compaction pass counts")
    ap.add_argument("--gold-per-category", type=int, default=120)
    ap.add_argument("--max-bytes", type=int, default=0, help="Limit bytes read from source; 0 = full file")
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--out-md", required=True)
    ap.add_argument("--decay", type=float, default=0.965)
    ap.add_argument(
        "--require-ledger-retention",
        type=float,
        default=0.0,
        help="Fail if typed_ledger or ledger_sqlite_roundtrip overall retention is below this fraction.",
    )
    args = ap.parse_args(argv)

    source = Path(args.session)
    max_bytes = args.max_bytes or None
    events = event_texts(source, max_bytes=max_bytes)
    atoms = collect_atoms(events)
    max_turn = max((event["turn"] for event in events), default=0)
    gold = select_gold(atoms, args.gold_per_category, max_turn=max_turn)
    passes = [int(p.strip()) for p in args.passes.split(",") if p.strip()]
    base_budget = {
        "decision": 70,
        "detail": 55,
        "path": 65,
        "command": 45,
        "preference": 45,
    }

    runs: list[dict[str, Any]] = []
    for n in passes:
        recursive = recursive_compress(gold, n, max_turn=max_turn, base_budget=base_budget, decay=args.decay)
        runs.append({"strategy": "recursive_summary", "passes": n, "score": score(gold, recursive)})
        ledger = typed_ledger(gold)
        runs.append({"strategy": "typed_ledger", "passes": n, "score": score(gold, ledger)})
        ledger_db = ledger_sqlite_roundtrip(gold)
        runs.append({"strategy": "ledger_sqlite_roundtrip", "passes": n, "score": score(gold, ledger_db)})

    source_bytes = source.stat().st_size if source.exists() else 0
    scanned = min(source_bytes, max_bytes) if max_bytes else source_bytes
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_path": str(source),
        "source_bytes": source_bytes,
        "source_bytes_scanned": scanned,
        "events_parsed": len(events),
        "atom_census": summarize_atoms(atoms),
        "gold_per_category": args.gold_per_category,
        "gold_counts": {cat: len(gold[cat]) for cat in CATEGORIES},
        "runs": runs,
        "method": {
            "judge": "deterministic exact/extractive atom retention",
            "categories": list(CATEGORIES),
            "recursive_decay": args.decay,
            "raw_samples_included": False,
        },
    }

    out_json = Path(args.out_json)
    out_md = Path(args.out_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    write_markdown(report, out_md)

    print(f"wrote {out_json}")
    print(f"wrote {out_md}")
    failed_gate = False
    for row in runs:
        overall = row["score"]["overall"]["retention"]
        print(f"{row['strategy']} passes={row['passes']} retention={overall:.1%}")
        if (
            args.require_ledger_retention
            and row["strategy"] in {"typed_ledger", "ledger_sqlite_roundtrip"}
            and overall < args.require_ledger_retention
        ):
            failed_gate = True
    if failed_gate:
        print(
            "ledger retention gate failed: "
            f"required {args.require_ledger_retention:.1%}",
        )
        return 2
    return 0


def main() -> int:
    return main_args()


if __name__ == "__main__":
    raise SystemExit(main())
