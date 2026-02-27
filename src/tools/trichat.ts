import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const threadStatusSchema = z.enum(["active", "archived"]);
const adapterChannelSchema = z.enum(["command", "model"]);
const turnStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
const turnPhaseSchema = z.enum(["plan", "propose", "critique", "merge", "execute", "verify", "summarize"]);
const turnPhaseStatusSchema = z.enum(["running", "completed", "failed", "skipped"]);
const DEFAULT_CONSENSUS_AGENT_IDS = ["codex", "cursor", "local-imprint"] as const;
const DEFAULT_TURN_AGENT_IDS = [...DEFAULT_CONSENSUS_AGENT_IDS];
const BRIDGE_PROTOCOL_VERSION = "trichat-bridge-v1";
const BRIDGE_RESPONSE_KIND = "trichat.adapter.response";
const BRIDGE_PONG_KIND = "trichat.adapter.pong";
const TURN_PHASE_ORDER: ReadonlyArray<string> = [
  "plan",
  "propose",
  "critique",
  "merge",
  "execute",
  "verify",
  "summarize",
];

export const trichatThreadOpenSchema = z.object({
  mutation: mutationSchema,
  thread_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  status: threadStatusSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatThreadListSchema = z.object({
  status: threadStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const trichatThreadGetSchema = z.object({
  thread_id: z.string().min(1),
});

export const trichatMessagePostSchema = z.object({
  mutation: mutationSchema,
  thread_id: z.string().min(1),
  agent_id: z.string().min(1),
  role: z.string().min(1),
  content: z.string().min(1),
  reply_to_message_id: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTimelineSchema = z.object({
  thread_id: z.string().min(1),
  limit: z.number().int().min(1).max(2000).optional(),
  since: z.string().optional(),
  agent_id: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
});

export const trichatRetentionSchema = z.object({
  mutation: mutationSchema,
  older_than_days: z.number().int().min(0).max(3650),
  thread_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  dry_run: z.boolean().optional(),
});

export const trichatSummarySchema = z.object({
  busiest_limit: z.number().int().min(1).max(200).optional(),
});

export const trichatConsensusSchema = z.object({
  thread_id: z.string().min(1),
  limit: z.number().int().min(1).max(2000).optional(),
  agent_ids: z.array(z.string().min(1)).min(1).max(12).optional(),
  min_agents: z.number().int().min(2).max(12).optional(),
  recent_turn_limit: z.number().int().min(1).max(50).optional(),
});

export const trichatTurnStartSchema = z.object({
  mutation: mutationSchema,
  thread_id: z.string().min(1),
  user_message_id: z.string().min(1),
  user_prompt: z.string().min(1),
  expected_agents: z.array(z.string().min(1)).min(1).max(12).optional(),
  min_agents: z.number().int().min(1).max(12).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTurnAdvanceSchema = z.object({
  mutation: mutationSchema,
  turn_id: z.string().min(1),
  status: turnStatusSchema.optional(),
  phase: turnPhaseSchema.optional(),
  phase_status: turnPhaseStatusSchema.optional(),
  expected_agents: z.array(z.string().min(1)).min(1).max(12).optional(),
  min_agents: z.number().int().min(1).max(12).optional(),
  novelty_score: z.number().min(0).max(1).nullable().optional(),
  novelty_threshold: z.number().min(0).max(1).nullable().optional(),
  retry_required: z.boolean().optional(),
  retry_agents: z.array(z.string().min(1)).max(12).optional(),
  disagreement: z.boolean().optional(),
  decision_summary: z.string().nullable().optional(),
  selected_agent: z.string().nullable().optional(),
  selected_strategy: z.string().nullable().optional(),
  verify_status: z.string().nullable().optional(),
  verify_summary: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTurnArtifactSchema = z.object({
  mutation: mutationSchema,
  turn_id: z.string().min(1),
  phase: turnPhaseSchema,
  artifact_type: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  content: z.string().optional(),
  structured: z.record(z.unknown()).optional(),
  score: z.number().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTurnGetSchema = z
  .object({
    turn_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    include_closed: z.boolean().optional(),
    include_artifacts: z.boolean().optional(),
    artifact_limit: z.number().int().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.turn_id && !value.thread_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turn_id or thread_id is required",
        path: ["turn_id"],
      });
    }
  });

export const trichatWorkboardSchema = z.object({
  thread_id: z.string().min(1).optional(),
  status: turnStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const trichatNoveltySchema = z
  .object({
    turn_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    novelty_threshold: z.number().min(0).max(1).optional(),
    max_similarity: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.turn_id && !value.thread_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turn_id or thread_id is required",
        path: ["turn_id"],
      });
    }
  });

export const trichatTurnOrchestrateSchema = z
  .object({
    mutation: mutationSchema,
    turn_id: z.string().min(1),
    action: z.enum(["decide", "verify_finalize"]).default("decide"),
    novelty_threshold: z.number().min(0).max(1).optional(),
    max_similarity: z.number().min(0).max(1).optional(),
    verify_status: z.enum(["passed", "failed", "skipped", "error"]).optional(),
    verify_summary: z.string().optional(),
    verify_details: z.record(z.unknown()).optional(),
    allow_phase_skip: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "verify_finalize" && !value.verify_status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verify_status is required for verify_finalize action",
        path: ["verify_status"],
      });
    }
  });

const trichatAdapterStateSchema = z.object({
  agent_id: z.string().min(1),
  channel: adapterChannelSchema,
  updated_at: z.string().optional(),
  open: z.boolean(),
  open_until: z.string().optional(),
  failure_count: z.number().int().min(0),
  trip_count: z.number().int().min(0),
  success_count: z.number().int().min(0),
  last_error: z.string().optional(),
  last_opened_at: z.string().optional(),
  turn_count: z.number().int().min(0),
  degraded_turn_count: z.number().int().min(0),
  last_result: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const trichatAdapterEventSchema = z.object({
  agent_id: z.string().min(1),
  channel: adapterChannelSchema,
  event_type: z.string().min(1),
  created_at: z.string().optional(),
  open_until: z.string().optional(),
  error_text: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export const trichatAdapterTelemetrySchema = z
  .object({
    action: z.enum(["status", "record"]).default("status"),
    mutation: mutationSchema.optional(),
    agent_id: z.string().min(1).optional(),
    channel: adapterChannelSchema.optional(),
    event_limit: z.number().int().min(0).max(2000).optional(),
    include_events: z.boolean().optional(),
    states: z.array(trichatAdapterStateSchema).max(2000).optional(),
    events: z.array(trichatAdapterEventSchema).max(5000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "record" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for record action",
        path: ["mutation"],
      });
    }
    if (value.action === "record") {
      const stateCount = value.states?.length ?? 0;
      const eventCount = value.events?.length ?? 0;
      if (stateCount === 0 && eventCount === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "record action requires at least one state or event payload",
          path: ["states"],
        });
      }
    }
  });

export const trichatAdapterProtocolCheckSchema = z.object({
  agent_ids: z.array(z.string().min(1)).min(1).max(12).optional(),
  bridge_commands: z.record(z.string().min(1)).optional(),
  timeout_seconds: z.number().int().min(1).max(120).optional(),
  run_ask_check: z.boolean().optional(),
  ask_dry_run: z.boolean().optional(),
  workspace: z.string().min(1).optional(),
  thread_id: z.string().min(1).optional(),
  ask_prompt: z.string().min(1).optional(),
});

export const trichatAutoRetentionSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(10).max(86400).optional(),
    older_than_days: z.number().int().min(0).max(3650).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    run_immediately: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for start, stop, and run_once actions",
        path: ["mutation"],
      });
    }
  });

export const trichatTurnWatchdogSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    stale_after_seconds: z.number().int().min(15).max(86400).optional(),
    batch_limit: z.number().int().min(1).max(200).optional(),
    stale_before_iso: z.string().optional(),
    run_immediately: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for start, stop, and run_once actions",
        path: ["mutation"],
      });
    }
  });

export const trichatChaosSchema = z
  .object({
    action: z
      .enum(["status", "inject_adapter_failure", "inject_turn_failure", "verify_turn", "run_once"])
      .default("status"),
    mutation: mutationSchema.optional(),
    thread_id: z.string().min(1).optional(),
    turn_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    channel: adapterChannelSchema.optional(),
    reason: z.string().min(1).optional(),
    open_for_seconds: z.number().int().min(5).max(3600).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    title: z.string().min(1).optional(),
    user_prompt: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.action === "inject_adapter_failure" ||
        value.action === "inject_turn_failure" ||
        value.action === "run_once") &&
      !value.mutation
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for mutating chaos actions",
        path: ["mutation"],
      });
    }
    if (value.action === "inject_adapter_failure" && !value.agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent_id is required for inject_adapter_failure action",
        path: ["agent_id"],
      });
    }
    if ((value.action === "inject_turn_failure" || value.action === "verify_turn") && !value.turn_id && !value.thread_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turn_id or thread_id is required",
        path: ["turn_id"],
      });
    }
  });

export const trichatSloSchema = z
  .object({
    action: z.enum(["status", "snapshot", "history"]).default("status"),
    mutation: mutationSchema.optional(),
    window_minutes: z.number().int().min(1).max(10080).optional(),
    event_limit: z.number().int().min(10).max(50000).optional(),
    thread_id: z.string().min(1).optional(),
    history_limit: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "snapshot" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for snapshot action",
        path: ["mutation"],
      });
    }
  });

type TriChatAutoRetentionConfig = {
  interval_seconds: number;
  older_than_days: number;
  limit: number;
};

type TriChatTurnWatchdogConfig = {
  interval_seconds: number;
  stale_after_seconds: number;
  batch_limit: number;
};

type TriChatAutoRetentionTickResult = {
  completed_at: string;
  candidate_count: number;
  deleted_count: number;
  deleted_message_ids: string[];
  skipped?: boolean;
  reason?: string;
};

const DEFAULT_AUTO_RETENTION_CONFIG: TriChatAutoRetentionConfig = {
  interval_seconds: 600,
  older_than_days: 30,
  limit: 1000,
};

const DEFAULT_TURN_WATCHDOG_CONFIG: TriChatTurnWatchdogConfig = {
  interval_seconds: 30,
  stale_after_seconds: 180,
  batch_limit: 10,
};

const autoRetentionRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: TriChatAutoRetentionConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  total_candidates: number;
  total_deleted: number;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_AUTO_RETENTION_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  total_candidates: 0,
  total_deleted: 0,
};

const turnWatchdogRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: TriChatTurnWatchdogConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  stale_detected_count: number;
  escalated_count: number;
  last_escalated_turn_ids: string[];
  last_slo_snapshot_id: string | null;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_TURN_WATCHDOG_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  stale_detected_count: 0,
  escalated_count: 0,
  last_escalated_turn_ids: [],
  last_slo_snapshot_id: null,
};

type TriChatTurnWatchdogTickResult = {
  completed_at: string;
  stale_before_iso: string;
  stale_after_seconds: number;
  candidate_count: number;
  escalated_count: number;
  escalated_turn_ids: string[];
  invariant_failures: Array<{
    turn_id: string;
    failed_checks: string[];
  }>;
  slo_snapshot: {
    snapshot_id: string;
    created_at: string;
  } | null;
  skipped?: boolean;
  reason?: string;
};

type TriChatSloMetrics = {
  computed_at: string;
  thread_id: string | null;
  window_minutes: number;
  since_iso: string;
  event_limit: number;
  adapter: {
    sample_count: number;
    error_count: number;
    error_rate: number;
    latency_sample_count: number;
    p95_latency_ms: number | null;
  };
  turns: {
    total_count: number;
    failed_count: number;
    failure_rate: number;
  };
};

export function trichatThreadOpen(storage: Storage, input: z.infer<typeof trichatThreadOpenSchema>) {
  return storage.upsertTriChatThread({
    thread_id: input.thread_id,
    title: input.title,
    status: input.status,
    metadata: input.metadata,
  });
}

