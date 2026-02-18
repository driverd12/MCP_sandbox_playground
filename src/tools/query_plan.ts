import { z } from "zod";
import { Storage } from "../storage.js";

export const queryPlanSchema = z.object({
  objective: z.string().min(1),
  query: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  required_fields: z.array(z.string()).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export function queryPlan(storage: Storage, input: z.infer<typeof queryPlanSchema>) {
  const query = input.query ?? input.objective;
  const limit = input.limit ?? 10;

  const notes = storage.searchNotes({
    query,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    include_expired: false,
    limit,
  });

  const transcripts = storage.searchTranscripts({
    query,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    limit,
  });

  const evidence = [
    ...notes.map((note) => ({
      type: "note",
      id: note.id,
      created_at: note.created_at,
      score: note.score ?? 0,
      text: truncate(note.text, 240),
      citation: `note:${note.id}`,
    })),
    ...transcripts.map((transcript) => ({
      type: "transcript",
      id: transcript.id,
      created_at: transcript.created_at,
      score: transcript.score ?? 0,
      text: truncate(transcript.text, 240),
      citation: `transcript:${transcript.id}`,
    })),
  ]
    .sort((a, b) => (b.score - a.score) || b.created_at.localeCompare(a.created_at))
    .slice(0, limit);

  const missingFields = detectMissingFields(evidence.map((entry) => entry.text).join("\n"), input.required_fields ?? []);
  const baseConfidence = evidence.length === 0 ? 0.1 : Math.min(0.95, 0.35 + evidence.length * 0.08);
  const confidence = Math.max(0.05, baseConfidence - missingFields.length * 0.12);

  return {
    objective: input.objective,
    query,
    confidence: Number(confidence.toFixed(2)),
    constraints: input.constraints ?? [],
    missing_data: missingFields,
    recommended_steps: [
      "Run `policy.evaluate` for the intended mutation class before execution.",
      "Use `preflight.check` to validate prerequisites and invariants.",
      "Acquire a scoped lease via `lock.acquire` if concurrent agents may touch shared state.",
      "Execute mutation with required idempotency metadata and append run events.",
      "Run `postflight.verify` and persist final summary with `memory.append`.",
    ],
    evidence,
  };
}

function detectMissingFields(content: string, requiredFields: string[]): string[] {
  const lower = content.toLowerCase();
  return requiredFields.filter((field) => !lower.includes(field.toLowerCase()));
}

function truncate(value: string, max = 240): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}
