import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const threadStatusSchema = z.enum(["active", "archived"]);
const adapterChannelSchema = z.enum(["command", "model"]);
const DEFAULT_CONSENSUS_AGENT_IDS = ["codex", "cursor", "local-imprint"] as const;

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

type TriChatAutoRetentionConfig = {
  interval_seconds: number;
  older_than_days: number;
  limit: number;
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