export function trichatThreadList(storage: Storage, input: z.infer<typeof trichatThreadListSchema>) {
  const threads = storage.listTriChatThreads({
    status: input.status,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    count: threads.length,
    threads,
  };
}

export function trichatThreadGet(storage: Storage, input: z.infer<typeof trichatThreadGetSchema>) {
  const thread = storage.getTriChatThreadById(input.thread_id);
  if (!thread) {
    return {
      found: false,
      thread_id: input.thread_id,
    };
  }
  return {
    found: true,
    thread,
  };
}

export function trichatMessagePost(storage: Storage, input: z.infer<typeof trichatMessagePostSchema>) {
  const message = storage.appendTriChatMessage({
    thread_id: input.thread_id,
    agent_id: input.agent_id,
    role: input.role,
    content: input.content,
    reply_to_message_id: input.reply_to_message_id,
    metadata: input.metadata,
  });
  return {
    ok: true,
    message,
  };
}

export function trichatTimeline(storage: Storage, input: z.infer<typeof trichatTimelineSchema>) {
  const messages = storage.getTriChatTimeline({
    thread_id: input.thread_id,
    limit: input.limit ?? 200,
    since: input.since,
    agent_id: input.agent_id,
    role: input.role,
  });
  return {
    thread_id: input.thread_id,
    count: messages.length,
    messages,
  };
}

export function trichatRetention(
  storage: Storage,
  input: Pick<z.infer<typeof trichatRetentionSchema>, "older_than_days" | "thread_id" | "limit" | "dry_run">
) {
  const now = Date.now();
  const cutoff = new Date(now - input.older_than_days * 24 * 60 * 60 * 1000).toISOString();
  const result = storage.pruneTriChatMessages({
    older_than_iso: cutoff,
    thread_id: input.thread_id,
    limit: input.limit ?? 1000,
    dry_run: input.dry_run ?? false,
  });
  return {
    cutoff_iso: cutoff,
    older_than_days: input.older_than_days,
    thread_id: input.thread_id ?? null,
    dry_run: input.dry_run ?? false,
    ...result,
  };
}

export function trichatSummary(storage: Storage, input: z.infer<typeof trichatSummarySchema>) {
  const summary = storage.getTriChatSummary({
    busiest_limit: input.busiest_limit ?? 10,
  });
  return {
    generated_at: new Date().toISOString(),
    ...summary,
  };
}

export function trichatConsensus(storage: Storage, input: z.infer<typeof trichatConsensusSchema>) {
  const timeline = storage.getTriChatTimeline({
    thread_id: input.thread_id,
    limit: input.limit ?? 240,
  });
  const agentIds = normalizeConsensusAgentIds(input.agent_ids);
  const agentSet = new Set(agentIds);
  const minAgents = Math.max(2, Math.min(input.min_agents ?? agentIds.length, agentIds.length));
  const recentTurnLimit = input.recent_turn_limit ?? 8;

  const turnsByUserMessageId = new Map<
    string,
    {
      user_message_id: string;
      user_created_at: string;
      user_excerpt: string;
      responses: Map<string, (typeof timeline)[number]>;
    }
  >();
  const orderedTurns: Array<{
    user_message_id: string;
    user_created_at: string;
    user_excerpt: string;
    responses: Map<string, (typeof timeline)[number]>;
  }> = [];

  for (const message of timeline) {
    if (message.role !== "user") {
      continue;
    }
    const turn = {
      user_message_id: message.message_id,
      user_created_at: message.created_at,
      user_excerpt: compactConsensusText(message.content, 160),
      responses: new Map<string, (typeof timeline)[number]>(),
    };
    turnsByUserMessageId.set(message.message_id, turn);
    orderedTurns.push(turn);
  }

  for (const message of timeline) {
    if (message.role !== "assistant") {
      continue;
    }
    const normalizedAgentId = normalizeConsensusAgentId(message.agent_id);
    if (!normalizedAgentId || !agentSet.has(normalizedAgentId)) {
      continue;
    }
    const replyToId = message.reply_to_message_id?.trim();
    if (!replyToId) {
      continue;
    }
    const turn = turnsByUserMessageId.get(replyToId);
    if (!turn) {
      continue;
    }
    turn.responses.set(normalizedAgentId, message);
  }

  const evaluatedTurns = orderedTurns
    .map((turn) => evaluateConsensusTurn(turn, agentIds, minAgents))
    .filter((turn) => turn.response_count > 0);

  const consensusTurns = evaluatedTurns.filter((turn) => turn.status === "consensus").length;
  const disagreementTurns = evaluatedTurns.filter((turn) => turn.status === "disagreement").length;
  const incompleteTurns = evaluatedTurns.filter((turn) => turn.status === "incomplete").length;
  const analyzedTurns = consensusTurns + disagreementTurns;
  const latestTurn = evaluatedTurns.length ? evaluatedTurns[evaluatedTurns.length - 1] : null;
  const latestDisagreement =
    [...evaluatedTurns].reverse().find((turn) => turn.status === "disagreement") ?? null;

  return {
    generated_at: new Date().toISOString(),
    mode: "basic",
    thread_id: input.thread_id,
    agent_ids: agentIds,
    min_agents: minAgents,
    turns_total: orderedTurns.length,
    turns_with_any_response: evaluatedTurns.length,
    analyzed_turns: analyzedTurns,
    consensus_turns: consensusTurns,
    disagreement_turns: disagreementTurns,
    incomplete_turns: incompleteTurns,
    disagreement_rate: analyzedTurns > 0 ? Number((disagreementTurns / analyzedTurns).toFixed(4)) : null,
    flagged: latestTurn?.status === "disagreement",
    latest_turn: latestTurn,
    latest_disagreement: latestDisagreement,
    recent_turns: evaluatedTurns.slice(-recentTurnLimit),
  };
}

export function trichatTurnStart(storage: Storage, input: z.infer<typeof trichatTurnStartSchema>) {
  const expectedAgents = normalizeConsensusAgentIds(input.expected_agents ?? DEFAULT_TURN_AGENT_IDS);
  const minAgents = Math.max(1, Math.min(input.min_agents ?? expectedAgents.length, expectedAgents.length));
  return storage.createOrGetTriChatTurn({
    thread_id: input.thread_id,
    user_message_id: input.user_message_id,
    user_prompt: input.user_prompt,
    status: "running",
    phase: "plan",
    phase_status: "running",
    expected_agents: expectedAgents,
    min_agents: minAgents,
    metadata: input.metadata,
  });
}

export function trichatTurnAdvance(storage: Storage, input: z.infer<typeof trichatTurnAdvanceSchema>) {
  const existing = storage.getTriChatTurnById(input.turn_id);
  if (!existing) {
    throw new Error(`Tri-chat turn not found: ${input.turn_id}`);
  }
  validateTurnAdvance(existing, input);
  const turn = storage.updateTriChatTurn({
    turn_id: input.turn_id,
    status: input.status,
    phase: input.phase,
    phase_status: input.phase_status,
    expected_agents: input.expected_agents,
    min_agents: input.min_agents,
    novelty_score: input.novelty_score,
    novelty_threshold: input.novelty_threshold,
    retry_required: input.retry_required,
    retry_agents: input.retry_agents,
    disagreement: input.disagreement,
    decision_summary: input.decision_summary,
    selected_agent: input.selected_agent,
    selected_strategy: input.selected_strategy,
    verify_status: input.verify_status,
    verify_summary: input.verify_summary,
    metadata: input.metadata,
  });
  return {
    ok: true,
    turn,
  };
}

export function trichatTurnArtifact(storage: Storage, input: z.infer<typeof trichatTurnArtifactSchema>) {
  const artifact = storage.appendTriChatTurnArtifact({
    turn_id: input.turn_id,
    phase: input.phase,
    artifact_type: input.artifact_type,
    agent_id: input.agent_id,
    content: input.content,
    structured: input.structured,
    score: input.score,
    metadata: input.metadata,
  });
  return {
    ok: true,
    artifact,
  };
}

export function trichatTurnGet(storage: Storage, input: z.infer<typeof trichatTurnGetSchema>) {
  const turn = resolveTurnForLookup(storage, input.turn_id, input.thread_id, input.include_closed ?? true);
  if (!turn) {
    return {
      found: false,
      turn_id: input.turn_id ?? null,
      thread_id: input.thread_id ?? null,
    };
  }
  const includeArtifacts = input.include_artifacts ?? true;
  const artifacts = includeArtifacts
    ? storage.listTriChatTurnArtifacts({
        turn_id: turn.turn_id,
        limit: input.artifact_limit ?? 120,
      })
    : [];
  return {
    found: true,
    turn,
    artifact_count: artifacts.length,
    artifacts,
  };
}

export function trichatWorkboard(storage: Storage, input: z.infer<typeof trichatWorkboardSchema>) {
  const turns = storage.listTriChatTurns({
    thread_id: input.thread_id,
    status: input.status,
    limit: input.limit ?? 30,
  });
  const counts = {
    total: turns.length,
    running: turns.filter((turn) => turn.status === "running").length,
    completed: turns.filter((turn) => turn.status === "completed").length,
    failed: turns.filter((turn) => turn.status === "failed").length,
    cancelled: turns.filter((turn) => turn.status === "cancelled").length,
  };
  const phaseCounts: Record<string, number> = {
    plan: 0,
    propose: 0,
    critique: 0,
    merge: 0,
    execute: 0,
    verify: 0,
    summarize: 0,
  };
  for (const turn of turns) {
    phaseCounts[turn.phase] = (phaseCounts[turn.phase] ?? 0) + 1;
  }
  const latest = turns.length > 0 ? turns[0] : null;
  const active = turns.find((turn) => turn.status === "running") ?? null;
  const latestDecision =
    turns.find((turn) => turn.decision_summary && turn.decision_summary.trim().length > 0) ?? null;

  return {
    generated_at: new Date().toISOString(),
    thread_id: input.thread_id ?? null,
    status_filter: input.status ?? null,
    counts,
    phase_counts: phaseCounts,
    latest_turn: latest,
    active_turn: active,
    latest_decision: latestDecision
      ? {
          turn_id: latestDecision.turn_id,
          decision_summary: latestDecision.decision_summary,
          selected_agent: latestDecision.selected_agent,
          selected_strategy: latestDecision.selected_strategy,
          updated_at: latestDecision.updated_at,
          novelty_score: latestDecision.novelty_score,
        }
      : null,
    turns,
  };
}

export function trichatNovelty(
  storage: Storage,
  input: z.infer<typeof trichatNoveltySchema>
): TriChatNoveltyResult {
  const turn = resolveTurnForLookup(storage, input.turn_id, input.thread_id, true);
  if (!turn) {
    return {
      found: false,
      turn_id: input.turn_id ?? null,
      thread_id: input.thread_id ?? null,
    };
  }

  const noveltyThreshold = clamp(input.novelty_threshold ?? turn.novelty_threshold ?? 0.35, 0, 1);
  const maxSimilarity = clamp(input.max_similarity ?? 0.82, 0, 1);
  const artifacts = storage.listTriChatTurnArtifacts({
    turn_id: turn.turn_id,
    phase: "propose",
    limit: input.limit ?? 200,
  });
  const proposals = collectLatestProposalsByAgent(
    turn,
    artifacts.filter((artifact) => {
      const type = String(artifact.artifact_type ?? "").trim().toLowerCase();
      return type === "proposal" || type === "proposal_retry" || type === "proposal_interop";
    }),
    storage
  );
  const pairs = buildNoveltyPairs(proposals);
  const averageSimilarity =
    pairs.length > 0
      ? Number((pairs.reduce((total, pair) => total + pair.similarity, 0) / pairs.length).toFixed(4))
      : 0;
  const noveltyScore = Number((1 - averageSimilarity).toFixed(4));
  const hottestPair = pairs.length > 0 ? pairs[0] : null;
  const baselineRetryRequired =
    proposals.length >= 2 && (noveltyScore < noveltyThreshold || (hottestPair?.similarity ?? 0) >= maxSimilarity);
  const baselineRetryAgents = baselineRetryRequired
    ? recommendNoveltyRetryAgents(proposals, pairs, maxSimilarity)
    : [];
  const disagreement = inferProposalDisagreement(proposals);
  const baselineNovelty: TriChatNoveltyFoundResult = {
    found: true,
    turn_id: turn.turn_id,
    thread_id: turn.thread_id,
    user_message_id: turn.user_message_id,
    proposal_count: proposals.length,
    proposals,
    pairs,
    average_similarity: averageSimilarity,
    novelty_score: noveltyScore,
    novelty_threshold: noveltyThreshold,
    max_similarity: maxSimilarity,
    retry_required: baselineRetryRequired,
    retry_agents: baselineRetryAgents,
    retry_suppressed: false,
    retry_suppression_reason: null,
    retry_suppression_reference_turn_id: null,
    disagreement,
    decision_hint: baselineRetryRequired
      ? "retry-delta-required"
      : disagreement
        ? "merge-with-critique"
        : "merge-ready",
  };
  const candidateDecision = rankDecisionCandidates(baselineNovelty, {
    artifact_count: 0,
    per_target: {},
    sample: [],
  });
  const dedupeGuard = evaluateRetryDedupeGuard(storage, turn, baselineNovelty, candidateDecision);
  const retrySuppressed = dedupeGuard.suppressed;
  const retryRequired = baselineRetryRequired && !retrySuppressed;
  const retryAgents = retryRequired ? baselineRetryAgents : [];
  const decisionHint = retrySuppressed
    ? "retry-dedupe-suppressed"
    : retryRequired
      ? "retry-delta-required"
      : disagreement
        ? "merge-with-critique"
        : "merge-ready";

  return {
    found: true,
    turn_id: turn.turn_id,
    thread_id: turn.thread_id,
    user_message_id: turn.user_message_id,
    proposal_count: proposals.length,
    proposals,
    pairs,
    average_similarity: averageSimilarity,
    novelty_score: noveltyScore,
    novelty_threshold: noveltyThreshold,
    max_similarity: maxSimilarity,
    retry_required: retryRequired,
    retry_agents: retryAgents,
    retry_suppressed: retrySuppressed,
    retry_suppression_reason: dedupeGuard.reason,
    retry_suppression_reference_turn_id: dedupeGuard.reference_turn_id,
    disagreement,
    decision_hint: decisionHint,
  };
}

export function trichatTurnOrchestrate(storage: Storage, input: z.infer<typeof trichatTurnOrchestrateSchema>) {
  if (input.action === "verify_finalize") {
    return orchestrateVerifyFinalize(storage, input);
  }
  return orchestrateDecision(storage, input);
}

export function trichatAdapterTelemetry(storage: Storage, input: z.infer<typeof trichatAdapterTelemetrySchema>) {
  if (input.action === "status") {
    return buildAdapterTelemetryStatus(storage, input);
  }

  if (!input.mutation) {
    throw new Error("mutation is required for record action");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.adapter_telemetry",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const states = input.states?.length
        ? storage.upsertTriChatAdapterStates({
            states: input.states,
          })
        : [];
      const events = input.events?.length
        ? storage.appendTriChatAdapterEvents({
            events: input.events,
          })
        : [];
      return {
        action: "record",
        recorded_state_count: states.length,
        recorded_event_count: events.length,
        status: buildAdapterTelemetryStatus(storage, {
          agent_id: input.agent_id,
          channel: input.channel,
          include_events: input.include_events,
          event_limit: input.event_limit,
        }),
      };
    },
  });
}

