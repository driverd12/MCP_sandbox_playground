#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const out = {
    objective: "",
    projectDir: process.cwd(),
    model: "",
    maxSteps: undefined,
    commandTimeout: undefined,
    dryRun: undefined,
    profileId: process.env.ANAMNESIS_IMPRINT_PROFILE_ID ?? "default",
    mcpTransport: "",
    source: "inbox_enqueue.mjs",
    metadataJson: "",
    repoRoot: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--objective") {
      out.objective = argv[++i] ?? "";
    } else if (token === "--project-dir") {
      out.projectDir = argv[++i] ?? out.projectDir;
    } else if (token === "--model") {
      out.model = argv[++i] ?? "";
    } else if (token === "--max-steps") {
      out.maxSteps = Number.parseInt(argv[++i] ?? "", 10);
    } else if (token === "--command-timeout") {
      out.commandTimeout = Number.parseInt(argv[++i] ?? "", 10);
    } else if (token === "--dry-run") {
      out.dryRun = true;
    } else if (token === "--profile-id") {
      out.profileId = argv[++i] ?? out.profileId;
    } else if (token === "--mcp-transport") {
      out.mcpTransport = argv[++i] ?? "";
    } else if (token === "--source") {
      out.source = argv[++i] ?? out.source;
    } else if (token === "--metadata") {
      out.metadataJson = argv[++i] ?? "";
    } else if (token === "--repo-root") {
      out.repoRoot = argv[++i] ?? out.repoRoot;
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!out.objective.trim()) {
    throw new Error("--objective is required");
  }

  return out;
}

function printHelp() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/inbox_enqueue.mjs --objective \"Run tests and summarize\" [options]",
      "",
      "Options:",
      "  --project-dir <path>",
      "  --model <ollama-model>",
      "  --max-steps <int>",
      "  --command-timeout <seconds>",
      "  --dry-run",
      "  --profile-id <imprint-profile-id>",
      "  --mcp-transport stdio|http",
      "  --metadata '{\"ticket\":\"ABC-123\"}'",
      "  --repo-root <path>",
    ].join("\n") + "\n"
  );
}

function stableNow() {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let metadata = undefined;
  if (args.metadataJson) {
    try {
      metadata = JSON.parse(args.metadataJson);
    } catch (error) {
      throw new Error(`Invalid --metadata JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const repoRoot = path.resolve(args.repoRoot);
  const inboxPendingDir = path.join(repoRoot, "data", "imprint", "inbox", "pending");
  fs.mkdirSync(inboxPendingDir, { recursive: true });

  const now = stableNow();
  const taskId = `${now.replace(/[:.]/g, "-")}-${randomUUID()}`;

  const payload = {
    task_id: taskId,
    objective: args.objective,
    project_dir: path.resolve(args.projectDir),
    model: args.model || undefined,
    max_steps: Number.isInteger(args.maxSteps) ? args.maxSteps : undefined,
    command_timeout: Number.isInteger(args.commandTimeout) ? args.commandTimeout : undefined,
    dry_run: args.dryRun === true ? true : undefined,
    imprint_profile_id: args.profileId,
    mcp_transport: args.mcpTransport || undefined,
    source: args.source,
    metadata,
    created_at: now,
  };

  const filePath = path.join(inboxPendingDir, `${taskId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        task_id: taskId,
        task_path: filePath,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
