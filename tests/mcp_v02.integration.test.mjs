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
  "knowledge.decay",
  "knowledge.promote",
  "lock.acquire",
  "lock.release",
  "memory.append",
  "policy.evaluate",
  "run.begin",
  "run.end",
  "run.step",
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
  let mutationCounter = 0;

  const env = inheritedEnv({
    ANAMNESIS_HUB_DB_PATH: dbPath,
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
    assert.ok(healthStorage.schema_version >= 3);
    assert.equal(typeof healthStorage.table_counts.schema_migrations, "number");
    assert.equal(typeof healthStorage.table_counts.daemon_configs, "number");
    assert.equal(typeof healthStorage.table_counts.imprint_profiles, "number");
    assert.equal(typeof healthStorage.table_counts.imprint_snapshots, "number");

    const healthPolicy = await callTool(client, "health.policy", {});
    assert.equal(healthPolicy.ok, true);
    assert.ok(healthPolicy.enforced_rules.length >= 3);

    const migrationStatus = await callTool(client, "migration.status", {});
    assert.ok(migrationStatus.schema_version >= 3);
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
