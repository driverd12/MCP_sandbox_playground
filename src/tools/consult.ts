import { z } from "zod";
import { logEvent } from "../utils.js";

export const consultSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
});

export type ProviderResult = {
  enabled: boolean;
  ok?: boolean;
  model?: string;
  text?: string;
  error?: string;
};

const CLOUD_DISABLED_ERROR =
  "Cloud consultation is disabled. Use local tools: memory.search, who_knows, or knowledge.query.";

export async function consultOpenAI(input: z.infer<typeof consultSchema>): Promise<ProviderResult> {
  logEvent("consult.openai", { ok: false, local_only: true, model: input.model ?? null });
  return {
    enabled: false,
    ok: false,
    model: input.model ?? "disabled",
    error: CLOUD_DISABLED_ERROR,
  };
}

export async function consultGemini(input: z.infer<typeof consultSchema>): Promise<ProviderResult> {
  logEvent("consult.gemini", { ok: false, local_only: true, model: input.model ?? null });
  return {
    enabled: false,
    ok: false,
    model: input.model ?? "disabled",
    error: CLOUD_DISABLED_ERROR,
  };
}
