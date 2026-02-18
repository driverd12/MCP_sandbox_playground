import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

export const incidentOpenSchema = z.object({
  mutation: mutationSchema,
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const incidentTimelineSchema = z.object({
  incident_id: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
});

export async function incidentOpen(storage: Storage, input: z.infer<typeof incidentOpenSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "incident.open",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.openIncident({
        severity: input.severity,
        title: input.title,
        summary: input.summary,
        tags: input.tags,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

export function incidentTimeline(storage: Storage, input: z.infer<typeof incidentTimelineSchema>) {
  const timeline = storage.getIncidentTimeline(input.incident_id, input.limit ?? 100);
  return {
    incident_id: input.incident_id,
    found: Boolean(timeline.incident),
    incident: timeline.incident,
    events: timeline.events,
  };
}
