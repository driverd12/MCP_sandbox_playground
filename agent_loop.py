#!/usr/bin/env python3
"""
Imprint Executive Loop

A local autonomous helper that:
1) Scans local development context.
2) Plans next steps with Ollama (Llama-family model).
3) Executes safe actions inside a user-defined project root.

Usage examples:
  python3 agent_loop.py --scan-only
  python3 agent_loop.py --objective "Add a TODO file with release checklist"
  python3 agent_loop.py --project-dir /path/to/project --model llama3.2:3b --objective "Run tests and summarize failures"
  python3 agent_loop.py --objective "Run tests" --imprint-profile-id default
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shlex
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


OLLAMA_API_BASE = "http://127.0.0.1:11434"
DEFAULT_MODEL = "llama3.2:3b"
DEFAULT_MAX_STEPS = 12
DEFAULT_COMMAND_TIMEOUT = 120
MAX_PROMPT_HISTORY_STEPS = 6
MAX_TEXT_PREVIEW = 12000
IMPRINT_BOOTSTRAP_PREVIEW = 6000

ALLOWED_ACTIONS = {
    "list_dir",
    "read_file",
    "write_file",
    "append_file",
    "run_shell",
    "finish",
}

ALLOWED_BASE_COMMANDS = {
    "git",
    "ls",
    "pwd",
    "cat",
    "head",
    "tail",
    "sed",
    "awk",
    "rg",
    "find",
    "mkdir",
    "touch",
    "cp",
    "mv",
    "rm",
    "echo",
    "printf",
    "stat",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "xargs",
    "chmod",
    "chown",
    "npm",
    "pnpm",
    "yarn",
    "npx",
    "node",
    "python",
    "python3",
    "pip",
    "pip3",
    "pytest",
    "uv",
    "make",
    "go",
    "cargo",
    "brew",
    "ollama",
}

BLOCKED_COMMAND_PATTERNS = [
    r"(^|\s)sudo(\s|$)",
    r"(^|\s)shutdown(\s|$)",
    r"(^|\s)reboot(\s|$)",
    r"(^|\s)halt(\s|$)",
    r"(^|\s)poweroff(\s|$)",
    r"(^|\s)mkfs(\.|(\s|$))",
    r"(^|\s)dd\s+if=",
    r"(^|\s)diskutil\s+eraseDisk(\s|$)",
    r"\brm\s+-[^\n]*\brf\b[^\n]*/\s*$",
    r":\(\)\s*\{",
]

SYSTEM_PROMPT = textwrap.dedent(
    """
    You are Imprint, an autonomous local development sub-agent.
    You MUST respond with exactly one JSON object and no extra text.

    Allowed actions:
    - list_dir: {"action":"list_dir","reason":"...","path":"optional/relative/path"}
    - read_file: {"action":"read_file","reason":"...","path":"relative/path"}
    - write_file: {"action":"write_file","reason":"...","path":"relative/path","content":"full file content"}
    - append_file: {"action":"append_file","reason":"...","path":"relative/path","content":"text to append"}
    - run_shell: {"action":"run_shell","reason":"...","command":"single safe shell command"}
    - finish: {"action":"finish","reason":"...","done_message":"final summary"}

    Rules:
    - Keep actions small and deterministic.
    - Never repeat the same action with the same inputs if the previous result already succeeded.
    - Use run_shell only for standard developer commands.
    - If an action fails, inspect the error and choose a corrected next step.
    - Do not ask for confirmation for normal file ops or git commands.
    - When objective is complete, use finish.
    """
).strip()


@dataclass
class AgentAction:
    action: str
    reason: str = ""
    path: Optional[str] = None
    content: Optional[str] = None
    command: Optional[str] = None
    done_message: Optional[str] = None


class ExecutiveLoop:
    def __init__(
        self,
        project_root: Path,
        model: str = DEFAULT_MODEL,
        max_steps: int = DEFAULT_MAX_STEPS,
        command_timeout: int = DEFAULT_COMMAND_TIMEOUT,
        auto_pull_model: bool = True,
        dry_run: bool = False,
        imprint_bootstrap_enabled: bool = True,
        imprint_profile_id: str = "default",
        imprint_max_memories: int = 20,
        imprint_max_transcript_lines: int = 40,
        imprint_max_snapshots: int = 5,
        mcp_transport: str = "stdio",
        mcp_url: str = "http://127.0.0.1:8787/",
        mcp_origin: str = "http://127.0.0.1",
        mcp_stdio_command: str = "node",
        mcp_stdio_args: str = "dist/server.js",
    ) -> None:
        self.project_root = project_root.resolve()
        self.model = model
        self.max_steps = max_steps
        self.command_timeout = command_timeout
        self.auto_pull_model = auto_pull_model
        self.dry_run = dry_run
        self.repo_root = Path(__file__).resolve().parent
        self.imprint_bootstrap_enabled = imprint_bootstrap_enabled
        self.imprint_profile_id = imprint_profile_id.strip() or "default"
        self.imprint_max_memories = max(1, min(200, int(imprint_max_memories)))
        self.imprint_max_transcript_lines = max(1, min(1000, int(imprint_max_transcript_lines)))
        self.imprint_max_snapshots = max(1, min(100, int(imprint_max_snapshots)))
        self.mcp_transport = mcp_transport.strip().lower() or "stdio"
        self.mcp_url = mcp_url
        self.mcp_origin = mcp_origin
        self.mcp_stdio_command = mcp_stdio_command
        self.mcp_stdio_args = mcp_stdio_args

    def scan_environment(self) -> Dict[str, Any]:
        root_entries = []
        for entry in sorted(self.project_root.iterdir(), key=lambda item: item.name.lower()):
            suffix = "/" if entry.is_dir() else ""
            root_entries.append(f"{entry.name}{suffix}")
            if len(root_entries) >= 60:
                break

        sibling_projects = []
        for entry in sorted(self.project_root.parent.iterdir(), key=lambda item: item.name.lower()):
            if entry.is_dir() and (entry / ".git").exists():
                sibling_projects.append(str(entry.name))
            if len(sibling_projects) >= 30:
                break

        git_branch = None
        git_status = self._run_capture("git status --short --branch", cwd=self.project_root)
        if git_status["returncode"] == 0:
            first_line = git_status["stdout"].splitlines()[0] if git_status["stdout"] else ""
            git_branch = first_line.strip()

        return {
            "project_root": str(self.project_root),
            "platform": platform.platform(),
            "shell": os.environ.get("SHELL", ""),
            "homebrew_version": self._first_non_empty_line(
                self._run_capture("brew --version")["stdout"]
            ),
            "python3_path": self._run_capture("which python3")["stdout"].strip(),
            "python3_version": self._first_non_empty_line(
                self._run_capture("python3 --version")["stdout"]
                or self._run_capture("python3 --version")["stderr"]
            ),
            "ollama_version": self._first_non_empty_line(
                self._run_capture("ollama --version")["stdout"]
                or self._run_capture("ollama --version")["stderr"]
            ),
            "git_branch": git_branch,
            "root_entries": root_entries,
            "sibling_git_projects": sibling_projects,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }

    def run(self, objective: str) -> Dict[str, Any]:
        self.ensure_ollama_ready()
        env_context = self.scan_environment()
        imprint_bootstrap = self._load_imprint_bootstrap()
        env_context["imprint_bootstrap"] = imprint_bootstrap

        history: List[Dict[str, Any]] = []
        last_observation: Dict[str, Any] = {
            "ok": True,
            "kind": "bootstrap",
            "message": "Loop initialized with imprint bootstrap context.",
        }
        last_signature = ""
        repeated_signature_count = 0

        for step in range(1, self.max_steps + 1):
            action = self._decide_next_action(
                objective=objective,
                env_context=env_context,
                history=history,
                last_observation=last_observation,
                step=step,
            )

            signature = self._action_signature(action)
            if signature == last_signature and action.action != "finish":
                repeated_signature_count += 1
            else:
                repeated_signature_count = 0
            last_signature = signature

            if repeated_signature_count >= 2:
                observation = {
                    "ok": False,
                    "kind": "stagnation_guard",
                    "error": (
                        "Repeated identical action detected three times in a row. "
                        "Choose a different action or return finish."
                    ),
                    "action_signature": signature,
                }
                step_record = {
                    "step": step,
                    "action": action.action,
                    "reason": action.reason,
                    "observation": observation,
                }
                history.append(step_record)
                last_observation = observation
                self._log(f"step={step} action={action.action} ok=False (stagnation_guard)")
                continue

            step_record: Dict[str, Any] = {
                "step": step,
                "action": action.action,
                "reason": action.reason,
            }

            try:
                observation = self._execute_action(action)
            except Exception as error:  # noqa: BLE001
                observation = {
                    "ok": False,
                    "kind": "exception",
                    "error": f"{type(error).__name__}: {error}",
                }

            step_record["observation"] = observation
            history.append(step_record)
            self._log(f"step={step} action={action.action} ok={observation.get('ok')}")

            if action.action == "finish":
                return {
                    "ok": True,
                    "objective": objective,
                    "project_root": str(self.project_root),
                    "steps_executed": step,
                    "done_message": action.done_message or observation.get("done_message", ""),
                    "imprint_bootstrap": imprint_bootstrap,
                    "history": history,
                }

            last_observation = observation

        return {
            "ok": False,
            "objective": objective,
            "project_root": str(self.project_root),
            "steps_executed": self.max_steps,
            "error": f"Reached max steps ({self.max_steps}) before finish action.",
            "imprint_bootstrap": imprint_bootstrap,
            "history": history,
        }

    def _load_imprint_bootstrap(self) -> Dict[str, Any]:
        if not self.imprint_bootstrap_enabled:
            return {
                "enabled": False,
                "reason": "disabled-by-flag",
            }

        tool_script = self.repo_root / "scripts" / "mcp_tool_call.mjs"
        if not tool_script.exists():
            return {
                "enabled": True,
                "ok": False,
                "error": f"Missing MCP tool helper: {tool_script}",
            }

        args = {
            "profile_id": self.imprint_profile_id,
            "max_memories": self.imprint_max_memories,
            "max_transcript_lines": self.imprint_max_transcript_lines,
            "max_snapshots": self.imprint_max_snapshots,
        }
        command = [
            "node",
            str(tool_script),
            "--tool",
            "imprint.bootstrap",
            "--args",
            json.dumps(args, ensure_ascii=True),
            "--transport",
            self.mcp_transport,
            "--url",
            self.mcp_url,
            "--origin",
            self.mcp_origin,
            "--stdio-command",
            self.mcp_stdio_command,
            "--stdio-args",
            self.mcp_stdio_args,
            "--cwd",
            str(self.repo_root),
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )
        except Exception as error:  # noqa: BLE001
            return {
                "enabled": True,
                "ok": False,
                "error": f"bootstrap-call-exception: {type(error).__name__}: {error}",
            }

        if result.returncode != 0:
            stderr_preview = truncate_text((result.stderr or "").strip(), 1000)
            return {
                "enabled": True,
                "ok": False,
                "error": f"bootstrap-call-failed: {stderr_preview or 'unknown'}",
            }

        try:
            parsed = json.loads(result.stdout)
        except json.JSONDecodeError:
            return {
                "enabled": True,
                "ok": False,
                "error": f"bootstrap-call-invalid-json: {truncate_text(result.stdout.strip(), 800)}",
            }

        if not isinstance(parsed, dict):
            return {
                "enabled": True,
                "ok": False,
                "error": f"bootstrap-call-unexpected-payload: {type(parsed).__name__}",
            }

        bootstrap_text = str(parsed.get("bootstrap_text", ""))
        return {
            "enabled": True,
            "ok": True,
            "profile_id": parsed.get("profile_id"),
            "profile_found": parsed.get("profile_found"),
            "counts": parsed.get("counts"),
            "generated_at": parsed.get("generated_at"),
            "bootstrap_text_preview": truncate_text(bootstrap_text, IMPRINT_BOOTSTRAP_PREVIEW),
        }

    def ensure_ollama_ready(self) -> None:
        if not self._ollama_api_alive():
            self._log("ollama API unavailable, attempting to start service via Homebrew.")
            self._run_capture("brew services start ollama")
            for _ in range(15):
                if self._ollama_api_alive():
                    break
                time.sleep(1)

        if not self._ollama_api_alive():
            raise RuntimeError(
                "Ollama API is not reachable at http://127.0.0.1:11434. "
                "Start it with `brew services start ollama` or `ollama serve`."
            )

        models = self._ollama_models()
        if self.model not in models:
            if not self.auto_pull_model:
                raise RuntimeError(
                    f"Model '{self.model}' is not available. Pull it with `ollama pull {self.model}`."
                )
            self._log(f"model '{self.model}' missing, pulling now.")
            result = subprocess.run(
                ["ollama", "pull", self.model],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"Failed to pull model '{self.model}'. stderr: {truncate_text(result.stderr, 2000)}"
                )

    def _decide_next_action(
        self,
        objective: str,
        env_context: Dict[str, Any],
        history: List[Dict[str, Any]],
        last_observation: Dict[str, Any],
        step: int,
    ) -> AgentAction:
        history_slice = history[-MAX_PROMPT_HISTORY_STEPS:]
        prompt_payload = {
            "objective": objective,
            "project_root": str(self.project_root),
            "step": step,
            "max_steps": self.max_steps,
            "environment": env_context,
            "recent_history": self._compact_history_for_prompt(history_slice),
            "last_observation": last_observation,
            "rules": {
                "do_not_repeat_identical_action": True,
                "return_finish_when_objective_done": True,
            },
        }

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(prompt_payload, ensure_ascii=True),
            },
        ]
        content = self._ollama_chat(messages)
        data = parse_json_object(content)
        return self._normalize_action(data)

    def _normalize_action(self, data: Dict[str, Any]) -> AgentAction:
        action = str(data.get("action", "")).strip()
        if action not in ALLOWED_ACTIONS:
            raise ValueError(f"Invalid action from model: {action!r}")

        normalized = AgentAction(
            action=action,
            reason=str(data.get("reason", "")).strip(),
            path=str(data["path"]).strip() if "path" in data and data["path"] is not None else None,
            content=str(data["content"]) if "content" in data and data["content"] is not None else None,
            command=str(data["command"]).strip()
            if "command" in data and data["command"] is not None
            else None,
            done_message=str(data.get("done_message", "")).strip() if "done_message" in data else None,
        )

        if normalized.action in {"read_file", "write_file", "append_file"} and not normalized.path:
            raise ValueError(f"Action '{normalized.action}' requires a path.")
        if normalized.action in {"write_file", "append_file"} and normalized.content is None:
            raise ValueError(f"Action '{normalized.action}' requires content.")
        if normalized.action == "run_shell" and not normalized.command:
            raise ValueError("Action 'run_shell' requires command.")
        return normalized

    def _execute_action(self, action: AgentAction) -> Dict[str, Any]:
        if action.action == "list_dir":
            raw_path = action.path or "."
            target = self._resolve_project_path(raw_path)
            if not target.exists():
                return {"ok": False, "kind": "list_dir", "error": f"Path does not exist: {target}"}
            if not target.is_dir():
                return {"ok": False, "kind": "list_dir", "error": f"Path is not a directory: {target}"}
            entries = []
            for entry in sorted(target.iterdir(), key=lambda item: item.name.lower()):
                entries.append(f"{entry.name}{'/' if entry.is_dir() else ''}")
                if len(entries) >= 300:
                    break
            return {
                "ok": True,
                "kind": "list_dir",
                "path": str(target),
                "entries": entries,
                "entry_count": len(entries),
            }

        if action.action == "read_file":
            target = self._resolve_project_path(action.path or ".")
            if not target.exists():
                return {"ok": False, "kind": "read_file", "error": f"File does not exist: {target}"}
            if not target.is_file():
                return {"ok": False, "kind": "read_file", "error": f"Path is not a file: {target}"}
            content = target.read_text(encoding="utf-8", errors="replace")
            return {
                "ok": True,
                "kind": "read_file",
                "path": str(target),
                "content": truncate_text(content, MAX_TEXT_PREVIEW),
                "truncated": len(content) > MAX_TEXT_PREVIEW,
                "size_bytes": target.stat().st_size,
            }

        if action.action == "write_file":
            target = self._resolve_project_path(action.path or ".")
            if self.dry_run:
                return {
                    "ok": True,
                    "kind": "write_file",
                    "path": str(target),
                    "dry_run": True,
                    "bytes": len(action.content or ""),
                }
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(action.content or "", encoding="utf-8")
            return {
                "ok": True,
                "kind": "write_file",
                "path": str(target),
                "bytes": len(action.content or ""),
            }

        if action.action == "append_file":
            target = self._resolve_project_path(action.path or ".")
            if self.dry_run:
                return {
                    "ok": True,
                    "kind": "append_file",
                    "path": str(target),
                    "dry_run": True,
                    "bytes": len(action.content or ""),
                }
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("a", encoding="utf-8") as handle:
                handle.write(action.content or "")
            return {
                "ok": True,
                "kind": "append_file",
                "path": str(target),
                "bytes": len(action.content or ""),
            }

        if action.action == "run_shell":
            command = action.command or ""
            safe, reason = verify_command_safety(command)
            if not safe:
                return {
                    "ok": False,
                    "kind": "run_shell",
                    "command": command,
                    "error": f"Blocked by safety policy: {reason}",
                }

            if self.dry_run:
                return {
                    "ok": True,
                    "kind": "run_shell",
                    "command": command,
                    "dry_run": True,
                }

            started = time.time()
            proc = subprocess.run(
                command,
                shell=True,
                cwd=str(self.project_root),
                capture_output=True,
                text=True,
                timeout=self.command_timeout,
                check=False,
            )
            duration_ms = int((time.time() - started) * 1000)
            return {
                "ok": proc.returncode == 0,
                "kind": "run_shell",
                "command": command,
                "returncode": proc.returncode,
                "stdout": truncate_text(proc.stdout, MAX_TEXT_PREVIEW),
                "stderr": truncate_text(proc.stderr, MAX_TEXT_PREVIEW),
                "duration_ms": duration_ms,
            }

        if action.action == "finish":
            return {
                "ok": True,
                "kind": "finish",
                "done_message": action.done_message or "",
            }

        return {"ok": False, "kind": "unknown", "error": f"Unhandled action: {action.action}"}

    def _resolve_project_path(self, user_path: str) -> Path:
        requested = Path(user_path)
        if requested.is_absolute():
            resolved = requested.resolve()
        else:
            resolved = (self.project_root / requested).resolve()
        try:
            resolved.relative_to(self.project_root)
        except ValueError as error:
            raise ValueError(
                f"Path escapes project root: {user_path!r}. project_root={self.project_root}"
            ) from error
        return resolved

    def _action_signature(self, action: AgentAction) -> str:
        return json.dumps(
            {
                "action": action.action,
                "path": action.path or "",
                "command": action.command or "",
                "content_len": len(action.content or ""),
            },
            sort_keys=True,
            ensure_ascii=True,
        )

    def _compact_history_for_prompt(self, history_slice: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        compacted: List[Dict[str, Any]] = []
        for item in history_slice:
            observation = item.get("observation", {})
            if not isinstance(observation, dict):
                observation = {"raw": str(observation)}

            compact_obs: Dict[str, Any] = {}
            for key in [
                "ok",
                "kind",
                "error",
                "path",
                "command",
                "returncode",
                "entry_count",
                "bytes",
                "duration_ms",
                "action_signature",
                "done_message",
            ]:
                if key in observation:
                    compact_obs[key] = observation[key]
            if "stdout" in observation:
                compact_obs["stdout_preview"] = truncate_text(str(observation["stdout"]), 400)
            if "stderr" in observation:
                compact_obs["stderr_preview"] = truncate_text(str(observation["stderr"]), 400)

            compacted.append(
                {
                    "step": item.get("step"),
                    "action": item.get("action"),
                    "reason": item.get("reason", ""),
                    "observation": compact_obs,
                }
            )
        return compacted

    def _ollama_chat(self, messages: List[Dict[str, str]]) -> str:
        payload = {
            "model": self.model,
            "stream": False,
            "messages": messages,
            "options": {"temperature": 0.1},
        }
        data = self._ollama_post_json("/api/chat", payload)
        message = data.get("message", {})
        content = message.get("content", "")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("Empty response content from Ollama chat API.")
        return content.strip()

    def _ollama_models(self) -> List[str]:
        try:
            data = self._ollama_get_json("/api/tags")
        except RuntimeError:
            return []
        models = data.get("models", [])
        names: List[str] = []
        if isinstance(models, list):
            for model in models:
                if isinstance(model, dict) and isinstance(model.get("name"), str):
                    names.append(model["name"])
        return names

    def _ollama_api_alive(self) -> bool:
        try:
            self._ollama_get_json("/api/tags", timeout=5)
            return True
        except RuntimeError:
            return False

    def _ollama_post_json(self, endpoint: str, payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
        url = f"{OLLAMA_API_BASE}{endpoint}"
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url=url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_body = response.read().decode("utf-8", errors="replace")
        except urllib.error.URLError as error:
            raise RuntimeError(f"Ollama request failed ({url}): {error}") from error
        except TimeoutError as error:
            raise RuntimeError(f"Ollama request timed out ({url})") from error

        try:
            parsed = json.loads(response_body)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Ollama returned non-JSON response: {truncate_text(response_body, 400)}") from error
        if not isinstance(parsed, dict):
            raise RuntimeError(f"Ollama returned unexpected payload type: {type(parsed).__name__}")
        return parsed

    def _ollama_get_json(self, endpoint: str, timeout: int = 30) -> Dict[str, Any]:
        url = f"{OLLAMA_API_BASE}{endpoint}"
        request = urllib.request.Request(
            url=url,
            headers={"Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_body = response.read().decode("utf-8", errors="replace")
        except urllib.error.URLError as error:
            raise RuntimeError(f"Ollama request failed ({url}): {error}") from error
        except TimeoutError as error:
            raise RuntimeError(f"Ollama request timed out ({url})") from error

        try:
            parsed = json.loads(response_body)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Ollama returned non-JSON response: {truncate_text(response_body, 400)}") from error
        if not isinstance(parsed, dict):
            raise RuntimeError(f"Ollama returned unexpected payload type: {type(parsed).__name__}")
        return parsed

    def _run_capture(self, command: str, cwd: Optional[Path] = None) -> Dict[str, Any]:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            check=False,
        )
        return {
            "returncode": proc.returncode,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
        }

    @staticmethod
    def _first_non_empty_line(text: str) -> str:
        for line in text.splitlines():
            if line.strip():
                return line.strip()
        return ""

    @staticmethod
    def _log(message: str) -> None:
        sys.stderr.write(f"[imprint] {message}\n")
        sys.stderr.flush()


def verify_command_safety(command: str) -> Tuple[bool, str]:
    normalized = command.strip()
    if not normalized:
        return False, "empty command"
    if "\n" in normalized or "\r" in normalized:
        return False, "multi-line shell commands are blocked"

    for pattern in BLOCKED_COMMAND_PATTERNS:
        if re.search(pattern, normalized):
            return False, f"matched blocked pattern: {pattern}"

    if "&&" in normalized or "||" in normalized or ";" in normalized:
        return False, "command chaining operators are blocked"

    try:
        tokens = shlex.split(normalized)
    except ValueError as error:
        return False, f"failed to parse shell command: {error}"
    if not tokens:
        return False, "no tokens"

    base_command = extract_base_command(tokens)
    if not base_command:
        return False, "could not determine base command"
    if base_command not in ALLOWED_BASE_COMMANDS:
        return False, f"base command '{base_command}' is not allowlisted"

    if base_command == "rm":
        joined = " ".join(tokens[1:])
        if re.search(r"(^|\s)-[^\s]*r[^\s]*(\s|$)", joined) and (
            "/" in joined or ".." in joined or "~" in joined or "*" in joined
        ):
            return False, "recursive rm with broad path is blocked"

    return True, "allowed"


def extract_base_command(tokens: List[str]) -> str:
    for token in tokens:
        if token in {"|", ">", ">>", "<"}:
            continue
        if "=" in token and not token.startswith(("/", "./")):
            left = token.split("=", 1)[0]
            if left and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", left):
                continue
        return Path(token).name
    return ""


def truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}... [truncated {len(text) - max_chars} chars]"


def parse_json_object(text: str) -> Dict[str, Any]:
    raw = text.strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, flags=re.DOTALL)
    if fenced:
        parsed = json.loads(fenced.group(1))
        if isinstance(parsed, dict):
            return parsed

    first = raw.find("{")
    last = raw.rfind("}")
    if first != -1 and last != -1 and last > first:
        snippet = raw[first : last + 1]
        parsed = json.loads(snippet)
        if isinstance(parsed, dict):
            return parsed

    raise ValueError(f"Could not parse JSON object from model output: {truncate_text(raw, 800)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Imprint local executive loop")
    parser.add_argument(
        "--project-dir",
        default=os.getcwd(),
        help="Project root path. All file actions are constrained to this directory.",
    )
    parser.add_argument("--objective", help="Goal for autonomous execution.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Ollama model name.")
    parser.add_argument("--max-steps", type=int, default=DEFAULT_MAX_STEPS, help="Maximum agent loop steps.")
    parser.add_argument(
        "--command-timeout",
        type=int,
        default=DEFAULT_COMMAND_TIMEOUT,
        help="Timeout in seconds for shell commands.",
    )
    parser.add_argument(
        "--no-auto-pull-model",
        action="store_true",
        help="Do not automatically pull the model if missing.",
    )
    parser.add_argument(
        "--no-imprint-bootstrap",
        action="store_true",
        help="Skip loading imprint.bootstrap context before planning.",
    )
    parser.add_argument(
        "--imprint-profile-id",
        default=os.environ.get("ANAMNESIS_IMPRINT_PROFILE_ID", "default"),
        help="Imprint profile id for bootstrap context.",
    )
    parser.add_argument(
        "--imprint-max-memories",
        type=int,
        default=20,
        help="Max distilled memories to include from imprint.bootstrap.",
    )
    parser.add_argument(
        "--imprint-max-transcript-lines",
        type=int,
        default=40,
        help="Max transcript lines to include from imprint.bootstrap.",
    )
    parser.add_argument(
        "--imprint-max-snapshots",
        type=int,
        default=5,
        help="Max imprint snapshots to include from imprint.bootstrap.",
    )
    parser.add_argument(
        "--mcp-transport",
        default=os.environ.get("MCP_TOOL_CALL_TRANSPORT", "stdio"),
        choices=["stdio", "http"],
        help="Transport used for imprint.bootstrap MCP calls.",
    )
    parser.add_argument(
        "--mcp-url",
        default=os.environ.get("MCP_TOOL_CALL_URL", "http://127.0.0.1:8787/"),
        help="HTTP MCP URL for imprint.bootstrap calls when --mcp-transport=http.",
    )
    parser.add_argument(
        "--mcp-origin",
        default=os.environ.get("MCP_TOOL_CALL_ORIGIN", "http://127.0.0.1"),
        help="Origin header for HTTP MCP calls.",
    )
    parser.add_argument(
        "--mcp-stdio-command",
        default=os.environ.get("MCP_TOOL_CALL_STDIO_COMMAND", "node"),
        help="Command for stdio MCP calls used by imprint bootstrap.",
    )
    parser.add_argument(
        "--mcp-stdio-args",
        default=os.environ.get("MCP_TOOL_CALL_STDIO_ARGS", "dist/server.js"),
        help="Args string for stdio MCP calls used by imprint bootstrap.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not mutate files or run shell commands.")
    parser.add_argument("--scan-only", action="store_true", help="Only print environment/project scan and exit.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_root = Path(args.project_dir).resolve()
    if not project_root.exists() or not project_root.is_dir():
        sys.stderr.write(f"error: invalid --project-dir: {project_root}\n")
        return 2

    loop = ExecutiveLoop(
        project_root=project_root,
        model=args.model,
        max_steps=args.max_steps,
        command_timeout=args.command_timeout,
        auto_pull_model=not args.no_auto_pull_model,
        dry_run=args.dry_run,
        imprint_bootstrap_enabled=not args.no_imprint_bootstrap,
        imprint_profile_id=args.imprint_profile_id,
        imprint_max_memories=args.imprint_max_memories,
        imprint_max_transcript_lines=args.imprint_max_transcript_lines,
        imprint_max_snapshots=args.imprint_max_snapshots,
        mcp_transport=args.mcp_transport,
        mcp_url=args.mcp_url,
        mcp_origin=args.mcp_origin,
        mcp_stdio_command=args.mcp_stdio_command,
        mcp_stdio_args=args.mcp_stdio_args,
    )

    if args.scan_only:
        print(json.dumps(loop.scan_environment(), indent=2, ensure_ascii=True))
        return 0

    if not args.objective:
        sys.stderr.write("error: --objective is required unless --scan-only is used\n")
        return 2

    result = loop.run(args.objective)
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
