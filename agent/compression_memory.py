"""Private derived memory ledger for context compression.

The compressor summary is good at keeping the model moving, but it is still
prose that can be omitted or misread under tight budgets. This module stores a
small, local SQLite ledger derived from successful compaction summaries:
typed atoms, sanitized text, and raw-message backpointers by hash/ordinal only.

It intentionally does not store raw transcript bodies.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from agent.redact import redact_sensitive_text
from hermes_constants import get_hermes_home


SCHEMA_VERSION = 1
ATOM_TYPES = {"task", "decision", "blocker", "artifact", "verification", "handover"}
ATOM_STATUSES = {"active", "blocked", "deferred", "done", "superseded"}

_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.M)
_BULLET_RE = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+")
_COMMAND_RE = re.compile(
    r"^\s*(?:`)?(?:python(?:3(?:\.\d+)?)?|bash|sh|rg|find|sed|cat|git|npm|pnpm|"
    r"uv|curl|ssh|scp|tmux|timeout|chmod|mkdir|cp|mv|ln|date|pytest|"
    r"/(?:[A-Za-z0-9._-]+/)+)[^`]*",
    re.I,
)
_PATH_RE = re.compile(r"(?:~/?|/(?:[A-Za-z0-9._-]+/?)+)[^\s`'\")\]}<>]*")
_SECRETISH_RE = re.compile(
    r"(?i)\b(api[_-]?key|token|secret|password|passwd|bearer|authorization|cookie)\b"
)


@dataclass(frozen=True)
class CompressionAtom:
    atom_type: str
    status: str
    text: str
    source_refs: list[dict[str, Any]]


def _content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return str(content)


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()


def _sanitize_atom_text(text: str) -> str:
    text = redact_sensitive_text(text or "", force=True)
    text = re.sub(r"\s+", " ", text).strip()
    if _SECRETISH_RE.search(text):
        text = _SECRETISH_RE.sub("[REDACTED_LABEL]", text)
    if len(text) > 900:
        text = text[:880].rstrip() + " ...[truncated]"
    return text


def _parse_sections(summary_text: str) -> dict[str, str]:
    text = summary_text or ""
    matches = list(_SECTION_RE.finditer(text))
    sections: dict[str, str] = {}
    for idx, match in enumerate(matches):
        title = match.group(1).strip().lower()
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        sections[title] = text[start:end].strip()
    return sections


def _nonempty_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw in (text or "").splitlines():
        line = _BULLET_RE.sub("", raw).strip()
        if not line or line.lower() in {"none", "none.", "[none]", "n/a"}:
            continue
        lines.append(line)
    return lines


def source_refs_for_turns(
    turns: Iterable[dict[str, Any]],
    *,
    session_id: str,
    start_turn: int = 0,
    segment_id: Optional[int] = None,
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for offset, msg in enumerate(turns):
        content = _content_text(msg.get("content"))
        ref: dict[str, Any] = {
            "session_id": session_id,
            "turn": start_turn + offset,
            "role": str(msg.get("role") or "unknown"),
            "content_hash": _stable_hash(content),
        }
        for key in ("id", "message_id", "platform_message_id"):
            if msg.get(key):
                ref[key] = msg[key]
        if segment_id is not None:
            ref["segment_id"] = segment_id
        refs.append(ref)
    return refs


def extract_atoms_from_summary(
    summary_text: str,
    turns: Iterable[dict[str, Any]],
    *,
    session_id: str,
    segment_id: Optional[int] = None,
    start_turn: int = 0,
) -> list[CompressionAtom]:
    """Extract a conservative typed atom list from a structured summary."""
    refs = source_refs_for_turns(
        turns,
        session_id=session_id,
        start_turn=start_turn,
        segment_id=segment_id,
    )
    sections = _parse_sections(summary_text)
    atoms: list[CompressionAtom] = []

    def add(atom_type: str, status: str, text: str) -> None:
        text = _sanitize_atom_text(text)
        if not text:
            return
        if atom_type not in ATOM_TYPES or status not in ATOM_STATUSES:
            return
        atoms.append(CompressionAtom(atom_type, status, text, refs))

    for title in ("active task", "pending user asks", "in progress", "remaining work"):
        for line in _nonempty_lines(sections.get(title, "")):
            add("task", "active", line)

    for line in _nonempty_lines(sections.get("blocked", "")):
        add("blocker", "blocked", line)

    for line in _nonempty_lines(sections.get("key decisions", "")):
        add("decision", "active", line)

    for title in ("active state", "relevant files", "critical context"):
        for line in _nonempty_lines(sections.get(title, "")):
            add("artifact", "active", line)

    for line in _nonempty_lines(sections.get("completed actions", "")):
        atom_type = "verification" if re.search(r"\b(test|pytest|passed|failed|verified)\b", line, re.I) else "artifact"
        add(atom_type, "done", line)

    for title, body in sections.items():
        if "handover" in title:
            for line in _nonempty_lines(body):
                add("handover", "active", line)

    for line in _nonempty_lines(summary_text):
        if _COMMAND_RE.match(line):
            add("artifact", "active", f"Command: {line.strip('`')}")
        for path in _PATH_RE.findall(line):
            add("artifact", "active", f"Path: {path.rstrip('.,:;')}")

    deduped: list[CompressionAtom] = []
    seen: set[tuple[str, str, str]] = set()
    for atom in atoms:
        key = (atom.atom_type, atom.status, atom.text)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(atom)
    return deduped


class CompressionMemoryLedger:
    """SQLite-backed private ledger of compression-derived memory atoms."""

    def __init__(self, db_path: Optional[Path | str] = None):
        self.db_path = Path(db_path) if db_path else get_hermes_home() / "compression_memory.db"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path), timeout=30, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._fts_enabled = True
        self._apply_journal_mode()
        self._init_schema()

    def close(self) -> None:
        self._conn.close()

    def _apply_journal_mode(self) -> None:
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError as exc:
            if "locking protocol" not in str(exc).lower() and "not authorized" not in str(exc).lower():
                raise
            self._conn.execute("PRAGMA journal_mode=DELETE")

    def _init_schema(self) -> None:
        with self._conn:
            self._conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
            row = self._conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
            if row is None:
                self._conn.execute("INSERT INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,))
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS compression_segments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    parent_session_id TEXT,
                    start_turn INTEGER NOT NULL,
                    end_turn INTEGER NOT NULL,
                    summary_text TEXT NOT NULL,
                    summary_hash TEXT NOT NULL,
                    source_refs_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_atoms (
                    atom_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    segment_id INTEGER,
                    atom_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    text TEXT NOT NULL,
                    text_hash TEXT NOT NULL,
                    source_refs_json TEXT NOT NULL,
                    supersedes TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_atoms_session_status ON memory_atoms(session_id, status)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_atoms_type ON memory_atoms(atom_type)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_compression_segments_session ON compression_segments(session_id)")
            try:
                self._conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS memory_atoms_fts "
                    "USING fts5(atom_id UNINDEXED, session_id UNINDEXED, atom_type UNINDEXED, status UNINDEXED, text)"
                )
            except sqlite3.OperationalError:
                self._fts_enabled = False

    def record_segment(
        self,
        *,
        session_id: str,
        summary_text: str,
        turns: Iterable[dict[str, Any]],
        start_turn: int,
        end_turn: int,
        parent_session_id: str = "",
    ) -> int:
        if not session_id:
            raise ValueError("session_id is required")
        turns_list = list(turns)
        summary_text = redact_sensitive_text(summary_text or "", force=True).strip()
        source_refs = source_refs_for_turns(turns_list, session_id=session_id, start_turn=start_turn)
        now = time.time()
        with self._conn:
            cur = self._conn.execute(
                """
                INSERT INTO compression_segments(
                    session_id, parent_session_id, start_turn, end_turn,
                    summary_text, summary_hash, source_refs_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    parent_session_id or "",
                    start_turn,
                    end_turn,
                    summary_text,
                    _stable_hash(summary_text),
                    json.dumps(source_refs, sort_keys=True),
                    now,
                ),
            )
            segment_id = int(cur.lastrowid)
            atoms = extract_atoms_from_summary(
                summary_text,
                turns_list,
                session_id=session_id,
                segment_id=segment_id,
                start_turn=start_turn,
            )
            for atom in atoms:
                self._insert_atom(atom, session_id=session_id, segment_id=segment_id, now=now)
        return segment_id

    def has_segments(self, session_id: str) -> bool:
        if not session_id:
            return False
        row = self._conn.execute(
            "SELECT 1 FROM compression_segments WHERE session_id=? LIMIT 1",
            (session_id,),
        ).fetchone()
        return row is not None

    def prune_older_than(self, retention_days: int) -> int:
        """Delete ledger rows older than ``retention_days``.

        The ledger is derived state, so pruning it is safe: normal context
        summaries still carry the latest continuity record.
        """
        if retention_days <= 0:
            return 0
        cutoff = time.time() - (retention_days * 24 * 60 * 60)
        with self._conn:
            old_segments = self._conn.execute(
                "SELECT id FROM compression_segments WHERE created_at < ?",
                (cutoff,),
            ).fetchall()
            segment_ids = [int(row["id"]) for row in old_segments]
            if not segment_ids:
                return 0
            placeholders = ",".join("?" for _ in segment_ids)
            atom_ids = [
                str(row["atom_id"])
                for row in self._conn.execute(
                    f"SELECT atom_id FROM memory_atoms WHERE segment_id IN ({placeholders})",
                    segment_ids,
                ).fetchall()
            ]
            if atom_ids and self._fts_enabled:
                atom_placeholders = ",".join("?" for _ in atom_ids)
                self._conn.execute(
                    f"DELETE FROM memory_atoms_fts WHERE atom_id IN ({atom_placeholders})",
                    atom_ids,
                )
            self._conn.execute(
                f"DELETE FROM memory_atoms WHERE segment_id IN ({placeholders})",
                segment_ids,
            )
            self._conn.execute(
                f"DELETE FROM compression_segments WHERE id IN ({placeholders})",
                segment_ids,
            )
        return len(segment_ids)

    def lineage_session_ids(
        self,
        session_id: str,
        *,
        parent_session_id: str = "",
        max_depth: int = 8,
    ) -> list[str]:
        """Return newest-to-oldest session ids known to this ledger.

        The compressor rotates SQLite sessions on compaction. The ledger keeps
        segment parent ids, so retrieval can follow that chain without needing
        to join the main session DB.
        """
        out: list[str] = []
        queue: list[str] = [sid for sid in (session_id, parent_session_id) if sid]
        seen: set[str] = set()
        while queue and len(out) < max_depth:
            sid = queue.pop(0)
            if not sid or sid in seen:
                continue
            seen.add(sid)
            out.append(sid)
            parents = self._conn.execute(
                """
                SELECT DISTINCT parent_session_id
                FROM compression_segments
                WHERE session_id=? AND parent_session_id IS NOT NULL AND parent_session_id != ''
                ORDER BY id DESC
                """,
                (sid,),
            ).fetchall()
            for row in parents:
                parent = str(row["parent_session_id"] or "")
                if parent and parent not in seen:
                    queue.append(parent)
        return out

    def _insert_atom(self, atom: CompressionAtom, *, session_id: str, segment_id: int, now: float) -> str:
        text_hash = _stable_hash(atom.text)
        atom_id = _stable_hash(f"{session_id}\0{atom.atom_type}\0{text_hash}")[:24]
        source_refs_json = json.dumps(atom.source_refs, sort_keys=True)
        self._conn.execute(
            """
            INSERT INTO memory_atoms(
                atom_id, session_id, segment_id, atom_type, status, text,
                text_hash, source_refs_json, supersedes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(atom_id) DO UPDATE SET
                segment_id=excluded.segment_id,
                status=excluded.status,
                text=excluded.text,
                source_refs_json=excluded.source_refs_json,
                updated_at=excluded.updated_at
            """,
            (
                atom_id,
                session_id,
                segment_id,
                atom.atom_type,
                atom.status,
                atom.text,
                text_hash,
                source_refs_json,
                now,
                now,
            ),
        )
        if self._fts_enabled:
            self._conn.execute("DELETE FROM memory_atoms_fts WHERE atom_id = ?", (atom_id,))
            self._conn.execute(
                "INSERT INTO memory_atoms_fts(atom_id, session_id, atom_type, status, text) VALUES (?, ?, ?, ?, ?)",
                (atom_id, session_id, atom.atom_type, atom.status, atom.text),
            )
        return atom_id

    def mark_superseded(self, old_atom_id: str, new_atom_id: str, reason: str = "") -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE memory_atoms SET status='superseded', supersedes=?, updated_at=? WHERE atom_id=?",
                (new_atom_id or reason, time.time(), old_atom_id),
            )
            if self._fts_enabled:
                self._conn.execute(
                    "UPDATE memory_atoms_fts SET status='superseded' WHERE atom_id=?",
                    (old_atom_id,),
                )

    def retrieve_for_prompt(self, *, session_id: str, query: str = "", limit: int = 8) -> list[sqlite3.Row]:
        if not session_id or limit <= 0:
            return []
        rows = list(
            self._conn.execute(
                """
                SELECT atom_id, atom_type, status, text, source_refs_json, updated_at
                FROM memory_atoms
                WHERE session_id=? AND status IN ('active', 'blocked', 'deferred')
                ORDER BY
                    CASE status WHEN 'blocked' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                    updated_at DESC
                LIMIT ?
                """,
                (session_id, limit),
            )
        )

        if query and self._fts_enabled and len(rows) < limit:
            fts_query = self._sanitize_fts_query(query)
            if fts_query:
                try:
                    rows.extend(
                        self._conn.execute(
                            """
                            SELECT ma.atom_id, ma.atom_type, ma.status, ma.text, ma.source_refs_json, ma.updated_at
                            FROM memory_atoms_fts
                            JOIN memory_atoms ma ON ma.atom_id=memory_atoms_fts.atom_id
                            WHERE memory_atoms_fts.session_id=? AND memory_atoms_fts.status != 'superseded'
                              AND memory_atoms_fts MATCH ?
                            ORDER BY bm25(memory_atoms_fts)
                            LIMIT ?
                            """,
                            (session_id, fts_query, limit - len(rows)),
                        ).fetchall()
                    )
                except sqlite3.OperationalError:
                    pass

        deduped: list[sqlite3.Row] = []
        seen: set[str] = set()
        for row in rows:
            atom_id = str(row["atom_id"])
            if atom_id in seen:
                continue
            seen.add(atom_id)
            deduped.append(row)
            if len(deduped) >= limit:
                break
        return deduped

    @staticmethod
    def _sanitize_fts_query(query: str) -> str:
        terms = re.findall(r"[A-Za-z0-9_./:-]{3,}", query or "")
        terms = terms[:12]
        return " OR ".join(f'"{term.replace(chr(34), chr(34) + chr(34))}"' for term in terms)

    @staticmethod
    def format_for_prompt(atoms: Iterable[sqlite3.Row], *, limit: int = 8) -> str:
        lines: list[str] = []
        for row in atoms:
            status = str(row["status"])
            atom_type = str(row["atom_type"])
            text = _sanitize_atom_text(str(row["text"]))
            if not text:
                continue
            lines.append(f"- [{status}/{atom_type}] {text}")
            if len(lines) >= limit:
                break
        return "\n".join(lines)
