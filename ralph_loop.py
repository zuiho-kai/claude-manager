"""Ralph Loop scheduler — central dispatcher with worker state tracking."""

from typing import Optional, Dict, List

import asyncio
import logging

from db import fetch_one, fetch_all, execute
from runner import run_claude_task
from worktree import acquire, release
from plan_mode import on_plan_task_complete, check_plan_completion

logger = logging.getLogger(__name__)

DEFAULT_MAX_CONCURRENT = 4


class Worker:
    """Represents a single worker slot."""
    def __init__(self, worker_id: int):
        self.id = worker_id
        self.status = "idle"  # idle / busy
        self.task_id = None
        self.task_prompt = ""
        self.worktree_name = ""
        self.worktree_id = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "task_id": self.task_id,
            "task_prompt": (self.task_prompt[:80] + "...") if len(self.task_prompt) > 80 else self.task_prompt,
            "worktree": self.worktree_name,
        }


class RalphLoop:
    def __init__(self, max_concurrent: int = DEFAULT_MAX_CONCURRENT, broadcast=None):
        self.max_concurrent = max_concurrent
        self.broadcast = broadcast
        self.workers: List[Worker] = [Worker(i) for i in range(max_concurrent)]
        self._running: Dict[int, asyncio.Task] = {}  # worker_id -> asyncio.Task
        self._wake = asyncio.Event()
        self._stop = False
        self._loop_task: Optional[asyncio.Task] = None

    def start(self):
        self._stop = False
        self._loop_task = asyncio.create_task(self._loop())
        logger.info(f"Ralph Loop started ({self.max_concurrent} workers)")

    async def stop(self):
        self._stop = True
        self._wake.set()
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        if self._running:
            await asyncio.gather(*self._running.values(), return_exceptions=True)
        logger.info("Ralph Loop stopped")

    def notify(self):
        self._wake.set()

    def get_workers(self) -> List[dict]:
        return [w.to_dict() for w in self.workers]

    async def _loop(self):
        while not self._stop:
            self._wake.clear()

            # Clean up finished workers
            for wid, atask in list(self._running.items()):
                if atask.done():
                    del self._running[wid]
                    self.workers[wid].status = "idle"
                    self.workers[wid].task_id = None
                    self.workers[wid].task_prompt = ""
                    self.workers[wid].worktree_name = ""
                    self.workers[wid].worktree_id = None

            # Find idle workers and dispatch
            for w in self.workers:
                if w.status == "busy" or w.id in self._running:
                    continue

                task_row = await fetch_one(
                    "SELECT * FROM tasks WHERE status='queued' ORDER BY priority DESC, id ASC LIMIT 1"
                )
                if not task_row:
                    break

                task_id = task_row["id"]

                # Acquire worktree
                wt = await acquire()
                cwd = wt["path"] if wt else task_row.get("cwd")
                wt_id = wt["id"] if wt else None
                wt_name = wt["name"] if wt else ""

                if wt_id:
                    await execute("UPDATE tasks SET worktree_id=? WHERE id=?", (wt_id, task_id))

                await execute("UPDATE tasks SET status='running' WHERE id=?", (task_id,))

                # Update worker state
                w.status = "busy"
                w.task_id = task_id
                w.task_prompt = task_row["prompt"]
                w.worktree_name = wt_name
                w.worktree_id = wt_id

                atask = asyncio.create_task(
                    self._run_and_release(w, task_id, task_row["prompt"], cwd, wt_id)
                )
                self._running[w.id] = atask
                logger.info(f"Worker {w.id}: task {task_id} -> {wt_name or 'no-wt'}")

            # Broadcast worker states
            if self.broadcast:
                await self.broadcast(0, "scheduler", {
                    "type": "scheduler_status",
                    "workers": self.get_workers(),
                })

            try:
                await asyncio.wait_for(self._wake.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

    async def _run_and_release(self, worker: Worker, task_id: int, prompt: str, cwd: Optional[str], worktree_id: Optional[int]):
        try:
            status = await run_claude_task(task_id, prompt, cwd=cwd, broadcast=self.broadcast)

            task = await fetch_one("SELECT * FROM tasks WHERE id=?", (task_id,))
            if task:
                # Handle plan mode: parse plan JSON and transition to "reviewing"
                if task.get("mode") == "plan":
                    try:
                        await on_plan_task_complete(task_id)
                    except Exception:
                        logger.exception(f"Plan completion failed for task {task_id}")

                # Check if all subtasks in a plan group are done
                if task.get("plan_group_id"):
                    try:
                        await check_plan_completion(task["plan_group_id"])
                    except Exception:
                        logger.exception(f"Plan group check failed for task {task_id}")

            # Auto-progress: summarize completed tasks
            if status == "completed":
                try:
                    from progress import auto_summarize_task, save_summary_result
                    summary_info = await auto_summarize_task(task_id)
                    if summary_info:
                        # Simple auto-record without calling Claude again
                        task = await fetch_one("SELECT * FROM tasks WHERE id=?", (task_id,))
                        if task:
                            from progress import record_progress
                            short_prompt = (task["prompt"] or "")[:100]
                            result = (task.get("result_text") or "")[:200]
                            await record_progress(
                                task_id,
                                summary=f"Task #{task_id}: {short_prompt}",
                                lessons=result,
                                tags="auto",
                            )
                except Exception:
                    logger.exception(f"Auto-progress failed for task {task_id}")

        except Exception:
            logger.exception(f"Worker {worker.id}: task {task_id} failed")
            await execute("UPDATE tasks SET status='failed' WHERE id=?", (task_id,))
        finally:
            if worktree_id:
                await release(worktree_id)
            self._wake.set()
