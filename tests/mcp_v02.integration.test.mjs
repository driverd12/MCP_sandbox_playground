import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();
const ADR_DIR_PATH = path.join(REPO_ROOT, "docs", "adrs");

const EXPECTED_TOOLS = [
  "adr.create",
  "decision.link",
  "health.policy",
  "health.storage",
  "health.tools",
  "imprint.auto_snapshot",
  "imprint.bootstrap",
  "imprint.inbox.enqueue",
  "imprint.inbox.list",
  "imprint.profile_get",
  "imprint.profile_set",
  "imprint.snapshot",
  "incident.open",
  "incident.timeline",
  "knowledge.decay",
  "knowledge.promote",
  "knowledge.query",
  "lock.acquire",
  "lock.release",
  "memory.append",
  "memory.get",
  "memory.search",
  "migration.status",
  "mutation.check",
  "policy.evaluate",
  "postflight.verify",
  "preflight.check",
  "query.plan",
  "retrieval.hybrid",
  "run.begin",
  "run.end",
  "run.step",
  "run.timeline",
  "task.claim",
  "task.complete",
  "task.create",
  "task.fail",
  "task.heartbeat",
  "task.list",
  "task.summary",
  "task.timeline",
  "task.retry",
  "task.auto_retry",
  "trichat.adapter_telemetry",
  "trichat.bus",
  "trichat.consensus",
  "trichat.message_post",
  "trichat.auto_retention",
  "trichat.retention",
  "trichat.summary",
  "trichat.thread_get",
  "trichat.thread_list",
  "trichat.thread_open",
  "trichat.timeline",
  "simulate.workflow",
  "transcript.log",
  "transcript.auto_squish",
  "transcript.pending_runs",
  "transcript.retention",
  "transcript.run_timeline",
  "transcript.squish",
  "transcript.append",
  "transcript.summarize",
  "who_knows",
].sort();

const MUTATION_REQUIRED_TOOLS = [
  "adr.create",
  "decision.link",
  "incident.open",
  "imprint.profile_set",
  "imprint.snapshot",
  "imprint.inbox.enqueue",
  "knowledge.decay",
  "knowledge.promote",
  "lock.acquire",
  "lock.release",
  "memory.append",
  "policy.evaluate",
  "run.begin",
  "run.end",
  "run.step",
  "task.claim",
  "task.complete",
  "task.create",
  "task.fail",
  "task.heartbeat",
  "task.retry",
  "trichat.message_post",
  "trichat.retention",
  "trichat.thread_open",
  "transcript.log",
  "transcript.retention",
  "transcript.squish",
  "transcript.append",
  "transcript.summarize",
];

