#!/usr/bin/env python3
"""Shared helpers for TriChat command adapter bridges."""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Sequence

ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
BRIDGE_PROTOCOL_VERSION = "trichat-bridge-v1"
ADAPTER_RESPONSE_KIND = "trichat.adapter.response"
ADAPTER_PONG_KIND = "trichat.adapter.pong"


class BridgeError(RuntimeError):
    """Raised when a bridge cannot produce a valid response."""


def compact_single_line(text: Any, limit: int = 240) -> str:
    collapsed = " ".join(str(text).split())
    if len(collapsed) <= limit:
        return collapsed
    if limit <= 3:
        return collapsed[:limit]
    return collapsed[: limit - 3] + "..."


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_RE.sub("", text or "")


def parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def parse_int_env(name: str, default: int, minimum: int = 1, maximum: int = 3600) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        return default
    value = max(minimum, value)
    value = min(maximum, value)
    return value


def read_payload() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise BridgeError("missing JSON payload on stdin")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise BridgeError(f"invalid JSON payload: {error}") from error
    if not isinstance(parsed, dict):
        raise BridgeError("payload must be a JSON object")
    return validate_bridge_payload(parsed)


def validate_bridge_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    op = str(payload.get("op") or "ask").strip().lower()
    if op not in {"ask", "ping"}:
        raise BridgeError(f"unsupported bridge operation: {op}")

    protocol_version = str(payload.get("protocol_version") or "").strip()
    if not protocol_version:
        raise BridgeError("missing protocol_version in payload")
    if protocol_version != BRIDGE_PROTOCOL_VERSION:
        raise BridgeError(
            f"unsupported protocol_version: {protocol_version} (expected {BRIDGE_PROTOCOL_VERSION})"
        )

    request_id = str(payload.get("request_id") or "").strip()
    if not request_id:
        raise BridgeError("missing request_id in payload")

    agent_id = str(payload.get("agent_id") or "").strip()
    if not agent_id:
        raise BridgeError("missing agent_id in payload")

    if op == "ask":
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise BridgeError("missing prompt for ask operation")

    payload["op"] = op
    payload["protocol_version"] = protocol_version
    payload["request_id"] = request_id
    payload["agent_id"] = agent_id
    return payload


def is_ping(payload: Dict[str, Any]) -> bool:
    return str(payload.get("op") or "ask").strip().lower() == "ping"


def workspace_from_payload(payload: Dict[str, Any]) -> Path:
    raw = str(payload.get("workspace") or "").strip()
    if not raw:
        return Path.cwd()
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    return path


def _is_executable(path: str) -> bool:
    candidate = Path(path).expanduser()
    return candidate.exists() and os.access(str(candidate), os.X_OK)


def resolve_executable(preferred: str, fallbacks: Sequence[str] | None = None) -> str:
    name = (preferred or "").strip()
    if not name:
        name = "python3"

    # If caller passed a path-like command, use it when executable.
    if "/" in name and _is_executable(name):
        return str(Path(name).expanduser())

    located = shutil.which(name)
    if located:
        return located

    for entry in fallbacks or ():
        candidate = str(Path(entry).expanduser())
        if _is_executable(candidate):
            return candidate

    return name


def build_prompt(payload: Dict[str, Any], *, bridge_name: str, max_history: int = 24) -> str:
    prompt = str(payload.get("prompt") or "").strip()
    history = payload.get("history") if isinstance(payload.get("history"), list) else []
    peer_context = str(payload.get("peer_context") or "").strip()
    bootstrap_text = str(payload.get("bootstrap_text") or "").strip()
    turn_phase = str(payload.get("turn_phase") or "").strip()
    role_hint = str(payload.get("role_hint") or "").strip()
    role_objective = str(payload.get("role_objective") or "").strip()
    collaboration_contract = str(payload.get("collaboration_contract") or "").strip()
    response_mode = str(payload.get("response_mode") or "plain").strip().lower()

    history_lines: List[str] = []
    for entry in history[-max_history:]:
        if not isinstance(entry, dict):
            continue
        agent_id = str(entry.get("agent_id") or "unknown")
        role = str(entry.get("role") or "assistant")
        content = compact_single_line(entry.get("content") or "", 280)
        history_lines.append(f"[{agent_id}/{role}] {content}")
    history_block = "\n".join(history_lines) if history_lines else "(no prior timeline messages)"

    parts: List[str] = [f"TriChat adapter target: {bridge_name}"]
    if turn_phase or role_hint:
        parts.extend(
            [
                "",
                "Coordination context:",
                f"- turn_phase: {turn_phase or 'unknown'}",
                f"- role_hint: {role_hint or 'unspecified'}",
            ]
        )
    if role_objective:
        parts.append(f"- role_objective: {compact_single_line(role_objective, 240)}")
    if collaboration_contract:
        parts.append(f"- collaboration_contract: {compact_single_line(collaboration_contract, 360)}")

    if response_mode == "json":
        parts.extend(
            [
                "",
                "Output contract:",
                "- return one valid JSON object only (no markdown fences)",
                "- preserve required keys exactly as requested",
                "- avoid extra wrapper fields or explanatory prose",
            ]
        )
    else:
        parts.extend(
            [
                "",
                "Output contract:",
                "- reply with direct plain-text answer only",
                "- keep output concise (max 6 lines) unless user asks for detail",
                "- for arithmetic, apply order of operations and verify the final numeric answer",
                "- do not include thread recap, next-action scaffolding, or debug dumps",
            ]
        )

    parts.extend(
        [
            "",
            "User request:",
            prompt or "(empty prompt)",
            "",
            "Recent timeline:",
            history_block,
            "",
            "Peer context:",
            peer_context or "(no peer context)",
        ]
    )
    if bootstrap_text:
        parts.extend(
            [
                "",
                "Bootstrap context:",
                bootstrap_text[:6000],
            ]
        )
    return "\n".join(parts).strip()