export function trichatAdapterProtocolCheck(
  _storage: Storage,
  input: z.infer<typeof trichatAdapterProtocolCheckSchema>
) {
  const checkedAt = new Date().toISOString();
  const workspace = resolveAdapterProtocolWorkspace(input.workspace);
  const timeoutSeconds = Math.max(1, input.timeout_seconds ?? 8);
  const runAskCheck = input.run_ask_check ?? true;
  const askDryRun = input.ask_dry_run ?? true;
  const threadId = String(input.thread_id ?? "trichat-adapter-protocol-check").trim();
  const askPrompt = String(
    input.ask_prompt ??
      "Protocol diagnostics request: acknowledge adapter readiness in one concise sentence."
  ).trim();
  const pythonBin = resolveAdapterProtocolPython();
  const agentIds = normalizeAdapterProtocolAgentIds(input.agent_ids);

  const results = agentIds.map((agentId) =>
    runAdapterProtocolCheckForAgent({
      agent_id: agentId,
      workspace,
      timeout_seconds: timeoutSeconds,
      command_overrides: input.bridge_commands ?? {},
      python_bin: pythonBin,
      thread_id: threadId,
      ask_prompt: askPrompt,
      run_ask_check: runAskCheck,
      ask_dry_run: askDryRun,
    })
  );

  const pingOkCount = results.filter((entry) => entry.ping.ok).length;
  const askOkCount = results.filter((entry) => !entry.ask || entry.ask.ok).length;
  const allOk = results.every((entry) => entry.ok);

  return {
    generated_at: checkedAt,
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    workspace,
    timeout_seconds: timeoutSeconds,
    run_ask_check: runAskCheck,
    ask_dry_run: askDryRun,
    thread_id: threadId,
    all_ok: allOk,
    counts: {
      total: results.length,
      ok: results.filter((entry) => entry.ok).length,
      ping_ok: pingOkCount,
      ask_ok: askOkCount,
    },
    results,
  };
}

export function initializeTriChatAutoRetentionDaemon(storage: Storage) {
  const persisted = storage.getTriChatAutoRetentionState();
  if (!persisted) {
    autoRetentionRuntime.config = { ...DEFAULT_AUTO_RETENTION_CONFIG };
    stopAutoRetentionDaemon();
    return {
      restored: false,
      running: false,
      config: { ...autoRetentionRuntime.config },
    };
  }

  autoRetentionRuntime.config = resolveAutoRetentionConfig(persisted, DEFAULT_AUTO_RETENTION_CONFIG);
  if (persisted.enabled) {
    startAutoRetentionDaemon(storage);
  } else {
    stopAutoRetentionDaemon();
  }

  return {
    restored: true,
    running: autoRetentionRuntime.running,
    config: { ...autoRetentionRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export function trichatAutoRetentionControl(storage: Storage, input: z.infer<typeof trichatAutoRetentionSchema>) {
  if (input.action === "status") {
    return getAutoRetentionStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.auto_retention",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = autoRetentionRuntime.running;
        autoRetentionRuntime.config = resolveAutoRetentionConfig(input, autoRetentionRuntime.config);
        startAutoRetentionDaemon(storage);
        let initialTick: TriChatAutoRetentionTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runAutoRetentionTick(storage, autoRetentionRuntime.config);
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...autoRetentionRuntime.config },
          persisted: storage.setTriChatAutoRetentionState({
            enabled: true,
            interval_seconds: autoRetentionRuntime.config.interval_seconds,
            older_than_days: autoRetentionRuntime.config.older_than_days,
            limit: autoRetentionRuntime.config.limit,
          }),
          initial_tick: initialTick,
          status: getAutoRetentionStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = autoRetentionRuntime.running;
        stopAutoRetentionDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setTriChatAutoRetentionState({
            enabled: false,
            interval_seconds: autoRetentionRuntime.config.interval_seconds,
            older_than_days: autoRetentionRuntime.config.older_than_days,
            limit: autoRetentionRuntime.config.limit,
          }),
          status: getAutoRetentionStatus(),
        };
      }

      const config = resolveAutoRetentionConfig(input, autoRetentionRuntime.config);
      const tick = runAutoRetentionTick(storage, config);
      return {
        running: autoRetentionRuntime.running,
        tick,
        status: getAutoRetentionStatus(),
      };
    },
  });
}

export function initializeTriChatTurnWatchdogDaemon(storage: Storage) {
  const persisted = storage.getTriChatTurnWatchdogState();
  if (!persisted) {
    turnWatchdogRuntime.config = { ...DEFAULT_TURN_WATCHDOG_CONFIG };
    stopTurnWatchdogDaemon();
    return {
      restored: false,
      running: false,
      config: { ...turnWatchdogRuntime.config },
    };
  }

  turnWatchdogRuntime.config = resolveTurnWatchdogConfig(persisted, DEFAULT_TURN_WATCHDOG_CONFIG);
  if (persisted.enabled) {
    startTurnWatchdogDaemon(storage);
  } else {
    stopTurnWatchdogDaemon();
  }

  return {
    restored: true,
    running: turnWatchdogRuntime.running,
    config: { ...turnWatchdogRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export function trichatTurnWatchdogControl(storage: Storage, input: z.infer<typeof trichatTurnWatchdogSchema>) {
  if (input.action === "status") {
    return getTurnWatchdogStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.turn_watchdog",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = turnWatchdogRuntime.running;
        turnWatchdogRuntime.config = resolveTurnWatchdogConfig(input, turnWatchdogRuntime.config);
        startTurnWatchdogDaemon(storage);
        let initialTick: TriChatTurnWatchdogTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runTurnWatchdogTick(storage, turnWatchdogRuntime.config, {
            stale_before_iso: input.stale_before_iso,
          });
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...turnWatchdogRuntime.config },
          persisted: storage.setTriChatTurnWatchdogState({
            enabled: true,
            interval_seconds: turnWatchdogRuntime.config.interval_seconds,
            stale_after_seconds: turnWatchdogRuntime.config.stale_after_seconds,
            batch_limit: turnWatchdogRuntime.config.batch_limit,
          }),
          initial_tick: initialTick,
          status: getTurnWatchdogStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = turnWatchdogRuntime.running;
        stopTurnWatchdogDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setTriChatTurnWatchdogState({
            enabled: false,
            interval_seconds: turnWatchdogRuntime.config.interval_seconds,
            stale_after_seconds: turnWatchdogRuntime.config.stale_after_seconds,
            batch_limit: turnWatchdogRuntime.config.batch_limit,
          }),
          status: getTurnWatchdogStatus(),
        };
      }

      const config = resolveTurnWatchdogConfig(input, turnWatchdogRuntime.config);
      const tick = runTurnWatchdogTick(storage, config, {
        stale_before_iso: input.stale_before_iso,
      });
      return {
        running: turnWatchdogRuntime.running,
        tick,
        status: getTurnWatchdogStatus(),
      };
    },
  });
}