test("MCP v0.2 integration and safety invariants", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-v02-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const adrFilesToRemove = new Set();
  const inboxFilesToRemove = new Set();
  let mutationCounter = 0;

  const env = inheritedEnv({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-v02-test-client", version: "0.1.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const toolsList = await client.listTools();
    const toolNames = toolsList.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, EXPECTED_TOOLS);

    const toolsByName = new Map(toolsList.tools.map((tool) => [tool.name, tool]));
    for (const toolName of MUTATION_REQUIRED_TOOLS) {
      const tool = toolsByName.get(toolName);
      assert.ok(tool, `Tool missing from list: ${toolName}`);
      const required = tool.inputSchema?.required ?? [];
      assert.ok(required.includes("mutation"), `${toolName} should require mutation metadata`);
    }

    const missingMutationError = await callToolExpectError(client, "memory.append", {
      text: "should fail due to missing mutation",
    });
    assert.match(missingMutationError, /mutation|required|invalid/i);

    const noteMutation = nextMutation(testId, "memory.append", () => mutationCounter++);
    const note = await callTool(client, "memory.append", {
      mutation: noteMutation,
      content: `integration note ${testId}`,
      keywords: ["integration", "v02"],
    });
    assert.ok(note.id);

    const replayedNote = await callTool(client, "memory.append", {
      mutation: noteMutation,
      content: `integration note ${testId}`,
      keywords: ["integration", "v02"],
    });
    assert.equal(replayedNote.id, note.id);
    assert.equal(replayedNote.replayed, true);

    const mismatchedFingerprintError = await callToolExpectError(client, "memory.append", {
      mutation: {
        idempotency_key: noteMutation.idempotency_key,
        side_effect_fingerprint: `${noteMutation.side_effect_fingerprint}-changed`,
      },
      content: "same key different fingerprint must fail",
    });
    assert.match(mismatchedFingerprintError, /mismatched side_effect_fingerprint/i);

    const memoryMatches = await callTool(client, "memory.search", {
      query: `integration note ${testId}`,
      limit: 5,
    });
    assert.ok(Array.isArray(memoryMatches));
    assert.ok(memoryMatches.length >= 1);

    const memoryGet = await callTool(client, "memory.get", {
      id: note.id,
      touch: true,
    });
    assert.equal(memoryGet.found, true);
    assert.equal(memoryGet.memory.id, note.id);

    const imprintProfileId = `imprint-${testId}`;
    const imprintProfile = await callTool(client, "imprint.profile_set", {
      mutation: nextMutation(testId, "imprint.profile_set", () => mutationCounter++),
      profile_id: imprintProfileId,
      title: "Integration Test Imprint",
      mission: "Preserve local continuity for autonomous workflows.",
      principles: [
        "Prefer deterministic local-first operations.",
        "Preserve idempotency for all mutating tool paths.",
      ],
      hard_constraints: ["Never write operational logs to stdout."],
      preferred_models: ["llama3.2:3b"],
      project_roots: [REPO_ROOT],
      notes: `profile for ${testId}`,
      source_client: "codex-tests",
    });
    assert.equal(imprintProfile.ok, true);
    assert.equal(imprintProfile.profile.profile_id, imprintProfileId);

    const imprintProfileGet = await callTool(client, "imprint.profile_get", {
      profile_id: imprintProfileId,
    });
    assert.equal(imprintProfileGet.found, true);
    assert.equal(imprintProfileGet.profile.profile_id, imprintProfileId);

    const imprintSnapshot = await callTool(client, "imprint.snapshot", {
      mutation: nextMutation(testId, "imprint.snapshot", () => mutationCounter++),
      profile_id: imprintProfileId,
      summary: "integration continuity checkpoint",
      tags: ["integration", "continuity"],
      include_recent_memories: 5,
      include_recent_transcript_lines: 5,
      write_file: false,
      promote_summary: false,
      source_client: "codex-tests",
    });
    assert.equal(imprintSnapshot.ok, true);
    assert.ok(imprintSnapshot.snapshot_id);
    assert.equal(imprintSnapshot.snapshot_path, null);

    const imprintBootstrap = await callTool(client, "imprint.bootstrap", {
      profile_id: imprintProfileId,
      max_memories: 5,
      max_transcript_lines: 5,
      max_snapshots: 5,
    });
    assert.equal(imprintBootstrap.profile_found, true);
    assert.match(imprintBootstrap.bootstrap_text, /Anamnesis Imprint Bootstrap/);
    assert.match(imprintBootstrap.bootstrap_text, /Integration Test Imprint/);

    const imprintAutoSnapshotRunOnce = await callTool(client, "imprint.auto_snapshot", {
      action: "run_once",
      mutation: nextMutation(testId, "imprint.auto_snapshot-run-once", () => mutationCounter++),
      profile_id: imprintProfileId,
      include_recent_memories: 3,
      include_recent_transcript_lines: 3,
      write_file: false,
      promote_summary: false,
    });
    assert.equal(typeof imprintAutoSnapshotRunOnce.tick.ok, "boolean");

    const imprintAutoSnapshotStatus = await callTool(client, "imprint.auto_snapshot", {
      action: "status",
    });
    assert.equal(typeof imprintAutoSnapshotStatus.running, "boolean");

    const inboxTask = await callTool(client, "imprint.inbox.enqueue", {
      mutation: nextMutation(testId, "imprint.inbox.enqueue", () => mutationCounter++),
      objective: `Run dry-run workload for ${testId}`,
      project_dir: REPO_ROOT,
      dry_run: true,
      imprint_profile_id: imprintProfileId,
      source: "integration-suite",
      metadata: { test_id: testId },
    });
    assert.equal(inboxTask.ok, true);
    assert.equal(inboxTask.status, "pending");
    assert.ok(inboxTask.task_id);
    if (inboxTask.path) {
      inboxFilesToRemove.add(inboxTask.path);
    }

    const inboxPending = await callTool(client, "imprint.inbox.list", {
      status: "pending",
      limit: 200,
    });
    assert.ok(
      inboxPending.tasks.some((task) => task.task_id === inboxTask.task_id),
      "Expected enqueued task in pending inbox list"
    );

    const workerId = `worker-${testId}`;
    const durableTaskId = `task-${testId}-a`;
    const durableTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create-a", () => mutationCounter++),
      task_id: durableTaskId,
      objective: `Review project health for ${testId}`,
      project_dir: REPO_ROOT,
      payload: {
        dry_run: true,
        max_steps: 3,
        command_timeout: 60,
      },
      priority: 5,
      tags: ["integration", "durable-task"],
      source: "integration-suite",
    });
    assert.equal(durableTask.created, true);
    assert.equal(durableTask.task.task_id, durableTaskId);
    assert.equal(durableTask.task.status, "pending");

    const durablePendingList = await callTool(client, "task.list", {
      status: "pending",
      limit: 200,
    });
    assert.ok(
      durablePendingList.tasks.some((task) => task.task_id === durableTaskId),
      "Expected durable task in pending list"
    );

    const claimedTask = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim-a", () => mutationCounter++),
      task_id: durableTaskId,
      worker_id: workerId,
      lease_seconds: 120,
    });
    assert.equal(claimedTask.claimed, true);
    assert.equal(claimedTask.task.task_id, durableTaskId);
    assert.equal(claimedTask.task.status, "running");
    assert.equal(claimedTask.task.lease.owner_id, workerId);

    const heartbeatTask = await callTool(client, "task.heartbeat", {
      mutation: nextMutation(testId, "task.heartbeat-a", () => mutationCounter++),
      task_id: durableTaskId,
      worker_id: workerId,
      lease_seconds: 180,
    });
    assert.equal(heartbeatTask.ok, true);

    const completedTask = await callTool(client, "task.complete", {
      mutation: nextMutation(testId, "task.complete-a", () => mutationCounter++),
      task_id: durableTaskId,
      worker_id: workerId,
      result: { ok: true, source: "integration" },
    });
    assert.equal(completedTask.completed, true);
    assert.equal(completedTask.task.task_id, durableTaskId);
    assert.equal(completedTask.task.status, "completed");

    const durableTaskIdB = `task-${testId}-b`;
    await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create-b", () => mutationCounter++),
      task_id: durableTaskIdB,
      objective: `Run follow-up checks for ${testId}`,
      project_dir: REPO_ROOT,
      payload: {
        dry_run: true,
      },
      priority: 2,
    });

    const claimedTaskB = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim-b", () => mutationCounter++),
      task_id: durableTaskIdB,
      worker_id: workerId,
      lease_seconds: 120,
    });
    assert.equal(claimedTaskB.claimed, true);
    assert.equal(claimedTaskB.task.status, "running");

    const failedTaskB = await callTool(client, "task.fail", {
      mutation: nextMutation(testId, "task.fail-b", () => mutationCounter++),
      task_id: durableTaskIdB,
      worker_id: workerId,
      error: "simulated integration failure",
      result: { exit_code: 1 },
    });
    assert.equal(failedTaskB.failed, true);
    assert.equal(failedTaskB.task.status, "failed");

    const retriedTaskB = await callTool(client, "task.retry", {
      mutation: nextMutation(testId, "task.retry-b", () => mutationCounter++),
      task_id: durableTaskIdB,
      delay_seconds: 0,
      reason: "integration retry path",
    });
    assert.equal(retriedTaskB.retried, true);
    assert.equal(retriedTaskB.task.status, "pending");

    const taskTimelineB = await callTool(client, "task.timeline", {
      task_id: durableTaskIdB,
      limit: 50,
    });
    assert.ok(taskTimelineB.count >= 4);
    const taskTimelineTypes = taskTimelineB.events.map((event) => event.event_type);
    assert.ok(taskTimelineTypes.includes("created"));
    assert.ok(taskTimelineTypes.includes("claimed"));
    assert.ok(taskTimelineTypes.includes("failed"));
    assert.ok(taskTimelineTypes.includes("retried"));

    const taskSummaryBeforeAutoRetry = await callTool(client, "task.summary", {
      running_limit: 10,
    });
    assert.equal(typeof taskSummaryBeforeAutoRetry.counts.pending, "number");
    assert.equal(typeof taskSummaryBeforeAutoRetry.counts.failed, "number");
    assert.ok(Array.isArray(taskSummaryBeforeAutoRetry.running));
    if (taskSummaryBeforeAutoRetry.last_failed) {
      assert.equal(typeof taskSummaryBeforeAutoRetry.last_failed.task_id, "string");
    }

    const triChatThreadId = `trichat-${testId}`;
    const triChatThread = await callTool(client, "trichat.thread_open", {
      mutation: nextMutation(testId, "trichat.thread_open", () => mutationCounter++),
      thread_id: triChatThreadId,
      title: `Integration thread ${testId}`,
      metadata: {
        source: "integration-test",
      },
    });
    assert.equal(triChatThread.created, true);
    assert.equal(triChatThread.thread.thread_id, triChatThreadId);
    assert.equal(triChatThread.thread.status, "active");

    const triChatThreadList = await callTool(client, "trichat.thread_list", {
      status: "active",
      limit: 50,
    });
    assert.ok(
      triChatThreadList.threads.some((thread) => thread.thread_id === triChatThreadId),
      "Expected tri-chat thread in active list"
    );

    const triChatThreadGet = await callTool(client, "trichat.thread_get", {
      thread_id: triChatThreadId,
    });
    assert.equal(triChatThreadGet.found, true);
    assert.equal(triChatThreadGet.thread.thread_id, triChatThreadId);

    const triChatMessageMutation = nextMutation(testId, "trichat.message_post-user", () => mutationCounter++);
    const triChatUserMessage = await callTool(client, "trichat.message_post", {
      mutation: triChatMessageMutation,
      thread_id: triChatThreadId,
      agent_id: "user",
      role: "user",
      content: `integration tri-chat user message ${testId}`,
    });
    assert.equal(triChatUserMessage.ok, true);
    assert.ok(triChatUserMessage.message.message_id);

    const triChatUserMessageReplay = await callTool(client, "trichat.message_post", {
      mutation: triChatMessageMutation,
      thread_id: triChatThreadId,
      agent_id: "user",
      role: "user",
      content: `integration tri-chat user message ${testId}`,
    });
    assert.equal(triChatUserMessageReplay.replayed, true);
    assert.equal(
      triChatUserMessageReplay.message.message_id,
      triChatUserMessage.message.message_id
    );

    const triChatCodexMessage = await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post-codex", () => mutationCounter++),
      thread_id: triChatThreadId,
      agent_id: "codex",
      role: "assistant",
      content: `integration tri-chat codex reply ${testId}`,
      reply_to_message_id: triChatUserMessage.message.message_id,
    });
    assert.equal(triChatCodexMessage.ok, true);

    const triChatCursorMessage = await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post-cursor", () => mutationCounter++),
      thread_id: triChatThreadId,
      agent_id: "cursor",
      role: "assistant",
      content: `integration tri-chat cursor follow-up ${testId}`,
      reply_to_message_id: triChatCodexMessage.message.message_id,
    });
    assert.equal(triChatCursorMessage.ok, true);

    const triChatImprintMessage = await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post-imprint", () => mutationCounter++),
      thread_id: triChatThreadId,
      agent_id: "local-imprint",
      role: "assistant",
      content: `integration tri-chat local-imprint synthesis ${testId}`,
      reply_to_message_id: triChatCursorMessage.message.message_id,
    });
    assert.equal(triChatImprintMessage.ok, true);

    const triChatTimeline = await callTool(client, "trichat.timeline", {
      thread_id: triChatThreadId,
      limit: 20,
    });
    assert.ok(triChatTimeline.count >= 4);
    assert.equal(triChatTimeline.messages[0].role, "user");
    const timelineAgents = new Set(triChatTimeline.messages.map((message) => message.agent_id));
    assert.ok(timelineAgents.has("codex"));
    assert.ok(timelineAgents.has("cursor"));
    assert.ok(timelineAgents.has("local-imprint"));
    assert.ok(
      triChatTimeline.messages.some(
        (message) => message.reply_to_message_id === triChatUserMessage.message.message_id
      )
    );
    assert.ok(
      triChatTimeline.messages.some(
        (message) => message.reply_to_message_id === triChatCodexMessage.message.message_id
      )
    );
    assert.ok(
      triChatTimeline.messages.some(
        (message) => message.reply_to_message_id === triChatCursorMessage.message.message_id
      )
    );

    const triChatConsensusUserMessage = await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post-consensus-user", () => mutationCounter++),
      thread_id: triChatThreadId,
      agent_id: "user",
      role: "user",
      content: `consensus test expression ${testId}: 2 + 3 * 4`,
    });
    assert.equal(triChatConsensusUserMessage.ok, true);
    assert.ok(triChatConsensusUserMessage.message.message_id);

    await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post-consensus-codex", () => mutationCounter++),
      thread_id: triChatThreadId,
      agent_id: "codex",
      role: "assistant",
      content: "14",
      reply_to_message_id: triChatConsensusUserMessage.message.message_id,
    });

    await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post-consensus-cursor", () => mutationCounter++),
      thread_id: triChatThreadId,
      agent_id: "cursor",
      role: "assistant",
      content: "14",
      reply_to_message_id: triChatConsensusUserMessage.message.message_id,
    });

    await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post-consensus-imprint", () => mutationCounter++),
      thread_id: triChatThreadId,
      agent_id: "local-imprint",
      role: "assistant",
      content: "20",
      reply_to_message_id: triChatConsensusUserMessage.message.message_id,
    });

    const triChatConsensus = await callTool(client, "trichat.consensus", {
      thread_id: triChatThreadId,
      limit: 120,
      recent_turn_limit: 5,
    });
    assert.equal(triChatConsensus.mode, "basic");
    assert.ok(triChatConsensus.turns_with_any_response >= 1);
    assert.ok(triChatConsensus.disagreement_turns >= 1);
    assert.equal(triChatConsensus.latest_turn.status, "disagreement");
    assert.ok(Array.isArray(triChatConsensus.latest_turn.answers));
    assert.ok(triChatConsensus.latest_turn.answers.length >= 3);
    assert.ok(triChatConsensus.latest_turn.disagreement_agents.includes("local-imprint"));
    assert.equal(triChatConsensus.flagged, true);

    const triChatBusStatus = await callTool(client, "trichat.bus", {
      action: "status",
    });
    assert.equal(typeof triChatBusStatus.running, "boolean");
    assert.equal(typeof triChatBusStatus.socket_path, "string");
    assert.ok(triChatBusStatus.socket_path.length > 0);

    const triChatBusPublishMissingMutation = await callToolExpectError(client, "trichat.bus", {
      action: "publish",
      thread_id: triChatThreadId,
      event_type: "integration.manual-event",
      source_agent: "codex",
    });
    assert.match(triChatBusPublishMissingMutation, /mutation|required|invalid/i);

    const triChatBusPublish = await callTool(client, "trichat.bus", {
      action: "publish",
      mutation: nextMutation(testId, "trichat.bus.publish", () => mutationCounter++),
      thread_id: triChatThreadId,
      event_type: "integration.manual-event",
      source_agent: "codex",
      source_client: "mcp-v02.integration",
      role: "system",
      content: `integration bus event ${testId}`,
      metadata: {
        scope: "integration-test",
      },
    });
    assert.equal(triChatBusPublish.action, "publish");
    assert.equal(typeof triChatBusPublish.event.event_seq, "number");
    assert.equal(triChatBusPublish.event.event_type, "integration.manual-event");

    const triChatBusTail = await callTool(client, "trichat.bus", {
      action: "tail",
      thread_id: triChatThreadId,
      since_seq: 0,
      limit: 50,
    });
    assert.ok(Array.isArray(triChatBusTail.events));
    assert.ok(triChatBusTail.events.length >= 1);
    assert.ok(
      triChatBusTail.events.some((event) => event.event_type === "trichat.message_post"),
      "Expected trichat.message_post bus events in tail output"
    );
    assert.ok(
      triChatBusTail.events.some((event) => event.event_type === "integration.manual-event"),
      "Expected integration.manual-event in bus tail output"
    );

    const triChatRetentionDryRun = await callTool(client, "trichat.retention", {
      mutation: nextMutation(testId, "trichat.retention", () => mutationCounter++),
      older_than_days: 0,
      thread_id: triChatThreadId,
      limit: 100,
      dry_run: true,
    });
    assert.equal(triChatRetentionDryRun.thread_id, triChatThreadId);
    assert.ok(triChatRetentionDryRun.candidate_count >= 2);
    assert.equal(triChatRetentionDryRun.deleted_count, 0);

    const triChatSummary = await callTool(client, "trichat.summary", {
      busiest_limit: 10,
    });
    assert.ok(triChatSummary.thread_counts.total >= 1);
    assert.ok(triChatSummary.message_count >= 4);
    assert.ok(Array.isArray(triChatSummary.busiest_threads));

    const adapterTelemetryInitial = await callTool(client, "trichat.adapter_telemetry", {
      action: "status",
      event_limit: 10,
    });
    assert.equal(typeof adapterTelemetryInitial.summary.total_channels, "number");
    assert.ok(Array.isArray(adapterTelemetryInitial.states));

    const telemetryOpenUntil = new Date(Date.now() + 60_000).toISOString();
    const telemetryOpenedAt = new Date(Date.now() - 1_000).toISOString();
    const adapterTelemetryRecorded = await callTool(client, "trichat.adapter_telemetry", {
      action: "record",
      mutation: nextMutation(testId, "trichat.adapter_telemetry-record", () => mutationCounter++),
      states: [
        {
          agent_id: "codex",
          channel: "command",
          open: true,
          open_until: telemetryOpenUntil,
          failure_count: 0,
          trip_count: 1,
          success_count: 0,
          last_error: "bridge timeout",
          last_opened_at: telemetryOpenedAt,
          turn_count: 2,
          degraded_turn_count: 1,
          last_result: "trip-opened",
          metadata: {
            source: "integration-test",
          },
        },
        {
          agent_id: "codex",
          channel: "model",
          open: false,
          failure_count: 0,
          trip_count: 0,
          success_count: 2,
          turn_count: 2,
          degraded_turn_count: 1,
          last_result: "success",
          metadata: {
            source: "integration-test",
          },
        },
      ],
      events: [
        {
          agent_id: "codex",
          channel: "command",
          event_type: "trip_opened",
          open_until: telemetryOpenUntil,
          error_text: "bridge timeout",
          details: {
            threshold: 2,
          },
        },
      ],
    });
    assert.equal(adapterTelemetryRecorded.action, "record");
    assert.equal(adapterTelemetryRecorded.recorded_state_count, 2);
    assert.equal(adapterTelemetryRecorded.recorded_event_count, 1);
    assert.ok(adapterTelemetryRecorded.status.summary.total_channels >= 2);

    const adapterTelemetryStatus = await callTool(client, "trichat.adapter_telemetry", {
      action: "status",
      agent_id: "codex",
      event_limit: 20,
    });
    assert.ok(adapterTelemetryStatus.state_count >= 2);
    assert.ok(
      adapterTelemetryStatus.states.some(
        (state) => state.agent_id === "codex" && state.channel === "command" && state.open === true
      )
    );
    assert.ok(adapterTelemetryStatus.summary.total_trips >= 1);
    assert.ok(
      adapterTelemetryStatus.last_open_events.some((event) => event.event_type === "trip_opened")
    );

    const triChatAutoRetentionRunOnce = await callTool(client, "trichat.auto_retention", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.auto_retention-run_once", () => mutationCounter++),
      older_than_days: 3650,
      limit: 100,
    });
    assert.equal(typeof triChatAutoRetentionRunOnce.tick.candidate_count, "number");

    const triChatAutoRetentionStart = await callTool(client, "trichat.auto_retention", {
      action: "start",
      mutation: nextMutation(testId, "trichat.auto_retention-start", () => mutationCounter++),
      interval_seconds: 15,
      older_than_days: 45,
      limit: 1500,
      run_immediately: false,
    });
    assert.equal(triChatAutoRetentionStart.running, true);
    assert.equal(triChatAutoRetentionStart.persisted.enabled, true);
    assert.equal(triChatAutoRetentionStart.persisted.interval_seconds, 15);
    assert.equal(triChatAutoRetentionStart.persisted.older_than_days, 45);
    assert.equal(triChatAutoRetentionStart.persisted.limit, 1500);

    const triChatAutoRetentionStatus = await callTool(client, "trichat.auto_retention", {
      action: "status",
    });
    assert.equal(triChatAutoRetentionStatus.running, true);
    assert.equal(triChatAutoRetentionStatus.config.interval_seconds, 15);
    assert.equal(triChatAutoRetentionStatus.config.older_than_days, 45);
    assert.equal(triChatAutoRetentionStatus.config.limit, 1500);

    const triChatAutoRetentionStop = await callTool(client, "trichat.auto_retention", {
      action: "stop",
      mutation: nextMutation(testId, "trichat.auto_retention-stop", () => mutationCounter++),
    });
    assert.equal(triChatAutoRetentionStop.running, false);
    assert.equal(triChatAutoRetentionStop.persisted.enabled, false);

    const durableTaskIdC = `task-${testId}-c`;
    await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create-c", () => mutationCounter++),
      task_id: durableTaskIdC,
      objective: `Run failing branch for auto retry ${testId}`,
      project_dir: REPO_ROOT,
      payload: {
        dry_run: true,
      },
      priority: 3,
    });
    await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim-c", () => mutationCounter++),
      task_id: durableTaskIdC,
      worker_id: workerId,
      lease_seconds: 120,
    });
    await callTool(client, "task.fail", {
      mutation: nextMutation(testId, "task.fail-c", () => mutationCounter++),
      task_id: durableTaskIdC,
      worker_id: workerId,
      error: "auto retry candidate failure",
      result: { exit_code: 2 },
    });

    const autoRetryRunOnce = await callTool(client, "task.auto_retry", {
      action: "run_once",
      mutation: nextMutation(testId, "task.auto_retry-run_once", () => mutationCounter++),
      batch_limit: 25,
      base_delay_seconds: 0,
      max_delay_seconds: 0,
    });
    assert.ok(autoRetryRunOnce.tick);
    assert.ok(autoRetryRunOnce.tick.retried_count >= 1);
    assert.ok(
      autoRetryRunOnce.tick.run_results.some(
        (entry) => entry.task_id === durableTaskIdC && entry.retried === true
      )
    );

    const pendingAfterAutoRetry = await callTool(client, "task.list", {
      status: "pending",
      limit: 200,
    });
    assert.ok(
      pendingAfterAutoRetry.tasks.some((task) => task.task_id === durableTaskIdC),
      "Expected failed task to be rescheduled to pending by task.auto_retry"
    );

    const mutationCheckReplaySafe = await callTool(client, "mutation.check", {
      tool_name: "memory.append",
      idempotency_key: noteMutation.idempotency_key,
      side_effect_fingerprint: noteMutation.side_effect_fingerprint,
    });
    assert.equal(mutationCheckReplaySafe.exists, true);
    assert.equal(mutationCheckReplaySafe.valid_for_execution, true);
    assert.equal(mutationCheckReplaySafe.reason, "replay-safe");

    const mutationCheckMismatch = await callTool(client, "mutation.check", {
      tool_name: "memory.append",
      idempotency_key: noteMutation.idempotency_key,
      side_effect_fingerprint: `${noteMutation.side_effect_fingerprint}-wrong`,
    });
    assert.equal(mutationCheckMismatch.exists, true);
    assert.equal(mutationCheckMismatch.valid_for_execution, false);
    assert.equal(mutationCheckMismatch.reason, "mismatch");

    const sessionId = `session-${testId}`;
    const transcriptLog = await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log", () => mutationCounter++),
      run_id: sessionId,
      role: "user",
      content: `Raw transcript line for ${testId}`,
    });
    assert.equal(typeof transcriptLog.id, "number");

    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log", () => mutationCounter++),
      run_id: sessionId,
      role: "assistant",
      content: `Follow-up action for ${testId} should be tested.`,
    });

    const promoteTranscriptLine = await callTool(client, "knowledge.promote", {
      mutation: nextMutation(testId, "knowledge.promote-line", () => mutationCounter++),
      source_type: "transcript_line",
      source_id: String(transcriptLog.id),
      tags: ["line-promotion"],
      reason: "transcript line promotion path",
    });
    assert.ok(promoteTranscriptLine.memory_id);

    const squishMutation = nextMutation(testId, "transcript.squish", () => mutationCounter++);
    const transcriptSquish = await callTool(client, "transcript.squish", {
      mutation: squishMutation,
      run_id: sessionId,
      max_points: 6,
    });
    assert.equal(transcriptSquish.created_memory, true);
    assert.ok(typeof transcriptSquish.memory_id === "number");
    assert.ok(transcriptSquish.squished_count >= 2);

    const transcriptSquishReplay = await callTool(client, "transcript.squish", {
      mutation: squishMutation,
      run_id: sessionId,
      max_points: 6,
    });
    assert.equal(transcriptSquishReplay.replayed, true);

    const transcriptRunTimeline = await callTool(client, "transcript.run_timeline", {
      run_id: sessionId,
      include_squished: true,
      limit: 20,
    });
    assert.ok(transcriptRunTimeline.count >= 2);
    assert.ok(Array.isArray(transcriptRunTimeline.lines));

    const transcriptPendingRuns = await callTool(client, "transcript.pending_runs", {
      limit: 20,
    });
    assert.ok(Array.isArray(transcriptPendingRuns.runs));

    const autoSquishStatus = await callTool(client, "transcript.auto_squish", {
      action: "status",
    });
    assert.equal(typeof autoSquishStatus.running, "boolean");
    assert.equal(typeof autoSquishStatus.in_tick, "boolean");

    const daemonRunId = `daemon-${testId}`;
    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log-daemon-1", () => mutationCounter++),
      run_id: daemonRunId,
      role: "user",
      content: `Daemon backlog line 1 for ${testId}`,
    });
    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log-daemon-2", () => mutationCounter++),
      run_id: daemonRunId,
      role: "assistant",
      content: `Daemon backlog line 2 for ${testId}`,
    });

    const pendingBeforeAutoSquish = await callTool(client, "transcript.pending_runs", {
      limit: 50,
    });
    assert.ok(
      pendingBeforeAutoSquish.runs.some((run) => run.run_id === daemonRunId),
      "Expected daemon run to appear in pending backlog before auto squish run_once"
    );

    const autoSquishRunOnce = await callTool(client, "transcript.auto_squish", {
      action: "run_once",
      mutation: nextMutation(testId, "transcript.auto_squish-run-once", () => mutationCounter++),
      batch_runs: 50,
      per_run_limit: 500,
      max_points: 6,
    });
    assert.ok(autoSquishRunOnce.tick);
    assert.ok(Array.isArray(autoSquishRunOnce.tick.run_results));
    assert.ok(
      autoSquishRunOnce.tick.run_results.some((run) => run.run_id === daemonRunId && run.created_memory === true),
      "Expected run_once to squish daemon run into a memory"
    );

    const pendingAfterAutoSquish = await callTool(client, "transcript.pending_runs", {
      limit: 50,
    });
    assert.equal(
      pendingAfterAutoSquish.runs.some((run) => run.run_id === daemonRunId),
      false,
      "Expected daemon run to be drained from pending backlog after run_once"
    );

    const autoSquishStart = await callTool(client, "transcript.auto_squish", {
      action: "start",
      mutation: nextMutation(testId, "transcript.auto_squish-start", () => mutationCounter++),
      interval_seconds: 30,
      batch_runs: 10,
      per_run_limit: 200,
      max_points: 8,
      run_immediately: false,
    });
    assert.equal(autoSquishStart.running, true);

    const autoSquishRunningStatus = await callTool(client, "transcript.auto_squish", {
      action: "status",
    });
    assert.equal(autoSquishRunningStatus.running, true);

    const autoSquishStop = await callTool(client, "transcript.auto_squish", {
      action: "stop",
      mutation: nextMutation(testId, "transcript.auto_squish-stop", () => mutationCounter++),
    });
    assert.equal(autoSquishStop.running, false);

    const retentionRunId = `retention-${testId}`;
    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log-retention-1", () => mutationCounter++),
      run_id: retentionRunId,
      role: "user",
      content: `Retention squished line 1 for ${testId}`,
    });
    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log-retention-2", () => mutationCounter++),
      run_id: retentionRunId,
      role: "assistant",
      content: `Retention squished line 2 for ${testId}`,
    });
    await callTool(client, "transcript.squish", {
      mutation: nextMutation(testId, "transcript.squish-retention", () => mutationCounter++),
      run_id: retentionRunId,
      max_points: 6,
    });

    const retentionDryRun = await callTool(client, "transcript.retention", {
      mutation: nextMutation(testId, "transcript.retention-dry", () => mutationCounter++),
      older_than_days: 0,
      run_id: retentionRunId,
      limit: 100,
      dry_run: true,
    });
    assert.ok(retentionDryRun.candidate_count >= 1);
    assert.equal(retentionDryRun.deleted_count, 0);

    const retentionApply = await callTool(client, "transcript.retention", {
      mutation: nextMutation(testId, "transcript.retention-apply", () => mutationCounter++),
      older_than_days: 0,
      run_id: retentionRunId,
      limit: 100,
      dry_run: false,
    });
    assert.ok(retentionApply.deleted_count >= 1);

    const retentionTimeline = await callTool(client, "transcript.run_timeline", {
      run_id: retentionRunId,
      include_squished: true,
      limit: 50,
    });
    assert.equal(retentionTimeline.count, 0);

    const retentionRawRunId = `retention-raw-${testId}`;
    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log-retention-raw", () => mutationCounter++),
      run_id: retentionRawRunId,
      role: "user",
      content: `Retention raw unsquished line for ${testId}`,
    });

    const retentionRawProtected = await callTool(client, "transcript.retention", {
      mutation: nextMutation(testId, "transcript.retention-raw-safe", () => mutationCounter++),
      older_than_days: 0,
      run_id: retentionRawRunId,
      include_unsquished: false,
      limit: 100,
      dry_run: true,
    });
    assert.equal(retentionRawProtected.candidate_count, 0);

    const retentionRawApply = await callTool(client, "transcript.retention", {
      mutation: nextMutation(testId, "transcript.retention-raw-apply", () => mutationCounter++),
      older_than_days: 0,
      run_id: retentionRawRunId,
      include_unsquished: true,
      limit: 100,
      dry_run: false,
    });
    assert.ok(retentionRawApply.deleted_count >= 1);

    const transcript = await callTool(client, "transcript.append", {
      mutation: nextMutation(testId, "transcript.append", () => mutationCounter++),
      session_id: sessionId,
      source_client: "cursor-tests",
      source_model: "local-test",
      source_agent: "integration-suite",
      kind: "user",
      text: `Decision made for ${testId}. Next action is validating all tool paths.`,
    });
    assert.ok(transcript.id);

    const transcriptSummary = await callTool(client, "transcript.summarize", {
      mutation: nextMutation(testId, "transcript.summarize", () => mutationCounter++),
      session_id: sessionId,
      provider: "auto",
      max_points: 6,
    });
    assert.equal(transcriptSummary.enabled, true);
    assert.ok(transcriptSummary.note_id);

    const whoKnows = await callTool(client, "who_knows", { query: testId, limit: 10 });
    assert.equal(whoKnows.local_only, true);
    assert.ok(whoKnows.counts.matches >= 1);
    assert.ok(whoKnows.counts.memories >= 1);

    const whoKnowsRaw = await callTool(client, "who_knows", {
      query: `Raw transcript line for ${testId}`,
      session_id: sessionId,
      limit: 10,
    });
    assert.ok(
      whoKnowsRaw.matches.some((match) => match.type === "memory" || match.type === "transcript_line"),
      "Expected memory or transcript_line match for raw transcript query"
    );

    const knowledgeQuery = await callTool(client, "knowledge.query", { query: testId, limit: 10 });
    assert.equal(knowledgeQuery.local_only, true);
    assert.ok(knowledgeQuery.counts.matches >= 1);

    const policyDenied = await callTool(client, "policy.evaluate", {
      mutation: nextMutation(testId, "policy.evaluate-deny", () => mutationCounter++),
      operation: "deprovision_user",
      classification: "destructive",
      target: "ceo",
      protected_targets: ["ceo"],
      confirmations: [{ source: "hris", confirmed: true }],
    });
    assert.equal(policyDenied.allowed, false);
    assert.ok(
      policyDenied.violations.some((violation) => violation.code === "protected-target"),
      "Expected protected-target violation"
    );

    const policyAllowed = await callTool(client, "policy.evaluate", {
      mutation: nextMutation(testId, "policy.evaluate-allow", () => mutationCounter++),
      operation: "deprovision_user",
      classification: "destructive",
      target: "normal-user",
      execution_mode: "staged",
      confirmations: [
        { source: "hris", confirmed: true },
        { source: "it", confirmed: true },
      ],
    });
    assert.equal(policyAllowed.allowed, true);

    const runId = `run-${testId}`;
    const runBeginMutation = nextMutation(testId, "run.begin", () => mutationCounter++);
    const runBegin = await callTool(client, "run.begin", {
      mutation: runBeginMutation,
      run_id: runId,
      summary: "Begin integration run",
      source_client: "codex-tests",
    });
    assert.equal(runBegin.run_id, runId);

    const runBeginReplay = await callTool(client, "run.begin", {
      mutation: runBeginMutation,
      run_id: runId,
      summary: "Begin integration run",
      source_client: "codex-tests",
    });
    assert.equal(runBeginReplay.run_id, runId);
    assert.equal(runBeginReplay.replayed, true);

    await callTool(client, "run.step", {
      mutation: nextMutation(testId, "run.step", () => mutationCounter++),
      run_id: runId,
      step_index: 1,
      status: "completed",
      summary: "Step completed",
    });

    await callTool(client, "run.end", {
      mutation: nextMutation(testId, "run.end", () => mutationCounter++),
      run_id: runId,
      status: "succeeded",
      summary: "Run completed",
    });

    const timeline = await callTool(client, "run.timeline", { run_id: runId });
    assert.ok(timeline.count >= 3);
    assert.ok(
      timeline.events.some((event) => event.event_type === "begin") &&
        timeline.events.some((event) => event.event_type === "step") &&
        timeline.events.some((event) => event.event_type === "end"),
      "Run timeline should contain begin/step/end events"
    );

    const preflightFail = await callTool(client, "preflight.check", {
      action: "integration-write",
      classification: "write",
      prerequisites: [
        { name: "two-source confirmed", met: false, severity: "error" },
      ],
      invariants: [{ name: "protected target untouched", met: true }],
    });
    assert.equal(preflightFail.pass, false);
    assert.equal(preflightFail.failed_prerequisites.length, 1);

    const postflightFail = await callTool(client, "postflight.verify", {
      action: "integration-write",
      assertions: [{ name: "result status", operator: "eq", expected: "ok", actual: "failed" }],
    });
    assert.equal(postflightFail.pass, false);
    assert.equal(postflightFail.failures.length, 1);

    const lockKey = `lock-${testId}`;
    const lockA = await callTool(client, "lock.acquire", {
      mutation: nextMutation(testId, "lock.acquire-a", () => mutationCounter++),
      lock_key: lockKey,
      owner_id: "agent-a",
      lease_seconds: 120,
    });
    assert.equal(lockA.acquired, true);

    const lockB = await callTool(client, "lock.acquire", {
      mutation: nextMutation(testId, "lock.acquire-b", () => mutationCounter++),
      lock_key: lockKey,
      owner_id: "agent-b",
      lease_seconds: 120,
    });
    assert.equal(lockB.acquired, false);
    assert.equal(lockB.reason, "held-by-active-owner");

    const badRelease = await callTool(client, "lock.release", {
      mutation: nextMutation(testId, "lock.release-b", () => mutationCounter++),
      lock_key: lockKey,
      owner_id: "agent-b",
    });
    assert.equal(badRelease.released, false);
    assert.equal(badRelease.reason, "owner-mismatch");

    const goodRelease = await callTool(client, "lock.release", {
      mutation: nextMutation(testId, "lock.release-a", () => mutationCounter++),
      lock_key: lockKey,
      owner_id: "agent-a",
    });
    assert.equal(goodRelease.released, true);

    const promoted = await callTool(client, "knowledge.promote", {
      mutation: nextMutation(testId, "knowledge.promote", () => mutationCounter++),
      source_type: "memory",
      source_id: String(note.id),
      tags: ["promotion-test"],
      reason: "promotion path validation",
      source_client: "codex-tests",
    });
    assert.ok(promoted.memory_id);

    const promoteMissingSourceError = await callToolExpectError(client, "knowledge.promote", {
      mutation: nextMutation(testId, "knowledge.promote-missing", () => mutationCounter++),
      source_type: "note",
      source_id: `missing-${testId}`,
    });
    assert.match(promoteMissingSourceError, /not found/i);

    const decayResult = await callTool(client, "knowledge.decay", {
      mutation: nextMutation(testId, "knowledge.decay", () => mutationCounter++),
      older_than_days: 1,
      from_tiers: ["raw"],
      to_tier: "deprecated",
      limit: 25,
    });
    assert.equal(typeof decayResult.updated_count, "number");
    assert.ok(Array.isArray(decayResult.updated_ids));

    const hybrid = await callTool(client, "retrieval.hybrid", {
      query: testId,
      limit: 10,
    });
    assert.ok(Array.isArray(hybrid.matches));
    assert.ok(hybrid.matches.length >= 1);
    assert.ok(hybrid.matches[0].citation?.entity_id);
    assert.ok(typeof hybrid.counts.memories === "number");

    const decision = await callTool(client, "decision.link", {
      mutation: nextMutation(testId, "decision.link", () => mutationCounter++),
      title: `decision-${testId}`,
      rationale: "verify decision linkage",
      entity_type: "run",
      entity_id: runId,
      relation: "supports",
      source_client: "codex-tests",
    });
    assert.ok(decision.decision_id);
    assert.ok(decision.link_id);

    const simulation = await callTool(client, "simulate.workflow", {
      workflow: "provision_user",
      employment_type: "FTE",
      manager_dn_resolved: true,
      scim_ready: true,
      actual_outcomes: {
        identity_created: false,
      },
    });
    assert.equal(simulation.deterministic, true);
    assert.equal(simulation.summary.pass, false);
    assert.ok(simulation.summary.mismatches >= 1);

    const incident = await callTool(client, "incident.open", {
      mutation: nextMutation(testId, "incident.open", () => mutationCounter++),
      severity: "P3",
      title: `integration-incident-${testId}`,
      summary: "integration validation event",
      source_client: "codex-tests",
    });
    assert.ok(incident.incident_id);

    const incidentTimeline = await callTool(client, "incident.timeline", {
      incident_id: incident.incident_id,
      limit: 20,
    });
    assert.equal(incidentTimeline.found, true);
    assert.ok(incidentTimeline.events.length >= 1);

    const missingIncident = await callTool(client, "incident.timeline", {
      incident_id: `missing-${testId}`,
      limit: 20,
    });
    assert.equal(missingIncident.found, false);

    const queryPlan = await callTool(client, "query.plan", {
      objective: "validate retrieval planning",
      query: testId,
      required_fields: ["field-that-does-not-exist"],
      limit: 10,
    });
    assert.equal(typeof queryPlan.confidence, "number");
    assert.ok(queryPlan.missing_data.includes("field-that-does-not-exist"));
    assert.ok(Array.isArray(queryPlan.evidence));

    const healthTools = await callTool(client, "health.tools", {});
    assert.equal(healthTools.ok, true);
    assert.equal(healthTools.tool_count, EXPECTED_TOOLS.length);

    const healthStorage = await callTool(client, "health.storage", {});
    assert.equal(healthStorage.ok, true);
    assert.equal(path.resolve(healthStorage.db_path), path.resolve(dbPath));
    assert.equal(healthStorage.db_exists, true);
    assert.ok(healthStorage.schema_version >= 6);
    assert.equal(typeof healthStorage.table_counts.schema_migrations, "number");
    assert.equal(typeof healthStorage.table_counts.daemon_configs, "number");
    assert.equal(typeof healthStorage.table_counts.imprint_profiles, "number");
    assert.equal(typeof healthStorage.table_counts.imprint_snapshots, "number");

    const healthPolicy = await callTool(client, "health.policy", {});
    assert.equal(healthPolicy.ok, true);
    assert.ok(healthPolicy.enforced_rules.length >= 3);

    const migrationStatus = await callTool(client, "migration.status", {});
    assert.ok(migrationStatus.schema_version >= 6);
    assert.ok(Array.isArray(migrationStatus.applied_versions));
    assert.ok(
      migrationStatus.applied_versions.some((entry) => entry.version === 1),
      "Expected migration version 1 to be present"
    );
    assert.ok(
      migrationStatus.applied_versions.some((entry) => entry.version === 2),
      "Expected migration version 2 to be present"
    );
    assert.ok(
      migrationStatus.applied_versions.some((entry) => entry.version === 3),
      "Expected migration version 3 to be present"
    );
    assert.ok(
      migrationStatus.applied_versions.some((entry) => entry.version === 6),
      "Expected migration version 6 to be present"
    );
    assert.equal(typeof migrationStatus.recorded_count, "number");
    assert.equal(typeof migrationStatus.inferred_count, "number");

    const adr = await callTool(client, "adr.create", {
      mutation: nextMutation(testId, "adr.create", () => mutationCounter++),
      title: `MCP integration test ${testId}`,
      content: "Integration test ADR content.",
      status: "proposed",
    });
    assert.equal(adr.ok, true);
    if (adr.path) {
      assert.equal(path.isAbsolute(adr.path), true);
      assert.equal(fs.existsSync(adr.path), true);
      assert.equal(path.dirname(adr.path), ADR_DIR_PATH);
      adrFilesToRemove.add(adr.path);
    }
  } finally {
    await client.close().catch(() => {});
    for (const adrPath of adrFilesToRemove) {
      if (fs.existsSync(adrPath)) {
        fs.unlinkSync(adrPath);
      }
    }
    for (const inboxPath of inboxFilesToRemove) {
      if (fs.existsSync(inboxPath)) {
        fs.unlinkSync(inboxPath);
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function callTool(client, name, args) {
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
}

async function callToolExpectError(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  assert.equal(response.isError, true, `Expected ${name} to fail but it succeeded`);
  return text;
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