def run_command(
    command: Sequence[str],
    *,
    input_text: str,
    cwd: Path,
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(command),
            input=input_text,
            capture_output=True,
            text=True,
            cwd=str(cwd),
            timeout=max(1, timeout_seconds),
            check=False,
        )
    except FileNotFoundError as error:
        raise BridgeError(f"command not found: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise BridgeError(f"command timed out after {timeout_seconds}s: {' '.join(command)}") from error


def emit_content(
    content: str,
    *,
    meta: Dict[str, Any] | None = None,
    max_chars: int = 12000,
    request_id: str,
    agent_id: str,
    bridge_name: str,
) -> None:
    text = (content or "").strip()
    if not text:
        raise BridgeError("adapter produced empty content")
    if len(text) > max_chars:
        text = text[: max_chars - 3] + "..."
    normalized_request_id = str(request_id or "").strip()
    normalized_agent_id = str(agent_id or "").strip()
    normalized_bridge = str(bridge_name or "").strip()
    if not normalized_request_id:
        raise BridgeError("missing request_id while emitting adapter response")
    if not normalized_agent_id:
        raise BridgeError("missing agent_id while emitting adapter response")
    payload: Dict[str, Any] = {
        "kind": ADAPTER_RESPONSE_KIND,
        "protocol_version": BRIDGE_PROTOCOL_VERSION,
        "request_id": normalized_request_id,
        "agent_id": normalized_agent_id,
        "bridge": normalized_bridge or None,
        "content": text,
    }
    if payload.get("bridge") is None:
        payload.pop("bridge", None)
    if meta:
        payload["meta"] = meta
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")


def emit_status(status: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(status, ensure_ascii=True, indent=2) + "\n")


def emit_pong(
    *,
    request_id: str,
    agent_id: str,
    bridge_name: str,
    meta: Dict[str, Any] | None = None,
) -> None:
    payload: Dict[str, Any] = {
        "kind": ADAPTER_PONG_KIND,
        "protocol_version": BRIDGE_PROTOCOL_VERSION,
        "request_id": str(request_id or "").strip(),
        "agent_id": str(agent_id or "").strip(),
        "bridge": str(bridge_name or "").strip() or None,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if payload.get("bridge") is None:
        payload.pop("bridge", None)
    if meta:
        payload["meta"] = meta
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")


def default_bus_socket_path() -> Path:
    raw = (os.environ.get("TRICHAT_BUS_SOCKET_PATH") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return (Path(__file__).resolve().parents[1] / "data" / "trichat.bus.sock").resolve()


def bus_request(command: Dict[str, Any], *, timeout_seconds: float = 1.5) -> Dict[str, Any]:
    socket_path = default_bus_socket_path()
    if not socket_path.exists():
        raise BridgeError(f"trichat bus socket not found: {socket_path}")

    payload = json.dumps(command, ensure_ascii=True) + "\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(max(0.2, float(timeout_seconds)))
        try:
            client.connect(str(socket_path))
            client.sendall(payload.encode("utf-8"))
        except OSError as error:
            raise BridgeError(f"trichat bus connect/send failed: {error}") from error

        data = b""
        while b"\n" not in data:
            try:
                chunk = client.recv(8192)
            except socket.timeout as error:
                raise BridgeError("trichat bus request timed out waiting for response") from error
            if not chunk:
                break
            data += chunk

    line = data.decode("utf-8", errors="replace").splitlines()
    if not line:
        raise BridgeError("trichat bus returned empty response")
    try:
        parsed = json.loads(line[-1])
    except json.JSONDecodeError as error:
        raise BridgeError(f"trichat bus returned invalid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise BridgeError("trichat bus response must be a JSON object")
    if str(parsed.get("kind") or "").strip().lower() == "error":
        raise BridgeError(str(parsed.get("error") or "trichat bus returned error"))
    return parsed


def publish_bus_event(
    *,
    thread_id: str,
    event_type: str,
    source_agent: str,
    source_client: str,
    role: str = "system",
    content: str = "",
    metadata: Dict[str, Any] | None = None,
    timeout_seconds: float = 1.5,
) -> Dict[str, Any] | None:
    if not thread_id.strip():
        return None
    command: Dict[str, Any] = {
        "op": "publish",
        "thread_id": thread_id.strip(),
        "event_type": event_type.strip() or "adapter.event",
        "source_agent": source_agent.strip() or "unknown-agent",
        "source_client": source_client.strip() or "bridge",
        "role": role.strip() or "system",
        "content": content.strip(),
        "metadata": metadata or {},
    }
    return bus_request(command, timeout_seconds=timeout_seconds)
