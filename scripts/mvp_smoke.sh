#!/usr/bin/env bash
set -euo pipefail

export MCP_SMOKE_TRANSPORT="${MCP_SMOKE_TRANSPORT:-stdio}"
export MCP_SMOKE_URL="${MCP_SMOKE_URL:-http://127.0.0.1:8787/}"
export MCP_SMOKE_ORIGIN="${MCP_SMOKE_ORIGIN:-http://127.0.0.1}"
export MCP_SMOKE_RUN_ID="${MCP_SMOKE_RUN_ID:-smoke-$(date +%s)}"
export MCP_SMOKE_STDIO_COMMAND="${MCP_SMOKE_STDIO_COMMAND:-node}"
export MCP_SMOKE_STDIO_ARGS="${MCP_SMOKE_STDIO_ARGS:-dist/server.js}"

if [[ "${MCP_SMOKE_TRANSPORT}" == "http" ]] && [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
  echo "error: MCP_HTTP_BEARER_TOKEN is required when MCP_SMOKE_TRANSPORT=http" >&2
  exit 2
fi

node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transportMode = process.env.MCP_SMOKE_TRANSPORT ?? "stdio";
const runId = process.env.MCP_SMOKE_RUN_ID;
const transport =
  transportMode === "http"
    ? new StreamableHTTPClientTransport(new URL(process.env.MCP_SMOKE_URL), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.MCP_HTTP_BEARER_TOKEN}`,
            Origin: process.env.MCP_SMOKE_ORIGIN,
          },
        },
      })
    : new StdioClientTransport({
        command: process.env.MCP_SMOKE_STDIO_COMMAND ?? "node",
        args: (process.env.MCP_SMOKE_STDIO_ARGS ?? "dist/server.js")
          .split(/\s+/)
          .filter(Boolean),
        cwd: process.cwd(),
        env: process.env,
        stderr: "pipe",
      });

const client = new Client(
  { name: "anamnesis-mvp-smoke", version: "0.1.0" },
  { capabilities: {} }
);

let mutationCounter = 0;
const mutation = (toolName) => {
  const index = mutationCounter++;
  const tool = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `smoke-${runId}-${tool}-${index}`,
    side_effect_fingerprint: `smoke-fingerprint-${runId}-${tool}-${index}`,
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

  await callTool("transcript.log", {
    mutation: mutation("transcript.log"),
    run_id: runId,
    role: "user",
    content: `Smoke user line for ${runId}`,
  });
  await callTool("transcript.log", {
    mutation: mutation("transcript.log"),
    run_id: runId,
    role: "assistant",
    content: `Smoke assistant action for ${runId}`,
  });

  const autoRunOnce = await callTool("transcript.auto_squish", {
    action: "run_once",
    mutation: mutation("transcript.auto_squish"),
    batch_runs: 100,
    per_run_limit: 500,
    max_points: 6,
  });

  const autoRunResult = autoRunOnce?.tick?.run_results?.find((entry) => entry.run_id === runId);
  let memoryId = autoRunResult?.memory_id;
  if (!memoryId) {
    const squish = await callTool("transcript.squish", {
      mutation: mutation("transcript.squish"),
      run_id: runId,
      max_points: 6,
    });
    if (!squish.created_memory || !squish.memory_id) {
      throw new Error(`No memory created for ${runId} via auto_squish run_once or transcript.squish`);
    }
    memoryId = squish.memory_id;
  }

  const search = await callTool("memory.search", {
    query: runId,
    limit: 5,
  });
  if (!Array.isArray(search) || search.length === 0) {
    throw new Error(`memory.search returned no matches for ${runId}`);
  }

  const memory = await callTool("memory.get", { id: memoryId });
  const timeline = await callTool("transcript.run_timeline", {
    run_id: runId,
    include_squished: true,
    limit: 20,
  });
  const pending = await callTool("transcript.pending_runs", { limit: 20 });
  const retentionDryRun = await callTool("transcript.retention", {
    mutation: mutation("transcript.retention"),
    older_than_days: 0,
    run_id: runId,
    limit: 100,
    dry_run: true,
  });
  const autoStatus = await callTool("transcript.auto_squish", {
    action: "status",
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: transportMode,
        run_id: runId,
        memory_id: memoryId,
        timeline_count: timeline.count ?? 0,
        pending_count: pending.count ?? 0,
        search_count: search.length,
        memory_found: memory.found ?? false,
        auto_squish_running: autoStatus.running ?? false,
        retention_candidates: retentionDryRun.candidate_count ?? 0,
      },
      null,
      2
    )
  );
} finally {
  await client.close().catch(() => {});
}
NODE
