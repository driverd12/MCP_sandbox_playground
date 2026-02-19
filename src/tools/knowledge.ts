import { z } from "zod";
import { Storage, TrustTier } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const trustTierSchema = z.enum(["raw", "verified", "policy-backed", "deprecated"]);

export const knowledgePromoteSchema = z.object({
  mutation: mutationSchema,
  source_type: z.enum(["note", "transcript", "memory", "transcript_line"]),
  source_id: z.string().min(1),
  promoted_text: z.string().optional(),
  trust_tier: trustTierSchema.optional(),
  tags: z.array(z.string()).optional(),
  reason: z.string().optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const knowledgeDecaySchema = z.object({
  mutation: mutationSchema,
  older_than_days: z.number().int().min(1).max(3650),
  from_tiers: z.array(trustTierSchema).min(1),
  to_tier: trustTierSchema.default("deprecated"),
  limit: z.number().int().min(1).max(500).optional(),
});

export const retrievalHybridSchema = z.object({
  query: z.string().min(1),
  tags: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  trust_tiers: z.array(trustTierSchema).optional(),
  include_notes: z.boolean().optional(),
  include_transcripts: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function knowledgePromote(storage: Storage, input: z.infer<typeof knowledgePromoteSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "knowledge.promote",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const source = resolvePromoteSource(storage, input.source_type, input.source_id);
      const promotedText = input.promoted_text ?? source.text;
      const keywords = dedupeKeywords([
        "promoted",
        input.source_type,
        ...source.keywords,
        ...(input.tags ?? []),
      ]);

      const memory = storage.insertMemory({
        content: promotedText,
        keywords,
      });

      return {
        memory_id: memory.id,
        created_at: memory.created_at,
        source_type: input.source_type,
        source_id: input.source_id,
        keywords,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        reason: input.reason,
        trust_tier_ignored: input.trust_tier ? input.trust_tier : undefined,
        expires_in_days_ignored: input.expires_in_days ?? undefined,
      };
    },
  });
}

export async function knowledgeDecay(storage: Storage, input: z.infer<typeof knowledgeDecaySchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "knowledge.decay",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const olderThanIso = new Date(Date.now() - input.older_than_days * 24 * 60 * 60 * 1000).toISOString();
      const result = storage.decayNotes({
        older_than_iso: olderThanIso,
        from_tiers: input.from_tiers as TrustTier[],
        to_tier: input.to_tier as TrustTier,
        limit: input.limit ?? 100,
      });
      return {
        updated_count: result.updated_ids.length,
        updated_ids: result.updated_ids,
        older_than_iso: olderThanIso,
      };
    },
  });
}

