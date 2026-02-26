"""FastAPI main application — routes, WebSocket, startup/shutdown."""

from typing import Optional, List, Dict

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from db import init_db, fetch_all, fetch_one, execute, execute_returning
from ralph_loop import RalphLoop
from worktree import init_pool, get_repo_root_sync, list_worktrees, remove_worktree
from plan_mode import create_plan_group, get_plan_detail, approve_plan, on_plan_task_complete, check_plan_completion
from progress import get_progress_entries, record_progress, get_relevant_experience

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# --- WebSocket manager ---

class ConnectionManager:
    def __init__(self):
        self.task_connections: Dict[int, List[WebSocket]] = {}
        self.event_connections: List[WebSocket] = []

    async def connect_task(self, ws: WebSocket, task_id: int):
        await ws.accept()
        self.task_connections.setdefault(task_id, []).append(ws)

    async def connect_events(self, ws: WebSocket):
        await ws.accept()
        self.event_connections.append(ws)

    def disconnect_task(self, ws: WebSocket, task_id: int):
        conns = self.task_connections.get(task_id, [])
        if ws in conns:
            conns.remove(ws)

    def disconnect_events(self, ws: WebSocket):
        if ws in self.event_connections:
            self.event_connections.remove(ws)

    async def broadcast(self, task_id: int, event_type: str, payload: dict):
        msg = json.dumps({"task_id": task_id, "event_type": event_type, "payload": payload}, ensure_ascii=False)

        # Send to task-specific subscribers
        for ws in list(self.task_connections.get(task_id, [])):
            try:
                await ws.send_text(msg)
            except Exception:
                self.task_connections[task_id].remove(ws)

        # Send to global event subscribers
        for ws in list(self.event_connections):
            try:
                await ws.send_text(msg)
            except Exception:
                self.event_connections.remove(ws)


manager = ConnectionManager()
scheduler: Optional[RalphLoop] = None


# --- Lifespan ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    global scheduler
    await init_db()

    # Try to init worktree pool if we're in a git repo
    repo_root = get_repo_root_sync(os.getcwd())
    if repo_root:
        pool_size = int(os.environ.get("CCM_POOL_SIZE", "4"))
        await init_pool(repo_root, pool_size)
        logger.info(f"Worktree pool initialized in {repo_root}")
    else:
        logger.warning("Not in a git repo — worktree pool disabled")

    scheduler = RalphLoop(
        max_concurrent=int(os.environ.get("CCM_MAX_CONCURRENT", "4")),
        broadcast=manager.broadcast,
    )
    scheduler.start()

    yield

    await scheduler.stop()


app = FastAPI(title="Claude Code Manager", lifespan=lifespan)

# --- Pydantic models ---

class TaskCreate(BaseModel):
    prompt: str
    priority: int = 0
    mode: str = "execute"
    cwd: Optional[str] = None

class PlanCreate(BaseModel):
    goal: str

class ProgressCreate(BaseModel):
    task_id: Optional[int] = None
    summary: str
    lessons: str = ""
    tags: str = ""

# --- Task routes ---

@app.post("/api/tasks")
async def create_task(body: TaskCreate):
    # Inject experience context
    experience = await get_relevant_experience(body.prompt)
    prompt = body.prompt
    if experience:
        prompt = f"{experience}\n\n---\n\n{prompt}"

    task_id = await execute_returning(
        "INSERT INTO tasks (prompt, priority, mode, cwd) VALUES (?, ?, ?, ?)",
        (prompt, body.priority, body.mode, body.cwd),
    )
    if scheduler:
        scheduler.notify()
    return {"id": task_id, "status": "queued"}


@app.get("/api/tasks")
async def list_tasks(status: Optional[str] = None):
    if status:
        tasks = await fetch_all(
            "SELECT id, prompt, status, mode, priority, worktree_id, plan_group_id, created_at, started_at, finished_at, cost_usd FROM tasks WHERE status=? ORDER BY id DESC",
            (status,),
        )
    else:
        tasks = await fetch_all(
            "SELECT id, prompt, status, mode, priority, worktree_id, plan_group_id, created_at, started_at, finished_at, cost_usd FROM tasks ORDER BY id DESC"
        )
    # Truncate prompt for list view
    for t in tasks:
        t["prompt_short"] = t["prompt"][:100]
    return tasks


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: int):
    task = await fetch_one("SELECT * FROM tasks WHERE id=?", (task_id,))
    if not task:
        raise HTTPException(404, "Task not found")
    logs = await fetch_all(
        "SELECT id, event_type, payload, ts FROM task_logs WHERE task_id=? ORDER BY id",
        (task_id,),
    )
    return {**dict(task), "logs": logs}


