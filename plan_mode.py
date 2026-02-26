"""Plan Mode workflow — generate plan, review, approve, execute subtasks."""

from typing import Optional, List

import json
import logging

from db import execute, execute_returning, fetch_one, fetch_all

logger = logging.getLogger(__name__)

PLAN_PROMPT_TEMPLATE = """You are a senior software architect. Given the following goal, produce a detailed implementation plan broken into multiple concrete steps. Each step should be a self-contained task that Claude Code can execute independently.

GOAL:
{goal}

Rules:
- Break the goal into 2-6 concrete steps (not just one big step)
- Each step should be independently executable
- Each step's prompt should be detailed enough for Claude Code to execute without asking questions
- Steps should be ordered by dependency (earlier steps first)
- Include specific file names, function names, and implementation details in each prompt

Output a JSON object with this structure:
{{
  "summary": "Brief summary of the plan",
  "steps": [
    {{"title": "Step title", "description": "What this step does", "prompt": "The exact detailed prompt to give to Claude Code to execute this step"}}
  ]
}}

Output ONLY valid JSON, no markdown fences or extra text."""


async def create_plan_group(goal: str) -> int:
    """Create a new plan group and a planning task."""
    group_id = await execute_returning(
        "INSERT INTO plan_groups (goal, status) VALUES (?, 'planning')",
        (goal,),
    )

    # Create a task to generate the plan
    prompt = PLAN_PROMPT_TEMPLATE.format(goal=goal)
    task_id = await execute_returning(
        "INSERT INTO tasks (prompt, status, mode, plan_group_id) VALUES (?, 'queued', 'plan', ?)",
        (prompt, group_id),
    )

    logger.info(f"Plan group {group_id} created, planning task {task_id}")
    return group_id


async def on_plan_task_complete(task_id: int):
    """Called when a planning task finishes. Parse the plan and update the group.

    Must be called AFTER result_text is saved to DB (not from broadcast hook).
    """
    task = await fetch_one("SELECT * FROM tasks WHERE id=?", (task_id,))
    if not task or task["mode"] != "plan":
        return

    group_id = task["plan_group_id"]
    if not group_id:
        return

    result_text = task.get("result_text", "") or ""

    # Also try to extract from task_logs if result_text is empty
    if not result_text.strip():
        logs = await fetch_all(
            "SELECT payload FROM task_logs WHERE task_id=? AND event_type='result' ORDER BY id DESC LIMIT 1",
            (task_id,),
        )
        if logs:
            try:
                payload = json.loads(logs[0]["payload"])
                result_text = payload.get("result", "")
            except (json.JSONDecodeError, TypeError):
                pass

    if not result_text.strip():
        # Last resort: scan assistant messages for JSON
        logs = await fetch_all(
            "SELECT payload FROM task_logs WHERE task_id=? AND event_type='assistant' ORDER BY id",
            (task_id,),
        )
        for log in logs:
            try:
                payload = json.loads(log["payload"])
                text = ""
                if payload.get("message", {}).get("content"):
                    parts = payload["message"]["content"]
                    text = "".join(c.get("text", "") for c in parts) if isinstance(parts, list) else str(parts)
                elif payload.get("content"):
                    parts = payload["content"]
                    text = "".join(c.get("text", "") for c in parts) if isinstance(parts, list) else str(parts)
                if text and "{" in text:
                    result_text = text
                    break
            except (json.JSONDecodeError, TypeError):
                pass

    # Try to extract JSON from result
    plan_data = _extract_json(result_text)

    if plan_data:
        await execute(
            "UPDATE plan_groups SET plan_text=?, status='reviewing' WHERE id=?",
            (json.dumps(plan_data, ensure_ascii=False), group_id),
        )
        logger.info(f"Plan group {group_id} ready for review")
    else:
        await execute(
            "UPDATE plan_groups SET plan_text=?, status='reviewing' WHERE id=?",
            (result_text, group_id),
        )
        logger.warning(f"Plan group {group_id}: could not parse JSON plan, storing raw text")


def _extract_json(text):
    """Try to extract a JSON object from text."""
    if not text:
        return None
    text = text.strip()
    # Strip markdown fences
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Find first { to last }
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass
    return None


async def approve_plan(group_id: int, notify_scheduler=None) -> List[int]:
    """Approve a plan and create subtasks for each step."""
    group = await fetch_one("SELECT * FROM plan_groups WHERE id=?", (group_id,))
    if not group:
        return []

    plan_text = group.get("plan_text", "")
    steps = []

    try:
        plan_data = json.loads(plan_text)
        steps = plan_data.get("steps", [])
    except (json.JSONDecodeError, TypeError):
        # Can't parse — create a single task with the raw plan
        steps = [{"title": "Execute plan", "prompt": plan_text}]

    task_ids = []
    for i, step in enumerate(steps):
        prompt = step.get("prompt", step.get("description", str(step)))
        title = step.get("title", f"Step {i+1}")
        full_prompt = f"[Plan Step {i+1}: {title}]\n\n{prompt}"

        task_id = await execute_returning(
            "INSERT INTO tasks (prompt, status, mode, plan_group_id, priority) VALUES (?, 'queued', 'execute', ?, ?)",
            (full_prompt, group_id, len(steps) - i),  # Higher priority for earlier steps
        )
        task_ids.append(task_id)

    await execute(
        "UPDATE plan_groups SET status='executing' WHERE id=?",
        (group_id,),
    )

    if notify_scheduler:
        notify_scheduler()

    logger.info(f"Plan group {group_id} approved, created {len(task_ids)} subtasks")
    return task_ids


async def check_plan_completion(group_id: int):
    """Check if all subtasks in a plan group are done."""
    tasks = await fetch_all(
        "SELECT status FROM tasks WHERE plan_group_id=? AND mode='execute'",
        (group_id,),
    )
    if not tasks:
        return

    all_done = all(t["status"] in ("completed", "failed", "cancelled") for t in tasks)
    if all_done:
        await execute(
            "UPDATE plan_groups SET status='completed', finished_at=datetime('now') WHERE id=?",
            (group_id,),
        )
        logger.info(f"Plan group {group_id} completed")


async def get_plan_detail(group_id: int) -> Optional[dict]:
    group = await fetch_one("SELECT * FROM plan_groups WHERE id=?", (group_id,))
    if not group:
        return None

    tasks = await fetch_all(
        "SELECT id, prompt, status, result_text, started_at, finished_at FROM tasks WHERE plan_group_id=? ORDER BY id",
        (group_id,),
    )

    plan_steps = []
    try:
        plan_data = json.loads(group.get("plan_text", "{}") or "{}")
        plan_steps = plan_data.get("steps", [])
    except (json.JSONDecodeError, TypeError):
        pass

    return {
        **dict(group),
        "tasks": tasks,
        "plan_steps": plan_steps,
    }
