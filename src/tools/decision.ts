import crypto from "node:crypto";
import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

export const decisionLinkSchema = z.object({
  mutation: mutationSchema,
  decision_id: z.string().optional(),
  title: z.string().optional(),
  rationale: z.string().optional(),
  consequences: z.string().optional(),
  rollback: z.string().optional(),
  links: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  run_id: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  relation: z.string().default("supports"),
  details: z.record(z.unknown()).optional(),
});

export async function decisionLink(storage: Storage, input: z.infer<typeof decisionLinkSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "decision.link",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const decisionId = input.decision_id ?? crypto.randomUUID();
      const title = input.title ?? `Decision ${decisionId}`;
      const rationale = input.rationale ?? "linked decision";

      const decision = storage.upsertDecision({
        decision_id: decisionId,
        title,
        rationale,
        consequences: input.consequences,
        rollback: input.rollback,
        links: input.links,
        tags: input.tags,
        run_id: input.run_id,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      const link = storage.insertDecisionLink({
        decision_id: decisionId,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        relation: input.relation,
        details: input.details,
      });

      return {
        decision_id: decision.decision_id,
        decision_created: decision.created,
        link_id: link.id,
        linked_to: {
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          relation: input.relation,
        },
      };
    },
  });
}
