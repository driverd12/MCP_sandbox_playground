import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema } from "./mutation.js";

export const memoryAppendSchema = z
  .object({
    mutation: mutationSchema,
    content: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    // Backward compatibility for older clients.
    text: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.content && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content is required",
        path: ["content"],
      });
    }
  });

export const memorySearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  // Backward compatibility fields are accepted and ignored.
  tags: z.array(z.string()).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  trust_tiers: z.array(z.string()).optional(),
  include_expired: z.boolean().optional(),
});

export function appendMemory(storage: Storage, input: z.infer<typeof memoryAppendSchema>) {
  const content = (input.content ?? input.text ?? "").trim();
  if (!content) {
    throw new Error("content is required");
  }
  const keywords = dedupeKeywords(input.keywords ?? input.tags ?? []);
  const memory = storage.insertMemory({
    content,
    keywords,
  });
  return {
    id: memory.id,
    created_at: memory.created_at,
    last_accessed_at: memory.last_accessed_at,
    content,
    keywords,
  };
}

export function searchMemory(storage: Storage, input: z.infer<typeof memorySearchSchema>) {
  return storage.searchMemories({
    query: input.query,
    limit: input.limit ?? 10,
  });
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
