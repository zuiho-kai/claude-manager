# Claude Code Manager (CCM)

> 灵感来自胡渊鸣的文章[《我给10个Claude Code打工》](https://mp.weixin.qq.com/s/9qPD3gXj3HLmrKC64Q6fbQ)
>
> Inspired by Yuanming Hu's article "I Work for 10 Claude Codes"

Web-based manager for parallel Claude Code CLI instances.
Mobile-first dark UI, manage multiple Claude Code workers from your phone.

用手机管理多个并行 Claude Code 实例的 Web 工具。深色 iOS 风格界面，随时随地派活。

![Python](https://img.shields.io/badge/python-3.9+-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-green)
![License](https://img.shields.io/badge/license-MIT-green)

<!--
截图/GIF 放这里：
Screenshots/GIF go here:

![Demo](docs/demo.gif)
-->

---

## Features / 功能

| Feature | Description |
|---------|-------------|
| **Worker Pool / 工人池** | N parallel Claude Code processes, auto-dispatch by priority / N 个并行 Claude Code 进程，按优先级自动调度 |
| **Plan Mode / 计划模式** | Describe a goal → Claude generates plan → review → auto-execute / 描述目标 → Claude 生成计划 → 审核 → 自动执行 |
| **Worktree Isolation / 工作树隔离** | Each task runs in its own git worktree / 每个任务在独立 worktree 中运行，互不冲突 |
| **Experience / 经验沉淀** | Auto-summarize completed tasks to `PROGRESS.md`, inject into future prompts / 自动总结完成的任务，注入未来提示 |
| **Voice Input / 语音输入** | Web Speech API on all input fields / 所有输入框支持语音识别 |
| **Real-time Logs / 实时日志** | WebSocket streaming of Claude output / WebSocket 实时推送 Claude 输出 |
| **Mobile-first / 移动优先** | iOS dark theme, works on iPhone Safari / iOS 深色主题，iPhone Safari 完美适配 |

---

## Quick Start / 快速开始

```bash
# Install / 安装依赖
pip install -r requirements.txt

# Make sure claude CLI is on PATH / 确保 claude 命令可用
claude --version

# Start server / 启动服务器（随机端口）
python app.py
#  → http://localhost:9xxx
```

Open the URL on your phone or browser. / 在手机或浏览器打开链接。

---

## How It Works / 工作原理

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Browser UI  │────▶│  FastAPI App  │────▶│   Ralph Loop    │
│  手机/浏览器  │◀────│  + WebSocket  │◀────│   调度器         │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                    ┌──────────────────────────────┼──────────────────────────────┐
                    │                              │                              │
              ┌─────▼─────┐                 ┌─────▼─────┐                 ┌─────▼─────┐
              │  Worker 0  │                 │  Worker 1  │                 │  Worker N  │
              │  claude -p │                 │  claude -p │                 │  claude -p │
              │  worktree0 │                 │  worktree1 │                 │  worktreeN │
              └───────────┘                 └───────────┘                 └───────────┘
```

1. Type or speak a task in the UI / 在界面输入或语音说出任务
2. Task queued in SQLite / 任务进入 SQLite 队列
3. Ralph Loop assigns idle worker + worktree / Ralph Loop 分配空闲工人和工作树
4. Worker spawns `claude -p <prompt> --output-format stream-json`
5. Output streams to browser via WebSocket / 输出通过 WebSocket 实时推送到浏览器
6. On completion, experience auto-distilled to `PROGRESS.md` / 完成后自动沉淀经验

---

## UI Overview / 界面概览

```
┌──────────────────────────────────┐
│  Tell Claude what to do...  🎤 ➤ │  ← Quick input / 快速输入
├──────────────────────────────────┤
│  ● connected    Plan  Experience │  ← Status bar / 状态栏
├──────────────────────────────────┤
│  ┌──────┐ ┌──────┐ ┌──────┐     │
│  │ W0   │ │ W1   │ │ W2   │     │  ← Worker cards / 工人卡片
│  │ busy │ │ idle │ │ busy │     │
│  │ #3.. │ │      │ │ #5.. │     │
│  └──────┘ └──────┘ └──────┘     │
├──────────────────────────────────┤
│  2 running  1 queued  5 done    │  ← Stats / 统计
├──────────────────────────────────┤
│  All(8) │ Running │ Queued │Done│  ← Tabs / 标签页
├──────────────────────────────────┤
│  #8  ● running                  │
│  Add error handling to auth...  │  ← Task list / 任务列表
│  plan#2  $0.042  3m             │
│─────────────────────────────────│
│  #7  ● completed                │
│  Fix login page CSS...          │
│  $0.018  12m                    │
└──────────────────────────────────┘
```

---

## Environment Variables / 环境变量

| Variable | Default | Description |
|----------|---------|-------------|
| `CCM_MAX_CONCURRENT` | `4` | Parallel workers / 并行工人数 |
| `CCM_POOL_SIZE` | `4` | Git worktrees / 工作树数量 |

---

## API

### Tasks / 任务

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tasks` | Create task / 创建任务 `{"prompt":"...", "priority":0}` |
| `GET` | `/api/tasks` | List all / 列表 (可选 `?status=queued\|running\|completed\|failed`) |
| `GET` | `/api/tasks/{id}` | Detail + logs / 详情 + 日志 |
| `DELETE` | `/api/tasks/{id}` | Cancel / 取消 |

### Plan Mode / 计划模式

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/plan` | Create plan / 创建计划 `{"goal":"..."}` |
| `GET` | `/api/plan/{gid}` | View plan / 查看计划 |
| `POST` | `/api/plan/{gid}/approve` | Approve & execute / 批准并执行 |

### Status / 状态

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Dashboard / 仪表盘 |
| `GET` | `/api/workers` | Worker states / 工人状态 |

### WebSocket

| Path | Description |
|------|-------------|
| `WS /ws/logs/{task_id}` | Real-time task logs / 任务实时日志 |
| `WS /ws/events` | Global events / 全局事件流 |

---

## Demo

```bash
# Terminal 1: start server / 启动服务器
python app.py

# Terminal 2: run demo / 运行演示
python demo.py <port>
```

`demo.py` walks through all features: create tasks, check workers, plan mode, experience notes.

`demo.py` 演示所有功能：创建任务、查看工人、计划模式、经验笔记。

---

## Tech Stack / 技术栈

- **Backend**: Python, FastAPI, aiosqlite, uvicorn
- **Frontend**: Vanilla HTML/CSS/JS (no build step / 无需构建)
- **CLI**: `claude -p` + `--output-format stream-json`
- **DB**: SQLite (WAL mode)

## License

MIT
