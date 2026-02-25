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


def first_existing(paths: list[Path]) -> Path:
    for path in paths:
        if path.exists():
            return path
    return paths[0]


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


def run_status(command: str, args: list[str]) -> Dict[str, Any]:
    path = shutil.which(command)
    result: Dict[str, Any] = {
        "command": command,
        "path": path,
        "available": bool(path),
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
    result["returncode"] = proc.returncode
    result["output"] = " ".join(output.split())[:220]
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
    imprint_wrapper = first_existing(
        [
            bridges_dir / "local-imprint_bridge.py",
            bridges_dir / "local_imprint_bridge.py",
        ]
    )

    codex_bin = (os.environ.get("TRICHAT_CODEX_BIN") or "codex").strip() or "codex"
    cursor_bin = (os.environ.get("TRICHAT_CURSOR_BIN") or "cursor-agent").strip() or "cursor-agent"

    codex_info = run_help(codex_bin, ["exec", "--help"])
    cursor_info = run_help(cursor_bin, ["--help"])
    ollama_info = run_help("ollama", ["--version"])
    ollama_status = run_status("ollama", ["list"])
    codex_status = run_status(codex_bin, ["login", "status"])
    cursor_status = run_status(cursor_bin, ["status"])
    codex_wrapper_info = run_wrapper_self_test(codex_wrapper)
    cursor_wrapper_info = run_wrapper_self_test(cursor_wrapper)
    imprint_wrapper_info = run_wrapper_self_test(imprint_wrapper)

    codex_auth_output = str(codex_status.get("output") or "").lower()
    cursor_auth_output = str(cursor_status.get("output") or "").lower()
    codex_authenticated = bool(codex_status.get("available")) and "logged in" in codex_auth_output and "not logged" not in codex_auth_output
    cursor_authenticated = bool(cursor_status.get("available")) and "not logged in" not in cursor_auth_output and cursor_status.get("returncode") == 0

    recommended = {
        "TRICHAT_CODEX_CMD": os.environ.get("TRICHAT_CODEX_CMD") or auto_command(codex_wrapper),
        "TRICHAT_CURSOR_CMD": os.environ.get("TRICHAT_CURSOR_CMD") or auto_command(cursor_wrapper),
        "TRICHAT_IMPRINT_CMD": os.environ.get("TRICHAT_IMPRINT_CMD") or auto_command(imprint_wrapper),
    }

    overall_ok = (
        bool(codex_info.get("found"))
        and bool(cursor_info.get("found"))
        and codex_authenticated
        and cursor_authenticated
        and bool(codex_wrapper_info.get("ok"))
        and bool(cursor_wrapper_info.get("ok"))
        and bool(imprint_wrapper_info.get("ok"))
    )
    payload = {
        "ok": overall_ok,
        "repo_root": str(repo_root),
        "codex": codex_info,
        "cursor": cursor_info,
        "ollama": {
            "binary": ollama_info,
            "status": ollama_status,
        },
        "auth": {
            "codex": {
                "authenticated": codex_authenticated,
                "status": codex_status,
            },
            "cursor": {
                "authenticated": cursor_authenticated,
                "status": cursor_status,
            },
        },
        "wrappers": {
            "codex": codex_wrapper_info,
            "cursor": cursor_wrapper_info,
            "local-imprint": imprint_wrapper_info,
        },
        "recommended_commands": recommended,
        "notes": [
            "TriChat and trichat-tui auto-load codex/cursor/local-imprint wrappers when TRICHAT_*_CMD overrides are unset.",
            "Use TRICHAT_BRIDGE_DRY_RUN=1 to smoke bridge payload parsing without hitting model providers.",
            "local-imprint bridge uses deterministic arithmetic evaluation before Ollama fallback for math reliability.",
        ],
    }
    print(json.dumps(payload, indent=2))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
