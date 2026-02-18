import { z } from "zod";
import { Storage } from "../storage.js";

const trustTierSchema = z.enum(["raw", "verified", "policy-backed", "deprecated"]);

export const whoKnowsSchema = z.object({
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
  consult: z.boolean().optional(),
});

export async function whoKnows(storage: Storage, input: z.infer<typeof whoKnowsSchema>) {
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

  const matches = [
    ...notes.map((note) => ({
      type: "note",
      id: note.id,
      created_at: note.created_at,
      source: note.source,
      source_client: note.source_client,
      source_model: note.source_model,
      source_agent: note.source_agent,
      trust_tier: note.trust_tier,
      score: note.score ?? 0,
      text: note.text,
    })),
    ...transcripts.map((transcript) => ({
      type: "transcript",
      id: transcript.id,
      created_at: transcript.created_at,
      session_id: transcript.session_id,
      source_client: transcript.source_client,
      source_model: transcript.source_model,
      source_agent: transcript.source_agent,
      kind: transcript.kind,
      score: transcript.score ?? 0,
      text: transcript.text,
    })),
  ]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.created_at.localeCompare(a.created_at))
    .slice(0, limit);

  return {
    local_only: true,
    query: input.query,
    counts: {
      notes: notes.length,
      transcripts: transcripts.length,
      matches: matches.length,
    },
    consult_ignored: input.consult ? "consult flag ignored in local-only mode" : undefined,
    notes,
    transcripts,
    matches,
  };
}
