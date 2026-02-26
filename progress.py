"""PROGRESS.md experience distillation — auto-summarize completed tasks."""

from typing import Optional, List

import json
import logging
import os

from db import execute_returning, fetch_all, fetch_one

logger = logging.getLogger(__name__)

PROGRESS_FILE = "PROGRESS.md"

SUMMARIZE_PROMPT = """Analyze the following task and its result. Write a brief experience note with:
1. What was done (1 sentence)
2. Key lessons or patterns discovered (1-2 bullet points)
3. Tags (comma-separated, e.g.: auth, bugfix, refactor)

Task prompt: {prompt}

Task result: {result}

Output as JSON:
{{"summary": "...", "lessons": "...", "tags": "..."}}
Output ONLY valid JSON."""


async def record_progress(task_id: int, summary: str, lessons: str = "", tags: str = ""):
    """Manually add a progress entry."""
    await execute_returning(
        "INSERT INTO progress_entries (task_id, summary, lessons, tags) VALUES (?, ?, ?, ?)",
        (task_id, summary, lessons, tags),
    )
    await _rebuild_progress_file()


async def auto_summarize_task(task_id: int) -> Optional[dict]:
    """Generate a progress entry from a completed task. Returns the prompt for Claude to summarize."""
    task = await fetch_one("SELECT * FROM tasks WHERE id=?", (task_id,))
    if not task or task["status"] != "completed":
        return None

    prompt = task["prompt"][:500]
    result = (task.get("result_text") or "")[:500]

    return {
        "task_id": task_id,
        "prompt": SUMMARIZE_PROMPT.format(prompt=prompt, result=result),
    }


async def save_summary_result(task_id: int, result_text: str):
    """Parse a summary result and save it."""
    try:
        data = json.loads(result_text)
    except json.JSONDecodeError:
        start = result_text.find("{")
        end = result_text.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                data = json.loads(result_text[start:end])
            except json.JSONDecodeError:
                data = {"summary": result_text[:200], "lessons": "", "tags": ""}
        else:
            data = {"summary": result_text[:200], "lessons": "", "tags": ""}

    await execute_returning(
        "INSERT INTO progress_entries (task_id, summary, lessons, tags) VALUES (?, ?, ?, ?)",
        (task_id, data.get("summary", ""), data.get("lessons", ""), data.get("tags", "")),
    )
    await _rebuild_progress_file()
    logger.info(f"Progress entry saved for task {task_id}")


async def get_relevant_experience(prompt: str, limit: int = 3) -> str:
    """Get recent progress entries to inject into a new task's context."""
    entries = await fetch_all(
        "SELECT summary, lessons, tags FROM progress_entries ORDER BY id DESC LIMIT ?",
        (limit,),
    )
    if not entries:
        return ""

    lines = ["## Recent Experience Notes"]
    for e in entries:
        lines.append(f"- {e['summary']}")
        if e["lessons"]:
            lines.append(f"  Lessons: {e['lessons']}")
    return "\n".join(lines)


async def _rebuild_progress_file():
    """Rebuild PROGRESS.md from all entries."""
    entries = await fetch_all(
        "SELECT * FROM progress_entries ORDER BY created_at DESC"
    )

    lines = ["# Progress Notes\n"]
    for e in entries:
        lines.append(f"### Task #{e.get('task_id', '?')} — {e['created_at']}")
        lines.append(f"{e['summary']}")
        if e["lessons"]:
            lines.append(f"\n**Lessons:** {e['lessons']}")
        if e["tags"]:
            lines.append(f"\n*Tags: {e['tags']}*")
        lines.append("")

    content = "\n".join(lines)
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        f.write(content)
    logger.info(f"PROGRESS.md updated ({len(entries)} entries)")


async def get_progress_entries() -> List[dict]:
    return await fetch_all("SELECT * FROM progress_entries ORDER BY created_at DESC")