@app.delete("/api/tasks/{task_id}")
async def cancel_task(task_id: int):
    task = await fetch_one("SELECT * FROM tasks WHERE id=?", (task_id,))
    if not task:
        raise HTTPException(404, "Task not found")
    if task["status"] in ("queued", "running"):
        await execute("UPDATE tasks SET status='cancelled' WHERE id=?", (task_id,))
        return {"status": "cancelled"}
    return {"status": task["status"], "message": "Can only cancel queued or running tasks"}


# --- Voice route (placeholder — accepts text for now) ---

@app.post("/api/tasks/voice")
async def voice_task(body: TaskCreate):
    """Accept voice-transcribed text as a task. Frontend handles speech-to-text."""
    return await create_task(body)


# --- Worktree routes ---

@app.get("/api/worktrees")
async def get_worktrees():
    return await list_worktrees()


@app.delete("/api/worktrees/{wt_id}")
async def delete_worktree(wt_id: int):
    await remove_worktree(wt_id)
    return {"status": "removed"}


# --- Plan routes ---

@app.post("/api/plan")
async def create_plan(body: PlanCreate):
    group_id = await create_plan_group(body.goal)
    if scheduler:
        scheduler.notify()
    return {"group_id": group_id, "status": "planning"}


@app.get("/api/plan/{group_id}")
async def get_plan(group_id: int):
    detail = await get_plan_detail(group_id)
    if not detail:
        raise HTTPException(404, "Plan group not found")
    return detail


class PlanUpdate(BaseModel):
    steps: list


@app.post("/api/plan/{group_id}/update")
async def update_plan_route(group_id: int, body: PlanUpdate):
    group = await fetch_one("SELECT * FROM plan_groups WHERE id=?", (group_id,))
    if not group:
        raise HTTPException(404, "Plan group not found")
    if group["status"] != "reviewing":
        raise HTTPException(400, "Can only edit plans in reviewing status")
    # Rebuild plan_text with updated steps
    try:
        plan_data = json.loads(group.get("plan_text", "{}") or "{}")
    except (json.JSONDecodeError, TypeError):
        plan_data = {}
    plan_data["steps"] = body.steps
    await execute(
        "UPDATE plan_groups SET plan_text=? WHERE id=?",
        (json.dumps(plan_data, ensure_ascii=False), group_id),
    )
    return {"status": "updated"}


@app.post("/api/plan/{group_id}/approve")
async def approve_plan_route(group_id: int):
    notify_fn = scheduler.notify if scheduler else None
    task_ids = await approve_plan(group_id, notify_scheduler=notify_fn)
    return {"status": "approved", "subtask_ids": task_ids}


# --- Progress routes ---

@app.get("/api/progress")
async def get_progress():
    return await get_progress_entries()


@app.post("/api/progress")
async def add_progress(body: ProgressCreate):
    await record_progress(body.task_id, body.summary, body.lessons, body.tags)
    return {"status": "ok"}


# --- Dashboard status ---

@app.get("/api/status")
async def get_status():
    tasks = await fetch_all("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
    status_map = {t["status"]: t["count"] for t in tasks}
    worktrees = await list_worktrees()
    wt_busy = sum(1 for w in worktrees if w["status"] == "busy")
    return {
        "tasks": status_map,
        "worktrees_total": len(worktrees),
        "worktrees_busy": wt_busy,
        "max_concurrent": scheduler.max_concurrent if scheduler else 0,
        "workers": scheduler.get_workers() if scheduler else [],
    }


@app.get("/api/workers")
async def get_workers():
    if not scheduler:
        return []
    return scheduler.get_workers()


# --- WebSocket endpoints ---

@app.websocket("/ws/logs/{task_id}")
async def ws_task_logs(ws: WebSocket, task_id: int):
    await manager.connect_task(ws, task_id)
    try:
        # History is loaded via HTTP GET /api/tasks/{id} — WebSocket only streams new events
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_task(ws, task_id)


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    await manager.connect_events(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_events(ws)


# --- Hook: post-task completion ---

original_broadcast = manager.broadcast

async def enhanced_broadcast(task_id: int, event_type: str, payload: dict):
    await original_broadcast(task_id, event_type, payload)

    # Note: plan mode completion is handled in ralph_loop._run_and_release
    # AFTER result_text is saved to DB. Do NOT handle it here — result_text
    # hasn't been written yet when the "result" event streams through.

manager.broadcast = enhanced_broadcast


# --- Static files ---

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def index():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import random
    import uvicorn
    port = random.randint(9000, 9999)
    print(f"\n  → http://localhost:{port}\n")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=True)
