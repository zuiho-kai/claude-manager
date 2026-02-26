"""SQLite schema + query utilities."""

from typing import Optional, List

import aiosqlite
import os

DB_PATH = os.environ.get("CCM_DB_PATH", "claude_manager.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',  -- queued/running/completed/failed/cancelled
    mode TEXT NOT NULL DEFAULT 'execute',   -- execute/plan
    priority INTEGER NOT NULL DEFAULT 0,
    worktree_id INTEGER,
    plan_group_id INTEGER,
    cwd TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    result_text TEXT,
    cost_usd REAL DEFAULT 0,
    FOREIGN KEY (worktree_id) REFERENCES worktrees(id),
    FOREIGN KEY (plan_group_id) REFERENCES plan_groups(id)
);

CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,  -- assistant/tool_use/tool_result/result/error/system
    payload TEXT NOT NULL,     -- raw JSON line
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',  -- idle/busy/removed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal TEXT NOT NULL,
    plan_text TEXT,
    status TEXT NOT NULL DEFAULT 'planning',  -- planning/reviewing/approved/executing/completed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS progress_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    summary TEXT NOT NULL,
    lessons TEXT,
    tags TEXT,  -- comma-separated
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);
"""


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    return db


async def init_db():
    db = await get_db()
    try:
        await db.executescript(SCHEMA)
        await db.commit()
    finally:
        await db.close()


async def fetch_one(query: str, params=()) -> Optional[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(query, params)
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def fetch_all(query: str, params=()) -> List[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def execute(query: str, params=()) -> int:
    db = await get_db()
    try:
        cursor = await db.execute(query, params)
        await db.commit()
        return cursor.lastrowid
    finally:
        await db.close()


async def execute_returning(query: str, params=()) -> int:
    return await execute(query, params)
