#!/usr/bin/env python3
"""
Anamnesis Imprint Inbox Worker

Continuously drains local task files from:
  data/imprint/inbox/pending/*.json

Each task is executed via agent_loop.py and archived into:
  data/imprint/inbox/done/
  data/imprint/inbox/failed/
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

DEFAULT_POLL_INTERVAL = 5
DEFAULT_BATCH_SIZE = 3
MAX_TEXT_PREVIEW = 8000


class InboxWorker:
    def __init__(
        self,
        repo_root: Path,
        poll_interval: int,
        batch_size: int,
        once: bool,
        worker_id: str,
    ) -> None:
        self.repo_root = repo_root.resolve()
        self.poll_interval = max(1, poll_interval)
        self.batch_size = max(1, batch_size)
        self.once = once
        self.worker_id = worker_id

        self.inbox_root = self.repo_root / "data" / "imprint" / "inbox"
        self.pending_dir = self.inbox_root / "pending"
        self.processing_dir = self.inbox_root / "processing"
        self.done_dir = self.inbox_root / "done"
        self.failed_dir = self.inbox_root / "failed"

        self.agent_loop_path = self.repo_root / "agent_loop.py"

    def run(self) -> int:
        if not self.agent_loop_path.exists():
            self._log(f"error: agent loop not found: {self.agent_loop_path}")
            return 2

        self._ensure_dirs()
        self._recover_processing_orphans()

        self._log(
            f"started worker_id={self.worker_id} repo_root={self.repo_root} "
            f"poll_interval={self.poll_interval}s batch_size={self.batch_size} once={self.once}"
        )

        while True:
            processed = self._process_batch()
            if self.once:
                return 0
            if processed == 0:
                time.sleep(self.poll_interval)

    def _ensure_dirs(self) -> None:
        for directory in [
            self.inbox_root,
            self.pending_dir,
            self.processing_dir,
            self.done_dir,
            self.failed_dir,
        ]:
            directory.mkdir(parents=True, exist_ok=True)

    def _recover_processing_orphans(self) -> None:
        orphan_count = 0
        for task_path in sorted(self.processing_dir.glob("*.json")):
            recovered_name = f"recovered-{int(time.time())}-{task_path.name}"
            recovered_path = self.pending_dir / recovered_name
            try:
                task_path.rename(recovered_path)
                orphan_count += 1
            except FileNotFoundError:
                continue
            except OSError as error:
                self._log(f"warn: failed to recover orphan task {task_path}: {error}")
        if orphan_count > 0:
            self._log(f"recovered {orphan_count} orphan task(s) from processing/")

    def _process_batch(self) -> int:
        pending = self._list_pending_tasks()
        if not pending:
            return 0

        processed = 0
        for task_path in pending[: self.batch_size]:
            if self._process_one(task_path):
                processed += 1
        return processed

    def _list_pending_tasks(self) -> List[Path]:
        tasks = [path for path in self.pending_dir.glob("*.json") if path.is_file()]
        tasks.sort(key=lambda path: (path.stat().st_mtime, path.name))
        return tasks

    def _claim_task(self, pending_path: Path) -> Path | None:
        claimed_path = self.processing_dir / pending_path.name
        try:
            pending_path.rename(claimed_path)
            return claimed_path
        except FileNotFoundError:
            return None
        except OSError as error:
            self._log(f"warn: failed to claim task {pending_path}: {error}")
            return None

    def _process_one(self, pending_path: Path) -> bool:
        claimed = self._claim_task(pending_path)
        if not claimed:
            return False

        task_id = claimed.stem
        started_at = utc_now_iso()

        try:
            raw_task = self._read_json_file(claimed)
            task = self._normalize_task(task_id, raw_task)
            command = self._build_agent_command(task)
            timeout_seconds = max(300, task["command_timeout"] * task["max_steps"] + 120)

            proc = subprocess.run(
                command,
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )

            stdout_text = (proc.stdout or "").strip()
            stderr_text = (proc.stderr or "").strip()
            stdout_json: Dict[str, Any] | None = None
            if stdout_text:
                try:
                    parsed = json.loads(stdout_text)
                    if isinstance(parsed, dict):
                        stdout_json = parsed
                except json.JSONDecodeError:
                    stdout_json = None

            task_ok = proc.returncode == 0 and (stdout_json.get("ok", True) if stdout_json else True)
            status = "succeeded" if task_ok else "failed"

            result = {
                "task_id": task_id,
                "status": status,
                "worker_id": self.worker_id,
                "started_at": started_at,
                "finished_at": utc_now_iso(),
                "duration_ms": elapsed_ms(started_at),
                "task": task,
                "command": command,
                "returncode": proc.returncode,
                "stdout_json": stdout_json,
                "stdout_preview": truncate_text(stdout_text, MAX_TEXT_PREVIEW),
                "stderr_preview": truncate_text(stderr_text, MAX_TEXT_PREVIEW),
            }

            self._archive_task(claimed, task_id, result, success=task_ok)
            self._log(f"task={task_id} status={status} returncode={proc.returncode}")
            return True

        except Exception as error:  # noqa: BLE001
            result = {
                "task_id": task_id,
                "status": "failed",
                "worker_id": self.worker_id,
                "started_at": started_at,
                "finished_at": utc_now_iso(),
                "duration_ms": elapsed_ms(started_at),
                "error": f"{type(error).__name__}: {error}",
            }
            self._archive_task(claimed, task_id, result, success=False)
            self._log(f"task={task_id} status=failed error={type(error).__name__}: {error}")
            return True

    def _read_json_file(self, file_path: Path) -> Dict[str, Any]:
        try:
            raw = file_path.read_text(encoding="utf-8")
        except OSError as error:
            raise ValueError(f"failed to read task file {file_path}: {error}") from error
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid task JSON in {file_path}: {error}") from error
        if not isinstance(parsed, dict):
            raise ValueError(f"task payload in {file_path} must be a JSON object")
        return parsed

    def _normalize_task(self, task_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
        objective = str(raw.get("objective", "")).strip()
        if not objective:
            raise ValueError("task objective is required")

        project_dir_raw = raw.get("project_dir")
        if isinstance(project_dir_raw, str) and project_dir_raw.strip():
            requested = Path(project_dir_raw.strip())
            project_dir = requested.resolve() if requested.is_absolute() else (self.repo_root / requested).resolve()
        else:
            project_dir = self.repo_root

        if not project_dir.exists() or not project_dir.is_dir():
            raise ValueError(f"project_dir is not a valid directory: {project_dir}")

        model = str(raw.get("model") or os.environ.get("ANAMNESIS_INBOX_DEFAULT_MODEL") or "llama3.2:3b").strip()
        max_steps = bounded_int(raw.get("max_steps"), fallback=12, min_value=1, max_value=100)
        command_timeout = bounded_int(raw.get("command_timeout"), fallback=120, min_value=10, max_value=3600)

        dry_run = parse_bool(raw.get("dry_run"), fallback=False)
        no_auto_pull_model = parse_bool(raw.get("no_auto_pull_model"), fallback=False)

        imprint_profile_id = str(raw.get("imprint_profile_id") or os.environ.get("ANAMNESIS_IMPRINT_PROFILE_ID") or "default").strip()

        mcp_transport = str(raw.get("mcp_transport") or os.environ.get("ANAMNESIS_INBOX_MCP_TRANSPORT") or "stdio").strip().lower()
        if mcp_transport not in {"stdio", "http"}:
            mcp_transport = "stdio"

        mcp_url = str(raw.get("mcp_url") or os.environ.get("ANAMNESIS_INBOX_MCP_URL") or "http://127.0.0.1:8787/").strip()
        mcp_origin = str(raw.get("mcp_origin") or os.environ.get("ANAMNESIS_INBOX_MCP_ORIGIN") or "http://127.0.0.1").strip()
        mcp_stdio_command = str(raw.get("mcp_stdio_command") or os.environ.get("ANAMNESIS_INBOX_MCP_STDIO_COMMAND") or "node").strip()
        mcp_stdio_args = str(raw.get("mcp_stdio_args") or os.environ.get("ANAMNESIS_INBOX_MCP_STDIO_ARGS") or "dist/server.js").strip()

        return {
            "task_id": task_id,
            "objective": objective,
            "project_dir": str(project_dir),
            "model": model,
            "max_steps": max_steps,
            "command_timeout": command_timeout,
            "dry_run": dry_run,
            "no_auto_pull_model": no_auto_pull_model,
            "imprint_profile_id": imprint_profile_id,
            "mcp_transport": mcp_transport,
            "mcp_url": mcp_url,
            "mcp_origin": mcp_origin,
            "mcp_stdio_command": mcp_stdio_command,
            "mcp_stdio_args": mcp_stdio_args,
            "source": raw.get("source"),
            "metadata": raw.get("metadata"),
        }

    def _build_agent_command(self, task: Dict[str, Any]) -> List[str]:
        command = [
            sys.executable,
            str(self.agent_loop_path),
            "--project-dir",
            task["project_dir"],
            "--objective",
            task["objective"],
            "--model",
            task["model"],
            "--max-steps",
            str(task["max_steps"]),
            "--command-timeout",
            str(task["command_timeout"]),
            "--imprint-profile-id",
            task["imprint_profile_id"],
            "--mcp-transport",
            task["mcp_transport"],
            "--mcp-url",
            task["mcp_url"],
            "--mcp-origin",
            task["mcp_origin"],
            "--mcp-stdio-command",
            task["mcp_stdio_command"],
            "--mcp-stdio-args",
            task["mcp_stdio_args"],
        ]
        if task["dry_run"]:
            command.append("--dry-run")
        if task["no_auto_pull_model"]:
            command.append("--no-auto-pull-model")
        return command

    def _archive_task(self, processing_path: Path, task_id: str, result: Dict[str, Any], success: bool) -> None:
        target_dir = self.done_dir if success else self.failed_dir
        target_dir.mkdir(parents=True, exist_ok=True)

        result_path = target_dir / f"{task_id}.result.json"
        archived_task_path = target_dir / f"{task_id}.task.json"

        write_json_atomic(result_path, result)
        processing_path.rename(archived_task_path)

    @staticmethod
    def _log(message: str) -> None:
        sys.stderr.write(f"[imprint-inbox-worker] {message}\n")
        sys.stderr.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Anamnesis local inbox worker daemon")
    parser.add_argument(
        "--repo-root",
        default=str(Path(__file__).resolve().parent.parent),
        help="Repository root path.",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL,
        help="Idle polling interval in seconds.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="Max tasks to process per loop iteration.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process at most one polling batch and exit.",
    )
    parser.add_argument(
        "--worker-id",
        default=f"{socket.gethostname()}-{os.getpid()}",
        help="Worker id used in result metadata.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def elapsed_ms(started_at_iso: str) -> int:
    try:
        started = datetime.fromisoformat(started_at_iso.replace("Z", "+00:00"))
    except ValueError:
        return 0
    now = datetime.now(timezone.utc)
    delta = now - started
    return int(delta.total_seconds() * 1000)


def bounded_int(value: Any, fallback: int, min_value: int, max_value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(min_value, min(max_value, parsed))


def parse_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return fallback


def truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}... [truncated {len(text) - max_chars} chars]"


def write_json_atomic(path: Path, payload: Dict[str, Any]) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")
    temp_path.replace(path)


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    if not repo_root.exists() or not repo_root.is_dir():
        sys.stderr.write(f"error: invalid --repo-root: {repo_root}\n")
        return 2

    worker = InboxWorker(
        repo_root=repo_root,
        poll_interval=args.poll_interval,
        batch_size=args.batch_size,
        once=args.once,
        worker_id=args.worker_id,
    )
    return worker.run()


if __name__ == "__main__":
    sys.exit(main())