export function trichatChaos(storage: Storage, input: z.infer<typeof trichatChaosSchema>) {
  if (input.action === "status") {
    return {
      generated_at: new Date().toISOString(),
      recent_events: storage.listTriChatChaosEvents({
        limit: input.limit ?? 25,
      }),
      watchdog: getTurnWatchdogStatus(),
      latest_slo_snapshot: storage.getLatestTriChatSloSnapshot(),
    };
  }

  if (input.action === "verify_turn") {
    const turn = resolveChaosTargetTurn(storage, input.turn_id, input.thread_id, true);
    if (!turn) {
      return {
        ok: false,
        found: false,
        turn_id: input.turn_id ?? null,
        thread_id: input.thread_id ?? null,
      };
    }
    const invariants = evaluateTurnAutoFinalizationInvariants(storage, turn);
    return {
      ok: invariants.ok,
      found: true,
      turn: pickTurnSummary(turn),
      invariants,
    };
  }

  if (!input.mutation) {
    throw new Error("mutation is required for mutating chaos actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.chaos",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "inject_adapter_failure") {
        const injected = injectAdapterFailure(storage, {
          agent_id: input.agent_id ?? "",
          channel: input.channel ?? "model",
          reason:
            input.reason?.trim() ||
            `chaos adapter failure injection for ${input.agent_id ?? "unknown-agent"}/${input.channel ?? "model"}`,
          open_for_seconds: clampInt(input.open_for_seconds ?? 45, 5, 3600),
        });
        return {
          action: input.action,
          ok: true,
          ...injected,
        };
      }

      if (input.action === "inject_turn_failure") {
        const turn = resolveChaosTargetTurn(storage, input.turn_id, input.thread_id, false);
        if (!turn) {
          throw new Error("No running turn found for chaos injection target");
        }
        const result = failTurnWithEvidence(storage, {
          turn,
          source: "trichat.chaos",
          actor: "chaos",
          artifact_type: "chaos_fault",
          reason:
            input.reason?.trim() ||
            `chaos injected failure for turn ${turn.turn_id} at phase ${turn.phase}/${turn.phase_status}`,
          metadata: {
            injected: true,
            action: input.action,
          },
          chaos_action: "inject_turn_failure",
        });
        return {
          action: input.action,
          ok: result.invariants.ok,
          ...result,
        };
      }

      const syntheticThreadId = `trichat-chaos-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const title = input.title?.trim() || "TriChat Chaos Probe";
      const userPrompt = input.user_prompt?.trim() || "chaos probe: validate turn auto-finalization invariants";
      storage.upsertTriChatThread({
        thread_id: syntheticThreadId,
        title,
        status: "archived",
        metadata: {
          source: "trichat.chaos",
          kind: "run_once",
        },
      });
      const userMessage = storage.appendTriChatMessage({
        thread_id: syntheticThreadId,
        agent_id: "user",
        role: "user",
        content: userPrompt,
        metadata: {
          source: "trichat.chaos",
          kind: "run_once_seed",
        },
      });
      const started = trichatTurnStart(storage, {
        mutation: input.mutation!,
        thread_id: syntheticThreadId,
        user_message_id: userMessage.message_id,
        user_prompt: userPrompt,
        expected_agents: ["codex", "cursor", "local-imprint"],
        min_agents: 2,
        metadata: {
          source: "trichat.chaos",
          kind: "run_once",
        },
      });
      const runningTurn = storage.updateTriChatTurn({
        turn_id: started.turn.turn_id,
        status: "running",
        phase: "execute",
        phase_status: "running",
        metadata: {
          source: "trichat.chaos",
          kind: "run_once_execute_seed",
          allow_phase_skip: true,
        },
      });
      const result = failTurnWithEvidence(storage, {
        turn: runningTurn,
        source: "trichat.chaos",
        actor: "chaos",
        artifact_type: "chaos_fault",
        reason: `chaos run_once forced failure for turn ${runningTurn.turn_id}`,
        metadata: {
          injected: true,
          action: "run_once",
        },
        chaos_action: "run_once",
      });
      return {
        action: input.action,
        ok: result.invariants.ok,
        thread_id: syntheticThreadId,
        message_id: userMessage.message_id,
        ...result,
      };
    },
  });
}

export function trichatSlo(storage: Storage, input: z.infer<typeof trichatSloSchema>) {
  if (input.action === "history") {
    const history = storage.listTriChatSloSnapshots({
      limit: input.history_limit ?? 50,
    });
    return {
      generated_at: new Date().toISOString(),
      action: "history",
      count: history.length,
      snapshots: history,
    };
  }

  if (input.action === "status") {
    const computed = computeTriChatSloMetrics(storage, {
      window_minutes: input.window_minutes ?? 60,
      event_limit: input.event_limit ?? 8000,
      thread_id: input.thread_id,
    });
    return {
      generated_at: new Date().toISOString(),
      action: "status",
      metrics: computed,
      latest_snapshot: storage.getLatestTriChatSloSnapshot(),
    };
  }

  if (!input.mutation) {
    throw new Error("mutation is required for snapshot action");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.slo",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const metrics = computeTriChatSloMetrics(storage, {
        window_minutes: input.window_minutes ?? 60,
        event_limit: input.event_limit ?? 8000,
        thread_id: input.thread_id,
      });
      const snapshot = storage.appendTriChatSloSnapshot({
        window_minutes: metrics.window_minutes,
        adapter_sample_count: metrics.adapter.sample_count,
        adapter_error_count: metrics.adapter.error_count,
        adapter_error_rate: metrics.adapter.error_rate,
        adapter_latency_p95_ms: metrics.adapter.p95_latency_ms,
        turn_total_count: metrics.turns.total_count,
        turn_failed_count: metrics.turns.failed_count,
        turn_failure_rate: metrics.turns.failure_rate,
        metadata: {
          source: "trichat.slo",
          thread_id: metrics.thread_id,
          since_iso: metrics.since_iso,
          event_limit: metrics.event_limit,
        },
      });
      return {
        action: "snapshot",
        ok: true,
        metrics,
        snapshot,
      };
    },
  });
}

function resolveAutoRetentionConfig(
  input:
    | z.infer<typeof trichatAutoRetentionSchema>
    | Partial<
        Pick<
          z.infer<typeof trichatAutoRetentionSchema>,
          "interval_seconds" | "older_than_days" | "limit"
        >
      >,
  fallback: TriChatAutoRetentionConfig
): TriChatAutoRetentionConfig {
  return {
    interval_seconds: input.interval_seconds ?? fallback.interval_seconds ?? DEFAULT_AUTO_RETENTION_CONFIG.interval_seconds,
    older_than_days: input.older_than_days ?? fallback.older_than_days ?? DEFAULT_AUTO_RETENTION_CONFIG.older_than_days,
    limit: input.limit ?? fallback.limit ?? DEFAULT_AUTO_RETENTION_CONFIG.limit,
  };
}

function buildAdapterTelemetryStatus(
  storage: Storage,
  input: Pick<z.infer<typeof trichatAdapterTelemetrySchema>, "agent_id" | "channel" | "event_limit" | "include_events">
) {
  const includeEvents = input.include_events ?? true;
  const eventLimit = input.event_limit ?? 50;
  const states = storage.listTriChatAdapterStates({
    agent_id: input.agent_id,
    channel: input.channel,
    limit: 1000,
  });
  const summary = storage.getTriChatAdapterTelemetrySummary({
    agent_id: input.agent_id,
    channel: input.channel,
  });
  const recentEvents = includeEvents
    ? storage.listTriChatAdapterEvents({
        agent_id: input.agent_id,
        channel: input.channel,
        limit: eventLimit,
      })
    : [];
  const lastOpenEvents = includeEvents
    ? storage.listTriChatAdapterEvents({
        agent_id: input.agent_id,
        channel: input.channel,
        event_types: ["trip_opened"],
        limit: Math.min(eventLimit, 25),
      })
    : [];
  return {
    generated_at: new Date().toISOString(),
    agent_id: input.agent_id ?? null,
    channel: input.channel ?? null,
    state_count: states.length,
    states,
    summary,
    recent_events: recentEvents,
    last_open_events: lastOpenEvents,
  };
}

function evaluateConsensusTurn(
  turn: {
    user_message_id: string;
    user_created_at: string;
    user_excerpt: string;
    responses: Map<string, TriChatTimelineMessage>;
  },
  agentIds: string[],
  minAgents: number
) {
  const answers = agentIds
    .map((agentId) => {
      const message = turn.responses.get(agentId);
      if (!message) {
        return null;
      }
      const canonical = canonicalizeConsensusAnswer(message.content);
      return {
        agent_id: agentId,
        message_id: message.message_id,
        created_at: message.created_at,
        answer_excerpt: compactConsensusText(message.content, 140),
        mode: canonical.mode,
        normalized: canonical.normalized,
        numeric_value: canonical.numeric_value,
        canonical: canonical.canonical,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const responseCount = answers.length;
  const groups = new Map<string, { canonical: string; normalized: string; agents: string[] }>();
  for (const answer of answers) {
    const existing = groups.get(answer.canonical);
    if (existing) {
      existing.agents.push(answer.agent_id);
      continue;
    }
    groups.set(answer.canonical, {
      canonical: answer.canonical,
      normalized: answer.normalized,
      agents: [answer.agent_id],
    });
  }
  const rankedGroups = Array.from(groups.values()).sort((left, right) => {
    if (right.agents.length !== left.agents.length) {
      return right.agents.length - left.agents.length;
    }
    return left.canonical.localeCompare(right.canonical);
  });
  const majorityGroup = rankedGroups[0] ?? null;
  const disagreementAgents = majorityGroup
    ? answers
        .filter((answer) => answer.canonical !== majorityGroup.canonical)
        .map((answer) => answer.agent_id)
    : [];

  let status: "incomplete" | "consensus" | "disagreement" = "incomplete";
  if (responseCount >= minAgents) {
    status = groups.size <= 1 ? "consensus" : "disagreement";
  }

  return {
    user_message_id: turn.user_message_id,
    user_created_at: turn.user_created_at,
    user_excerpt: turn.user_excerpt,
    status,
    response_count: responseCount,
    required_count: minAgents,
    agents_responded: answers.map((answer) => answer.agent_id),
    majority_answer: majorityGroup?.normalized ?? null,
    disagreement_agents: disagreementAgents,
    answers: answers.map((answer) => ({
      agent_id: answer.agent_id,
      message_id: answer.message_id,
      created_at: answer.created_at,
      answer_excerpt: answer.answer_excerpt,
      mode: answer.mode,
      normalized: answer.normalized,
      numeric_value: answer.numeric_value,
    })),
  };
}

function validateTurnAdvance(
  existing: ReturnType<Storage["getTriChatTurnById"]> extends infer T
    ? T extends null
      ? never
      : NonNullable<T>
    : never,
  input: z.infer<typeof trichatTurnAdvanceSchema>
) {
  const nextStatus = String(input.status ?? existing.status);
  const nextPhase = String(input.phase ?? existing.phase);
  const nextPhaseStatus = String(input.phase_status ?? existing.phase_status);
  const metadata = (input.metadata ?? {}) as Record<string, unknown>;
  const allowPhaseSkip = metadata.allow_phase_skip === true;

  if (isTerminalTurnStatus(existing.status)) {
    if (nextStatus !== existing.status || nextPhase !== existing.phase || nextPhaseStatus !== existing.phase_status) {
      throw new Error(`Cannot mutate terminal turn ${existing.turn_id} with status=${existing.status}`);
    }
    return;
  }

  const currentIndex = TURN_PHASE_ORDER.indexOf(existing.phase);
  const nextIndex = TURN_PHASE_ORDER.indexOf(nextPhase);
  if (nextIndex < 0) {
    throw new Error(`Unknown phase: ${nextPhase}`);
  }
  if (currentIndex < 0) {
    throw new Error(`Unknown current phase on turn ${existing.turn_id}: ${existing.phase}`);
  }
  if (nextIndex < currentIndex) {
    throw new Error(`Invalid phase regression: ${existing.phase} -> ${nextPhase}`);
  }
  if (!allowPhaseSkip && nextIndex > currentIndex + 1) {
    throw new Error(
      `Invalid phase jump without allow_phase_skip=true: ${existing.phase} -> ${nextPhase}`
    );
  }

  if (nextStatus === "completed" && nextPhase !== "summarize" && !allowPhaseSkip) {
    throw new Error(`Turn can only complete at summarize phase (got ${nextPhase}).`);
  }
  if (nextStatus === "cancelled" && nextPhaseStatus === "completed") {
    throw new Error("Cancelled turn cannot have phase_status=completed.");
  }
}

function isTerminalTurnStatus(value: string): boolean {
  return value === "completed" || value === "failed" || value === "cancelled";
}

type TriChatNoveltyProposal = {
  agent_id: string;
  content: string;
  normalized: string;
  token_count: number;
  source: "artifact" | "timeline";
  created_at: string;
};

type TriChatNoveltyPair = {
  left_agent: string;
  right_agent: string;
  similarity: number;
  overlap_tokens: number;
  total_tokens: number;
};

type TriChatNoveltyFoundResult = {
  found: true;
  turn_id: string;
  thread_id: string;
  user_message_id: string;
  proposal_count: number;
  proposals: TriChatNoveltyProposal[];
  pairs: TriChatNoveltyPair[];
  average_similarity: number;
  novelty_score: number;
  novelty_threshold: number;
  max_similarity: number;
  retry_required: boolean;
  retry_agents: string[];
  retry_suppressed: boolean;
  retry_suppression_reason: string | null;
  retry_suppression_reference_turn_id: string | null;
  disagreement: boolean;
  decision_hint: "retry-delta-required" | "retry-dedupe-suppressed" | "merge-with-critique" | "merge-ready";
};

type TriChatNoveltyMissingResult = {
  found: false;
  turn_id: string | null;
  thread_id: string | null;
};

type TriChatNoveltyResult = TriChatNoveltyFoundResult | TriChatNoveltyMissingResult;

type TriChatRetryDedupeGuard = {
  suppressed: boolean;
  reason: string | null;
  reference_turn_id: string | null;
};

function resolveTurnForLookup(
  storage: Storage,
  turnId: string | undefined,
  threadId: string | undefined,
  includeClosed: boolean
) {
  if (turnId?.trim()) {
    return storage.getTriChatTurnById(turnId);
  }
  if (threadId?.trim()) {
    return storage.getLatestTriChatTurn({
      thread_id: threadId,
      include_closed: includeClosed,
    });
  }
  return null;
}

function collectLatestProposalsByAgent(
  turn: ReturnType<Storage["getTriChatTurnById"]> extends infer T
    ? T extends null
      ? never
      : NonNullable<T>
    : never,
  artifacts: ReturnType<Storage["listTriChatTurnArtifacts"]>,
  storage: Storage
): TriChatNoveltyProposal[] {
  const byAgent = new Map<string, TriChatNoveltyProposal>();

  for (const artifact of artifacts) {
    const agentId = normalizeConsensusAgentId(artifact.agent_id ?? "");
    if (!agentId) {
      continue;
    }
    const candidateText = extractArtifactProposalText(artifact);
    if (!candidateText) {
      continue;
    }
    byAgent.set(agentId, {
      agent_id: agentId,
      content: compactConsensusText(candidateText, 1200),
      normalized: normalizeNoveltyText(candidateText),
      token_count: tokenizeNoveltyText(candidateText).size,
      source: "artifact",
      created_at: artifact.created_at,
    });
  }

  if (byAgent.size === 0) {
    const timeline = storage.getTriChatTimeline({
      thread_id: turn.thread_id,
      limit: 240,
    });
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const message = timeline[index];
      if (message.role !== "assistant") {
        continue;
      }
      if (String(message.reply_to_message_id ?? "").trim() !== turn.user_message_id) {
        continue;
      }
      const agentId = normalizeConsensusAgentId(message.agent_id);
      if (!agentId || byAgent.has(agentId)) {
        continue;
      }
      const text = compactConsensusText(message.content, 1200);
      byAgent.set(agentId, {
        agent_id: agentId,
        content: text,
        normalized: normalizeNoveltyText(text),
        token_count: tokenizeNoveltyText(text).size,
        source: "timeline",
        created_at: message.created_at,
      });
    }
  }

  return [...byAgent.values()].sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

function extractArtifactProposalText(artifact: ReturnType<Storage["listTriChatTurnArtifacts"]>[number]): string {
  const structured = artifact.structured ?? {};
  const structuredCandidates = [
    structured.strategy,
    structured.proposal,
    structured.plan,
    structured.summary,
    structured.content,
  ];
  for (const candidate of structuredCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return String(artifact.content ?? "").trim();
}

function normalizeNoveltyText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeNoveltyText(value: string): Set<string> {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "then",
    "else",
    "when",
    "where",
    "your",
    "have",
    "will",
    "just",
    "very",
    "make",
    "using",
    "into",
    "same",
    "plan",
    "step",
    "steps",
    "agent",
  ]);
  const tokens = normalizeNoveltyText(value)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3 && !stopWords.has(entry));
  return new Set(tokens);
}

function buildNoveltyPairs(proposals: TriChatNoveltyProposal[]): TriChatNoveltyPair[] {
  const pairs: TriChatNoveltyPair[] = [];
  for (let i = 0; i < proposals.length; i += 1) {
    const left = proposals[i];
    if (!left) {
      continue;
    }
    const leftTokens = tokenizeNoveltyText(left.content);
    for (let j = i + 1; j < proposals.length; j += 1) {
      const right = proposals[j];
      if (!right) {
        continue;
      }
      const rightTokens = tokenizeNoveltyText(right.content);
      const overlap = countTokenOverlap(leftTokens, rightTokens);
      const union = leftTokens.size + rightTokens.size - overlap;
      const similarity = union > 0 ? Number((overlap / union).toFixed(4)) : 1;
      pairs.push({
        left_agent: left.agent_id,
        right_agent: right.agent_id,
        similarity,
        overlap_tokens: overlap,
        total_tokens: union,
      });
    }
  }
  pairs.sort((left, right) => {
    if (right.similarity !== left.similarity) {
      return right.similarity - left.similarity;
    }
    const leftKey = `${left.left_agent}/${left.right_agent}`;
    const rightKey = `${right.left_agent}/${right.right_agent}`;
    return leftKey.localeCompare(rightKey);
  });
  return pairs;
}

function countTokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) {
    if (large.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function recommendNoveltyRetryAgents(
  proposals: TriChatNoveltyProposal[],
  pairs: TriChatNoveltyPair[],
  maxSimilarity: number
): string[] {
  if (proposals.length <= 1) {
    return [];
  }

  const retries = new Set<string>();
  const normalizedBuckets = new Map<string, string[]>();
  for (const proposal of proposals) {
    const bucket = normalizedBuckets.get(proposal.normalized);
    if (bucket) {
      bucket.push(proposal.agent_id);
      continue;
    }
    normalizedBuckets.set(proposal.normalized, [proposal.agent_id]);
  }
  for (const agents of normalizedBuckets.values()) {
    if (agents.length <= 1) {
      continue;
    }
    const sorted = [...agents].sort();
    for (const agent of sorted.slice(1)) {
      retries.add(agent);
    }
  }

  const hotPairs = pairs.filter((pair) => pair.similarity >= maxSimilarity).slice(0, 4);
  for (const pair of hotPairs) {
    retries.add([pair.left_agent, pair.right_agent].sort()[1] ?? pair.right_agent);
  }

  if (retries.size === 0 && pairs.length > 0) {
    const hottest = pairs[0];
    if (hottest) {
      retries.add([hottest.left_agent, hottest.right_agent].sort()[1] ?? hottest.right_agent);
    }
  }

  return [...retries].sort();
}

function inferProposalDisagreement(proposals: TriChatNoveltyProposal[]): boolean {
  if (proposals.length <= 1) {
    return false;
  }
  const unique = new Set(proposals.map((proposal) => proposal.normalized).filter((entry) => entry.length > 0));
  return unique.size > 1;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function evaluateRetryDedupeGuard(
  storage: Storage,
  turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>,
  novelty: TriChatNoveltyFoundResult,
  decision: ReturnType<typeof rankDecisionCandidates>
): TriChatRetryDedupeGuard {
  if (!novelty.retry_required) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (!isInternalReliabilityThread(storage, turn.thread_id)) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const previous = findPreviousComparableTurn(storage, turn);
  if (!previous) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const currentPrompt = normalizePromptForDedupe(turn.user_prompt);
  const previousPrompt = normalizePromptForDedupe(previous.user_prompt);
  if (!currentPrompt || currentPrompt !== previousPrompt) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (!previous.selected_agent || !decision.selected_agent) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (normalizeConsensusAgentId(previous.selected_agent) !== normalizeConsensusAgentId(decision.selected_agent)) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (typeof previous.novelty_score !== "number" || !Number.isFinite(previous.novelty_score)) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const noveltyDelta = Math.abs(previous.novelty_score - novelty.novelty_score);
  const noveltyStable = noveltyDelta <= 0.03;
  if (!noveltyStable) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const strategySimilarity = compareTextSimilarity(
    previous.selected_strategy ?? "",
    decision.selected_strategy ?? ""
  );
  if (strategySimilarity < 0.88) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  return {
    suppressed: true,
    reason: `consecutive-heartbeat dedupe suppressed retries (novelty_delta=${noveltyDelta.toFixed(
      3
    )}, strategy_similarity=${strategySimilarity.toFixed(3)})`,
    reference_turn_id: previous.turn_id,
  };
}

function isInternalReliabilityThread(storage: Storage, threadId: string): boolean {
  const normalizedThreadId = String(threadId ?? "").trim().toLowerCase();
  if (!normalizedThreadId) {
    return false;
  }
  if (normalizedThreadId === "trichat-reliability-internal" || normalizedThreadId.startsWith("trichat-reliability-")) {
    return true;
  }
  const thread = storage.getTriChatThreadById(threadId);
  if (!thread) {
    return false;
  }
  const source = String(thread.metadata?.source ?? "").trim().toLowerCase();
  if (source.includes("trichat_reliability")) {
    return true;
  }
  return false;
}

function findPreviousComparableTurn(
  storage: Storage,
  turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>
) {
  const turns = storage.listTriChatTurns({
    thread_id: turn.thread_id,
    limit: 20,
  });
  const previous = turns.find((candidate) => candidate.turn_id !== turn.turn_id) ?? null;
  if (!previous) {
    return null;
  }
  if (!previous.selected_agent || !previous.selected_strategy) {
    return null;
  }
  if (typeof previous.novelty_score !== "number" || !Number.isFinite(previous.novelty_score)) {
    return null;
  }
  return previous;
}

function normalizePromptForDedupe(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compareTextSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeNoveltyText(left);
  const rightTokens = tokenizeNoveltyText(right);
  const overlap = countTokenOverlap(leftTokens, rightTokens);
  const union = leftTokens.size + rightTokens.size - overlap;
  if (union <= 0) {
    return 1;
  }
  return overlap / union;
}

function orchestrateDecision(storage: Storage, input: z.infer<typeof trichatTurnOrchestrateSchema>) {
  const turn = storage.getTriChatTurnById(input.turn_id);
  if (!turn) {
    throw new Error(`Tri-chat turn not found: ${input.turn_id}`);
  }
  if (isTerminalTurnStatus(turn.status)) {
    return {
      ok: true,
      action: "decide",
      replayed: true,
      reason: `turn is terminal (${turn.status})`,
      turn,
    };
  }

  const noveltyEvaluation = trichatNovelty(storage, {
    turn_id: turn.turn_id,
    novelty_threshold: input.novelty_threshold,
    max_similarity: input.max_similarity,
    limit: 300,
  });
  if (!noveltyEvaluation.found) {
    throw new Error(`Cannot orchestrate decision: novelty evaluation missing for turn ${turn.turn_id}`);
  }
  const novelty = noveltyEvaluation;
  const critiqueArtifacts = storage.listTriChatTurnArtifacts({
    turn_id: turn.turn_id,
    phase: "critique",
    artifact_type: "critique",
    limit: 300,
  });
  const critiqueSummary = summarizeCritiques(critiqueArtifacts);
  const decision = rankDecisionCandidates(novelty, critiqueSummary);
  const allowPhaseSkip = input.allow_phase_skip ?? true;
  const metadata = allowPhaseSkip ? { allow_phase_skip: true } : undefined;

  let updated = storage.getTriChatTurnById(turn.turn_id);
  if (!updated) {
    throw new Error(`Turn disappeared during orchestration: ${turn.turn_id}`);
  }
  if (updated.phase === "plan") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "propose",
      phase_status: "completed",
      status: "running",
      novelty_score: novelty.novelty_score,
      novelty_threshold: novelty.novelty_threshold,
      retry_required: novelty.retry_required,
      retry_agents: novelty.retry_agents,
      disagreement: novelty.disagreement,
      metadata,
    });
  } else if (updated.phase === "propose") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "propose",
      phase_status: "completed",
      status: "running",
      novelty_score: novelty.novelty_score,
      novelty_threshold: novelty.novelty_threshold,
      retry_required: novelty.retry_required,
      retry_agents: novelty.retry_agents,
      disagreement: novelty.disagreement,
      metadata,
    });
  }

  if (updated.phase === "critique") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "critique",
      phase_status: critiqueArtifacts.length > 0 ? "completed" : "skipped",
      status: "running",
      metadata,
    });
  }
  if (updated.phase !== "merge") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "merge",
      phase_status: "running",
      status: "running",
      metadata,
    });
  }

  storage.appendTriChatTurnArtifact({
    turn_id: turn.turn_id,
    phase: "merge",
    artifact_type: "decision",
    agent_id: "router",
    content: decision.decision_summary,
    structured: {
      selected_agent: decision.selected_agent,
      selected_strategy: decision.selected_strategy,
      novelty_score: novelty.novelty_score,
      retry_required: novelty.retry_required,
      retry_agents: novelty.retry_agents,
      retry_suppressed: novelty.retry_suppressed,
      retry_suppression_reason: novelty.retry_suppression_reason,
      retry_suppression_reference_turn_id: novelty.retry_suppression_reference_turn_id,
      disagreement: novelty.disagreement,
      score_breakdown: decision.score_breakdown,
      critique_penalties: critiqueSummary.per_target,
    },
    score: decision.score,
    metadata: {
      source: "trichat.turn_orchestrate",
    },
  });

  updated = applyOrchestratedTurnAdvance(storage, updated, {
    phase: "execute",
    phase_status: "running",
    status: "running",
    decision_summary: decision.decision_summary,
    selected_agent: decision.selected_agent,
    selected_strategy: decision.selected_strategy,
    novelty_score: novelty.novelty_score,
    novelty_threshold: novelty.novelty_threshold,
    retry_required: novelty.retry_required,
    retry_agents: novelty.retry_agents,
    disagreement: novelty.disagreement,
    metadata,
  });

  return {
    ok: true,
    action: "decide",
    turn: updated,
    novelty,
    critique: critiqueSummary,
    decision,
  };
}

function orchestrateVerifyFinalize(storage: Storage, input: z.infer<typeof trichatTurnOrchestrateSchema>) {
  const turn = storage.getTriChatTurnById(input.turn_id);
  if (!turn) {
    throw new Error(`Tri-chat turn not found: ${input.turn_id}`);
  }
  if (isTerminalTurnStatus(turn.status)) {
    return {
      ok: true,
      action: "verify_finalize",
      replayed: true,
      reason: `turn is terminal (${turn.status})`,
      turn,
    };
  }

  const verifyStatus = input.verify_status ?? "skipped";
  const verifyFailed = verifyStatus === "failed" || verifyStatus === "error";
  const verifySummary = input.verify_summary?.trim() || `verify ${verifyStatus}`;
  const verifyDetails = input.verify_details ?? {};
  const allowPhaseSkip = input.allow_phase_skip ?? true;
  const metadata = allowPhaseSkip ? { allow_phase_skip: true } : undefined;

  let updated = turn;
  if (updated.phase !== "verify") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "verify",
      phase_status: "running",
      status: "running",
      metadata,
    });
  }

  storage.appendTriChatTurnArtifact({
    turn_id: turn.turn_id,
    phase: "verify",
    artifact_type: "verifier_result",
    agent_id: "router",
    content: verifySummary,
    structured: {
      verify_status: verifyStatus,
      ...verifyDetails,
    },
    score: verifyFailed ? 0.2 : 0.9,
    metadata: {
      source: "trichat.turn_orchestrate",
    },
  });

  updated = applyOrchestratedTurnAdvance(storage, updated, {
    phase: "verify",
    phase_status: verifyFailed ? "failed" : "completed",
    status: "running",
    verify_status: verifyStatus,
    verify_summary: verifySummary,
    metadata,
  });

  updated = applyOrchestratedTurnAdvance(storage, updated, {
    phase: "summarize",
    phase_status: "completed",
    status: verifyFailed ? "failed" : "completed",
    verify_status: verifyStatus,
    verify_summary: verifySummary,
    metadata,
  });

  return {
    ok: true,
    action: "verify_finalize",
    turn: updated,
    verify: {
      status: verifyStatus,
      summary: verifySummary,
      failed: verifyFailed,
    },
  };
}

function applyOrchestratedTurnAdvance(
  storage: Storage,
  existing: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>,
  changes: {
    status?: "running" | "completed" | "failed" | "cancelled";
    phase?: "plan" | "propose" | "critique" | "merge" | "execute" | "verify" | "summarize";
    phase_status?: "running" | "completed" | "failed" | "skipped";
    novelty_score?: number | null;
    novelty_threshold?: number | null;
    retry_required?: boolean;
    retry_agents?: string[];
    disagreement?: boolean;
    decision_summary?: string | null;
    selected_agent?: string | null;
    selected_strategy?: string | null;
    verify_status?: string | null;
    verify_summary?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  validateTurnAdvance(existing, {
    mutation: {
      idempotency_key: "internal",
      side_effect_fingerprint: "internal",
    },
    turn_id: existing.turn_id,
    status: changes.status,
    phase: changes.phase,
    phase_status: changes.phase_status,
    novelty_score: changes.novelty_score,
    novelty_threshold: changes.novelty_threshold,
    retry_required: changes.retry_required,
    retry_agents: changes.retry_agents,
    disagreement: changes.disagreement,
    decision_summary: changes.decision_summary ?? undefined,
    selected_agent: changes.selected_agent ?? undefined,
    selected_strategy: changes.selected_strategy ?? undefined,
    verify_status: changes.verify_status ?? undefined,
    verify_summary: changes.verify_summary ?? undefined,
    metadata: changes.metadata,
  });
  return storage.updateTriChatTurn({
    turn_id: existing.turn_id,
    status: changes.status,
    phase: changes.phase,
    phase_status: changes.phase_status,
    novelty_score: changes.novelty_score,
    novelty_threshold: changes.novelty_threshold,
    retry_required: changes.retry_required,
    retry_agents: changes.retry_agents,
    disagreement: changes.disagreement,
    decision_summary: changes.decision_summary,
    selected_agent: changes.selected_agent,
    selected_strategy: changes.selected_strategy,
    verify_status: changes.verify_status,
    verify_summary: changes.verify_summary,
    metadata: changes.metadata,
  });
}

function summarizeCritiques(artifacts: ReturnType<Storage["listTriChatTurnArtifacts"]>) {
  const perTarget: Record<string, number> = {};
  const sample: Array<{ critic: string; target: string; concern_count: number }> = [];
  for (const artifact of artifacts) {
    const structured = artifact.structured ?? {};
    const target = normalizeConsensusAgentId(
      String(structured.target_agent ?? artifact.metadata?.target_agent ?? "")
    );
    if (!target) {
      continue;
    }
    const concerns = Array.isArray(structured.concerns) ? structured.concerns : [];
    const concernCount = Math.max(1, concerns.length);
    perTarget[target] = (perTarget[target] ?? 0) + concernCount;
    sample.push({
      critic: normalizeConsensusAgentId(String(structured.critic_agent ?? artifact.agent_id ?? "")),
      target,
      concern_count: concernCount,
    });
  }
  return {
    artifact_count: artifacts.length,
    per_target: perTarget,
    sample: sample.slice(0, 12),
  };
}

function rankDecisionCandidates(
  novelty: TriChatNoveltyFoundResult,
  critiqueSummary: ReturnType<typeof summarizeCritiques>
) {
  const pairByAgent = new Map<string, { total_similarity: number; count: number }>();
  for (const pair of novelty.pairs) {
    const left = pairByAgent.get(pair.left_agent) ?? { total_similarity: 0, count: 0 };
    left.total_similarity += pair.similarity;
    left.count += 1;
    pairByAgent.set(pair.left_agent, left);

    const right = pairByAgent.get(pair.right_agent) ?? { total_similarity: 0, count: 0 };
    right.total_similarity += pair.similarity;
    right.count += 1;
    pairByAgent.set(pair.right_agent, right);
  }

  const confidenceByAgent = new Map<string, number>();
  for (const proposal of novelty.proposals) {
    confidenceByAgent.set(proposal.agent_id, inferProposalConfidence(proposal.content));
  }

  const ranked = novelty.proposals
    .map((proposal) => {
      const aggregate = pairByAgent.get(proposal.agent_id);
      const avgSimilarity = aggregate && aggregate.count > 0 ? aggregate.total_similarity / aggregate.count : 0;
      const uniqueness = 1 - avgSimilarity;
      const confidence = confidenceByAgent.get(proposal.agent_id) ?? 0.5;
      const critiquePenalty = Math.min(0.4, (critiqueSummary.per_target[proposal.agent_id] ?? 0) * 0.08);
      const score = Number((uniqueness * 0.55 + confidence * 0.35 - critiquePenalty).toFixed(4));
      return {
        agent_id: proposal.agent_id,
        strategy: compactConsensusText(proposal.content, 260),
        uniqueness: Number(uniqueness.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        critique_penalty: Number(critiquePenalty.toFixed(4)),
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.agent_id.localeCompare(right.agent_id);
    });

  const selected = ranked[0] ?? {
    agent_id: "router",
    strategy: "fallback decision due to missing proposals",
    uniqueness: 0,
    confidence: 0.4,
    critique_penalty: 0,
    score: 0.4,
  };
  const decisionSummary = `turn decision: selected ${selected.agent_id} strategy. score=${selected.score.toFixed(
    2
  )} novelty=${novelty.novelty_score.toFixed(2)} retry=${novelty.retry_required ? "on" : "off"}${
    novelty.retry_suppressed ? " retry_suppressed=on" : ""
  } disagreement=${
    novelty.disagreement ? "on" : "off"
  }`;

  return {
    selected_agent: selected.agent_id,
    selected_strategy: selected.strategy,
    score: selected.score,
    decision_summary: decisionSummary,
    score_breakdown: ranked,
  };
}

function inferProposalConfidence(content: string): number {
  const extracted = extractJSONObject(content);
  if (!extracted) {
    return 0.5;
  }
  try {
    const parsed = JSON.parse(extracted) as Record<string, unknown>;
    const raw = parsed.confidence;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return clamp(raw, 0.05, 0.99);
    }
    if (typeof raw === "string") {
      const parsedNumber = Number.parseFloat(raw);
      if (Number.isFinite(parsedNumber)) {
        return clamp(parsedNumber, 0.05, 0.99);
      }
    }
  } catch {
    return 0.5;
  }
  return 0.5;
}

function extractJSONObject(value: string): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return null;
  }
  return trimmed.slice(first, last + 1).trim();
}

type AdapterProtocolCheckInput = {
  agent_id: string;
  workspace: string;
  timeout_seconds: number;
  command_overrides: Record<string, string>;
  python_bin: string;
  thread_id: string;
  ask_prompt: string;
  run_ask_check: boolean;
  ask_dry_run: boolean;
};

type AdapterProtocolCommandResolution = {
  command: string | null;
  source: "input" | "env" | "auto" | "missing";
  wrapper_candidates: string[];
};

type AdapterProtocolExecResult = {
  ok: boolean;
  duration_ms: number;
  error: string | null;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  signal: string | null;
  envelope: Record<string, unknown> | null;
};

function resolveAdapterProtocolWorkspace(inputWorkspace: string | undefined): string {
  const base = String(inputWorkspace ?? "").trim();
  if (!base) {
    return process.cwd();
  }
  return path.resolve(base);
}

function resolveAdapterProtocolPython(): string {
  const raw = String(process.env.TRICHAT_BRIDGE_PYTHON ?? "python3").trim();
  return raw || "python3";
}

function normalizeAdapterProtocolAgentIds(agentIds: readonly string[] | undefined): string[] {
  const normalized = normalizeConsensusAgentIds(agentIds).filter((entry) => entry.length > 0);
  if (normalized.length > 0) {
    return normalized;
  }
  return [...DEFAULT_CONSENSUS_AGENT_IDS];
}

function runAdapterProtocolCheckForAgent(input: AdapterProtocolCheckInput) {
  const resolution = resolveAdapterProtocolCommand(input);
  if (!resolution.command) {
    const missingStep = {
      ok: false,
      duration_ms: 0,
      request_id: null,
      envelope_kind: null,
      protocol_version: null,
      error: "bridge command not resolved",
      stdout_excerpt: null,
      stderr_excerpt: null,
      exit_code: null,
      signal: null,
    };
    return {
      agent_id: input.agent_id,
      command: null,
      command_source: resolution.source,
      wrapper_candidates: resolution.wrapper_candidates,
      ok: false,
      ping: missingStep,
      ask: input.run_ask_check ? missingStep : null,
    };
  }

  const pingRequestId = buildAdapterProtocolRequestId(input.agent_id, "ping");
  const pingPayload = {
    op: "ping",
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    request_id: pingRequestId,
    agent_id: input.agent_id,
    thread_id: input.thread_id,
    workspace: input.workspace,
    timestamp: new Date().toISOString(),
  };
  const pingExecution = runAdapterProtocolCommand({
    command: resolution.command,
    payload: pingPayload,
    timeout_seconds: Math.min(input.timeout_seconds, 8),
    workspace: input.workspace,
  });
  const pingValidationError = validateAdapterProtocolEnvelope({
    envelope: pingExecution.envelope,
    expected_kind: BRIDGE_PONG_KIND,
    expected_request_id: pingRequestId,
    expected_agent_id: input.agent_id,
    require_content: false,
  });
  const pingError = pingExecution.error ?? pingValidationError;
  const pingStep = {
    ok: pingError === null,
    duration_ms: pingExecution.duration_ms,
    request_id: pingRequestId,
    envelope_kind: safeAdapterEnvelopeField(pingExecution.envelope?.kind),
    protocol_version: safeAdapterEnvelopeField(pingExecution.envelope?.protocol_version),
    error: pingError,
    stdout_excerpt: excerptAdapterText(pingExecution.stdout),
    stderr_excerpt: excerptAdapterText(pingExecution.stderr),
    exit_code: pingExecution.exit_code,
    signal: pingExecution.signal,
  };

  let askStep:
    | {
        ok: boolean;
        duration_ms: number;
        request_id: string | null;
        envelope_kind: string | null;
        protocol_version: string | null;
        error: string | null;
        stdout_excerpt: string | null;
        stderr_excerpt: string | null;
        exit_code: number | null;
        signal: string | null;
      }
    | null = null;

  if (input.run_ask_check) {
    const askRequestId = buildAdapterProtocolRequestId(input.agent_id, "ask");
    const askPayload = {
      op: "ask",
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      request_id: askRequestId,
      agent_id: input.agent_id,
      thread_id: input.thread_id,
      prompt: input.ask_prompt,
      history: [],
      peer_context: "",
      bootstrap_text: "",
      workspace: input.workspace,
      timestamp: new Date().toISOString(),
      turn_phase: "diagnostics",
      role_hint: "protocol-check",
      role_objective: "verify adapter protocol compliance",
      response_mode: "plain",
      collaboration_contract: "protocol diagnostics only",
    };
    const askExecution = runAdapterProtocolCommand({
      command: resolution.command,
      payload: askPayload,
      timeout_seconds: input.timeout_seconds,
      workspace: input.workspace,
      env_overrides: input.ask_dry_run ? { TRICHAT_BRIDGE_DRY_RUN: "1" } : undefined,
    });
    const askValidationError = validateAdapterProtocolEnvelope({
      envelope: askExecution.envelope,
      expected_kind: BRIDGE_RESPONSE_KIND,
      expected_request_id: askRequestId,
      expected_agent_id: input.agent_id,
      require_content: true,
    });
    const askError = askExecution.error ?? askValidationError;
    askStep = {
      ok: askError === null,
      duration_ms: askExecution.duration_ms,
      request_id: askRequestId,
      envelope_kind: safeAdapterEnvelopeField(askExecution.envelope?.kind),
      protocol_version: safeAdapterEnvelopeField(askExecution.envelope?.protocol_version),
      error: askError,
      stdout_excerpt: excerptAdapterText(askExecution.stdout),
      stderr_excerpt: excerptAdapterText(askExecution.stderr),
      exit_code: askExecution.exit_code,
      signal: askExecution.signal,
    };
  }

  const ok = pingStep.ok && (!askStep || askStep.ok);
  return {
    agent_id: input.agent_id,
    command: resolution.command,
    command_source: resolution.source,
    wrapper_candidates: resolution.wrapper_candidates,
    ok,
    ping: pingStep,
    ask: askStep,
  };
}

function resolveAdapterProtocolCommand(input: AdapterProtocolCheckInput): AdapterProtocolCommandResolution {
  const normalizedAgentId = normalizeConsensusAgentId(input.agent_id);
  const commandOverrides = input.command_overrides ?? {};
  const directOverride = String(commandOverrides[normalizedAgentId] ?? "").trim();
  const underscoredOverride = String(commandOverrides[normalizedAgentId.replace(/-/g, "_")] ?? "").trim();
  if (directOverride) {
    return {
      command: directOverride,
      source: "input",
      wrapper_candidates: [],
    };
  }
  if (underscoredOverride) {
    return {
      command: underscoredOverride,
      source: "input",
      wrapper_candidates: [],
    };
  }

  const envKeyByAgent: Record<string, string> = {
    codex: "TRICHAT_CODEX_CMD",
    cursor: "TRICHAT_CURSOR_CMD",
    "local-imprint": "TRICHAT_IMPRINT_CMD",
  };
  const envKey = envKeyByAgent[normalizedAgentId] ?? "";
  const envValue = envKey ? String(process.env[envKey] ?? "").trim() : "";
  if (envValue) {
    return {
      command: envValue,
      source: "env",
      wrapper_candidates: [],
    };
  }

  const bridgeCandidates = [
    path.join(input.workspace, "bridges", `${normalizedAgentId}_bridge.py`),
    path.join(input.workspace, "bridges", `${normalizedAgentId.replace(/-/g, "_")}_bridge.py`),
  ];
  const existingWrapper = bridgeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!existingWrapper) {
    return {
      command: null,
      source: "missing",
      wrapper_candidates: bridgeCandidates,
    };
  }

  return {
    command: `${JSON.stringify(input.python_bin)} ${JSON.stringify(existingWrapper)}`,
    source: "auto",
    wrapper_candidates: bridgeCandidates,
  };
}

function runAdapterProtocolCommand(input: {
  command: string;
  payload: Record<string, unknown>;
  timeout_seconds: number;
  workspace: string;
  env_overrides?: Record<string, string>;
}): AdapterProtocolExecResult {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Math.floor(input.timeout_seconds * 1000));
  const spawned = spawnSync("/bin/sh", ["-lc", input.command], {
    cwd: input.workspace,
    input: `${JSON.stringify(input.payload)}\n`,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256_000,
    env: {
      ...process.env,
      ...(input.env_overrides ?? {}),
    },
  });
  const durationMs = Date.now() - startedAt;
  const stdout = String(spawned.stdout ?? "");
  const stderr = String(spawned.stderr ?? "");
  const exitCode = typeof spawned.status === "number" ? spawned.status : null;
  const signal = spawned.signal ? String(spawned.signal) : null;

  if (spawned.error) {
    const timedOut =
      spawned.error.name === "TimeoutError" || String((spawned.error as NodeJS.ErrnoException).code ?? "") === "ETIMEDOUT";
    const message = timedOut
      ? `bridge command timed out after ${input.timeout_seconds}s`
      : `bridge command failed: ${spawned.error.message}`;
    return {
      ok: false,
      duration_ms: durationMs,
      error: message,
      stdout,
      stderr,
      exit_code: exitCode,
      signal,
      envelope: decodeAdapterProtocolEnvelope(stdout),
    };
  }

  if (exitCode !== 0) {
    const reason = excerptAdapterText(stderr) ?? excerptAdapterText(stdout) ?? "bridge command returned non-zero exit code";
    return {
      ok: false,
      duration_ms: durationMs,
      error: `bridge command failed (exit=${exitCode}${signal ? ` signal=${signal}` : ""}): ${reason}`,
      stdout,
      stderr,
      exit_code: exitCode,
      signal,
      envelope: decodeAdapterProtocolEnvelope(stdout),
    };
  }

  const envelope = decodeAdapterProtocolEnvelope(stdout);
  if (!envelope) {
    return {
      ok: false,
      duration_ms: durationMs,
      error: "bridge protocol violation: adapter stdout was not valid JSON envelope",
      stdout,
      stderr,
      exit_code: exitCode,
      signal,
      envelope: null,
    };
  }

  return {
    ok: true,
    duration_ms: durationMs,
    error: null,
    stdout,
    stderr,
    exit_code: exitCode,
    signal,
    envelope,
  };
}

function validateAdapterProtocolEnvelope(input: {
  envelope: Record<string, unknown> | null;
  expected_kind: string;
  expected_request_id: string;
  expected_agent_id: string;
  require_content: boolean;
}): string | null {
  if (!input.envelope) {
    return "bridge protocol violation: missing adapter envelope";
  }
  const kind = safeAdapterEnvelopeField(input.envelope.kind);
  const protocolVersion = safeAdapterEnvelopeField(input.envelope.protocol_version);
  const requestId = safeAdapterEnvelopeField(input.envelope.request_id);
  const agentId = safeAdapterEnvelopeField(input.envelope.agent_id);

  if (kind !== input.expected_kind) {
    return `bridge protocol violation: expected kind=${input.expected_kind} got=${kind ?? "(missing)"}`;
  }
  if (protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return `bridge protocol violation: expected protocol_version=${BRIDGE_PROTOCOL_VERSION} got=${protocolVersion ?? "(missing)"}`;
  }
  if (requestId !== input.expected_request_id) {
    return `bridge protocol violation: expected request_id=${input.expected_request_id} got=${requestId ?? "(missing)"}`;
  }
  if (normalizeConsensusAgentId(agentId) !== normalizeConsensusAgentId(input.expected_agent_id)) {
    return `bridge protocol violation: expected agent_id=${input.expected_agent_id} got=${agentId ?? "(missing)"}`;
  }

  if (input.require_content) {
    const content = safeAdapterEnvelopeField(input.envelope.content);
    if (!content) {
      return "bridge protocol violation: ask response missing content";
    }
  }

  return null;
}

function decodeAdapterProtocolEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function safeAdapterEnvelopeField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function excerptAdapterText(value: string): string | null {
  const compact = compactConsensusText(String(value ?? ""), 280);
  return compact.length > 0 ? compact : null;
}

function buildAdapterProtocolRequestId(agentId: string, operation: string): string {
  const normalizedAgent = normalizeConsensusAgentId(agentId).replace(/[^a-z0-9-]+/g, "-");
  const normalizedOperation = normalizeConsensusAgentId(operation).replace(/[^a-z0-9-]+/g, "-");
  const safeAgent = normalizedAgent || "agent";
  const safeOperation = normalizedOperation || "op";
  return `trichat-protocol-${safeAgent}-${safeOperation}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

type TriChatTimelineMessage = ReturnType<Storage["getTriChatTimeline"]>[number];

function normalizeConsensusAgentIds(agentIds: readonly string[] | undefined): string[] {
  const values = (agentIds?.length ? agentIds : DEFAULT_CONSENSUS_AGENT_IDS).map((agentId) =>
    normalizeConsensusAgentId(agentId)
  );
  const deduped = new Set<string>();
  for (const value of values) {
    if (value) {
      deduped.add(value);
    }
  }
  if (deduped.size > 0) {
    return Array.from(deduped);
  }
  return [...DEFAULT_CONSENSUS_AGENT_IDS];
}

function normalizeConsensusAgentId(agentId: string | null | undefined): string {
  return String(agentId ?? "")
    .trim()
    .toLowerCase();
}

function compactConsensusText(value: string, limit: number): string {
  const compact = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= limit) {
    return compact;
  }
  if (limit <= 3) {
    return compact.slice(0, limit);
  }
  return `${compact.slice(0, limit - 3)}...`;
}

function canonicalizeConsensusAnswer(value: string): {
  mode: "numeric" | "text";
  normalized: string;
  numeric_value: number | null;
  canonical: string;
} {
  const normalized = normalizeConsensusText(value);
  const numericValue = extractConsensusNumericValue(normalized);
  if (numericValue !== null) {
    const canonicalNumber = Number(numericValue.toPrecision(12));
    return {
      mode: "numeric",
      normalized: canonicalNumber.toString(),
      numeric_value: canonicalNumber,
      canonical: `n:${canonicalNumber.toString()}`,
    };
  }
  return {
    mode: "text",
    normalized,
    numeric_value: null,
    canonical: `t:${normalized}`,
  };
}

function normalizeConsensusText(value: string): string {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^(answer|result|final answer)\s*[:=-]\s*/i, "")
    .trim();
}

