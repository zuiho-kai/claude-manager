# Claude Code Manager (CCM)

> 灵感来自胡渊鸣的文章《我给10个Claude Code打工》

Web-based manager for parallel Claude Code CLI instances. Mobile-first UI designed for iPhone Safari, manage multiple Claude Code workers from your phone.

![Python](https://img.shields.io/badge/python-3.9+-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-green)

## Features

- **Worker Pool** — N parallel Claude Code processes, auto-dispatch by priority
- **Plan Mode** — describe a goal, Claude generates a multi-step plan, review & approve, auto-execute
- **Git Worktree Isolation** — each task runs in its own worktree, no conflicts
- **Experience Distillation** — completed tasks auto-summarize to `PROGRESS.md`, injected as context into future tasks
- **Voice Input** — Web Speech API on all input fields (Chinese/English)
- **Real-time Logs** — WebSocket streaming of Claude Code's output per task
- **Mobile-first UI** — dark theme, iOS app style, works great on iPhone Safari

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Make sure claude CLI is on PATH
claude --version

# Start server (random port)
python app.py
```

Open the printed URL on your phone or browser.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CCM_MAX_CONCURRENT` | `4` | Number of parallel workers |
| `CCM_POOL_SIZE` | `4` | Number of git worktrees to create |

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Browser UI  │────▶│  FastAPI App  │────▶│   Ralph Loop    │
│  (mobile)    │◀────│  + WebSocket  │◀────│   (scheduler)   │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                          ┌────────────────────────┼────────────────────────┐
                          │                        │                        │
                    ┌─────▼─────┐           ┌─────▼─────┐           ┌─────▼─────┐
                    │  Worker 0  │           │  Worker 1  │           │  Worker N  │
                    │  claude -p │           │  claude -p │           │  claude -p │
                    │  worktree0 │           │  worktree1 │           │  worktreeN │
                    └───────────┘           └───────────┘           └───────────┘
```

1. You type a task (or speak it) in the UI
2. Task goes into SQLite queue
3. Ralph Loop picks it up, assigns an idle worker + worktree
4. Worker spawns `claude -p <prompt> --output-format stream-json`
5. Output streams to browser via WebSocket in real-time
6. On completion, experience is auto-distilled into `PROGRESS.md`

## API

### Tasks
- `POST /api/tasks` — create task `{"prompt": "...", "priority": 0}`
- `GET /api/tasks` — list all (optional `?status=queued|running|completed|failed`)
- `GET /api/tasks/{id}` — detail + logs
- `DELETE /api/tasks/{id}` — cancel

### Plan Mode
- `POST /api/plan` — `{"goal": "..."}` → generates plan
- `GET /api/plan/{group_id}` — view plan + step statuses
- `POST /api/plan/{group_id}/approve` — approve & queue subtasks

### Status
- `GET /api/status` — dashboard stats + worker states
- `GET /api/workers` — worker pool detail

### WebSocket
- `WS /ws/logs/{task_id}` — real-time logs for a task
- `WS /ws/events` — global event stream

## Demo

```bash
# Start the server
python app.py

# In another terminal, run the demo
python demo.py
```

See `demo.py` for a scripted walkthrough of all features.

## Tech Stack

- **Backend**: Python, FastAPI, aiosqlite, uvicorn
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **CLI**: `claude -p` with `--output-format stream-json`
- **DB**: SQLite (WAL mode)

## License

MIT
