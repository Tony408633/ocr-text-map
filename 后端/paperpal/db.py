"""SQLite persistence for the PaperPal backend.

One connection is opened per operation. SQLite in WAL mode handles the small
amount of concurrency of a local single-user service well, and opening a fresh
connection keeps FastAPI's thread pool safe without a connection pool.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from . import config

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (profile_id, key)
);

CREATE TABLE IF NOT EXISTS books (
    id         TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT 'jade',
    demo       INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS books_profile ON books(profile_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    document_id TEXT NOT NULL DEFAULT '',
    image_path  TEXT,
    thumb_path  TEXT,
    rectified_path TEXT,
    width       INTEGER NOT NULL DEFAULT 0,
    height      INTEGER NOT NULL DEFAULT 0,
    line_count  INTEGER NOT NULL DEFAULT 0,
    text        TEXT NOT NULL DEFAULT '',
    confidence  REAL NOT NULL DEFAULT 0,
    layout      TEXT NOT NULL DEFAULT 'none',
    rotation    INTEGER NOT NULL DEFAULT 0,
    warnings    TEXT NOT NULL DEFAULT '[]',
    timing_ms   TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (book_id, page_number)
);
CREATE INDEX IF NOT EXISTS pages_book ON pages(book_id, page_number);

CREATE TABLE IF NOT EXISTS page_lines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    reading_order INTEGER NOT NULL,
    text          TEXT NOT NULL,
    confidence    REAL NOT NULL DEFAULT 0,
    region_id     TEXT NOT NULL DEFAULT '',
    block_id      TEXT NOT NULL DEFAULT '',
    bbox          TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS page_lines_page ON page_lines(page_id, reading_order);

CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id     TEXT REFERENCES books(id) ON DELETE CASCADE,
    page_id     TEXT REFERENCES pages(id) ON DELETE SET NULL,
    page_number INTEGER NOT NULL DEFAULT 1,
    line_number INTEGER,
    scope       TEXT NOT NULL DEFAULT 'line' CHECK (scope IN ('line', 'page')),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_profile ON notes(profile_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS notes_book ON notes(book_id, page_number);

CREATE TABLE IF NOT EXISTS progress (
    profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL DEFAULT 1,
    line_index  INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (profile_id, book_id)
);

CREATE TABLE IF NOT EXISTS activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    book_id     TEXT,
    page_number INTEGER,
    lines       INTEGER NOT NULL DEFAULT 0,
    seconds     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_profile ON activity(profile_id, created_at);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    """Thin SQLite helper shared by the repository and the API."""

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path is not None else config.db_path()
        self._init_lock = threading.Lock()
        self._initialized = False

    def connect(self) -> sqlite3.Connection:
        if str(self.path) == ":memory:":
            connection = sqlite3.connect(":memory:", timeout=10)
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(str(self.path), timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        if str(self.path) != ":memory:":
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    @contextmanager
    def cursor(self, *, write: bool = False) -> Iterator[sqlite3.Cursor]:
        connection = self.connect()
        try:
            cursor = connection.cursor()
            if write:
                cursor.execute("BEGIN IMMEDIATE")
            try:
                yield cursor
            except BaseException:
                if write:
                    connection.rollback()
                raise
            else:
                if write:
                    connection.commit()
        finally:
            connection.close()

    def initialize(self, *, seed_demo: bool | None = None) -> None:
        with self._init_lock:
            if self._initialized:
                return
            with self.cursor(write=True) as cursor:
                cursor.executescript(SCHEMA)
                cursor.execute(
                    "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (str(SCHEMA_VERSION),),
                )
                now = utcnow()
                cursor.execute(
                    "INSERT INTO profiles(id, name, created_at, updated_at) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(id) DO NOTHING",
                    (config.DEFAULT_PROFILE_ID, config.DEFAULT_PROFILE_NAME, now, now),
                )
                for key, value in config.DEFAULT_SETTINGS.items():
                    cursor.execute(
                        "INSERT INTO settings(profile_id, key, value) VALUES(?, ?, ?) "
                        "ON CONFLICT(profile_id, key) DO NOTHING",
                        (config.DEFAULT_PROFILE_ID, key, json.dumps(value, ensure_ascii=False)),
                    )
            self._initialized = True
            should_seed = config.seed_demo() if seed_demo is None else seed_demo
            if should_seed and self.is_empty():
                self.seed_demo()

    def is_empty(self) -> bool:
        with self.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) AS n FROM books")
            return int(cursor.fetchone()["n"]) == 0

    def seed_demo(self) -> None:
        """Create a small demo book so the first launch is not an empty shell."""
        from .seed import DEMO_BOOK

        now = utcnow()
        with self.cursor(write=True) as cursor:
            cursor.execute(
                "INSERT INTO books(id, profile_id, title, author, color, demo, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
                (DEMO_BOOK["id"], config.DEFAULT_PROFILE_ID, DEMO_BOOK["title"],
                 DEMO_BOOK["author"], DEMO_BOOK["color"], now, now),
            )
            cursor.execute(
                "INSERT INTO pages(id, book_id, page_number, document_id, width, height, line_count, "
                "text, confidence, layout, rotation, warnings, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, 0, 0, ?, ?, ?, 'none', 0, '[]', ?, ?)",
                (DEMO_BOOK["page_id"], DEMO_BOOK["id"], DEMO_BOOK["page_number"],
                 "demo-document", len(DEMO_BOOK["lines"]), "\n".join(DEMO_BOOK["lines"]),
                 0.99, now, now),
            )
            for index, line in enumerate(DEMO_BOOK["lines"], 1):
                cursor.execute(
                    "INSERT INTO page_lines(page_id, reading_order, text, confidence, region_id, block_id, bbox) "
                    "VALUES(?, ?, ?, ?, 'page-1', 'block-1', '[]')",
                    (DEMO_BOOK["page_id"], index, line, 0.99),
                )
            cursor.execute(
                "INSERT INTO progress(profile_id, book_id, page_number, line_index, updated_at) "
                "VALUES(?, ?, ?, 0, ?)",
                (config.DEFAULT_PROFILE_ID, DEMO_BOOK["id"], DEMO_BOOK["page_number"], now),
            )

    def schema_version(self) -> int:
        try:
            with self.cursor() as cursor:
                cursor.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'")
                row = cursor.fetchone()
                return int(row["value"]) if row else 0
        except sqlite3.Error:
            return 0

    def close(self) -> None:  # pragma: no cover - kept for symmetry/tests
        pass
