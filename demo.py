"""
CCM Demo — scripted walkthrough of all features.

Usage:
    1. Start the server:  python app.py
    2. Note the port printed (e.g. http://localhost:9123)
    3. Run:  python demo.py [port]   (default: auto-detect from running server)
"""

import sys
import time
import requests

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9123
BASE = f"http://127.0.0.1:{PORT}"

def heading(text):
    print(f"\n{'='*50}")
    print(f"  {text}")
    print(f"{'='*50}")

def step(desc, method, path, **kwargs):
    url = BASE + path
    print(f"\n>> {method} {path}")
    print(f"   {desc}")
    r = getattr(requests, method.lower())(url, **kwargs)
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]
    print(f"   Status: {r.status_code}")
    print(f"   Response: {data}")
    return r

# ── Check server ──
heading("1. Check Server Status")
try:
    r = step("Get dashboard status", "GET", "/api/status")
    workers = r.json().get("workers", [])
    print(f"\n   Workers: {len(workers)}")
    for w in workers:
        print(f"     W{w['id']}: {w['status']}")
except requests.ConnectionError:
    print(f"\n   ERROR: Server not running on port {PORT}")
    print(f"   Start it first:  python app.py")
    print(f"   Then run:  python demo.py <port>")
    sys.exit(1)

# ── Create tasks ──
heading("2. Create Tasks")

step("Create a simple task",
     "POST", "/api/tasks",
     json={"prompt": "List all Python files in the current directory and count them"})

step("Create a high-priority task",
     "POST", "/api/tasks",
     json={"prompt": "Show the current git branch and last 3 commits", "priority": 10})

step("Create a low-priority task",
     "POST", "/api/tasks",
     json={"prompt": "What OS is this running on?"})

# ── List tasks ──
heading("3. List Tasks")

step("List all tasks", "GET", "/api/tasks")
step("List only queued tasks", "GET", "/api/tasks?status=queued")

# ── Worker status ──
heading("4. Worker Status")

time.sleep(2)
step("Check workers (some should be busy now)", "GET", "/api/workers")

# ── Task detail ──
heading("5. Task Detail")

step("Get task #1 detail with logs", "GET", "/api/tasks/1")

# ── Cancel a task ──
heading("6. Cancel a Task")

step("Create a task to cancel",
     "POST", "/api/tasks",
     json={"prompt": "This task will be cancelled before it runs"})

r = requests.get(f"{BASE}/api/tasks")
tasks = r.json()
cancel_id = None
for t in tasks:
    if t["status"] in ("queued",) and "cancelled" in t.get("prompt", ""):
        cancel_id = t["id"]
        break

if cancel_id:
    step(f"Cancel task #{cancel_id}", "DELETE", f"/api/tasks/{cancel_id}")
else:
    print("\n   (No queued task to cancel — workers picked it up already)")

# ── Plan Mode ──
heading("7. Plan Mode")

r = step("Create a plan",
         "POST", "/api/plan",
         json={"goal": "Create a simple Python script that reads a CSV file and outputs statistics"})

group_id = r.json().get("group_id")
if group_id:
    time.sleep(3)
    step(f"View plan #{group_id}", "GET", f"/api/plan/{group_id}")

# ── Experience / Progress ──
heading("8. Experience Notes")

step("Add a manual experience note",
     "POST", "/api/progress",
     json={
         "summary": "Demo: CSV parsing works best with pandas for large files",
         "lessons": "Use pandas.read_csv() with chunksize for memory efficiency",
         "tags": "python,csv,pandas"
     })

step("List all experience notes", "GET", "/api/progress")

# ── Worktrees ──
heading("9. Worktrees")

step("List worktrees", "GET", "/api/worktrees")

# ── Final status ──
heading("10. Final Status")

time.sleep(2)
r = step("Final dashboard status", "GET", "/api/status")

print(f"\n{'='*50}")
print(f"  Demo complete!")
print(f"  Open {BASE} in your browser to see the UI.")
print(f"{'='*50}\n")
