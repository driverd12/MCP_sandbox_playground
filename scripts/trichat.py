#!/usr/bin/env python3
"""TriChat orchestrator for Anamnesis.

Single-terminal UX:
- one prompt fanout to codex, cursor, and local-imprint adapters
- durable shared timeline via trichat.* MCP tools
- slash-command routing into durable task.* workflows
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shlex
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4


OLLAMA_API_BASE = os.environ.get("TRICHAT_OLLAMA_API_BASE", "http://127.0.0.1:11434")

DEFAULT_CODEX_PROMPT = (
    "You are Codex in tri-chat mode. Respond with concrete, high-signal engineering advice "
    "focused on implementation and reliability tradeoffs."
)
DEFAULT_CURSOR_PROMPT = (
    "You are Cursor in tri-chat mode. Respond with practical implementation guidance, "
    "developer UX suggestions, and concise reasoning."
)
DEFAULT_IMPRINT_PROMPT = (
    "You are the local Imprint agent for Anamnesis. Favor deterministic local-first execution, "
    "idempotent operations, and explicit next actions."
)

EXECUTE_GATE_MODES = {"open", "allowlist", "approval"}


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def truncate(text: str, limit: int = 700) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def compact_single_line(text: str, limit: int = 160) -> str:
    compact = " ".join(text.split())
    return truncate(compact, limit)


def safe_json_parse(raw: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def parse_csv_set(raw: str) -> set[str]:
    values = {
        item.strip().lower()
        for item in str(raw).split(",")
        if item and item.strip()
    }
    return values


class McpToolCaller:
    def __init__(
        self,
        repo_root: Path,
        transport: str,
        url: str,
        origin: str,
        stdio_command: str,
        stdio_args: str,
        retries: int,
        retry_delay_seconds: float,
    ) -> None:
        self.repo_root = repo_root
        self.transport = transport
        self.url = url
        self.origin = origin
        self.stdio_command = stdio_command
        self.stdio_args = stdio_args
        self.retries = max(0, retries)
        self.retry_delay_seconds = max(0.05, retry_delay_seconds)
        self.helper = repo_root / "scripts" / "mcp_tool_call.mjs"
        if not self.helper.exists():
            raise RuntimeError(f"Missing helper: {self.helper}")

    def call_tool(self, tool: str, args: Dict[str, Any]) -> Any:
        command = [
            "node",
            str(self.helper),
            "--tool",
            tool,
            "--args",
            json.dumps(args, ensure_ascii=True),
            "--transport",
            self.transport,
            "--url",
            self.url,
            "--origin",
            self.origin,
            "--stdio-command",
            self.stdio_command,
            "--stdio-args",
            self.stdio_args,
            "--cwd",
            str(self.repo_root),
        ]
        attempts = self.retries + 1
        last_error = "unknown error"
        for attempt in range(1, attempts + 1):
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode == 0:
                stdout = (proc.stdout or "").strip()
                if not stdout:
                    return {}
                return safe_json_parse(stdout)

            stderr = truncate((proc.stderr or "").strip(), 1000)
            last_error = stderr or f"exit={proc.returncode}"
            if attempt < attempts:
                sleep_seconds = self.retry_delay_seconds * attempt
                time.sleep(sleep_seconds)

        raise RuntimeError(f"MCP tool failed ({tool}): {last_error}")


class MutationFactory:
    def __init__(self, seed: Optional[str] = None) -> None:
        self.seed = seed or f"trichat-{int(time.time())}-{uuid4().hex[:8]}"
        self.counter = 0

    def next(self, tool_name: str) -> Dict[str, str]:
        self.counter += 1
        safe_tool = "".join(ch if ch.isalnum() else "-" for ch in tool_name).strip("-").lower()
        key = f"{self.seed}-{safe_tool}-{self.counter}"
        return {
            "idempotency_key": key,
            "side_effect_fingerprint": f"{key}-fingerprint",
        }


class OllamaClient:
    def __init__(self, model: str, timeout_seconds: int = 60) -> None:
        self.model = model
        self.timeout_seconds = timeout_seconds

    def chat(self, messages: List[Dict[str, str]], temperature: float = 0.2) -> str:
        payload = {
            "model": self.model,
            "stream": False,
            "messages": messages,
            "options": {"temperature": temperature},
        }
        raw = self._request("/api/chat", payload)
        message = raw.get("message", {}) if isinstance(raw, dict) else {}
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("Ollama returned empty response content")
        return content.strip()

    def _request(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url=f"{OLLAMA_API_BASE}{endpoint}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                text = resp.read().decode("utf-8", errors="replace")
        except TimeoutError as error:
            raise RuntimeError(f"Ollama timeout on {endpoint}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Ollama request failed on {endpoint}: {error}") from error
        parsed = safe_json_parse(text)
        if not isinstance(parsed, dict):
            raise RuntimeError(f"Ollama returned non-object payload: {type(parsed).__name__}")
        return parsed


@dataclass
class AgentConfig:
    agent_id: str
    system_prompt: str
    model: str
    command: Optional[str] = None


class AgentAdapter:
    def __init__(
        self,
        config: AgentConfig,
        ollama: OllamaClient,
        command_timeout_seconds: int = 45,
    ) -> None:
        self.config = config
        self.ollama = ollama
        self.command_timeout_seconds = command_timeout_seconds

    def respond(
        self,
        prompt: str,
        history: List[Dict[str, Any]],
        bootstrap_text: str,
        peer_context: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        bridge_error: Optional[str] = None
        if self.config.command:
            try:
                content = self._respond_via_command(prompt, history, bootstrap_text, peer_context)
                return content, {"adapter": "command", "command": self.config.command}
            except Exception as error:  # noqa: BLE001
                bridge_error = f"{type(error).__name__}: {error}"

        message_stack = self._build_messages(prompt, history, bootstrap_text, peer_context)
        content = self.ollama.chat(message_stack, temperature=0.2)
        if bridge_error:
            content = f"[bridge-fallback due to: {bridge_error}]\n\n{content}"
        return content, {"adapter": "ollama", "model": self.config.model}

    def _respond_via_command(
        self,
        prompt: str,
        history: List[Dict[str, Any]],
        bootstrap_text: str,
        peer_context: Optional[str],
    ) -> str:
        payload = {
            "agent_id": self.config.agent_id,
            "prompt": prompt,
            "history": history,
            "bootstrap_text": bootstrap_text,
            "peer_context": peer_context or "",
            "timestamp": now_iso(),
        }
        proc = subprocess.run(
            shlex.split(self.config.command),
            input=json.dumps(payload, ensure_ascii=True),
            capture_output=True,
            text=True,
            timeout=self.command_timeout_seconds,
            check=False,
        )
        if proc.returncode != 0:
            stderr = truncate((proc.stderr or "").strip(), 800)
            raise RuntimeError(f"bridge command failed: {stderr or proc.returncode}")
        stdout = (proc.stdout or "").strip()
        if not stdout:
            raise RuntimeError("bridge command returned empty stdout")
        parsed = safe_json_parse(stdout)
        if isinstance(parsed, dict):
            content = parsed.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
        if isinstance(parsed, str):
            return parsed.strip()
        raise RuntimeError("bridge command returned unsupported output")

    def _build_messages(
        self,
        prompt: str,
        history: List[Dict[str, Any]],
        bootstrap_text: str,
        peer_context: Optional[str],
    ) -> List[Dict[str, str]]:
        history_lines = []
        for item in history[-30:]:
            agent_id = item.get("agent_id", "unknown")
            role = item.get("role", "assistant")
            content = compact_single_line(str(item.get("content", "")), 300)
            history_lines.append(f"[{agent_id}/{role}] {content}")
        history_block = "\n".join(history_lines) if history_lines else "(no prior messages)"

        user_parts = [
            "TriChat user request:",
            prompt.strip(),
            "",
            "Recent thread history:",
            history_block,
        ]
        if peer_context:
            user_parts.extend(["", "Peer context:", peer_context.strip()])
        if bootstrap_text:
            user_parts.extend(["", "Imprint bootstrap context:", truncate(bootstrap_text, 3000)])

        return [
            {"role": "system", "content": self.config.system_prompt},
            {"role": "user", "content": "\n".join(user_parts).strip()},
        ]


class TriChatApp:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.repo_root = Path(args.repo_root).resolve()
        self.mcp = McpToolCaller(
            repo_root=self.repo_root,
            transport=args.transport,
            url=args.url,
            origin=args.origin,
            stdio_command=args.stdio_command,
            stdio_args=args.stdio_args,
            retries=args.mcp_retries,
            retry_delay_seconds=args.mcp_retry_delay,
        )
        self.mutation = MutationFactory(seed=args.session_seed)
        self.thread_id = args.thread_id or ""
        self.ollama = OllamaClient(model=args.model, timeout_seconds=args.turn_timeout)
        self.bootstrap_text = self._load_bootstrap()
        self.agents = self._build_agents()
        self.last_user_prompt = ""
        requested_mode = str(args.execute_gate_mode or "open").strip().lower()
        self.execute_gate_mode = requested_mode if requested_mode in EXECUTE_GATE_MODES else "open"
        self.execute_allow_agents = parse_csv_set(args.execute_allow_agents)
        if not self.execute_allow_agents:
            self.execute_allow_agents = {"codex", "cursor", "local-imprint"}
        self.execute_approval_phrase = str(args.execute_approval_phrase or "approve").strip() or "approve"

    def _load_bootstrap(self) -> str:
        if self.args.no_bootstrap:
            return ""
        try:
            response = self.mcp.call_tool(
                "imprint.bootstrap",
                {
                    "profile_id": self.args.profile_id,
                    "max_memories": self.args.max_memories,
                    "max_transcript_lines": self.args.max_transcript_lines,
                    "max_snapshots": self.args.max_snapshots,
                },
            )
        except Exception as error:  # noqa: BLE001
            return f"[bootstrap unavailable: {error}]"

        if isinstance(response, dict):
            bootstrap_text = response.get("bootstrap_text")
            if isinstance(bootstrap_text, str):
                return bootstrap_text
        return ""

    def _build_agents(self) -> Dict[str, AgentAdapter]:
        codex_command = self.args.codex_command or os.environ.get("TRICHAT_CODEX_CMD")
        cursor_command = self.args.cursor_command or os.environ.get("TRICHAT_CURSOR_CMD")
        imprint_command = self.args.imprint_command or os.environ.get("TRICHAT_IMPRINT_CMD")

        configs = [
            AgentConfig(
                agent_id="codex",
                system_prompt=DEFAULT_CODEX_PROMPT,
                model=self.args.model,
                command=codex_command,
            ),
            AgentConfig(
                agent_id="cursor",
                system_prompt=DEFAULT_CURSOR_PROMPT,
                model=self.args.model,
                command=cursor_command,
            ),
            AgentConfig(
                agent_id="local-imprint",
                system_prompt=DEFAULT_IMPRINT_PROMPT,
                model=self.args.model,
                command=imprint_command,
            ),
        ]
        return {
            config.agent_id: AgentAdapter(
                config=config,
                ollama=self.ollama,
                command_timeout_seconds=self.args.bridge_timeout,
            )
            for config in configs
        }

    def initialize_thread(self) -> None:
        if self.thread_id:
            opened = self.mcp.call_tool(
                "trichat.thread_open",
                {
                    "mutation": self.mutation.next("trichat.thread_open"),
                    "thread_id": self.thread_id,
                    "title": self.args.thread_title or f"TriChat {self.thread_id}",
                    "metadata": {
                        "source": "scripts/trichat.py",
                        "created_by": "manual",
                    },
                },
            )
            if isinstance(opened, dict):
                self.thread_id = opened.get("thread", {}).get("thread_id", self.thread_id)
            return

        if self.args.resume_latest:
            listing = self.mcp.call_tool(
                "trichat.thread_list",
                {
                    "status": "active",
                    "limit": 1,
                },
            )
            if isinstance(listing, dict):
                threads = listing.get("threads", [])
                if isinstance(threads, list) and threads:
                    candidate = threads[0]
                    if isinstance(candidate, dict):
                        thread_id = candidate.get("thread_id")
                        if isinstance(thread_id, str) and thread_id:
                            self.thread_id = thread_id
                            self.mcp.call_tool(
                                "trichat.thread_open",
                                {
                                    "mutation": self.mutation.next("trichat.thread_open"),
                                    "thread_id": self.thread_id,
                                    "status": "active",
                                    "metadata": {
                                        "source": "scripts/trichat.py",
                                        "resumed": True,
                                    },
                                },
                            )
                            return

        self.thread_id = f"trichat-{int(time.time())}"
        self.mcp.call_tool(
            "trichat.thread_open",
            {
                "mutation": self.mutation.next("trichat.thread_open"),
                "thread_id": self.thread_id,
                "title": self.args.thread_title or f"TriChat {datetime.now().strftime('%Y-%m-%d %H:%M')}",
                "metadata": {
                    "source": "scripts/trichat.py",
                    "created_by": "manual",
                },
            },
        )

    def run(self) -> None:
        self.validate_tooling()
        self.initialize_thread()
        self._print_header()
        self.render_thread_timeline(limit=12, compact=True)
        if self.args.panel_on_start:
            self.render_reliability_panel()

        while True:
            try:
                raw = input("\ntrichat> ").strip()
            except EOFError:
                print("\nExiting TriChat.")
                return
            except KeyboardInterrupt:
                print("\nExiting TriChat.")
                return

            if not raw:
                continue
            if raw.startswith("/"):
                if not self.handle_command(raw):
                    return
                continue

            self.last_user_prompt = raw
            self.fanout_prompt(raw)
            if self.args.panel_after_turn:
                self.render_reliability_panel()

    def validate_tooling(self) -> None:
        required_tools = [
            "trichat.thread_open",
            "trichat.thread_list",
            "trichat.thread_get",
            "trichat.message_post",
            "trichat.timeline",
            "trichat.retention",
            "task.create",
            "task.summary",
            "task.timeline",
            "task.auto_retry",
        ]
        payload = self.mcp.call_tool("health.tools", {})
        tools = payload.get("tools", []) if isinstance(payload, dict) else []
        tool_set = {str(item) for item in tools}
        missing = [name for name in required_tools if name not in tool_set]
        if missing:
            raise RuntimeError(
                "Server missing required tri-chat tools: "
                + ", ".join(sorted(missing))
            )

    def handle_command(self, raw: str) -> bool:
        try:
            parts = shlex.split(raw)
        except ValueError as error:
            print(f"Invalid command: {error}")
            return True
        if not parts:
            return True
        command = parts[0].lower()
        tail = parts[1:]

        if command in {"/quit", "/exit"}:
            return False
        if command == "/help":
            self.print_help()
            return True
        if command == "/history":
            limit = int(tail[0]) if tail else 40
            self.render_thread_timeline(limit=limit, compact=False)
            return True
        if command == "/panel":
            self.render_reliability_panel()
            return True
        if command == "/plan":
            text = " ".join(tail).strip()
            if not text:
                print("Usage: /plan <request>")
                return True
            self.last_user_prompt = text
            self.fanout_prompt(f"Create a concrete execution plan for:\n{text}")
            return True
        if command == "/propose":
            text = " ".join(tail).strip()
            if not text:
                print("Usage: /propose <request>")
                return True
            self.last_user_prompt = text
            self.fanout_prompt(
                "Propose one practical implementation approach. Include: summary, risks, and first 3 actions.\n"
                + text
            )
            return True
        if command == "/agent":
            if len(tail) < 2:
                print("Usage: /agent <codex|cursor|local-imprint> <message>")
                return True
            agent_id = tail[0]
            prompt = " ".join(tail[1:]).strip()
            self.targeted_prompt(agent_id, prompt)
            return True
        if command == "/huddle":
            topic = " ".join(tail).strip() or self.last_user_prompt
            if not topic:
                print("Usage: /huddle <topic>")
                return True
            self.run_huddle(topic, rounds=1)
            return True
        if command == "/execute":
            if not tail:
                print("Usage: /execute <agent_id> [task objective]")
                return True
            agent_id = tail[0]
            objective_override = " ".join(tail[1:]).strip() if len(tail) > 1 else None
            self.route_execute(agent_id, objective_override)
            if self.args.panel_after_turn:
                self.render_reliability_panel()
            return True
        if command == "/tasks":
            status = tail[0] if tail else None
            self.render_tasks(status)
            return True
        if command == "/timeline":
            if not tail:
                print("Usage: /timeline <task_id>")
                return True
            self.render_task_timeline(tail[0])
            return True
        if command == "/retry":
            action = tail[0] if tail else "status"
            self.route_retry(action)
            return True
        if command == "/retention":
            self.route_retention(tail)
            return True
        if command == "/gate":
            self.route_gate(tail)
            return True
        if command == "/switch":
            action = tail[0] if tail else "status"
            self.route_switch(action)
            return True
        if command == "/thread":
            self.route_thread(tail)
            return True

        print("Unknown command. Use /help.")
        return True

    def fanout_prompt(self, prompt: str) -> None:
        user_message = self.post_message(
            agent_id="user",
            role="user",
            content=prompt,
            metadata={"kind": "user-turn"},
        )
        history = self.get_timeline(limit=60)
        response_order = ["codex", "cursor", "local-imprint"]
        futures: Dict[concurrent.futures.Future[Tuple[str, Dict[str, Any]]], str] = {}

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            for agent_id in response_order:
                adapter = self.agents.get(agent_id)
                if not adapter:
                    continue
                future = executor.submit(
                    adapter.respond,
                    prompt,
                    history,
                    self.bootstrap_text,
                    None,
                )
                futures[future] = agent_id

            results: Dict[str, Dict[str, Any]] = {}
            for future in concurrent.futures.as_completed(futures):
                agent_id = futures[future]
                try:
                    content, adapter_meta = future.result(timeout=self.args.turn_timeout + 5)
                except Exception as error:  # noqa: BLE001
                    content = f"[agent-error] {type(error).__name__}: {error}"
                    adapter_meta = {"adapter": "error"}

                posted = self.post_message(
                    agent_id=agent_id,
                    role="assistant",
                    content=content,
                    reply_to_message_id=user_message.get("message_id"),
                    metadata={
                        "kind": "fanout-response",
                        "adapter": adapter_meta,
                    },
                )
                results[agent_id] = {
                    "content": content,
                    "message_id": posted.get("message_id"),
                }
                self.print_agent_block(agent_id, content)

        if self.args.huddle_rounds > 0:
            self.run_huddle(prompt, rounds=self.args.huddle_rounds, latest_results=results)

    def targeted_prompt(self, agent_id: str, prompt: str) -> None:
        adapter = self.agents.get(agent_id)
        if not adapter:
            print(f"Unknown agent: {agent_id}")
            return
        user_message = self.post_message(
            agent_id="user",
            role="user",
            content=f"[target:{agent_id}] {prompt}",
            metadata={"kind": "targeted-user-turn", "target_agent_id": agent_id},
        )
        history = self.get_timeline(limit=60)
        try:
            content, adapter_meta = adapter.respond(prompt, history, self.bootstrap_text, None)
        except Exception as error:  # noqa: BLE001
            content = f"[agent-error] {type(error).__name__}: {error}"
            adapter_meta = {"adapter": "error"}
        self.post_message(
            agent_id=agent_id,
            role="assistant",
            content=content,
            reply_to_message_id=user_message.get("message_id"),
            metadata={"kind": "targeted-response", "adapter": adapter_meta},
        )
        self.print_agent_block(agent_id, content)

    def run_huddle(
        self,
        topic: str,
        rounds: int = 1,
        latest_results: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> None:
        if rounds <= 0:
            return

        peer_seed: Dict[str, Dict[str, Any]] = latest_results or {}
        for round_index in range(1, rounds + 1):
            timeline = self.get_timeline(limit=90)
            agents_context = self._build_peer_context(timeline)
            for agent_id, adapter in self.agents.items():
                peer_context = agents_context.get(agent_id, "")
                huddle_prompt = (
                    f"Huddle round {round_index} on topic: {topic}\n"
                    "React to peer proposals, identify one risk, and propose one concrete next action."
                )
                try:
                    content, adapter_meta = adapter.respond(
                        huddle_prompt,
                        timeline,
                        self.bootstrap_text,
                        peer_context,
                    )
                except Exception as error:  # noqa: BLE001
                    content = f"[huddle-error] {type(error).__name__}: {error}"
                    adapter_meta = {"adapter": "error"}
                posted = self.post_message(
                    agent_id=agent_id,
                    role="assistant",
                    content=content,
                    metadata={
                        "kind": "huddle",
                        "round": round_index,
                        "adapter": adapter_meta,
                    },
                )
                peer_seed[agent_id] = {
                    "content": content,
                    "message_id": posted.get("message_id"),
                }
                self.print_agent_block(f"{agent_id} (huddle {round_index})", content)

    def route_execute(self, agent_id: str, objective_override: Optional[str]) -> None:
        timeline = self.get_timeline(limit=120)
        proposal = self._latest_agent_message(timeline, agent_id)
        if not proposal:
            print(f"No proposal found for agent '{agent_id}' in this thread.")
            return

        proposal_text = str(proposal.get("content", ""))
        objective = (objective_override or compact_single_line(proposal_text, 220)).strip()
        if not objective:
            print("Cannot derive task objective from empty proposal.")
            return

        approved, decision_reason = self._approve_execute(agent_id, objective)
        if not approved:
            print(f"/execute blocked: {decision_reason}")
            self.post_message(
                agent_id="router",
                role="system",
                content=f"/execute blocked for {agent_id}: {decision_reason}",
                metadata={
                    "kind": "command-route",
                    "command": "/execute",
                    "agent_id": agent_id,
                    "gate_mode": self.execute_gate_mode,
                    "decision": "blocked",
                    "reason": decision_reason,
                },
            )
            return

        payload = {
            "thread_id": self.thread_id,
            "agent_id": agent_id,
            "proposal_message_id": proposal.get("message_id"),
            "proposal_excerpt": truncate(proposal_text, 2000),
            "source": "trichat.execute",
            "execute_gate_mode": self.execute_gate_mode,
            "execute_gate_reason": decision_reason,
        }
        created = self.mcp.call_tool(
            "task.create",
            {
                "mutation": self.mutation.next("task.create"),
                "objective": objective,
                "project_dir": str(self.repo_root),
                "payload": payload,
                "priority": 5,
                "tags": ["trichat", "proposal", agent_id],
                "source": "trichat",
                "source_client": "trichat.py",
                "source_agent": agent_id,
            },
        )
        task = created.get("task", {}) if isinstance(created, dict) else {}
        task_id = task.get("task_id", "<unknown>")
        status = task.get("status", "<unknown>")
        summary = f"Routed /execute from {agent_id}. task_id={task_id} status={status}"
        self.post_message(
            agent_id="router",
            role="system",
            content=summary,
            metadata={
                "kind": "command-route",
                "command": "/execute",
                "task_id": task_id,
                "agent_id": agent_id,
                "gate_mode": self.execute_gate_mode,
                "decision": "allowed",
                "reason": decision_reason,
            },
        )
        print(f"Created task: {task_id} ({status})")

    def _approve_execute(self, agent_id: str, objective: str) -> Tuple[bool, str]:
        mode = self.execute_gate_mode
        normalized_agent = agent_id.strip().lower()
        if mode == "open":
            return True, "mode=open"

        if mode == "allowlist":
            if normalized_agent in self.execute_allow_agents:
                return True, "mode=allowlist agent-allowed"
            allowed_csv = ",".join(sorted(self.execute_allow_agents))
            return (
                False,
                f"mode=allowlist agent '{agent_id}' is not in allowlist ({allowed_csv})",
            )

        if mode == "approval":
            if not sys.stdin.isatty():
                return False, "mode=approval requires interactive tty input"
            phrase = self.execute_approval_phrase
            print("")
            print("Execute Approval Required")
            print("-" * 72)
            print(f"agent:     {agent_id}")
            print(f"objective: {objective}")
            print("")
            print(f"Type '{phrase}' to proceed, or anything else to deny.")
            try:
                entered = input("approval> ").strip()
            except (EOFError, KeyboardInterrupt):
                return False, "mode=approval cancelled by operator"
            if entered != phrase:
                return False, "mode=approval denied by operator"
            return True, "mode=approval approved by operator"

        return False, f"unsupported execute gate mode: {mode}"

    def route_retry(self, action: str) -> None:
        valid_actions = {"status", "start", "stop", "run_once"}
        if action not in valid_actions:
            print("Usage: /retry status|start|stop|run_once")
            return
        args: Dict[str, Any] = {"action": action}
        if action != "status":
            args["mutation"] = self.mutation.next(f"task.auto_retry.{action}")
            if action == "start":
                args["run_immediately"] = True
                args["interval_seconds"] = 30
                args["base_delay_seconds"] = 15
                args["max_delay_seconds"] = 600
        result = self.mcp.call_tool("task.auto_retry", args)
        print(json.dumps(result, indent=2))
        self.post_message(
            agent_id="router",
            role="system",
            content=f"task.auto_retry action={action}",
            metadata={"kind": "command-route", "command": "/retry", "action": action},
        )

    def route_switch(self, action: str) -> None:
        if action not in {"on", "off", "status"}:
            print("Usage: /switch on|off|status")
            return
        cmd = [str(self.repo_root / "scripts" / "agents_switch.sh"), action]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        payload = (proc.stdout or "").strip() or (proc.stderr or "").strip() or "{}"
        parsed = safe_json_parse(payload)
        if isinstance(parsed, (dict, list)):
            print(json.dumps(parsed, indent=2))
        else:
            print(parsed)
        self.post_message(
            agent_id="router",
            role="system",
            content=f"agents_switch action={action} rc={proc.returncode}",
            metadata={"kind": "command-route", "command": "/switch", "action": action, "rc": proc.returncode},
        )

    def route_retention(self, args: List[str]) -> None:
        older_than_days = 7
        apply = False
        thread_id: Optional[str] = self.thread_id
        limit = 1000

        for token in args:
            lowered = token.lower()
            if lowered in {"apply", "--apply"}:
                apply = True
                continue
            if lowered in {"all", "--all"}:
                thread_id = None
                continue
            if lowered.startswith("limit="):
                try:
                    limit = int(lowered.split("=", 1)[1])
                except ValueError:
                    pass
                continue
            try:
                older_than_days = int(token)
            except ValueError:
                pass

        payload = {
            "mutation": self.mutation.next("trichat.retention"),
            "older_than_days": max(0, older_than_days),
            "limit": max(1, min(limit, 5000)),
            "dry_run": not apply,
        }
        if thread_id:
            payload["thread_id"] = thread_id
        result = self.mcp.call_tool("trichat.retention", payload)
        print(json.dumps(result, indent=2))
        self.post_message(
            agent_id="router",
            role="system",
            content=(
                f"trichat.retention older_than_days={payload['older_than_days']} "
                f"thread_id={payload.get('thread_id') or 'all'} dry_run={payload['dry_run']}"
            ),
            metadata={
                "kind": "command-route",
                "command": "/retention",
                "payload": payload,
            },
        )

    def route_gate(self, args: List[str]) -> None:
        if not args or args[0] in {"status", "show"}:
            self._print_gate_status()
            return

        action = args[0].strip().lower()
        if action in EXECUTE_GATE_MODES:
            self.execute_gate_mode = action
            if action == "allowlist" and len(args) > 1:
                updated = parse_csv_set(",".join(args[1:]))
                if updated:
                    self.execute_allow_agents = updated
            print(f"Set /execute gate mode: {self.execute_gate_mode}")
            self._print_gate_status()
            return

        if action == "allowlist":
            if len(args) < 2:
                print("Usage: /gate allowlist <comma-separated-agent-ids>")
                return
            updated = parse_csv_set(",".join(args[1:]))
            if not updated:
                print("Allowlist update ignored: no valid entries.")
                return
            self.execute_allow_agents = updated
            self.execute_gate_mode = "allowlist"
            print("Updated execute allowlist and switched gate mode to allowlist.")
            self._print_gate_status()
            return

        if action == "phrase":
            if len(args) < 2:
                print("Usage: /gate phrase <approval-phrase>")
                return
            phrase = " ".join(args[1:]).strip()
            if not phrase:
                print("Approval phrase cannot be empty.")
                return
            self.execute_approval_phrase = phrase
            print("Updated approval phrase.")
            self._print_gate_status()
            return

        print(
            "Usage: /gate [status|open|allowlist|approval] | "
            "/gate allowlist <csv> | /gate phrase <text>"
        )

    def _print_gate_status(self) -> None:
        allowlist_csv = ",".join(sorted(self.execute_allow_agents))
        print("")
        print("Execute Gate")
        print("-" * 72)
        print(f"mode:            {self.execute_gate_mode}")
        print(f"allowlist:       {allowlist_csv}")
        print(f"approval phrase: {self.execute_approval_phrase}")

    def route_thread(self, args: List[str]) -> None:
        action = args[0] if args else "list"
        if action == "list":
            limit = 20
            if len(args) > 1:
                try:
                    limit = int(args[1])
                except ValueError:
                    limit = 20
            listing = self.mcp.call_tool("trichat.thread_list", {"status": "active", "limit": limit})
            threads = listing.get("threads", []) if isinstance(listing, dict) else []
            print("")
            print(f"Active threads ({len(threads)}):")
            for thread in threads:
                thread_id = thread.get("thread_id", "")
                updated_at = thread.get("updated_at", "")
                title = thread.get("title") or ""
                marker = "*" if thread_id == self.thread_id else " "
                print(f"{marker} {thread_id}  {updated_at}  {truncate(str(title), 60)}")
            return

        if action == "new":
            title = " ".join(args[1:]).strip()
            self.thread_id = f"trichat-{int(time.time())}"
            opened = self.mcp.call_tool(
                "trichat.thread_open",
                {
                    "mutation": self.mutation.next("trichat.thread_open"),
                    "thread_id": self.thread_id,
                    "title": title or f"TriChat {datetime.now().strftime('%Y-%m-%d %H:%M')}",
                    "metadata": {
                        "source": "scripts/trichat.py",
                        "created_by": "thread-command",
                    },
                },
            )
            thread = opened.get("thread", {}) if isinstance(opened, dict) else {}
            print(f"Now using thread: {thread.get('thread_id', self.thread_id)}")
            return

        if action == "use":
            if len(args) < 2:
                print("Usage: /thread use <thread_id>")
                return
            target = args[1]
            found = self.mcp.call_tool("trichat.thread_get", {"thread_id": target})
            if not isinstance(found, dict) or not found.get("found"):
                print(f"Thread not found: {target}")
                return
            self.thread_id = target
            self.mcp.call_tool(
                "trichat.thread_open",
                {
                    "mutation": self.mutation.next("trichat.thread_open"),
                    "thread_id": target,
                    "status": "active",
                    "metadata": {
                        "source": "scripts/trichat.py",
                        "resumed": True,
                    },
                },
            )
            print(f"Now using thread: {target}")
            return

        if action == "archive":
            target = args[1] if len(args) > 1 else self.thread_id
            if not target:
                print("No active thread to archive.")
                return
            self.mcp.call_tool(
                "trichat.thread_open",
                {
                    "mutation": self.mutation.next("trichat.thread_open"),
                    "thread_id": target,
                    "status": "archived",
                    "metadata": {
                        "source": "scripts/trichat.py",
                        "archived_via": "thread-command",
                    },
                },
            )
            print(f"Archived thread: {target}")
            if target == self.thread_id:
                self.thread_id = f"trichat-{int(time.time())}"
                self.mcp.call_tool(
                    "trichat.thread_open",
                    {
                        "mutation": self.mutation.next("trichat.thread_open"),
                        "thread_id": self.thread_id,
                        "title": f"TriChat {datetime.now().strftime('%Y-%m-%d %H:%M')}",
                        "metadata": {
                            "source": "scripts/trichat.py",
                            "created_by": "auto-after-archive",
                        },
                    },
                )
                print(f"Now using new thread: {self.thread_id}")
            return

        print("Usage: /thread list [limit] | /thread new [title] | /thread use <thread_id> | /thread archive [thread_id]")

    def render_tasks(self, status: Optional[str]) -> None:
        args: Dict[str, Any] = {"limit": 30}
        if status:
            args["status"] = status
        result = self.mcp.call_tool("task.list", args)
        tasks = result.get("tasks", []) if isinstance(result, dict) else []
        print("")
        print("Task List")
        print("-" * 72)
        if not tasks:
            print("No tasks.")
            return
        for task in tasks:
            task_id = task.get("task_id", "")
            task_status = task.get("status", "")
            owner = (task.get("lease") or {}).get("owner_id")
            objective = compact_single_line(str(task.get("objective", "")), 72)
            owner_text = f" owner={owner}" if owner else ""
            print(f"{task_id} [{task_status}]{owner_text} :: {objective}")

    def render_task_timeline(self, task_id: str) -> None:
        result = self.mcp.call_tool("task.timeline", {"task_id": task_id, "limit": 100})
        events = result.get("events", []) if isinstance(result, dict) else []
        print("")
        print(f"Task Timeline: {task_id}")
        print("-" * 72)
        if not events:
            print("No events.")
            return
        for event in events:
            ts = str(event.get("created_at", ""))[11:19]
            event_type = event.get("event_type", "")
            from_status = event.get("from_status")
            to_status = event.get("to_status")
            summary = compact_single_line(str(event.get("summary", "")), 90)
            print(f"{ts} {event_type} {from_status}->{to_status} :: {summary}")

    def render_reliability_panel(self) -> None:
        try:
            summary = self.mcp.call_tool("task.summary", {"running_limit": 10})
            auto_retry = self.mcp.call_tool("task.auto_retry", {"action": "status"})
            auto_squish = self.mcp.call_tool("transcript.auto_squish", {"action": "status"})
        except Exception as error:  # noqa: BLE001
            print(f"\nReliability panel unavailable: {error}")
            return

        counts = summary.get("counts", {}) if isinstance(summary, dict) else {}
        running = summary.get("running", []) if isinstance(summary, dict) else []
        last_failed = summary.get("last_failed") if isinstance(summary, dict) else None

        print("")
        print("Reliability Panel")
        print("=" * 72)
        print(
            "Tasks  "
            f"pending={counts.get('pending', 0)}  "
            f"running={counts.get('running', 0)}  "
            f"failed={counts.get('failed', 0)}  "
            f"completed={counts.get('completed', 0)}"
        )
        print(
            "Daemons  "
            f"task.auto_retry={'on' if auto_retry.get('running') else 'off'}  "
            f"transcript.auto_squish={'on' if auto_squish.get('running') else 'off'}"
        )
        if last_failed:
            print(
                "Last failure  "
                f"task_id={last_failed.get('task_id')}  "
                f"attempt={last_failed.get('attempt_count')}/{last_failed.get('max_attempts')}  "
                f"error={truncate(str(last_failed.get('last_error') or ''), 90)}"
            )
        else:
            print("Last failure  none")

        print("-" * 72)
        if not running:
            print("No running leases.")
            return
        print("Active leases:")
        for row in running:
            task_id = row.get("task_id", "")
            owner = row.get("owner_id") or "none"
            expiry = row.get("lease_expires_at") or "n/a"
            objective = compact_single_line(str(row.get("objective", "")), 64)
            print(f"- {task_id} owner={owner} lease_expires_at={expiry} :: {objective}")

    def render_thread_timeline(self, limit: int = 30, compact: bool = False) -> None:
        timeline = self.get_timeline(limit=limit)
        print("")
        print(f"Thread Timeline: {self.thread_id} (showing {len(timeline)} messages)")
        print("-" * 72)
        if not timeline:
            print("No messages yet.")
            return
        for message in timeline:
            ts = str(message.get("created_at", ""))[11:19]
            agent_id = message.get("agent_id", "")
            role = message.get("role", "")
            content = str(message.get("content", ""))
            if compact:
                content = compact_single_line(content, 120)
                print(f"{ts} [{agent_id}/{role}] {content}")
            else:
                print(f"{ts} [{agent_id}/{role}]")
                wrapped = textwrap.indent(textwrap.fill(content, width=100), "  ")
                print(wrapped)

    def get_timeline(self, limit: int = 60) -> List[Dict[str, Any]]:
        response = self.mcp.call_tool(
            "trichat.timeline",
            {
                "thread_id": self.thread_id,
                "limit": max(1, min(limit, 2000)),
            },
        )
        if isinstance(response, dict):
            messages = response.get("messages")
            if isinstance(messages, list):
                return [item for item in messages if isinstance(item, dict)]
        return []

    def post_message(
        self,
        agent_id: str,
        role: str,
        content: str,
        reply_to_message_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "mutation": self.mutation.next("trichat.message_post"),
            "thread_id": self.thread_id,
            "agent_id": agent_id,
            "role": role,
            "content": content,
            "metadata": metadata or {},
        }
        if reply_to_message_id:
            payload["reply_to_message_id"] = reply_to_message_id
        response = self.mcp.call_tool("trichat.message_post", payload)
        if isinstance(response, dict):
            message = response.get("message")
            if isinstance(message, dict):
                return message
        return {}

    def _latest_agent_message(self, timeline: List[Dict[str, Any]], agent_id: str) -> Optional[Dict[str, Any]]:
        for message in reversed(timeline):
            if message.get("agent_id") == agent_id and message.get("role") == "assistant":
                return message
        return None

    def _build_peer_context(self, timeline: List[Dict[str, Any]]) -> Dict[str, str]:
        latest_by_agent: Dict[str, str] = {}
        for message in timeline:
            agent_id = str(message.get("agent_id") or "")
            if agent_id not in self.agents:
                continue
            if message.get("role") != "assistant":
                continue
            latest_by_agent[agent_id] = str(message.get("content") or "")

        contexts: Dict[str, str] = {}
        for target_agent in self.agents:
            lines: List[str] = []
            for peer_id, content in latest_by_agent.items():
                if peer_id == target_agent:
                    continue
                lines.append(f"{peer_id}: {truncate(content, 800)}")
            contexts[target_agent] = "\n\n".join(lines) if lines else "(no peer responses yet)"
        return contexts

    def _print_header(self) -> None:
        print("")
        print("=" * 72)
        print("Anamnesis TriChat")
        print("=" * 72)
        print(f"Thread: {self.thread_id}")
        print(f"Repo:   {self.repo_root}")
        print(
            "Agents: codex, cursor, local-imprint "
            "(set TRICHAT_CODEX_CMD / TRICHAT_CURSOR_CMD for bridge adapters)"
        )
        print(
            "Execute gate: "
            f"{self.execute_gate_mode} "
            f"(allowlist={','.join(sorted(self.execute_allow_agents))})"
        )
        print("Type a prompt to fan out, or /help for commands.")

    def print_agent_block(self, agent_id: str, content: str) -> None:
        print("")
        print(f"[{agent_id}]")
        print("-" * 72)
        print(content.strip())
        print("-" * 72)

    @staticmethod
    def print_help() -> None:
        print("")
        print("Commands")
        print("-" * 72)
        print("/help                              Show this help")
        print("/history [limit]                   Show thread timeline")
        print("/panel                             Show reliability panel")
        print("/plan <request>                    Fanout with planning framing")
        print("/propose <request>                 Fanout with proposal framing")
        print("/agent <id> <message>              Target a single agent")
        print("/huddle <topic>                    Run one inter-agent discussion round")
        print("/execute <agent> [objective]       Route agent proposal into task.create")
        print("/tasks [status]                    List tasks")
        print("/timeline <task_id>                Show task.timeline")
        print("/retry status|start|stop|run_once  Control task.auto_retry")
        print("/gate ...                          Control /execute policy gate")
        print("/retention [days] [apply] [all]     Tri-chat message retention")
        print("/switch on|off|status              Control launchd agent switch")
        print("/thread ...                        Manage tri-chat threads")
        print("/quit                              Exit")


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tri-agent terminal orchestrator for Anamnesis.")
    parser.add_argument(
        "--repo-root",
        default=Path(__file__).resolve().parents[1],
        help="Repository root path.",
    )
    parser.add_argument("--thread-id", default="", help="Existing thread id to continue.")
    parser.add_argument("--thread-title", default="", help="Thread title when creating a new thread.")
    parser.add_argument("--resume-latest", action="store_true", help="Resume most recent active thread.")
    parser.add_argument(
        "--model",
        default=os.environ.get("TRICHAT_OLLAMA_MODEL", "llama3.2:3b"),
        help="Default Ollama model for local agent responses.",
    )
    parser.add_argument(
        "--codex-command",
        default="",
        help="Optional command adapter for codex (reads JSON from stdin, prints content).",
    )
    parser.add_argument(
        "--cursor-command",
        default="",
        help="Optional command adapter for cursor (reads JSON from stdin, prints content).",
    )
    parser.add_argument(
        "--imprint-command",
        default="",
        help="Optional command adapter for local-imprint (reads JSON from stdin, prints content).",
    )
    parser.add_argument(
        "--transport",
        default=os.environ.get("TRICHAT_MCP_TRANSPORT", "stdio"),
        choices=["stdio", "http"],
        help="MCP transport used by scripts/mcp_tool_call.mjs.",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("TRICHAT_MCP_URL", "http://127.0.0.1:8787/"),
        help="HTTP MCP URL when --transport=http.",
    )
    parser.add_argument(
        "--origin",
        default=os.environ.get("TRICHAT_MCP_ORIGIN", "http://127.0.0.1"),
        help="Origin header for HTTP MCP calls.",
    )
    parser.add_argument(
        "--stdio-command",
        default=os.environ.get("TRICHAT_MCP_STDIO_COMMAND", "node"),
        help="Stdio command for MCP tool calls.",
    )
    parser.add_argument(
        "--stdio-args",
        default=os.environ.get("TRICHAT_MCP_STDIO_ARGS", "dist/server.js"),
        help="Stdio args string for MCP tool calls.",
    )
    parser.add_argument(
        "--mcp-retries",
        type=int,
        default=int(os.environ.get("TRICHAT_MCP_RETRIES", "2")),
        help="Retry count for MCP tool calls on transient failures.",
    )
    parser.add_argument(
        "--mcp-retry-delay",
        type=float,
        default=float(os.environ.get("TRICHAT_MCP_RETRY_DELAY", "0.2")),
        help="Base delay in seconds between MCP retries.",
    )
    parser.add_argument("--profile-id", default=os.environ.get("TRICHAT_PROFILE_ID", "default"))
    parser.add_argument("--max-memories", type=int, default=20)
    parser.add_argument("--max-transcript-lines", type=int, default=20)
    parser.add_argument("--max-snapshots", type=int, default=5)
    parser.add_argument("--no-bootstrap", action="store_true", help="Skip imprint.bootstrap preloading.")
    parser.add_argument("--turn-timeout", type=int, default=60, help="Per-agent response timeout seconds.")
    parser.add_argument("--bridge-timeout", type=int, default=45, help="Bridge command timeout seconds.")
    parser.add_argument("--huddle-rounds", type=int, default=0, help="Automatic huddle rounds per prompt.")
    parser.add_argument(
        "--execute-gate-mode",
        default=os.environ.get("TRICHAT_EXECUTE_GATE_MODE", "open"),
        choices=["open", "allowlist", "approval"],
        help="Policy mode for /execute before task.create (default: open).",
    )
    parser.add_argument(
        "--execute-allow-agents",
        default=os.environ.get("TRICHAT_EXECUTE_ALLOW_AGENTS", "codex,cursor,local-imprint"),
        help="Comma-separated allowlist for /execute when gate mode is allowlist.",
    )
    parser.add_argument(
        "--execute-approval-phrase",
        default=os.environ.get("TRICHAT_EXECUTE_APPROVAL_PHRASE", "approve"),
        help="Required phrase for /execute when gate mode is approval.",
    )
    parser.add_argument(
        "--panel-after-turn",
        dest="panel_after_turn",
        action="store_true",
        default=True,
        help="Render reliability panel after each fanout (default: on).",
    )
    parser.add_argument(
        "--no-panel-after-turn",
        dest="panel_after_turn",
        action="store_false",
        help="Disable panel rendering after each fanout turn.",
    )
    parser.add_argument("--panel-on-start", action="store_true", help="Render reliability panel on startup.")
    parser.add_argument(
        "--session-seed",
        default="",
        help="Optional idempotency seed for deterministic replay of tri-chat operations.",
    )
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    try:
        app = TriChatApp(args)
        app.run()
        return 0
    except Exception as error:  # noqa: BLE001
        print(f"TriChat fatal error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
