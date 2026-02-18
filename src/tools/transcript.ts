import { z } from "zod";
import { Storage, TranscriptLineRecord, TranscriptRecord } from "../storage.js";
import { mutationSchema } from "./mutation.js";

export const transcriptAppendSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  source_client: z.string().min(1),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  kind: z.string().min(1),
  text: z.string().min(1),
});

export const transcriptLogSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]).or(z.string().min(1)),
  content: z.string().min(1),
  is_squished: z.boolean().optional(),
});

export const transcriptSummarizeSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  provider: z.enum(["openai", "gemini", "auto"]).optional(),
  max_points: z.number().int().min(3).max(20).optional(),
});

export const transcriptSquishSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().min(1),
  limit: z.number().int().min(1).max(5000).optional(),
  max_points: z.number().int().min(3).max(20).optional(),
});

export function appendTranscript(
  storage: Storage,
  input: z.infer<typeof transcriptAppendSchema>
) {
  const line = storage.insertTranscriptLine({
    run_id: input.session_id,
    role: input.kind,
    content: input.text,
    is_squished: false,
  });
  const transcript = storage.insertTranscript({
    session_id: input.session_id,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    kind: input.kind,
    text: input.text,
  });
  return {
    ...transcript,
    line_id: line.id,
    line_timestamp: line.timestamp,
  };
}

export function logTranscript(
  storage: Storage,
  input: z.infer<typeof transcriptLogSchema>
) {
  return storage.insertTranscriptLine({
    run_id: input.run_id,
    role: input.role,
    content: input.content,
    is_squished: input.is_squished,
  });
}

export function squishTranscript(
  storage: Storage,
  input: z.infer<typeof transcriptSquishSchema>
) {
  const unsquished = storage.getUnsquishedTranscriptLines(input.run_id, input.limit ?? 200);
  if (unsquished.length === 0) {
    return {
      run_id: input.run_id,
      created_memory: false,
      squished_count: 0,
      reason: "no-unsquished-lines",
    };
  }

  const lines = collectTranscriptLineContents(unsquished);
  const summary = buildSquishedSummary(input.run_id, unsquished, lines, input.max_points ?? 8);
  const keywords = extractKeywords(lines, 12);
  const memory = storage.insertMemory({
    content: summary,
    keywords,
  });
  const squished = storage.markTranscriptLinesSquished(unsquished.map((line) => line.id));

  return {
    run_id: input.run_id,
    created_memory: true,
    memory_id: memory.id,
    memory_created_at: memory.created_at,
    squished_count: squished.updated_count,
    keywords,
  };
}

export async function summarizeTranscript(
  storage: Storage,
  input: z.infer<typeof transcriptSummarizeSchema>
) {
  const transcripts = storage.getTranscriptsBySession(input.session_id);
  if (transcripts.length === 0) {
    return { enabled: false, reason: "no transcripts for session" };
  }

  const text = buildLocalSummary(input.session_id, transcripts, input.max_points ?? 8);
  const note = storage.insertNote({
    text,
    tags: ["summary", "transcript", "local"],
    source: `transcript:${input.session_id}`,
    source_client: "mcp-playground-hub",
    source_model: "local-deterministic-v2",
    source_agent: "transcript.summarize",
    trust_tier: "verified",
  });

  return {
    enabled: true,
    ok: true,
    method: "local",
    note_id: note.id,
    entries: transcripts.length,
    provider_ignored: input.provider ?? undefined,
  };
}