function extractConsensusNumericValue(normalized: string): number | null {
  const numericLiteral = /[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

  if (/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const answerMatch = normalized.match(
    /(?:answer|result|final answer)\s*[:=-]\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i
  );
  if (answerMatch?.[1]) {
    const parsed = Number(answerMatch[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const eqMatches = Array.from(normalized.matchAll(/=\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi));
  if (eqMatches.length > 0) {
    const parsed = Number(eqMatches[eqMatches.length - 1]?.[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const numbers = Array.from(normalized.matchAll(numericLiteral));
  if (numbers.length === 0) {
    return null;
  }
  const parsed = Number(numbers[numbers.length - 1]?.[0]);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function getAutoRetentionStatus() {
  return {
    running: autoRetentionRuntime.running,
    in_tick: autoRetentionRuntime.in_tick,
    config: { ...autoRetentionRuntime.config },
    started_at: autoRetentionRuntime.started_at,
    last_tick_at: autoRetentionRuntime.last_tick_at,
    last_error: autoRetentionRuntime.last_error,
    stats: {
      tick_count: autoRetentionRuntime.tick_count,
      total_candidates: autoRetentionRuntime.total_candidates,
      total_deleted: autoRetentionRuntime.total_deleted,
    },
  };
}

function startAutoRetentionDaemon(storage: Storage) {
  stopAutoRetentionDaemon();
  autoRetentionRuntime.running = true;
  autoRetentionRuntime.in_tick = false;
  autoRetentionRuntime.started_at = new Date().toISOString();
  autoRetentionRuntime.last_error = null;
  autoRetentionRuntime.timer = setInterval(() => {
    try {
      runAutoRetentionTick(storage, autoRetentionRuntime.config);
    } catch (error) {
      autoRetentionRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, autoRetentionRuntime.config.interval_seconds * 1000);
  autoRetentionRuntime.timer.unref?.();
}

function stopAutoRetentionDaemon() {
  if (autoRetentionRuntime.timer) {
    clearInterval(autoRetentionRuntime.timer);
  }
  autoRetentionRuntime.timer = null;
  autoRetentionRuntime.running = false;
  autoRetentionRuntime.in_tick = false;
}

function runAutoRetentionTick(
  storage: Storage,
  config: TriChatAutoRetentionConfig
): TriChatAutoRetentionTickResult {
  if (autoRetentionRuntime.in_tick) {
    return {
      completed_at: new Date().toISOString(),
      candidate_count: 0,
      deleted_count: 0,
      deleted_message_ids: [],
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  autoRetentionRuntime.in_tick = true;
  try {
    const result = trichatRetention(storage, {
      older_than_days: config.older_than_days,
      limit: config.limit,
      dry_run: false,
    });

    const completedAt = new Date().toISOString();
    autoRetentionRuntime.tick_count += 1;
    autoRetentionRuntime.total_candidates += result.candidate_count;
    autoRetentionRuntime.total_deleted += result.deleted_count;
    autoRetentionRuntime.last_tick_at = completedAt;
    autoRetentionRuntime.last_error = null;

    return {
      completed_at: completedAt,
      candidate_count: result.candidate_count,
      deleted_count: result.deleted_count,
      deleted_message_ids: result.deleted_message_ids,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    autoRetentionRuntime.tick_count += 1;
    autoRetentionRuntime.last_tick_at = completedAt;
    autoRetentionRuntime.last_error = message;
    return {
      completed_at: completedAt,
      candidate_count: 0,
      deleted_count: 0,
      deleted_message_ids: [],
      reason: message,
    };
  } finally {
    autoRetentionRuntime.in_tick = false;
  }
}

function resolveTurnWatchdogConfig(
  input:
    | z.infer<typeof trichatTurnWatchdogSchema>
    | Partial<Pick<z.infer<typeof trichatTurnWatchdogSchema>, "interval_seconds" | "stale_after_seconds" | "batch_limit">>,
  fallback: TriChatTurnWatchdogConfig
): TriChatTurnWatchdogConfig {
  return {
    interval_seconds:
      input.interval_seconds ??
      fallback.interval_seconds ??
      DEFAULT_TURN_WATCHDOG_CONFIG.interval_seconds,
    stale_after_seconds:
      input.stale_after_seconds ??
      fallback.stale_after_seconds ??
      DEFAULT_TURN_WATCHDOG_CONFIG.stale_after_seconds,
    batch_limit: input.batch_limit ?? fallback.batch_limit ?? DEFAULT_TURN_WATCHDOG_CONFIG.batch_limit,
  };
}

function getTurnWatchdogStatus() {
  return {
    running: turnWatchdogRuntime.running,
    in_tick: turnWatchdogRuntime.in_tick,
    config: { ...turnWatchdogRuntime.config },
    started_at: turnWatchdogRuntime.started_at,
    last_tick_at: turnWatchdogRuntime.last_tick_at,
    last_error: turnWatchdogRuntime.last_error,
    last_slo_snapshot_id: turnWatchdogRuntime.last_slo_snapshot_id,
    stats: {
      tick_count: turnWatchdogRuntime.tick_count,
      stale_detected_count: turnWatchdogRuntime.stale_detected_count,
      escalated_count: turnWatchdogRuntime.escalated_count,
      last_escalated_turn_ids: [...turnWatchdogRuntime.last_escalated_turn_ids],
    },
  };
}

function startTurnWatchdogDaemon(storage: Storage) {
  stopTurnWatchdogDaemon();
  turnWatchdogRuntime.running = true;
  turnWatchdogRuntime.in_tick = false;
  turnWatchdogRuntime.started_at = new Date().toISOString();
  turnWatchdogRuntime.last_error = null;
  turnWatchdogRuntime.timer = setInterval(() => {
    try {
      runTurnWatchdogTick(storage, turnWatchdogRuntime.config, {});
    } catch (error) {
      turnWatchdogRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, turnWatchdogRuntime.config.interval_seconds * 1000);
  turnWatchdogRuntime.timer.unref?.();
}

function stopTurnWatchdogDaemon() {
  if (turnWatchdogRuntime.timer) {
    clearInterval(turnWatchdogRuntime.timer);
  }
  turnWatchdogRuntime.timer = null;
  turnWatchdogRuntime.running = false;
  turnWatchdogRuntime.in_tick = false;
}

function runTurnWatchdogTick(
  storage: Storage,
  config: TriChatTurnWatchdogConfig,
  overrides: {
    stale_before_iso?: string;
  }
): TriChatTurnWatchdogTickResult {
  if (turnWatchdogRuntime.in_tick) {
    return {
      completed_at: new Date().toISOString(),
      stale_before_iso: new Date(Date.now() - config.stale_after_seconds * 1000).toISOString(),
      stale_after_seconds: config.stale_after_seconds,
      candidate_count: 0,
      escalated_count: 0,
      escalated_turn_ids: [],
      invariant_failures: [],
      slo_snapshot: null,
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  turnWatchdogRuntime.in_tick = true;
  try {
    const staleBeforeIso = normalizeIsoTimestamp(
      overrides.stale_before_iso,
      new Date(Date.now() - config.stale_after_seconds * 1000).toISOString()
    );
    const staleTurns = storage.listStaleRunningTriChatTurns({
      stale_before_iso: staleBeforeIso,
      limit: config.batch_limit,
    });

    const invariantFailures: TriChatTurnWatchdogTickResult["invariant_failures"] = [];
    const escalatedTurnIds: string[] = [];
    for (const turn of staleTurns) {
      const now = new Date();
      const lastUpdatedAt = normalizeIsoTimestamp(turn.updated_at, now.toISOString());
      const staleForMs = Math.max(0, now.getTime() - Date.parse(lastUpdatedAt));
      const staleForSeconds = Math.round(staleForMs / 1000);
      const reason = `watchdog timeout: turn ${turn.turn_id} stalled ${staleForSeconds}s at ${turn.phase}/${turn.phase_status}`;
      const escalated = failTurnWithEvidence(storage, {
        turn,
        source: "trichat.turn_watchdog",
        actor: "watchdog",
        artifact_type: "watchdog_timeout",
        reason,
        metadata: {
          stale_before_iso: staleBeforeIso,
          stale_after_seconds: config.stale_after_seconds,
          stale_for_seconds: staleForSeconds,
        },
        chaos_action: "watchdog_timeout",
      });
      escalatedTurnIds.push(escalated.turn.turn_id);
      if (!escalated.invariants.ok) {
        invariantFailures.push({
          turn_id: escalated.turn.turn_id,
          failed_checks: escalated.invariants.checks
            .filter((check) => !check.met)
            .map((check) => check.name),
        });
      }
    }

    const completedAt = new Date().toISOString();
    turnWatchdogRuntime.tick_count += 1;
    turnWatchdogRuntime.stale_detected_count += staleTurns.length;
    turnWatchdogRuntime.escalated_count += escalatedTurnIds.length;
    turnWatchdogRuntime.last_escalated_turn_ids = escalatedTurnIds.slice(0, 20);
    turnWatchdogRuntime.last_tick_at = completedAt;
    turnWatchdogRuntime.last_error = null;

    let snapshotRecord: ReturnType<Storage["appendTriChatSloSnapshot"]> | null = null;
    if (shouldPersistSloSnapshot(storage, completedAt)) {
      const metrics = computeTriChatSloMetrics(storage, {
        window_minutes: 60,
        event_limit: 8000,
      });
      snapshotRecord = storage.appendTriChatSloSnapshot({
        window_minutes: metrics.window_minutes,
        adapter_sample_count: metrics.adapter.sample_count,
        adapter_error_count: metrics.adapter.error_count,
        adapter_error_rate: metrics.adapter.error_rate,
        adapter_latency_p95_ms: metrics.adapter.p95_latency_ms,
        turn_total_count: metrics.turns.total_count,
        turn_failed_count: metrics.turns.failed_count,
        turn_failure_rate: metrics.turns.failure_rate,
        metadata: {
          source: "trichat.turn_watchdog",
          stale_before_iso: staleBeforeIso,
          stale_after_seconds: config.stale_after_seconds,
          candidate_count: staleTurns.length,
          escalated_count: escalatedTurnIds.length,
        },
      });
      turnWatchdogRuntime.last_slo_snapshot_id = snapshotRecord.snapshot_id;
    }

    return {
      completed_at: completedAt,
      stale_before_iso: staleBeforeIso,
      stale_after_seconds: config.stale_after_seconds,
      candidate_count: staleTurns.length,
      escalated_count: escalatedTurnIds.length,
      escalated_turn_ids: escalatedTurnIds,
      invariant_failures: invariantFailures,
      slo_snapshot: snapshotRecord
        ? {
            snapshot_id: snapshotRecord.snapshot_id,
            created_at: snapshotRecord.created_at,
          }
        : null,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    turnWatchdogRuntime.tick_count += 1;
    turnWatchdogRuntime.last_tick_at = completedAt;
    turnWatchdogRuntime.last_error = message;
    return {
      completed_at: completedAt,
      stale_before_iso: new Date(Date.now() - config.stale_after_seconds * 1000).toISOString(),
      stale_after_seconds: config.stale_after_seconds,
      candidate_count: 0,
      escalated_count: 0,
      escalated_turn_ids: [],
      invariant_failures: [],
      slo_snapshot: null,
      reason: message,
    };
  } finally {
    turnWatchdogRuntime.in_tick = false;
  }
}

function shouldPersistSloSnapshot(storage: Storage, nowIso: string): boolean {
  const latest = storage.getLatestTriChatSloSnapshot();
  if (!latest) {
    return true;
  }
  const latestEpoch = Date.parse(latest.created_at);
  const nowEpoch = Date.parse(nowIso);
  if (!Number.isFinite(latestEpoch) || !Number.isFinite(nowEpoch)) {
    return true;
  }
  return nowEpoch - latestEpoch >= 60_000;
}

function resolveChaosTargetTurn(
  storage: Storage,
  turnId: string | undefined,
  threadId: string | undefined,
  includeClosed: boolean
) {
  const normalizedTurnId = String(turnId ?? "").trim();
  if (normalizedTurnId) {
    return storage.getTriChatTurnById(normalizedTurnId);
  }
  const normalizedThreadId = String(threadId ?? "").trim();
  if (!normalizedThreadId) {
    return null;
  }
  const running = storage.getLatestTriChatTurn({
    thread_id: normalizedThreadId,
    include_closed: false,
  });
  if (running) {
    return running;
  }
  if (!includeClosed) {
    return null;
  }
  return storage.getLatestTriChatTurn({
    thread_id: normalizedThreadId,
    include_closed: true,
  });
}

function pickTurnSummary(turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>) {
  return {
    turn_id: turn.turn_id,
    thread_id: turn.thread_id,
    status: turn.status,
    phase: turn.phase,
    phase_status: turn.phase_status,
    updated_at: turn.updated_at,
    finished_at: turn.finished_at,
    selected_agent: turn.selected_agent,
    verify_status: turn.verify_status,
    verify_summary: turn.verify_summary,
  };
}

function injectAdapterFailure(
  storage: Storage,
  input: {
    agent_id: string;
    channel: z.infer<typeof adapterChannelSchema>;
    reason: string;
    open_for_seconds: number;
  }
) {
  const agentId = normalizeConsensusAgentId(input.agent_id);
  if (!agentId) {
    throw new Error("agent_id is required");
  }
  const channel = input.channel;
  const now = new Date().toISOString();
  const openForSeconds = clampInt(input.open_for_seconds, 5, 3600);
  const openUntil = new Date(Date.now() + openForSeconds * 1000).toISOString();
  const existing = storage.listTriChatAdapterStates({
    agent_id: agentId,
    channel,
    limit: 1,
  })[0];
  const state = storage.upsertTriChatAdapterStates({
    states: [
      {
        agent_id: agentId,
        channel,
        updated_at: now,
        open: true,
        open_until: openUntil,
        failure_count: 0,
        trip_count: (existing?.trip_count ?? 0) + 1,
        success_count: existing?.success_count ?? 0,
        last_error: input.reason,
        last_opened_at: now,
        turn_count: existing?.turn_count ?? 0,
        degraded_turn_count: existing?.degraded_turn_count ?? 0,
        last_result: "trip-opened",
        metadata: {
          ...(existing?.metadata ?? {}),
          chaos_injected: true,
          chaos_injected_at: now,
          chaos_reason: input.reason,
          chaos_open_for_seconds: openForSeconds,
        },
      },
    ],
  })[0];
  const event = storage.appendTriChatAdapterEvents({
    events: [
      {
        agent_id: agentId,
        channel,
        event_type: "trip_opened",
        open_until: openUntil,
        error_text: input.reason,
        details: {
          source: "trichat.chaos",
          injected: true,
          open_for_seconds: openForSeconds,
        },
      },
    ],
  })[0];
  const chaosEvent = storage.appendTriChatChaosEvent({
    action: "inject_adapter_failure",
    outcome: "injected",
    agent_id: agentId,
    channel,
    details: {
      reason: input.reason,
      open_until: openUntil,
    },
  });
  return {
    state,
    event,
    chaos_event: chaosEvent,
  };
}

function failTurnWithEvidence(
  storage: Storage,
  input: {
    turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>;
    source: string;
    actor: string;
    artifact_type: string;
    reason: string;
    metadata?: Record<string, unknown>;
    chaos_action: string;
  }
) {
  const turn = input.turn;
  if (isTerminalTurnStatus(turn.status)) {
    const invariants = evaluateTurnAutoFinalizationInvariants(storage, turn);
    const chaosEvent = storage.appendTriChatChaosEvent({
      action: input.chaos_action,
      outcome: "skipped-terminal",
      thread_id: turn.thread_id,
      turn_id: turn.turn_id,
      agent_id: input.actor,
      details: {
        source: input.source,
        reason: input.reason,
        status: turn.status,
      },
    });
    return {
      turn,
      artifact: null,
      message: null,
      bus_event: null,
      invariants,
      chaos_event: chaosEvent,
    };
  }

  const compactReason = compactConsensusText(input.reason, 800);
  const artifact = storage.appendTriChatTurnArtifact({
    turn_id: turn.turn_id,
    phase: turn.phase,
    artifact_type: input.artifact_type,
    agent_id: input.actor,
    content: compactReason,
    structured: {
      source: input.source,
      reason: compactReason,
      from_phase: turn.phase,
      from_phase_status: turn.phase_status,
      from_status: turn.status,
    },
    metadata: {
      source: input.source,
      ...input.metadata,
    },
  });
  const updated = storage.updateTriChatTurn({
    turn_id: turn.turn_id,
    status: "failed",
    phase: "summarize",
    phase_status: "failed",
    verify_status: "error",
    verify_summary: compactReason,
    metadata: {
      source: input.source,
      auto_fail_finalize: true,
      allow_phase_skip: true,
      failure_reason: compactReason,
      ...input.metadata,
    },
  });
  const message = storage.appendTriChatMessage({
    thread_id: turn.thread_id,
    agent_id: input.actor,
    role: "system",
    content: `[${input.actor}] ${compactReason}`,
    reply_to_message_id: turn.user_message_id,
    metadata: {
      kind: "turn-failed",
      source: input.source,
      turn_id: turn.turn_id,
      from_phase: turn.phase,
      from_status: turn.status,
      ...input.metadata,
    },
  });
  const busEvent = storage.appendTriChatBusEvent({
    thread_id: turn.thread_id,
    event_type: input.source === "trichat.turn_watchdog" ? "trichat.turn_watchdog" : "trichat.chaos",
    source_agent: input.actor,
    source_client: `mcp:${input.source}`,
    role: "system",
    content: compactReason,
    metadata: {
      kind: input.source === "trichat.turn_watchdog" ? "trichat.turn_watchdog" : "trichat.chaos",
      source: input.source,
      turn_id: turn.turn_id,
      phase: turn.phase,
      phase_status: turn.phase_status,
      status: "failed",
      event_kind: input.source === "trichat.turn_watchdog" ? "watchdog" : "chaos",
      ...input.metadata,
    },
  });
  const invariants = evaluateTurnAutoFinalizationInvariants(storage, updated);
  const chaosEvent = storage.appendTriChatChaosEvent({
    action: input.chaos_action,
    outcome: invariants.ok ? "escalated" : "escalated-invariant-failed",
    thread_id: updated.thread_id,
    turn_id: updated.turn_id,
    agent_id: input.actor,
    details: {
      source: input.source,
      reason: compactReason,
      invariant_ok: invariants.ok,
      failed_checks: invariants.checks.filter((check) => !check.met).map((check) => check.name),
    },
  });
  return {
    turn: updated,
    artifact,
    message,
    bus_event: busEvent,
    invariants,
    chaos_event: chaosEvent,
  };
}

function evaluateTurnAutoFinalizationInvariants(
  storage: Storage,
  turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>
) {
  const artifacts = storage.listTriChatTurnArtifacts({
    turn_id: turn.turn_id,
    limit: 300,
  });
  const artifactTypes = new Set(
    artifacts.map((artifact) => String(artifact.artifact_type ?? "").trim().toLowerCase()).filter(Boolean)
  );
  const timeline = storage.getTriChatTimeline({
    thread_id: turn.thread_id,
    limit: 300,
  });
  const timelineEvidence = timeline.filter((message) => {
    if (message.role !== "system") {
      return false;
    }
    const messageTurnId = String(message.metadata?.turn_id ?? "").trim();
    if (messageTurnId === turn.turn_id) {
      return true;
    }
    const content = String(message.content ?? "");
    return content.includes(turn.turn_id);
  });

  const failureEvidenceTypes = ["router_error", "watchdog_timeout", "chaos_fault", "verifier_result"];
  const hasFailureArtifact = failureEvidenceTypes.some((type) => artifactTypes.has(type));
  const isTerminal = turn.status === "failed" || turn.status === "completed" || turn.status === "cancelled";

  const checks = [
    {
      name: "terminal_status",
      met: isTerminal,
      details: `status=${turn.status}`,
    },
    {
      name: "summarize_phase",
      met: turn.phase === "summarize",
      details: `phase=${turn.phase}`,
    },
    {
      name: "terminal_phase_status",
      met: turn.phase_status === "failed" || turn.phase_status === "completed",
      details: `phase_status=${turn.phase_status}`,
    },
    {
      name: "finished_at_set",
      met: Boolean(turn.finished_at),
      details: `finished_at=${turn.finished_at ?? "(null)"}`,
    },
    {
      name: "failure_evidence_present",
      met: turn.status !== "failed" || hasFailureArtifact || timelineEvidence.length > 0,
      details: `artifacts=${[...artifactTypes].join(",") || "none"} timeline_evidence=${timelineEvidence.length}`,
    },
    {
      name: "verify_summary_on_failure",
      met: turn.status !== "failed" || Boolean(String(turn.verify_summary ?? "").trim()),
      details: `verify_summary=${String(turn.verify_summary ?? "").trim() ? "present" : "missing"}`,
    },
  ];

  return {
    ok: checks.every((check) => check.met),
    checks,
    evidence: {
      artifact_count: artifacts.length,
      artifact_types: [...artifactTypes],
      timeline_evidence_count: timelineEvidence.length,
    },
  };
}

function computeTriChatSloMetrics(
  storage: Storage,
  input: {
    window_minutes: number;
    event_limit: number;
    thread_id?: string;
  }
): TriChatSloMetrics {
  const windowMinutes = clampInt(input.window_minutes, 1, 10080);
  const eventLimit = clampInt(input.event_limit, 10, 50000);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const adapterEvents = storage.listTriChatAdapterEventsSince({
    since_iso: sinceIso,
    limit: eventLimit,
  });

  let sampleCount = 0;
  let errorCount = 0;
  const latencies: number[] = [];
  for (const event of adapterEvents) {
    const eventType = String(event.event_type ?? "").trim().toLowerCase();
    const latencyMs = extractLatencyMsFromDetails(event.details);
    const sampleEvent = isAdapterSampleEvent(eventType, latencyMs);
    if (!sampleEvent) {
      continue;
    }
    sampleCount += 1;
    if (latencyMs !== null) {
      latencies.push(latencyMs);
    }
    if (isAdapterErrorEvent(eventType, event.error_text)) {
      errorCount += 1;
    }
  }

  const turnOutcomes = storage.getTriChatTurnOutcomeCountsSince({
    since_iso: sinceIso,
    thread_id: input.thread_id,
  });
  const adapterErrorRate = sampleCount > 0 ? roundRate(errorCount / sampleCount) : 0;
  const turnFailureRate =
    turnOutcomes.total_count > 0 ? roundRate(turnOutcomes.failed_count / turnOutcomes.total_count) : 0;

  return {
    computed_at: new Date().toISOString(),
    thread_id: input.thread_id?.trim() || null,
    window_minutes: windowMinutes,
    since_iso: sinceIso,
    event_limit: eventLimit,
    adapter: {
      sample_count: sampleCount,
      error_count: errorCount,
      error_rate: adapterErrorRate,
      latency_sample_count: latencies.length,
      p95_latency_ms: percentile(latencies, 95),
    },
    turns: {
      total_count: turnOutcomes.total_count,
      failed_count: turnOutcomes.failed_count,
      failure_rate: turnFailureRate,
    },
  };
}

function extractLatencyMsFromDetails(details: Record<string, unknown>): number | null {
  const candidates = [
    details.latency_ms,
    details.duration_ms,
    details.elapsed_ms,
    details.latency,
    details.duration,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Number(parsed);
    }
  }
  return null;
}

function isAdapterSampleEvent(eventType: string, latencyMs: number | null): boolean {
  if (latencyMs !== null) {
    return true;
  }
  return (
    eventType === "response_ok" ||
    eventType === "response_error" ||
    eventType === "handshake_failed" ||
    eventType === "trip_opened"
  );
}

function isAdapterErrorEvent(eventType: string, errorText: string | null): boolean {
  if (eventType === "response_ok") {
    return false;
  }
  if (eventType === "response_error" || eventType === "handshake_failed" || eventType === "trip_opened") {
    return true;
  }
  if (eventType.includes("error") || eventType.includes("failed")) {
    return true;
  }
  return Boolean(String(errorText ?? "").trim());
}

function percentile(samples: number[], percentileRank: number): number | null {
  if (!samples.length) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = clamp(percentileRank / 100, 0, 1);
  const index = Math.max(0, Math.ceil(rank * sorted.length) - 1);
  const value = sorted[index] ?? sorted[sorted.length - 1];
  return Number(value.toFixed(2));
}

function roundRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeIsoTimestamp(value: string | undefined, fallback: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed.toISOString();
}
