#!/usr/bin/env bash
set -euo pipefail

export TRICHAT_SMOKE_TRANSPORT="${TRICHAT_SMOKE_TRANSPORT:-stdio}"
export TRICHAT_SMOKE_URL="${TRICHAT_SMOKE_URL:-http://127.0.0.1:8787/}"
export TRICHAT_SMOKE_ORIGIN="${TRICHAT_SMOKE_ORIGIN:-http://127.0.0.1}"
export TRICHAT_SMOKE_STDIO_COMMAND="${TRICHAT_SMOKE_STDIO_COMMAND:-node}"
export TRICHAT_SMOKE_STDIO_ARGS="${TRICHAT_SMOKE_STDIO_ARGS:-dist/server.js}"
export TRICHAT_SMOKE_THREAD_ID="${TRICHAT_SMOKE_THREAD_ID:-trichat-smoke-$(date +%s)}"

if [[ "${TRICHAT_SMOKE_TRANSPORT}" == "http" ]] && [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
  echo "error: MCP_HTTP_BEARER_TOKEN is required when TRICHAT_SMOKE_TRANSPORT=http" >&2
  exit 2
fi

node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transportMode = process.env.TRICHAT_SMOKE_TRANSPORT ?? "stdio";
const threadId = process.env.TRICHAT_SMOKE_THREAD_ID;
const transport =
  transportMode === "http"
    ? new StreamableHTTPClientTransport(new URL(process.env.TRICHAT_SMOKE_URL), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.MCP_HTTP_BEARER_TOKEN}`,
            Origin: process.env.TRICHAT_SMOKE_ORIGIN,
          },
        },
      })
    : new StdioClientTransport({
        command: process.env.TRICHAT_SMOKE_STDIO_COMMAND ?? "node",
        args: (process.env.TRICHAT_SMOKE_STDIO_ARGS ?? "dist/server.js").split(/\s+/).filter(Boolean),
        cwd: process.cwd(),
        env: process.env,
        stderr: "pipe",
      });

const client = new Client(
  { name: "anamnesis-trichat-smoke", version: "0.1.0" },
  { capabilities: {} }
);

let mutationCounter = 0;
const mutation = (toolName) => {
  const index = mutationCounter++;
  const safe = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const base = `trichat-smoke-${threadId}-${safe}-${index}`;
  return {
    idempotency_key: base,
    side_effect_fingerprint: `${base}-fingerprint`,
  };
};

const extractText = (response) =>
  (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

const callTool = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

try {
  await client.connect(transport);

  const opened = await callTool("trichat.thread_open", {
    mutation: mutation("trichat.thread_open"),
    thread_id: threadId,
    title: `TriChat Smoke ${threadId}`,
    metadata: {
      source: "scripts/trichat_smoke.sh",
      transport: transportMode,
    },
  });
  if (!opened?.thread?.thread_id) {
    throw new Error("trichat.thread_open did not return thread id");
  }

  await callTool("trichat.message_post", {
    mutation: mutation("trichat.message_post.user"),
    thread_id: threadId,
    agent_id: "user",
    role: "user",
    content: `TriChat smoke user prompt for ${threadId}`,
    metadata: { source: "trichat_smoke" },
  });

  await callTool("trichat.message_post", {
    mutation: mutation("trichat.message_post.assistant"),
    thread_id: threadId,
    agent_id: "codex",
    role: "assistant",
    content: `TriChat smoke assistant response for ${threadId}`,
    metadata: { source: "trichat_smoke" },
  });

  const timeline = await callTool("trichat.timeline", {
    thread_id: threadId,
    limit: 20,
  });
  if (!Array.isArray(timeline?.messages) || timeline.messages.length < 2) {
    throw new Error("trichat.timeline returned insufficient messages");
  }

  const thread = await callTool("trichat.thread_get", {
    thread_id: threadId,
  });
  if (!thread?.found) {
    throw new Error("trichat.thread_get returned not found for smoke thread");
  }

  const retention = await callTool("trichat.retention", {
    mutation: mutation("trichat.retention"),
    older_than_days: 0,
    thread_id: threadId,
    limit: 100,
    dry_run: true,
  });
  if (typeof retention?.candidate_count !== "number") {
    throw new Error("trichat.retention dry-run did not return candidate_count");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: transportMode,
        thread_id: threadId,
        timeline_count: timeline.count ?? timeline.messages.length,
        retention_candidates: retention.candidate_count,
        thread_status: thread.thread?.status ?? null,
      },
      null,
      2
    )
  );
} finally {
  await client.close().catch(() => {});
}
NODE
