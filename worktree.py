"""Git worktree pool management."""

from typing import Optional, List, Tuple

import asyncio
import logging
import os
import subprocess

from db import execute, execute_returning, fetch_all, fetch_one

logger = logging.getLogger(__name__)

DEFAULT_POOL_SIZE = 4
BASE_DIR = os.environ.get("CCM_WORKTREE_BASE", "")


def _run_git_sync(args: List[str], cwd: Optional[str] = None) -> Tuple[int, str, str]:
    """Synchronous git call — safe on Windows regardless of event loop."""
    try:
        r = subprocess.run(
            ["git"] + args,
            capture_output=True, text=True, cwd=cwd, timeout=30,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except FileNotFoundError:
        return 1, "", "git not found"
    except subprocess.TimeoutExpired:
        return 1, "", "git timeout"


async def _run_git(args: List[str], cwd: Optional[str] = None) -> Tuple[int, str, str]:
    """Async wrapper — runs git in a thread to avoid blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _run_git_sync, args, cwd)


def get_repo_root_sync(cwd: Optional[str] = None) -> Optional[str]:
    """Synchronous version for use during startup."""
    code, out, _ = _run_git_sync(["rev-parse", "--show-toplevel"], cwd=cwd)
    return out if code == 0 else None


async def get_repo_root(cwd: Optional[str] = None) -> Optional[str]:
    code, out, _ = await _run_git(["rev-parse", "--show-toplevel"], cwd=cwd)
    return out if code == 0 else None


async def init_pool(repo_dir: str, pool_size: int = DEFAULT_POOL_SIZE):
    """Create worktree pool if not already present."""
    global BASE_DIR
    BASE_DIR = repo_dir

    existing = await fetch_all("SELECT * FROM worktrees WHERE status != 'removed'")
    existing_names = {w["name"] for w in existing}

    for i in range(pool_size):
        name = f"wt-{i:02d}"
        if name in existing_names:
            continue

        branch = f"ccm/{name}"
        wt_path = os.path.join(repo_dir, ".worktrees", name)

        # Create branch from HEAD if it doesn't exist
        await _run_git(["branch", branch], cwd=repo_dir)

        # Create worktree
        code, out, err = await _run_git(
            ["worktree", "add", wt_path, branch],
            cwd=repo_dir,
        )

        if code == 0 or "already exists" in err.lower():
            # Ensure path exists even if worktree was already there
            if not os.path.isdir(wt_path):
                os.makedirs(wt_path, exist_ok=True)

            await execute_returning(
                "INSERT OR IGNORE INTO worktrees (name, path, branch, status) VALUES (?, ?, ?, 'idle')",
                (name, wt_path, branch),
            )
            logger.info(f"Worktree {name} ready at {wt_path}")
        else:
            logger.warning(f"Failed to create worktree {name}: {err}")


async def acquire() -> Optional[dict]:
    """Get an idle worktree and mark it busy. Returns worktree dict or None."""
    wt = await fetch_one(
        "SELECT * FROM worktrees WHERE status='idle' ORDER BY id LIMIT 1"
    )
    if wt:
        await execute("UPDATE worktrees SET status='busy' WHERE id=?", (wt["id"],))
        return dict(wt)
    return None


async def release(worktree_id: int):
    """Mark a worktree as idle and reset its state."""
    wt = await fetch_one("SELECT * FROM worktrees WHERE id=?", (worktree_id,))
    if not wt:
        return

    # Reset the worktree to clean state
    wt_path = wt["path"]
    if os.path.isdir(wt_path):
        await _run_git(["checkout", "--", "."], cwd=wt_path)
        await _run_git(["clean", "-fd"], cwd=wt_path)

    await execute("UPDATE worktrees SET status='idle' WHERE id=?", (worktree_id,))
    logger.info(f"Worktree {wt['name']} released")


async def remove_worktree(worktree_id: int):
    """Remove a worktree from disk and DB."""
    wt = await fetch_one("SELECT * FROM worktrees WHERE id=?", (worktree_id,))
    if not wt:
        return

    await _run_git(["worktree", "remove", wt["path"], "--force"], cwd=BASE_DIR)
    await execute("UPDATE worktrees SET status='removed' WHERE id=?", (worktree_id,))
    logger.info(f"Worktree {wt['name']} removed")


async def list_worktrees() -> List[dict]:
    return await fetch_all("SELECT * FROM worktrees WHERE status != 'removed' ORDER BY id")
