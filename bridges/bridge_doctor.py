#!/usr/bin/env python3
"""Local diagnostics for TriChat command adapter bridges."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict


def run_help(command: str, args: list[str]) -> Dict[str, Any]:
    path = shutil.which(command)
    result: Dict[str, Any] = {
        "command": command,
        "path": path,
        "found": bool(path),
    }
    if not path:
        return result
    proc = subprocess.run(
        [command, *args],
        capture_output=True,
        text=True,
        check=False,
    )
    output = (proc.stdout or proc.stderr or "").strip()
    result["help_ok"] = proc.returncode == 0
    result["returncode"] = proc.returncode
    result["excerpt"] = " ".join(output.split())[:220]
    return result


def run_wrapper_self_test(wrapper_path: Path) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "wrapper": str(wrapper_path),
        "exists": wrapper_path.exists(),
    }
    if not wrapper_path.exists():
        return result
    proc = subprocess.run(
        [sys.executable, str(wrapper_path), "--self-test"],
        capture_output=True,
        text=True,
        check=False,
    )
    result["returncode"] = proc.returncode
    result["ok"] = proc.returncode == 0
    stdout = (proc.stdout or "").strip()
    if stdout:
        try:
            result["details"] = json.loads(stdout)
        except json.JSONDecodeError:
            result["stdout_excerpt"] = " ".join(stdout.split())[:220]
    stderr = (proc.stderr or "").strip()
    if stderr:
        result["stderr_excerpt"] = " ".join(stderr.split())[:220]
    return result


def auto_command(wrapper_path: Path) -> str:
    python_bin = os.environ.get("TRICHAT_BRIDGE_PYTHON") or sys.executable or "python3"
    return " ".join([shlex.quote(python_bin), shlex.quote(str(wrapper_path))])


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    bridges_dir = repo_root / "bridges"
    codex_wrapper = bridges_dir / "codex_bridge.py"
    cursor_wrapper = bridges_dir / "cursor_bridge.py"

    codex_bin = (os.environ.get("TRICHAT_CODEX_BIN") or "codex").strip() or "codex"
    cursor_bin = (os.environ.get("TRICHAT_CURSOR_BIN") or "cursor-agent").strip() or "cursor-agent"

    codex_info = run_help(codex_bin, ["exec", "--help"])
    cursor_info = run_help(cursor_bin, ["--help"])
    codex_wrapper_info = run_wrapper_self_test(codex_wrapper)
    cursor_wrapper_info = run_wrapper_self_test(cursor_wrapper)

    recommended = {
        "TRICHAT_CODEX_CMD": os.environ.get("TRICHAT_CODEX_CMD") or auto_command(codex_wrapper),
        "TRICHAT_CURSOR_CMD": os.environ.get("TRICHAT_CURSOR_CMD") or auto_command(cursor_wrapper),
    }

    overall_ok = (
        bool(codex_info.get("found"))
        and bool(cursor_info.get("found"))
        and bool(codex_wrapper_info.get("ok"))
        and bool(cursor_wrapper_info.get("ok"))
    )
    payload = {
        "ok": overall_ok,
        "repo_root": str(repo_root),
        "codex": codex_info,
        "cursor": cursor_info,
        "wrappers": {
            "codex": codex_wrapper_info,
            "cursor": cursor_wrapper_info,
        },
        "recommended_commands": recommended,
        "notes": [
            "TriChat and trichat-tui auto-load these wrappers when TRICHAT_CODEX_CMD/TRICHAT_CURSOR_CMD are unset.",
            "Use TRICHAT_BRIDGE_DRY_RUN=1 to smoke bridge payload parsing without hitting model providers.",
        ],
    }
    print(json.dumps(payload, indent=2))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
