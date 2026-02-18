import { z } from "zod";

const checklistItemSchema = z.object({
  name: z.string().min(1),
  met: z.boolean(),
  details: z.string().optional(),
  severity: z.enum(["info", "warn", "error"]).optional(),
});

export const preflightCheckSchema = z.object({
  action: z.string().min(1),
  target: z.string().optional(),
  classification: z.enum(["read", "write", "destructive"]).default("read"),
  prerequisites: z.array(checklistItemSchema),
  invariants: z.array(checklistItemSchema).optional(),
});

const assertionSchema = z.object({
  name: z.string().min(1),
  operator: z.enum(["eq", "ne", "contains", "exists", "gt", "gte", "lt", "lte"]),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

export const postflightVerifySchema = z.object({
  action: z.string().min(1),
  target: z.string().optional(),
  assertions: z.array(assertionSchema).min(1),
});

export function preflightCheck(input: z.infer<typeof preflightCheckSchema>) {
  const invariantChecks = input.invariants ?? [];
  const failedPrereqs = input.prerequisites.filter((item) => !item.met);
  const failedInvariants = invariantChecks.filter((item) => !item.met);
  const pass = failedPrereqs.length === 0 && failedInvariants.length === 0;

  return {
    pass,
    action: input.action,
    target: input.target ?? null,
    classification: input.classification,
    failed_prerequisites: failedPrereqs,
    failed_invariants: failedInvariants,
    checklist: {
      prerequisites: input.prerequisites,
      invariants: invariantChecks,
    },
  };
}

export function postflightVerify(input: z.infer<typeof postflightVerifySchema>) {
  const evaluations = input.assertions.map((assertion) => {
    const ok = evaluateAssertion(assertion.operator, assertion.actual, assertion.expected);
    return {
      ...assertion,
      ok,
    };
  });
  const failed = evaluations.filter((evaluation) => !evaluation.ok);
  return {
    pass: failed.length === 0,
    action: input.action,
    target: input.target ?? null,
    assertions: evaluations,
    failures: failed,
  };
}

function evaluateAssertion(
  operator: z.infer<typeof assertionSchema>["operator"],
  actual: unknown,
  expected: unknown
): boolean {
  switch (operator) {
    case "eq":
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "ne":
      return JSON.stringify(actual) !== JSON.stringify(expected);
    case "contains":
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.some((entry) => JSON.stringify(entry) === JSON.stringify(expected));
      }
      return false;
    case "exists":
      return actual !== null && actual !== undefined;
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    default:
      return false;
  }
}
