import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema } from "./mutation.js";

const confirmationSchema = z.object({
  source: z.string().min(1),
  confirmed: z.boolean(),
  evidence: z.string().optional(),
});

export const policyEvaluateSchema = z.object({
  mutation: mutationSchema,
  policy_name: z.string().min(1).default("local-default"),
  operation: z.string().min(1),
  target: z.string().optional(),
  classification: z.enum(["read", "write", "destructive"]).default("read"),
  execution_mode: z.enum(["log-only", "staged", "execute"]).optional(),
  requires_two_source_confirmation: z.boolean().optional(),
  confirmations: z.array(confirmationSchema).optional(),
  protected_targets: z.array(z.string()).optional(),
  attributes: z.record(z.unknown()).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export function evaluatePolicy(storage: Storage, input: z.infer<typeof policyEvaluateSchema>) {
  const violations: Array<Record<string, unknown>> = [];
  const recommendations: string[] = [];

  const target = (input.target ?? "").toLowerCase();
  const protectedTargets = (input.protected_targets ?? []).map((entry) => entry.toLowerCase());
  const confirmations = input.confirmations ?? [];

  if (target && protectedTargets.includes(target) && input.classification !== "read") {
    violations.push({
      code: "protected-target",
      severity: "high",
      message: `Target ${input.target} is protected and cannot be modified.`,
    });
    recommendations.push("Route this change through a human-approved break-glass process.");
  }

  if (input.classification === "destructive") {
    const confirmedSources = confirmations.filter((entry) => entry.confirmed).map((entry) => entry.source);
    if (input.requires_two_source_confirmation !== false && new Set(confirmedSources).size < 2) {
      violations.push({
        code: "two-source-confirmation-required",
        severity: "high",
        message: "Destructive actions require two distinct confirmed sources.",
      });
      recommendations.push("Collect confirmations from two trusted systems before executing.");
    }
  }

  const operation = input.operation.toLowerCase();
  const riskyLifecycleOperation =
    operation.includes("deprovision") ||
    operation.includes("deactivate") ||
    operation.includes("disable") ||
    operation.includes("delete");

  if (riskyLifecycleOperation && input.classification !== "read") {
    if (!input.execution_mode || input.execution_mode === "log-only") {
      recommendations.push("Lifecycle action remains in safe mode. Use staged checks before execute mode.");
    }
  }

  const allowed = violations.length === 0;
  const reason = allowed ? "policy checks passed" : "policy checks failed";

  const evaluation = storage.insertPolicyEvaluation({
    policy_name: input.policy_name,
    input,
    allowed,
    reason,
    violations,
    recommendations,
  });

  return {
    evaluation_id: evaluation.id,
    created_at: evaluation.created_at,
    allowed,
    reason,
    violations,
    recommendations,
  };
}
