import { z } from "zod";
import { MutationMeta, Storage } from "../storage.js";

export const mutationSchema = z.object({
  idempotency_key: z.string().min(8).max(200),
  side_effect_fingerprint: z.string().min(8).max(512),
});

export async function runIdempotentMutation<T>(params: {
  storage: Storage;
  tool_name: string;
  mutation: MutationMeta;
  payload: unknown;
  execute: () => Promise<T> | T;
}): Promise<T & { replayed?: boolean }> {
  const started = params.storage.beginMutation(params.tool_name, params.mutation, params.payload);
  if (started.replayed) {
    const replayResult = (started.result ?? {}) as T & { replayed?: boolean };
    if (replayResult && typeof replayResult === "object" && !Array.isArray(replayResult)) {
      replayResult.replayed = true;
    }
    return replayResult;
  }

  try {
    const result = await params.execute();
    params.storage.completeMutation(params.mutation.idempotency_key, result);
    return result as T & { replayed?: boolean };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.storage.failMutation(params.mutation.idempotency_key, message);
    throw error;
  }
}