function buildLocalSummary(sessionId: string, transcripts: TranscriptRecord[], maxPoints: number): string {
  const first = transcripts[0];
  const last = transcripts[transcripts.length - 1];
  const participants = collectParticipants(transcripts);
  const lines = collectTranscriptLines(transcripts);
  const points = collectRecentUnique(lines, maxPoints);
  const decisions = collectPatternMatches(lines, /\b(decision|decide|decided|agreed|approved|chosen)\b/i, 6);
  const actions = collectPatternMatches(
    lines,
    /\b(action|todo|next|follow[ -]?up|owner|pending|need to|should|must)\b/i,
    8
  );
  const questions = collectPatternMatches(lines, /\?/, 6);

  return [
    `Session: ${sessionId}`,
    `Entries: ${transcripts.length}`,
    `Window: ${first.created_at} -> ${last.created_at}`,
    `Participants: ${participants.length ? participants.join(", ") : "unknown"}`,
    "",
    "Key points:",
    ...toBullets(points, "No key points captured."),
    "",
    "Decisions:",
    ...toBullets(decisions, "No explicit decisions detected."),
    "",
    "Action items:",
    ...toBullets(actions, "No explicit action items detected."),
    "",
    "Open questions:",
    ...toBullets(questions, "No open questions detected."),
  ].join("\n");
}

function buildSquishedSummary(
  runId: string,
  transcriptLines: TranscriptLineRecord[],
  lines: string[],
  maxPoints: number
): string {
  const first = transcriptLines[0];
  const last = transcriptLines[transcriptLines.length - 1];
  const points = collectRecentUnique(lines, maxPoints);
  const decisions = collectPatternMatches(lines, /\b(decision|decide|decided|agreed|approved|chosen)\b/i, 6);
  const actions = collectPatternMatches(
    lines,
    /\b(action|todo|next|follow[ -]?up|owner|pending|need to|should|must)\b/i,
    8
  );
  const questions = collectPatternMatches(lines, /\?/, 6);

  return [
    `Run: ${runId}`,
    `Raw lines squished: ${transcriptLines.length}`,
    `Window: ${first.timestamp} -> ${last.timestamp}`,
    "",
    "Key points:",
    ...toBullets(points, "No key points captured."),
    "",
    "Decisions:",
    ...toBullets(decisions, "No explicit decisions detected."),
    "",
    "Action items:",
    ...toBullets(actions, "No explicit action items detected."),
    "",
    "Open questions:",
    ...toBullets(questions, "No open questions detected."),
  ].join("\n");
}

function collectParticipants(transcripts: TranscriptRecord[]): string[] {
  const participants = new Set<string>();
  for (const transcript of transcripts) {
    const tags = [transcript.source_client];
    if (transcript.source_model) {
      tags.push(transcript.source_model);
    }
    if (transcript.source_agent) {
      tags.push(transcript.source_agent);
    }
    participants.add(tags.join(":"));
  }
  return Array.from(participants);
}

function collectTranscriptLines(transcripts: TranscriptRecord[]): string[] {
  const lines: string[] = [];
  for (const transcript of transcripts) {
    const split = transcript.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    lines.push(...split);
  }
  return lines;
}

function collectTranscriptLineContents(lines: TranscriptLineRecord[]): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const split = line.content
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    output.push(...split);
  }
  return output;
}

function collectRecentUnique(lines: string[], limit: number): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = normalizeLine(lines[i]);
    if (!line) {
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.unshift(line);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function collectPatternMatches(lines: string[], pattern: RegExp, limit: number): string[] {
  const matches: string[] = [];
  for (const raw of lines) {
    const line = normalizeLine(raw);
    if (!line) {
      continue;
    }
    if (pattern.test(line)) {
      matches.push(line);
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return dedupe(matches).slice(0, limit);
}

function normalizeLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 280) {
    return trimmed;
  }
  return `${trimmed.slice(0, 280)}...`;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function toBullets(values: string[], fallback: string): string[] {
  if (values.length === 0) {
    return [`- ${fallback}`];
  }
  return values.map((value) => `- ${value}`);
}

function extractKeywords(lines: string[], maxKeywords: number): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "will",
    "into",
    "about",
    "need",
    "next",
    "then",
    "were",
    "when",
    "what",
    "where",
    "which",
    "your",
    "our",
    "you",
    "can",
    "all",
    "not",
  ]);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const words = line.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
    for (const word of words) {
      if (stopWords.has(word)) {
        continue;
      }
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxKeywords)
    .map(([keyword]) => keyword);
}
