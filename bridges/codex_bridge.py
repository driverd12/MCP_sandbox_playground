#!/usr/bin/env python3
"""TriChat command adapter wrapper for Codex CLI."""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

from common import (
    BridgeError,
    build_prompt,
    compact_single_line,
    emit_content,
    emit_status,
    parse_bool_env,
    parse_int_env,
    read_payload,
    resolve_executable,
    run_command,
    strip_ansi,
    workspace_from_payload,
)


DEFAULT_CODEX_BIN = "codex"
CODEX_FALLBACK_BINS = (
    "/Applications/Codex.app/Contents/Resources/codex",
    "~/.local/bin/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
)


def resolve_codex_binary() -> str:
    requested = (os.environ.get("TRICHAT_CODEX_BIN") or DEFAULT_CODEX_BIN).strip() or DEFAULT_CODEX_BIN
    return resolve_executable(requested, CODEX_FALLBACK_BINS)


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Codex bridge wrapper for TriChat")
    parser.add_argument("--self-test", action="store_true", help="Validate local Codex CLI bridge dependencies.")
    parser.add_argument("--bridge-name", default="codex", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def codex_command_base(workspace: Path, output_file: Path) -> List[str]:
    codex_bin = resolve_codex_binary()
    command: List[str] = [
        codex_bin,
        "exec",
        "--color",
        "never",
        "--output-last-message",
        str(output_file),
        "--cd",
        str(workspace),
        "-",
    ]
    if parse_bool_env("TRICHAT_CODEX_SKIP_GIT_CHECK", True):
        command.insert(2, "--skip-git-repo-check")
    if parse_bool_env("TRICHAT_CODEX_EPHEMERAL", True):
        command.insert(2, "--ephemeral")

    model = (os.environ.get("TRICHAT_CODEX_MODEL") or "").strip()
    if model:
        command[2:2] = ["--model", model]
    profile = (os.environ.get("TRICHAT_CODEX_PROFILE") or "").strip()
    if profile:
        command[2:2] = ["--profile", profile]
    sandbox = (os.environ.get("TRICHAT_CODEX_SANDBOX") or "").strip()
    if sandbox:
        command[2:2] = ["--sandbox", sandbox]
    approval = (os.environ.get("TRICHAT_CODEX_APPROVAL") or "").strip()
    if approval:
        command[2:2] = ["--ask-for-approval", approval]
    if parse_bool_env("TRICHAT_CODEX_FULL_AUTO", False):
        command.insert(2, "--full-auto")
    if parse_bool_env("TRICHAT_CODEX_BYPASS_SANDBOX", False):
        command.insert(2, "--dangerously-bypass-approvals-and-sandbox")

    extra_args = (os.environ.get("TRICHAT_CODEX_EXTRA_ARGS") or "").strip()
    if extra_args:
        command[2:2] = shlex.split(extra_args)
    return command


def run_self_test() -> int:
    requested_bin = (os.environ.get("TRICHAT_CODEX_BIN") or DEFAULT_CODEX_BIN).strip() or DEFAULT_CODEX_BIN
    codex_bin = resolve_codex_binary()
    codex_path = codex_bin if Path(codex_bin).exists() else None
    payload: Dict[str, Any] = {
        "bridge": "codex",
        "binary": requested_bin,
        "resolved_binary": codex_bin,
        "binary_path": codex_path,
        "found": bool(codex_path),
    }
    if codex_path:
        proc = subprocess.run(
            [codex_bin, "exec", "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        payload["help_ok"] = proc.returncode == 0
        payload["help_excerpt"] = compact_single_line(strip_ansi(proc.stdout or proc.stderr), 200)
        emit_status(payload)
        return 0 if proc.returncode == 0 else 1

    emit_status(payload)
    return 1


def run_adapter() -> int:
    payload = read_payload()
    if parse_bool_env("TRICHAT_BRIDGE_DRY_RUN", False):
        prompt = str(payload.get("prompt") or "").strip() or "(empty prompt)"
        emit_content(
            f"[dry-run] codex bridge received prompt: {compact_single_line(prompt, 160)}",
            meta={"adapter": "codex-bridge", "dry_run": True},
        )
        return 0

    workspace = workspace_from_payload(payload)
    if not workspace.exists():
        workspace = Path.cwd()

    prompt = build_prompt(payload, bridge_name="codex")
    timeout_seconds = parse_int_env("TRICHAT_CODEX_TIMEOUT", 180, minimum=10, maximum=7200)
    max_chars = parse_int_env("TRICHAT_BRIDGE_MAX_CHARS", 12000, minimum=500, maximum=200000)

    with tempfile.NamedTemporaryFile(prefix="trichat-codex-", suffix=".txt", delete=False) as handle:
        output_path = Path(handle.name)

    try:
        command = codex_command_base(workspace, output_file=output_path)
        proc = run_command(
            command,
            input_text=prompt,
            cwd=workspace,
            timeout_seconds=timeout_seconds,
        )
        if proc.returncode != 0:
            stderr_tail = compact_single_line(strip_ansi(proc.stderr), 300)
            stdout_tail = compact_single_line(strip_ansi(proc.stdout), 200)
            raise BridgeError(
                f"codex exec failed rc={proc.returncode} stderr={stderr_tail or '(empty)'} stdout={stdout_tail or '(empty)'}"
            )

        content = ""
        if output_path.exists():
            content = output_path.read_text(encoding="utf-8", errors="replace").strip()
        if not content:
            content = strip_ansi(proc.stdout or "").strip()

        emit_content(
            content,
            meta={
                "adapter": "codex-bridge",
                "binary": command[0],
                "workspace": str(workspace),
                "timeout_seconds": timeout_seconds,
            },
            max_chars=max_chars,
        )
        return 0
    finally:
        try:
            output_path.unlink(missing_ok=True)
        except OSError:
            pass


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
        print(f"unexpected codex bridge error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