export function retrievalHybrid(storage: Storage, input: z.infer<typeof retrievalHybridSchema>) {
  const limit = input.limit ?? 10;
  const includeNotes = input.include_notes ?? true;
  const includeTranscripts = input.include_transcripts ?? true;

  const notes = includeNotes
    ? storage.searchNotes({
        query: input.query,
        tags: input.tags,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        trust_tiers: input.trust_tiers,
        include_expired: false,
        limit,
      })
    : [];

  const transcripts = includeTranscripts
    ? storage.searchTranscripts({
        query: input.query,
        session_id: input.session_id,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        limit,
      })
    : [];

  const memories = includeNotes
    ? storage.searchMemories({
        query: input.query,
        limit,
      })
    : [];

  const transcriptLines = includeTranscripts
    ? storage.searchTranscriptLines({
        query: input.query,
        run_id: input.session_id,
        limit,
      })
    : [];

  const nowMs = Date.now();

  const matches = [
    ...notes.map((note) => {
      const lexical = note.score ?? 0;
      const recency = recencyBoost(nowMs, note.created_at);
      const trustBoost = note.trust_tier === "policy-backed" ? 1.5 : note.trust_tier === "verified" ? 1 : 0;
      const hybridScore = lexical + recency + trustBoost;
      return {
        type: "note",
        id: note.id,
        text: note.text,
        score: Number(hybridScore.toFixed(4)),
        citation: {
          entity_type: "note",
          entity_id: note.id,
          created_at: note.created_at,
          source_client: note.source_client,
          source_model: note.source_model,
          source_agent: note.source_agent,
          trust_tier: note.trust_tier,
        },
      };
    }),
    ...memories.map((memory) => {
      const lexical = memory.score ?? 0;
      const recency = recencyBoost(nowMs, memory.created_at);
      const decayBoost = Math.max(0, Math.min(memory.decay_score, 2)) / 2;
      const hybridScore = lexical + recency + decayBoost;
      return {
        type: "memory",
        id: memory.id,
        text: memory.content,
        score: Number(hybridScore.toFixed(4)),
        citation: {
          entity_type: "memory",
          entity_id: memory.id,
          created_at: memory.created_at,
          last_accessed_at: memory.last_accessed_at,
          keywords: memory.keywords,
          decay_score: memory.decay_score,
        },
      };
    }),
    ...transcripts.map((transcript) => {
      const lexical = transcript.score ?? 0;
      const recency = recencyBoost(nowMs, transcript.created_at);
      const hybridScore = lexical + recency;
      return {
        type: "transcript",
        id: transcript.id,
        text: transcript.text,
        score: Number(hybridScore.toFixed(4)),
        citation: {
          entity_type: "transcript",
          entity_id: transcript.id,
          created_at: transcript.created_at,
          session_id: transcript.session_id,
          source_client: transcript.source_client,
          source_model: transcript.source_model,
          source_agent: transcript.source_agent,
        },
      };
    }),
    ...transcriptLines.map((line) => {
      const lexical = line.score ?? 0;
      const recency = recencyBoost(nowMs, line.timestamp);
      const freshnessBoost = line.is_squished ? 0 : 0.25;
      const hybridScore = lexical + recency + freshnessBoost;
      return {
        type: "transcript_line",
        id: line.id,
        text: line.content,
        score: Number(hybridScore.toFixed(4)),
        citation: {
          entity_type: "transcript_line",
          entity_id: line.id,
          created_at: line.timestamp,
          run_id: line.run_id,
          role: line.role,
          is_squished: line.is_squished,
        },
      };
    }),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query: input.query,
    strategy: "lexical+recency+trust+decay",
    counts: {
      notes: notes.length,
      memories: memories.length,
      transcripts: transcripts.length,
      transcript_lines: transcriptLines.length,
      matches: matches.length,
    },
    matches,
  };
}

function recencyBoost(nowMs: number, createdAtIso: string): number {
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(createdMs)) {
    return 0;
  }
  const ageHours = Math.max(0, (nowMs - createdMs) / (1000 * 60 * 60));
  if (ageHours <= 24) {
    return 1;
  }
  if (ageHours <= 24 * 7) {
    return 0.5;
  }
  return 0;
}

function resolvePromoteSource(
  storage: Storage,
  sourceType: z.infer<typeof knowledgePromoteSchema>["source_type"],
  sourceId: string
): { text: string; keywords: string[] } {
  if (sourceType === "note") {
    const note = storage.getNoteById(sourceId);
    if (!note) {
      throw new Error(`Source ${sourceType} not found: ${sourceId}`);
    }
    return { text: note.text, keywords: note.tags };
  }
  if (sourceType === "transcript") {
    const transcript = storage.getTranscriptById(sourceId);
    if (!transcript) {
      throw new Error(`Source ${sourceType} not found: ${sourceId}`);
    }
    return {
      text: transcript.text,
      keywords: [transcript.kind, transcript.session_id].filter(Boolean),
    };
  }
  if (sourceType === "memory") {
    const memoryId = parseNumericId(sourceType, sourceId);
    const memory = storage.getMemoryById(memoryId);
    if (!memory) {
      throw new Error(`Source ${sourceType} not found: ${sourceId}`);
    }
    return { text: memory.content, keywords: memory.keywords };
  }

  const lineId = parseNumericId(sourceType, sourceId);
  const line = storage.getTranscriptLineById(lineId);
  if (!line) {
    throw new Error(`Source ${sourceType} not found: ${sourceId}`);
  }
  return {
    text: line.content,
    keywords: [line.role ?? "", line.run_id ?? ""].filter(Boolean),
  };
}

function parseNumericId(sourceType: string, sourceId: string): number {
  const parsed = Number(sourceId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Source id for ${sourceType} must be a positive integer: ${sourceId}`);
  }
  return parsed;
}

function dedupeKeywords(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const keyword = value.trim().toLowerCase();
    if (keyword) {
      unique.add(keyword);
    }
  }
  return Array.from(unique);
}
