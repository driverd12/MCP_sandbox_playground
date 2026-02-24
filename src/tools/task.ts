import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
const sourceSchema = z.object({
  source: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const taskCreateSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1).max(200).optional(),
  objective: z.string().min(1),
  project_dir: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  available_at: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const taskListSchema = z.object({
  status: taskStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const taskClaimSchema = z.object({
  mutation: mutationSchema,
  worker_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  task_id: z.string().min(1).optional(),
});

export const taskHeartbeatSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
});

export const taskCompleteSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  result: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
});

export const taskFailSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  error: z.string().min(1),
  result: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
});

export const taskRetrySchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  delay_seconds: z.number().int().min(0).max(86400).optional(),
  reason: z.string().optional(),
  force: z.boolean().optional(),
});

export async function taskCreate(storage: Storage, input: z.infer<typeof taskCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.create",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.createTask({
        task_id: input.task_id,
        objective: input.objective,
        project_dir: input.project_dir ?? ".",
        payload: input.payload,
        priority: input.priority,
        max_attempts: input.max_attempts,
        available_at: input.available_at,
        source: input.source,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        tags: input.tags,
        metadata: input.metadata,
      }),
  });
}

export function taskList(storage: Storage, input: z.infer<typeof taskListSchema>) {
  const tasks = storage.listTasks({
    status: input.status,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    count: tasks.length,
    tasks,
  };
}

export async function taskClaim(storage: Storage, input: z.infer<typeof taskClaimSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.claim",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.claimTask({
        worker_id: input.worker_id,
        lease_seconds: input.lease_seconds ?? 300,
        task_id: input.task_id,
      }),
  });
}

export async function taskHeartbeat(storage: Storage, input: z.infer<typeof taskHeartbeatSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.heartbeat",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.heartbeatTaskLease({
        task_id: input.task_id,
        worker_id: input.worker_id,
        lease_seconds: input.lease_seconds ?? 300,
      }),
  });
}

export async function taskComplete(storage: Storage, input: z.infer<typeof taskCompleteSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.complete",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.completeTask({
        task_id: input.task_id,
        worker_id: input.worker_id,
        result: input.result,
        summary: input.summary,
      }),
  });
}

export async function taskFail(storage: Storage, input: z.infer<typeof taskFailSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.fail",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.failTask({
        task_id: input.task_id,
        worker_id: input.worker_id,
        error: input.error,
        result: input.result,
        summary: input.summary,
      }),
  });
}

export async function taskRetry(storage: Storage, input: z.infer<typeof taskRetrySchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.retry",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.retryTask({
        task_id: input.task_id,
        delay_seconds: input.delay_seconds ?? 0,
        reason: input.reason,
        force: input.force,
      }),
  });
}
