#!/usr/bin/env python3
"""TriChat command adapter wrapper for Cursor Agent CLI."""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List

from common import (
    BRIDGE_PROTOCOL_VERSION,
    BridgeError,
    build_prompt,
    compact_single_line,
    emit_content,
    emit_pong,
    emit_status,
    is_ping,
    parse_bool_env,
    parse_int_env,
    publish_bus_event,
    read_payload,
    resolve_executable,
    run_command,
    strip_ansi,
    workspace_from_payload,
)

ALLOWED_MODES = {"ask", "plan"}
ALLOWED_SANDBOX = {"enabled", "disabled"}
DEFAULT_CURSOR_BIN = "cursor-agent"
CURSOR_FALLBACK_BINS = (
    "~/.local/bin/cursor-agent",
    "/opt/homebrew/bin/cursor-agent",
    "/usr/local/bin/cursor-agent",
    "~/.local/bin/agent",
)


def resolve_cursor_binary() -> str:
    requested = (os.environ.get("TRICHAT_CURSOR_BIN") or DEFAULT_CURSOR_BIN).strip() or DEFAULT_CURSOR_BIN
    return resolve_executable(requested, CURSOR_FALLBACK_BINS)


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cursor bridge wrapper for TriChat")
    parser.add_argument("--self-test", action="store_true", help="Validate local Cursor Agent bridge dependencies.")
    parser.add_argument("--bridge-name", default="cursor", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def cursor_command_base(workspace: Path, prompt: str) -> List[str]:
    cursor_bin = resolve_cursor_binary()
    command: List[str] = [
        cursor_bin,
        "--print",
        "--output-format",
        "text",
        "--workspace",
        str(workspace),
    ]
    mode = (os.environ.get("TRICHAT_CURSOR_MODE") or "").strip().lower()
    if mode in ALLOWED_MODES:
        command.extend(["--mode", mode])

    sandbox = (os.environ.get("TRICHAT_CURSOR_SANDBOX") or "").strip().lower()
    if sandbox in ALLOWED_SANDBOX:
        command.extend(["--sandbox", sandbox])

    model = (os.environ.get("TRICHAT_CURSOR_MODEL") or "").strip()
    if model:
        command.extend(["--model", model])

    if parse_bool_env("TRICHAT_CURSOR_FORCE", True):
        command.append("--force")
    if parse_bool_env("TRICHAT_CURSOR_APPROVE_MCPS", True):
        command.append("--approve-mcps")

    extra_args = (os.environ.get("TRICHAT_CURSOR_EXTRA_ARGS") or "").strip()
    if extra_args:
        command.extend(shlex.split(extra_args))

    command.append(prompt)
    return command


def run_self_test() -> int:
    requested_bin = (os.environ.get("TRICHAT_CURSOR_BIN") or DEFAULT_CURSOR_BIN).strip() or DEFAULT_CURSOR_BIN
    cursor_bin = resolve_cursor_binary()
    cursor_path = cursor_bin if Path(cursor_bin).exists() else None
    payload: Dict[str, Any] = {
        "bridge": "cursor",
        "binary": requested_bin,
        "resolved_binary": cursor_bin,
        "binary_path": cursor_path,
        "found": bool(cursor_path),
    }
    if cursor_path:
        proc = subprocess.run(
            [cursor_bin, "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        payload["help_ok"] = proc.returncode == 0
        payload["help_excerpt"] = compact_single_line(strip_ansi(proc.stdout or proc.stderr), 220)
        emit_status(payload)
        return 0 if proc.returncode == 0 else 1

    emit_status(payload)
    return 1


def run_adapter() -> int:
    payload = read_payload()
    request_id = str(payload.get("request_id") or "").strip()
    agent_id = str(payload.get("agent_id") or "cursor").strip() or "cursor"
    thread_id = str(payload.get("thread_id") or "").strip()
    bus_enabled = parse_bool_env("TRICHAT_BRIDGE_BUS_EVENTS", True) and bool(thread_id)
    bus_warn = parse_bool_env("TRICHAT_BRIDGE_BUS_WARN", False)

    if is_ping(payload):
        emit_pong(
            request_id=request_id,
            agent_id=agent_id,
            bridge_name="cursor-bridge",
            meta={
                "adapter": "cursor-bridge",
                "binary": resolve_cursor_binary(),
                "protocol_version": BRIDGE_PROTOCOL_VERSION,
            },
        )
        return 0

    def emit_bus(event_type: str, *, content: str = "", metadata: Dict[str, Any] | None = None) -> None:
        if not bus_enabled:
            return
        try:
            publish_bus_event(
                thread_id=thread_id,
                event_type=event_type,
                source_agent="cursor",
                source_client="bridge.cursor",
                role="system",
                content=content,
                metadata=metadata,
            )
        except BridgeError as error:
            if bus_warn:
                print(f"[cursor-bridge] bus publish skipped: {error}", file=sys.stderr)

    if parse_bool_env("TRICHAT_BRIDGE_DRY_RUN", False):
        prompt = str(payload.get("prompt") or "").strip() or "(empty prompt)"
        emit_content(
            f"[dry-run] cursor bridge received prompt: {compact_single_line(prompt, 160)}",
            meta={"adapter": "cursor-bridge", "dry_run": True},
            request_id=request_id,
            agent_id=agent_id,
            bridge_name="cursor-bridge",
        )
        emit_bus(
            "adapter.turn.dry_run",
            content=compact_single_line(prompt, 180),
            metadata={"adapter": "cursor-bridge", "request_id": request_id},
        )
        return 0

    workspace = workspace_from_payload(payload)
    if not workspace.exists():
        workspace = Path.cwd()

    prompt = build_prompt(payload, bridge_name="cursor")
    timeout_seconds = parse_int_env("TRICHAT_CURSOR_TIMEOUT", 180, minimum=10, maximum=7200)
    max_chars = parse_int_env("TRICHAT_BRIDGE_MAX_CHARS", 12000, minimum=500, maximum=200000)

    command = cursor_command_base(workspace, prompt=prompt)
    emit_bus(
        "adapter.turn.started",
        content=f"cursor command start ({command[0]})",
        metadata={
            "adapter": "cursor-bridge",
            "workspace": str(workspace),
            "timeout_seconds": timeout_seconds,
            "request_id": request_id,
        },
    )
    proc = run_command(
        command,
        input_text="",
        cwd=workspace,
        timeout_seconds=timeout_seconds,
    )
    if proc.returncode != 0:
        stderr_tail = compact_single_line(strip_ansi(proc.stderr), 320)
        stdout_tail = compact_single_line(strip_ansi(proc.stdout), 220)
        emit_bus(
            "adapter.turn.failed",
            content=stderr_tail or stdout_tail or f"rc={proc.returncode}",
            metadata={
                "adapter": "cursor-bridge",
                "return_code": proc.returncode,
                "stderr": stderr_tail,
                "stdout": stdout_tail,
                "request_id": request_id,
            },
        )
        raise BridgeError(
            f"cursor-agent failed rc={proc.returncode} stderr={stderr_tail or '(empty)'} stdout={stdout_tail or '(empty)'}"
        )

    content = strip_ansi(proc.stdout or "").strip()
    if not content:
        # Some versions write non-critical notes to stderr. Keep this fallback bounded.
        content = compact_single_line(strip_ansi(proc.stderr), 400)
    emit_content(
        content,
        meta={
            "adapter": "cursor-bridge",
            "binary": command[0],
            "workspace": str(workspace),
            "timeout_seconds": timeout_seconds,
        },
        max_chars=max_chars,
        request_id=request_id,
        agent_id=agent_id,
        bridge_name="cursor-bridge",
    )
    emit_bus(
        "adapter.turn.succeeded",
        content=compact_single_line(content, 220),
        metadata={
            "adapter": "cursor-bridge",
            "workspace": str(workspace),
            "timeout_seconds": timeout_seconds,
            "output_chars": len(content),
            "request_id": request_id,
        },
    )
    return 0


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        return run_self_test()

    try:
        return run_adapter()
    except BridgeError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001
        print(f"unexpected cursor bridge error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
