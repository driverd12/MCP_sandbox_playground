import { z } from "zod";
import { Storage, TrustTier } from "../storage.js";
import { mutationSchema } from "./mutation.js";

const trustTierSchema = z.enum(["raw", "verified", "policy-backed", "deprecated"]);

export const memoryAppendSchema = z.object({
  mutation: mutationSchema,
  text: z.string().min(1),
  tags: z.array(z.string()).optional(),
  related_paths: z.array(z.string()).optional(),
  source: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  trust_tier: trustTierSchema.optional(),
  expires_at: z.string().optional(),
  promoted_from_note_id: z.string().optional(),
});

export const memorySearchSchema = z.object({
  query: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  trust_tiers: z.array(trustTierSchema).optional(),
  include_expired: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export function appendMemory(storage: Storage, input: z.infer<typeof memoryAppendSchema>) {
  return storage.insertNote({
    text: input.text,
    tags: input.tags,
    related_paths: input.related_paths,
    source: input.source,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    trust_tier: (input.trust_tier ?? "raw") as TrustTier,
    expires_at: input.expires_at,
    promoted_from_note_id: input.promoted_from_note_id,
  });
}

export function searchMemory(storage: Storage, input: z.infer<typeof memorySearchSchema>) {
  const limit = input.limit ?? 10;
  const hasActorFilter = Boolean(input.source_client || input.source_model || input.source_agent);
  const hasTrustFilter = Boolean(input.trust_tiers && input.trust_tiers.length > 0);
  if (!input.query && (!input.tags || input.tags.length === 0) && !hasActorFilter && !hasTrustFilter) {
    return [];
  }
  return storage.searchNotes({
    query: input.query,
    tags: input.tags,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    trust_tiers: input.trust_tiers,
    include_expired: input.include_expired,
    limit,
  });
}
