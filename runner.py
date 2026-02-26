"""Claude Code subprocess runner with stream-json parsing."""

from typing import Optional, List

import asyncio
import json
import logging
import subprocess
import threading
from datetime import datetime

from db import execute, execute_returning

logger = logging.getLogger(__name__)

CLAUDE_CMD = "claude"


def build_claude_args(prompt: str, cwd: Optional[str] = None, verbose: bool = True) -> List[str]:
    args = [
        CLAUDE_CMD,
        "-p", prompt,
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
    ]
    if verbose:
        args.append("--verbose")
    return args


def classify_event(data: dict) -> str:
    """Classify a stream-json event into a category."""
    etype = data.get("type", "")
    if etype == "assistant":
        return "assistant"
    if etype == "tool_use":
        return "tool_use"
    if etype == "tool_result":
        return "tool_result"
    if etype == "result":
        return "result"
    if etype == "error":
        return "error"
    # content_block events
    if etype in ("content_block_start", "content_block_delta", "content_block_stop"):
        return "assistant"
    if etype == "message_start":
        return "system"
    if etype == "message_delta":
        return "system"
    if etype == "message_stop":
        return "system"
    return "system"


async def run_claude_task(
    task_id: int,
    prompt: str,
    cwd: Optional[str] = None,
    broadcast=None,
):
    """Run a claude CLI subprocess and stream results.

    Args:
        task_id: DB task id
        prompt: The prompt to send
        cwd: Working directory for the subprocess
        broadcast: async callable(task_id, event_type, payload_dict) for WebSocket push
    """
    args = build_claude_args(prompt, cwd)
    logger.info(f"[Task {task_id}] Starting: {' '.join(args[:6])}...")

    await execute(
        "UPDATE tasks SET status='running', started_at=? WHERE id=?",
        (datetime.utcnow().isoformat(), task_id),
    )

    result_text = ""
    cost_usd = 0.0
    loop = asyncio.get_event_loop()

    try:
        # Use subprocess.Popen in a thread to avoid Windows asyncio issues
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
        )

        # Read stdout lines in a thread, push to an asyncio queue
        queue = asyncio.Queue()

        def _reader():
            try:
                for raw_line in proc.stdout:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if line:
                        loop.call_soon_threadsafe(queue.put_nowait, line)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

        reader_thread = threading.Thread(target=_reader, daemon=True)
        reader_thread.start()

        while True:
            line = await queue.get()
            if line is None:
                break

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                data = {"type": "raw", "text": line}

            event_type = classify_event(data)
            payload_str = json.dumps(data, ensure_ascii=False)

            # Store log
            await execute_returning(
                "INSERT INTO task_logs (task_id, event_type, payload) VALUES (?, ?, ?)",
                (task_id, event_type, payload_str),
            )

            # Broadcast via WebSocket
            if broadcast:
                await broadcast(task_id, event_type, data)

            # Extract result
            if data.get("type") == "result":
                result_text = data.get("result", "")
                cost_usd = data.get("cost_usd", 0) or 0
                usage = data.get("usage", {})
                if not cost_usd and usage:
                    input_tokens = usage.get("input_tokens", 0)
                    output_tokens = usage.get("output_tokens", 0)
                    cost_usd = (input_tokens * 0.015 + output_tokens * 0.075) / 1000

        # Wait for process to finish
        returncode = await loop.run_in_executor(None, proc.wait)

        if returncode == 0:
            status = "completed"
        else:
            status = "failed"
            stderr_text = proc.stderr.read().decode("utf-8", errors="replace").strip()
            if stderr_text and not result_text:
                result_text = f"Process exited with code {returncode}: {stderr_text}"

    except Exception as e:
        logger.exception(f"[Task {task_id}] Error")
        status = "failed"
        result_text = str(e)

    await execute(
        "UPDATE tasks SET status=?, finished_at=?, result_text=?, cost_usd=? WHERE id=?",
        (status, datetime.utcnow().isoformat(), result_text, cost_usd, task_id),
    )

    logger.info(f"[Task {task_id}] Finished with status={status}")
    return status
