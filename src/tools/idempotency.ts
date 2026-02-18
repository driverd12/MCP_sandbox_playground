import { z } from "zod";
import { Storage } from "../storage.js";

export const mutationCheckSchema = z.object({
  tool_name: z.string().min(1),
  idempotency_key: z.string().min(8).max(200),
  side_effect_fingerprint: z.string().min(8).max(512),
});

export function mutationCheck(storage: Storage, input: z.infer<typeof mutationCheckSchema>) {
  const existing = storage.getMutationStatus(input.idempotency_key);
  if (!existing) {
    return {
      exists: false,
      valid_for_execution: true,
      reason: "unused-key",
    };
  }

  const toolMatch = existing.tool_name === input.tool_name;
  const fingerprintMatch = existing.side_effect_fingerprint === input.side_effect_fingerprint;
  return {
    exists: true,
    valid_for_execution: toolMatch && fingerprintMatch,
    reason: toolMatch && fingerprintMatch ? "replay-safe" : "mismatch",
    existing,
  };
}
