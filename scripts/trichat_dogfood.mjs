#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO_ROOT = process.cwd();
const DEFAULT_AGENTS = ["codex", "cursor", "local-imprint"];
const BRIDGE_PROTOCOL_VERSION = "trichat-bridge-v1";
const BRIDGE_RESPONSE_KIND = "trichat.adapter.response";
const BRIDGE_PONG_KIND = "trichat.adapter.pong";
const DEFAULT_PROMPT =
  "Dogfood turn: propose one concrete reliability improvement for TriChat orchestration, with tradeoffs and an execution plan.";
const BRIDGE_HANDSHAKE_TTL_MS =
  parseBoundedInt(process.env.TRICHAT_DOGFOOD_HANDSHAKE_TTL_SECONDS, 120, 10, 900) * 1000;
const bridgeHandshakeCache = new Map();

function parseCli(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function printHelp() {
  const lines = [
    "TriChat dogfood runner",
    "",
    "Usage:",
    "  node ./scripts/trichat_dogfood.mjs [options]",
    "",
    "Options:",
    "  --transport stdio|http",
    "  --url <http_url>",
    "  --origin <origin>",
    "  --stdio-command <cmd>",
    "  --stdio-args <args>",
    "  --thread-id <id>",
    "  --prompt <text>",
    "  --cycles <n>",
    "  --interval-seconds <n>",
    "  --execute <true|false>",
    "  --verify-command <cmd>",
    "  --keep-active <true|false>",
    "  --thread-status active|archived",
    "  --agents codex,cursor,local-imprint",
    "  --require-success-agents <n>",
    "  --bridge-timeout <seconds>",
    "  --retention-days <n>",
    "  --retention-apply <true|false>",
    "  --retention-limit <n>",
    "  --codex-cmd <cmd>",
    "  --cursor-cmd <cmd>",
    "  --local-imprint-cmd <cmd>",
    "",
    "Examples:",
    "  npm run trichat:dogfood",
    "  npm run trichat:dogfood -- --execute true --cycles 2",
    "  npm run trichat:dogfood:smoke",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseThreadStatus(value, fallback = "active") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "archived") {
    return "archived";
  }
  if (normalized === "active") {
    return "active";
  }
  return fallback;
}

function compactSingleLine(value, limit = 220) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutationFactory(seed) {
  let counter = 0;
  return (toolName) => {
    counter += 1;
    const safe = String(toolName ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const base = `${seed}-${safe}-${counter}`;
    return {
      idempotency_key: base,
      side_effect_fingerprint: `${base}-fingerprint`,
    };
  };
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function bridgeRequestId(agentId, op = "ask") {
  const safeAgent = String(agentId ?? "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
  const safeOp = String(op ?? "ask")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "ask";
  return `dogfood-${safeAgent}-${safeOp}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractDirective(prompt, key) {
  const lines = String(prompt ?? "").replace(/\r/g, "").split("\n");
  const prefix = `${String(key ?? "").trim().toUpperCase()}=`;
  for (const line of lines) {
    const trimmed = String(line ?? "").trim();
    if (!trimmed.toUpperCase().startsWith(prefix)) {
      continue;
    }
    const value = trimmed.slice(prefix.length).trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function inferResponseMode(prompt) {
  const explicit = extractDirective(prompt, "TRICHAT_RESPONSE_MODE").toLowerCase();
  if (explicit === "json") {
    return "json";
  }
  const normalized = String(prompt ?? "").toLowerCase();
  if (normalized.includes("return only json") || normalized.includes("valid json object")) {
    return "json";
  }
  return "plain";
}

function roleProfileForAgent(agentId) {
  const normalized = String(agentId ?? "").trim().toLowerCase();
  if (normalized === "codex") {
    return {
      role: "implementer",
      objective: "translate objective into concrete implementation and command sequence",
      lane: "Implementation Lead",
    };
  }
  if (normalized === "cursor") {
    return {
      role: "planner",
      objective: "decompose objective into milestones, dependencies, and execution order",
      lane: "Planning Strategist",
    };
  }
  return {
    role: "reliability-critic",
    objective: "surface reliability risks, failure modes, and rollback/verifier hooks",
    lane: "Reliability Critic",
  };
}

function buildCollaborativePrompt(prompt, agentId, collaborators) {
  const raw = String(prompt ?? "").trim();
  if (!raw) {
    return raw;
  }
  if (raw.includes("TRICHAT_TURN_PHASE=")) {
    return raw;
  }
  const profile = roleProfileForAgent(agentId);
  const collab = collaborators.length > 0 ? collaborators.join(",") : "(none)";
  return [
    "TRICHAT_TURN_PHASE=propose",
    "TRICHAT_RESPONSE_MODE=json",
    `TRICHAT_ROLE=${profile.role}`,
    `TRICHAT_ROLE_OBJECTIVE=${profile.objective}`,
    `TRICHAT_AGENT=${agentId}`,
    `TRICHAT_COLLABORATORS=${collab}`,
    "User objective:",
    raw,
    "",
    "Lane contract:",
    `- You are the ${profile.lane} (${profile.role} lane).`,
    `- Primary focus: ${profile.objective}.`,
    "",
    "Return ONLY JSON with keys: strategy, plan_steps, risks, commands, confidence, role_lane, coordination_handoff.",
  ].join("\n");
}

function createTransport(options) {
  if (options.transport === "http") {
    const token = process.env.MCP_HTTP_BEARER_TOKEN;
    if (!token) {
      throw new Error("MCP_HTTP_BEARER_TOKEN is required for HTTP transport");
    }
    return new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: options.origin,
        },
      },
    });
  }
  return new StdioClientTransport({
    command: options.stdioCommand,
    args: String(options.stdioArgs)
      .split(/\s+/)
      .filter(Boolean),
    cwd: REPO_ROOT,
    env: process.env,
    stderr: "pipe",
  });
}

async function callTool(client, toolName, args) {
  const response = await client.callTool({ name: toolName, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`tool ${toolName} failed: ${text}`);
  }
  return parseJsonOrText(text);
}

function extractConfidence(content) {
  const raw = String(content ?? "");
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1));
    if (typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)) {
      return Math.max(0, Math.min(1, parsed.confidence));
    }
    if (typeof parsed.confidence === "string") {
      const asNumber = Number.parseFloat(parsed.confidence);
      if (Number.isFinite(asNumber)) {
        return Math.max(0, Math.min(1, asNumber));
      }
    }
  } catch {
    return null;
  }
  return null;
}

function toBridgeCommand(agentId, cliValue) {
  if (cliValue && String(cliValue).trim()) {
    return String(cliValue).trim();
  }
  const envKeys = {
    codex: "TRICHAT_DOGFOOD_CODEX_CMD",
    cursor: "TRICHAT_DOGFOOD_CURSOR_CMD",
    "local-imprint": "TRICHAT_DOGFOOD_LOCAL_IMPRINT_CMD",
  };
  const fromEnv = process.env[envKeys[agentId] ?? ""];
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  const bridgeFile = path.join(REPO_ROOT, "bridges", `${agentId}_bridge.py`);
  return `python3 ${JSON.stringify(bridgeFile)}`;
}

function runBridgeRaw(command, payload, timeoutSeconds) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const maxCapture = 256000;

    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      child.kill("SIGKILL");
    }, Math.max(1000, timeoutSeconds * 1000));

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxCapture) {
        stdout = stdout.slice(stdout.length - maxCapture);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > maxCapture) {
        stderr = stderr.slice(stderr.length - maxCapture);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (finished) {
        return;
      }
      finished = true;
      resolve({
        ok: false,
        error: `spawn-error: ${error instanceof Error ? error.message : String(error)}`,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (finished) {
        return;
      }
      finished = true;
      const out = stdout.trim();
      const err = stderr.trim();
      if (code !== 0) {
        resolve({
          ok: false,
          error: compactSingleLine(err || out || `exit=${code} signal=${signal ?? "none"}`, 240),
          stdout: out,
          stderr: err,
        });
        return;
      }
      if (!out) {
        resolve({
          ok: false,
          error: "empty bridge stdout",
          stdout: out,
          stderr: err,
        });
        return;
      }
      resolve({
        ok: true,
        stdout: out,
        stderr: err,
      });
    });

    child.stdin.write(`${JSON.stringify(payload, null, 0)}\n`);
    child.stdin.end();
  });
}

function parseBridgeJSONEnvelope(output) {
  const parsed = parseJsonOrText(String(output ?? "").trim());
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  return parsed;
}

async function runBridge(command, payload, timeoutSeconds) {
  const raw = await runBridgeRaw(command, payload, timeoutSeconds);
  if (!raw.ok) {
    return raw;
  }
  const envelope = parseBridgeJSONEnvelope(raw.stdout);
  if (!envelope) {
    return {
      ok: false,
      error: "bridge protocol violation: non-json envelope",
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.kind ?? "").trim() !== BRIDGE_RESPONSE_KIND) {
    return {
      ok: false,
      error: `bridge protocol violation: expected kind=${BRIDGE_RESPONSE_KIND}`,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.protocol_version ?? "").trim() !== BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `bridge protocol violation: expected protocol_version=${BRIDGE_PROTOCOL_VERSION}`,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.request_id ?? "").trim() !== String(payload.request_id ?? "").trim()) {
    return {
      ok: false,
      error: "bridge protocol violation: request_id mismatch",
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.agent_id ?? "").trim() !== String(payload.agent_id ?? "").trim()) {
    return {
      ok: false,
      error: "bridge protocol violation: agent_id mismatch",
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  const content = String(envelope.content ?? "").trim();
  if (!content) {
    return {
      ok: false,
      error: "bridge protocol violation: empty content",
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  return {
    ok: true,
    content,
    meta: envelope.meta ?? {},
    request_id: envelope.request_id,
    protocol_version: envelope.protocol_version,
    bridge: envelope.bridge ?? null,
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
}

async function pingBridge(command, payload, timeoutSeconds) {
  const raw = await runBridgeRaw(command, payload, timeoutSeconds);
  if (!raw.ok) {
    return raw;
  }
  const envelope = parseBridgeJSONEnvelope(raw.stdout);
  if (!envelope) {
    return {
      ok: false,
      error: "adapter handshake invalid JSON",
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.kind ?? "").trim() !== BRIDGE_PONG_KIND) {
    return {
      ok: false,
      error: `adapter handshake invalid kind: expected ${BRIDGE_PONG_KIND}`,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.protocol_version ?? "").trim() !== BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `adapter handshake protocol mismatch: expected ${BRIDGE_PROTOCOL_VERSION}`,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.request_id ?? "").trim() !== String(payload.request_id ?? "").trim()) {
    return {
      ok: false,
      error: "adapter handshake request_id mismatch",
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  if (String(envelope.agent_id ?? "").trim() !== String(payload.agent_id ?? "").trim()) {
    return {
      ok: false,
      error: "adapter handshake agent_id mismatch",
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
  return {
    ok: true,
    meta: envelope.meta ?? {},
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
}

async function runAgentFanout({
  agents,
  bridgeCommands,
  prompt,
  threadId,
  history,
  bootstrapText,
  timeoutSeconds,
  peerContext,
}) {
  const tasks = agents.map(async (agentId) => {
    const command = bridgeCommands[agentId] ?? "";
    if (!command) {
      return {
        agent_id: agentId,
        ok: false,
        content: "",
        error: "missing bridge command",
        adapter_meta: null,
      };
    }
    const collaborators = agents.filter((entry) => entry !== agentId);
    const collaborativePrompt = buildCollaborativePrompt(prompt, agentId, collaborators);
    const handshakeKey = `${agentId}::${command}`;
    const now = Date.now();
    const cacheEntry = bridgeHandshakeCache.get(handshakeKey);
    if (!cacheEntry || !cacheEntry.ok || now - cacheEntry.checked_at_ms >= BRIDGE_HANDSHAKE_TTL_MS) {
      const pingPayload = {
        op: "ping",
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        request_id: bridgeRequestId(agentId, "ping"),
        agent_id: agentId,
        thread_id: threadId,
        workspace: REPO_ROOT,
        timestamp: new Date().toISOString(),
      };
      const pingResult = await pingBridge(command, pingPayload, Math.min(timeoutSeconds, 5));
      if (!pingResult.ok) {
        bridgeHandshakeCache.set(handshakeKey, {
          ok: false,
          checked_at_ms: Date.now(),
        });
        return {
          agent_id: agentId,
          ok: false,
          content: "",
          error: `adapter handshake failed: ${compactSingleLine(pingResult.error ?? "unknown", 220)}`,
          adapter_meta: {
            bridge_command: command,
            handshake: "failed",
            stderr: pingResult.stderr || null,
          },
        };
      }
      bridgeHandshakeCache.set(handshakeKey, {
        ok: true,
        checked_at_ms: Date.now(),
      });
    }

    const turnPhase = extractDirective(collaborativePrompt, "TRICHAT_TURN_PHASE") || "propose";
    const roleHint = extractDirective(collaborativePrompt, "TRICHAT_ROLE") || roleProfileForAgent(agentId).role;
    const roleObjective = extractDirective(collaborativePrompt, "TRICHAT_ROLE_OBJECTIVE") || roleProfileForAgent(agentId).objective;
    const requestId = bridgeRequestId(agentId, "ask");
    const payload = {
      op: "ask",
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      request_id: requestId,
      agent_id: agentId,
      thread_id: threadId,
      prompt: collaborativePrompt,
      history,
      bootstrap_text: bootstrapText,
      peer_context: peerContext ?? "",
      workspace: REPO_ROOT,
      timestamp: new Date().toISOString(),
      turn_phase: turnPhase,
      role_hint: roleHint,
      role_objective: roleObjective,
      response_mode: inferResponseMode(collaborativePrompt),
      collaboration_contract: "coordinate with peers and avoid duplicate strategy",
    };
    const result = await runBridge(command, payload, timeoutSeconds);
    return {
      agent_id: agentId,
      ok: result.ok,
      content: result.ok ? result.content : "",
      error: result.ok ? null : result.error,
      adapter_meta: result.ok
        ? {
            ...(result.meta ?? {}),
            request_id: result.request_id ?? requestId,
            protocol_version: result.protocol_version ?? BRIDGE_PROTOCOL_VERSION,
            bridge: result.bridge ?? null,
            role_hint: roleHint,
            turn_phase: turnPhase,
          }
        : {
        bridge_command: command,
        request_id: requestId,
        role_hint: roleHint,
        turn_phase: turnPhase,
        stderr: result.stderr || null,
      },
    };
  });
  return Promise.all(tasks);
}

function deriveVerifyStatus(verifyPayload, verifyError) {
  if (verifyError) {
    return "error";
  }
  if (!verifyPayload || typeof verifyPayload !== "object") {
    return "error";
  }
  if (!verifyPayload.executed) {
    return "skipped";
  }
  if (verifyPayload.passed === true) {
    return "passed";
  }
  return "failed";
}

function buildVerifySummary(verifyPayload, verifyStatus, verifyError) {
  if (verifyError) {
    return `verify error: ${compactSingleLine(verifyError.message ?? String(verifyError), 220)}`;
  }
  if (!verifyPayload || typeof verifyPayload !== "object") {
    return `verify ${verifyStatus}`;
  }
  if (!verifyPayload.executed) {
    return verifyPayload.reason ? `verify skipped: ${compactSingleLine(verifyPayload.reason, 220)}` : "verify skipped";
  }
  const command = compactSingleLine(verifyPayload.command ?? "n/a", 100);
  const exitCode = verifyPayload.exit_code ?? "n/a";
  return `verify ${verifyStatus} command="${command}" exit=${exitCode}`;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (parseBool(cli.help ?? cli.h, false)) {
    printHelp();
    return;
  }
  const transport = String(cli.transport ?? process.env.TRICHAT_DOGFOOD_TRANSPORT ?? "stdio").toLowerCase();
  const options = {
    transport,
    url: String(cli.url ?? process.env.TRICHAT_DOGFOOD_URL ?? "http://127.0.0.1:8787/"),
    origin: String(cli.origin ?? process.env.TRICHAT_DOGFOOD_ORIGIN ?? "http://127.0.0.1"),
    stdioCommand: String(cli["stdio-command"] ?? process.env.TRICHAT_DOGFOOD_STDIO_COMMAND ?? "node"),
    stdioArgs: String(cli["stdio-args"] ?? process.env.TRICHAT_DOGFOOD_STDIO_ARGS ?? "dist/server.js"),
    cycles: parseBoundedInt(cli.cycles ?? process.env.TRICHAT_DOGFOOD_CYCLES, 1, 1, 100),
    intervalSeconds: parseBoundedInt(
      cli["interval-seconds"] ?? process.env.TRICHAT_DOGFOOD_INTERVAL_SECONDS,
      0,
      0,
      600
    ),
    bridgeTimeoutSeconds: parseBoundedInt(
      cli["bridge-timeout"] ?? process.env.TRICHAT_DOGFOOD_BRIDGE_TIMEOUT,
      180,
      5,
      7200
    ),
    keepActive: parseBool(cli["keep-active"] ?? process.env.TRICHAT_DOGFOOD_KEEP_ACTIVE, true),
    threadStatus: parseThreadStatus(cli["thread-status"] ?? process.env.TRICHAT_DOGFOOD_THREAD_STATUS, "active"),
    execute: parseBool(cli.execute ?? process.env.TRICHAT_DOGFOOD_EXECUTE, false),
    verifyCommand: String(cli["verify-command"] ?? process.env.TRICHAT_DOGFOOD_VERIFY_COMMAND ?? "").trim(),
    requireSuccessAgents: parseBoundedInt(
      cli["require-success-agents"] ?? process.env.TRICHAT_DOGFOOD_REQUIRE_SUCCESS_AGENTS,
      1,
      0,
      DEFAULT_AGENTS.length
    ),
    retentionDays: parseBoundedInt(
      cli["retention-days"] ?? process.env.TRICHAT_DOGFOOD_RETENTION_DAYS ?? -1,
      -1,
      -1,
      3650
    ),
    retentionApply: parseBool(cli["retention-apply"] ?? process.env.TRICHAT_DOGFOOD_RETENTION_APPLY, false),
    retentionLimit: parseBoundedInt(
      cli["retention-limit"] ?? process.env.TRICHAT_DOGFOOD_RETENTION_LIMIT,
      5000,
      1,
      5000
    ),
  };

  const agentsRaw = String(cli.agents ?? process.env.TRICHAT_DOGFOOD_AGENTS ?? DEFAULT_AGENTS.join(","));
  const agents = agentsRaw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => DEFAULT_AGENTS.includes(value));
  const activeAgents = agents.length > 0 ? [...new Set(agents)] : [...DEFAULT_AGENTS];
  const threadId = String(
    cli["thread-id"] ?? process.env.TRICHAT_DOGFOOD_THREAD_ID ?? `trichat-dogfood-${Math.floor(Date.now() / 1000)}`
  ).trim();
  const runId = `${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}`;
  const basePrompt = String(cli.prompt ?? process.env.TRICHAT_DOGFOOD_PROMPT ?? DEFAULT_PROMPT).trim() || DEFAULT_PROMPT;
  const transportInstance = createTransport(options);
  const client = new Client({ name: "anamnesis-trichat-dogfood", version: "0.1.0" }, { capabilities: {} });
  const mutation = mutationFactory(`trichat-dogfood-${threadId}-${runId}`);
  const bridgeCommands = {
    codex: toBridgeCommand("codex", cli["codex-cmd"]),
    cursor: toBridgeCommand("cursor", cli["cursor-cmd"]),
    "local-imprint": toBridgeCommand("local-imprint", cli["local-imprint-cmd"]),
  };

  const report = {
    ok: true,
    thread_id: threadId,
    transport: options.transport,
    cycles: [],
    started_at: new Date().toISOString(),
    run_id: runId,
    bridge_commands: bridgeCommands,
    execute: options.execute,
    thread_status: options.threadStatus,
  };

  try {
    await client.connect(transportInstance);
    await callTool(client, "trichat.thread_open", {
      mutation: mutation("trichat.thread_open"),
      thread_id: threadId,
      title: `TriChat Dogfood ${threadId}`,
      status: options.threadStatus,
      metadata: {
        source: "scripts/trichat_dogfood.mjs",
        transport: options.transport,
      },
    });

    let bootstrapText = "";
    try {
      const bootstrap = await callTool(client, "imprint.bootstrap", {
        profile_id: "default",
        max_memories: 20,
      });
      if (bootstrap && typeof bootstrap === "object" && typeof bootstrap.bootstrap_text === "string") {
        bootstrapText = bootstrap.bootstrap_text;
      }
    } catch {
      bootstrapText = "";
    }

    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      const prompt =
        options.cycles <= 1
          ? basePrompt
          : `${basePrompt}\n\nCycle marker: ${cycle}/${options.cycles}`;
      const userPost = await callTool(client, "trichat.message_post", {
        mutation: mutation("trichat.message_post.user"),
        thread_id: threadId,
        agent_id: "user",
        role: "user",
        content: prompt,
        metadata: {
          source: "scripts/trichat_dogfood.mjs",
          kind: "dogfood-user-turn",
          cycle,
        },
      });
      const userMessageId = String(userPost?.message?.message_id ?? "").trim();
      if (!userMessageId) {
        throw new Error("dogfood failed: user message id missing");
      }

      const turnStart = await callTool(client, "trichat.turn_start", {
        mutation: mutation("trichat.turn_start"),
        thread_id: threadId,
        user_message_id: userMessageId,
        user_prompt: prompt,
        expected_agents: activeAgents,
        min_agents: Math.max(1, Math.min(activeAgents.length, options.requireSuccessAgents || activeAgents.length)),
        metadata: {
          source: "scripts/trichat_dogfood.mjs",
          cycle,
        },
      });
      const turnId = String(turnStart?.turn?.turn_id ?? "").trim();
      if (!turnId) {
        throw new Error("dogfood failed: turn_id missing");
      }

      await callTool(client, "trichat.turn_advance", {
        mutation: mutation("trichat.turn_advance"),
        turn_id: turnId,
        phase: "propose",
        phase_status: "running",
        status: "running",
      });

      const timeline = await callTool(client, "trichat.timeline", {
        thread_id: threadId,
        limit: 120,
      });
      const history = Array.isArray(timeline?.messages) ? timeline.messages : [];
      const fanout = await runAgentFanout({
        agents: activeAgents,
        bridgeCommands,
        prompt,
        threadId,
        history,
        bootstrapText,
        timeoutSeconds: options.bridgeTimeoutSeconds,
        peerContext: "",
      });

      let successAgents = 0;
      for (const result of fanout) {
        const degraded = !result.ok;
        if (!degraded) {
          successAgents += 1;
        }
        const content = degraded
          ? `[degraded-mode] ${result.agent_id} unavailable this turn: ${compactSingleLine(result.error, 180)}`
          : result.content;
        await callTool(client, "trichat.message_post", {
          mutation: mutation(`trichat.message_post.${result.agent_id}`),
          thread_id: threadId,
          agent_id: result.agent_id,
          role: "assistant",
          content,
          reply_to_message_id: userMessageId,
          metadata: {
            source: "scripts/trichat_dogfood.mjs",
            kind: degraded ? "dogfood-proposal-degraded" : "dogfood-proposal",
            cycle,
            adapter_meta: result.adapter_meta,
          },
        });
        await callTool(client, "trichat.turn_artifact", {
          mutation: mutation(`trichat.turn_artifact.${result.agent_id}`),
          turn_id: turnId,
          phase: "propose",
          artifact_type: degraded ? "proposal_degraded" : "proposal",
          agent_id: result.agent_id,
          content,
          score: extractConfidence(content),
          metadata: {
            source: "scripts/trichat_dogfood.mjs",
            cycle,
            degraded,
          },
        });
      }

      if (successAgents < options.requireSuccessAgents) {
        throw new Error(
          `dogfood failed: success_agents=${successAgents} below require_success_agents=${options.requireSuccessAgents}`
        );
      }

      let novelty = await callTool(client, "trichat.novelty", {
        turn_id: turnId,
        novelty_threshold: 0.35,
        max_similarity: 0.82,
      });

      if (novelty?.found && novelty.retry_required && Array.isArray(novelty.retry_agents) && novelty.retry_agents.length > 0) {
        const peerContext = Array.isArray(novelty.proposals)
          ? novelty.proposals.map((entry) => `${entry.agent_id}: ${compactSingleLine(entry.content, 180)}`).join("\n")
          : "";
        for (const retryAgentRaw of novelty.retry_agents) {
          const retryAgent = String(retryAgentRaw ?? "").trim().toLowerCase();
          if (!retryAgent || !activeAgents.includes(retryAgent)) {
            continue;
          }
          const retryPrompt = [
            "TRICHAT_TURN_PHASE=propose_delta",
            `User objective: ${prompt}`,
            `You are ${retryAgent}.`,
            "Your previous response overlapped peers.",
            "Return a materially different strategy with direct implementation steps.",
            "",
            "Peer context:",
            peerContext || "(none)",
          ].join("\n");
          const retryResult = (await runAgentFanout({
            agents: [retryAgent],
            bridgeCommands,
            prompt: retryPrompt,
            threadId,
            history,
            bootstrapText,
            timeoutSeconds: options.bridgeTimeoutSeconds,
            peerContext,
          }))[0];
          const degraded = !retryResult.ok;
          const retryContent = degraded
            ? `[degraded-mode] ${retryAgent} retry unavailable: ${compactSingleLine(retryResult.error, 180)}`
            : retryResult.content;
          await callTool(client, "trichat.message_post", {
            mutation: mutation(`trichat.message_post.retry.${retryAgent}`),
            thread_id: threadId,
            agent_id: retryAgent,
            role: "assistant",
            content: retryContent,
            reply_to_message_id: userMessageId,
            metadata: {
              source: "scripts/trichat_dogfood.mjs",
              kind: degraded ? "dogfood-proposal-retry-degraded" : "dogfood-proposal-retry",
              cycle,
            },
          });
          await callTool(client, "trichat.turn_artifact", {
            mutation: mutation(`trichat.turn_artifact.retry.${retryAgent}`),
            turn_id: turnId,
            phase: "propose",
            artifact_type: degraded ? "proposal_retry_degraded" : "proposal_retry",
            agent_id: retryAgent,
            content: retryContent,
            score: extractConfidence(retryContent),
            metadata: {
              source: "scripts/trichat_dogfood.mjs",
              cycle,
              retry_agent: retryAgent,
              degraded,
            },
          });
        }
        novelty = await callTool(client, "trichat.novelty", {
          turn_id: turnId,
          novelty_threshold: 0.35,
          max_similarity: 0.82,
        });
      }

      const orchestrated = await callTool(client, "trichat.turn_orchestrate", {
        mutation: mutation("trichat.turn_orchestrate.decide"),
        turn_id: turnId,
        action: "decide",
        novelty_threshold: 0.35,
        max_similarity: 0.82,
      });
      const decisionSummary = compactSingleLine(
        orchestrated?.decision?.decision_summary ?? orchestrated?.turn?.decision_summary ?? "turn orchestrated",
        320
      );
      await callTool(client, "trichat.message_post", {
        mutation: mutation("trichat.message_post.router.decision"),
        thread_id: threadId,
        agent_id: "router",
        role: "system",
        content: decisionSummary,
        metadata: {
          source: "scripts/trichat_dogfood.mjs",
          kind: "dogfood-turn-decision",
          cycle,
          turn_id: turnId,
          selected_agent: orchestrated?.decision?.selected_agent ?? orchestrated?.turn?.selected_agent ?? null,
          novelty_score: novelty?.novelty_score ?? null,
          retry_required: novelty?.retry_required ?? false,
          retry_suppressed: novelty?.retry_suppressed ?? false,
          retry_suppression_reason: novelty?.retry_suppression_reason ?? null,
          retry_suppression_reference_turn_id: novelty?.retry_suppression_reference_turn_id ?? null,
        },
      });

      let verify = null;
      let verifyStatus = null;
      let verifySummary = null;
      let task = null;
      let finalized = null;
      if (options.execute) {
        const selectedAgent = String(orchestrated?.decision?.selected_agent ?? orchestrated?.turn?.selected_agent ?? "router");
        const selectedStrategy = String(
          orchestrated?.decision?.selected_strategy ?? orchestrated?.turn?.selected_strategy ?? decisionSummary
        );
        task = await callTool(client, "task.create", {
          mutation: mutation("task.create"),
          objective: compactSingleLine(selectedStrategy, 260),
          project_dir: REPO_ROOT,
          priority: 50,
          source: "trichat.dogfood",
          source_client: "scripts/trichat_dogfood.mjs",
          metadata: {
            thread_id: threadId,
            turn_id: turnId,
            selected_agent: selectedAgent,
            cycle,
          },
        });
        let verifyError = null;
        try {
          verify = await callTool(client, "trichat.verify", {
            project_dir: REPO_ROOT,
            command: options.verifyCommand || undefined,
            timeout_seconds: 180,
            capture_limit: 4000,
          });
        } catch (error) {
          verifyError = error;
        }
        verifyStatus = deriveVerifyStatus(verify, verifyError);
        verifySummary = buildVerifySummary(verify, verifyStatus, verifyError);
        finalized = await callTool(client, "trichat.turn_orchestrate", {
          mutation: mutation("trichat.turn_orchestrate.verify_finalize"),
          turn_id: turnId,
          action: "verify_finalize",
          verify_status: verifyStatus,
          verify_summary: verifySummary,
          verify_details: {
            selected_agent: selectedAgent,
            selected_strategy: compactSingleLine(selectedStrategy, 240),
            verify_result: verify ?? null,
            cycle,
          },
        });
        await callTool(client, "trichat.message_post", {
          mutation: mutation("trichat.message_post.router.execute"),
          thread_id: threadId,
          agent_id: "router",
          role: "system",
          content: `execute routed via ${selectedAgent}; ${verifySummary}`,
          metadata: {
            source: "scripts/trichat_dogfood.mjs",
            kind: "dogfood-execute",
            cycle,
            turn_id: turnId,
            verify_status: verifyStatus,
          },
        });
      }

      const consensus = await callTool(client, "trichat.consensus", {
        thread_id: threadId,
        limit: 240,
        min_agents: Math.max(2, Math.min(activeAgents.length, 3)),
        recent_turn_limit: 12,
      });
      const workboard = await callTool(client, "trichat.workboard", {
        thread_id: threadId,
        limit: 20,
      });

      report.cycles.push({
        cycle,
        user_message_id: userMessageId,
        turn_id: turnId,
        success_agents: successAgents,
        total_agents: activeAgents.length,
        novelty_score: novelty?.novelty_score ?? null,
        novelty_retry_required: novelty?.retry_required ?? null,
        novelty_retry_suppressed: novelty?.retry_suppressed ?? null,
        novelty_retry_suppression_reason: novelty?.retry_suppression_reason ?? null,
        novelty_retry_suppression_reference_turn_id: novelty?.retry_suppression_reference_turn_id ?? null,
        selected_agent: orchestrated?.decision?.selected_agent ?? orchestrated?.turn?.selected_agent ?? null,
        decision_summary: decisionSummary,
        execute_enabled: options.execute,
        verify_status: verifyStatus,
        task_id: task?.task?.task_id ?? null,
        finalized_status: finalized?.turn?.status ?? null,
        consensus_latest_status: consensus?.latest_turn?.status ?? null,
        workboard_active_phase: workboard?.active_turn?.phase ?? null,
      });

      if (options.retentionDays >= 0) {
        const retention = await callTool(client, "trichat.retention", {
          mutation: mutation("trichat.retention"),
          older_than_days: options.retentionDays,
          thread_id: threadId,
          limit: options.retentionLimit,
          dry_run: !options.retentionApply,
        });
        report.cycles[report.cycles.length - 1].retention = {
          older_than_days: options.retentionDays,
          applied: options.retentionApply,
          candidate_count: retention?.candidate_count ?? null,
          deleted_count: retention?.deleted_count ?? null,
        };
      }

      if (cycle < options.cycles && options.intervalSeconds > 0) {
        await sleep(options.intervalSeconds * 1000);
      }
    }

    if (!options.keepActive || options.threadStatus === "archived") {
      await callTool(client, "trichat.thread_open", {
        mutation: mutation("trichat.thread_open.archive"),
        thread_id: threadId,
        title: `TriChat Dogfood ${threadId}`,
        status: "archived",
        metadata: {
          source: "scripts/trichat_dogfood.mjs",
          archived_by: "dogfood",
        },
      });
    }
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    report.finished_at = new Date().toISOString();
    await client.close().catch(() => {});
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
