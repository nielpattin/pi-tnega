import {
  readRaftExecutionTraceV1,
  type RaftExecutionOutcomeV1,
  type RaftTraceJsonValue,
} from "../audit/trace.js";

export type RaftProjectionSource = "trace" | "legacy";

interface RaftProjectionOperation {
  sequence: number;
  ref: string;
  provider?: string;
  action?: string;
  tool: string;
  args: Record<string, RaftTraceJsonValue>;
  outcome: RaftExecutionOutcomeV1;
  error?: string;
  result?: RaftTraceJsonValue;
  source: RaftProjectionSource;
}

export interface RaftProjectionTrace {
  source: RaftProjectionSource;
  outcome?: RaftExecutionOutcomeV1;
  phases: string[];
  operations: RaftProjectionOperation[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonValue = (
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): value is RaftTraceJsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 16 || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors, depth + 1))
    : Object.values(value as Record<string, unknown>).every((item) =>
        isJsonValue(item, ancestors, depth + 1),
      );
  ancestors.delete(value);
  return valid;
};

const lexicalIdentity = (ref: string): { provider?: string; action?: string } => {
  const separator = ref.indexOf(".");
  if (separator <= 0 || separator === ref.length - 1) return {};
  return { provider: ref.slice(0, separator), action: ref.slice(separator + 1) };
};

const toolOf = (ref: string, provider?: string, action?: string): string => {
  if (provider === "pi" && action) return action;
  return action ?? ref;
};

const readLegacyAudits = (value: unknown): RaftProjectionTrace | undefined => {
  if (!Array.isArray(value)) return undefined;
  const operations: RaftProjectionOperation[] = [];
  for (let sequence = 0; sequence < value.length; sequence++) {
    const audit = value[sequence];
    if (
      !isRecord(audit) ||
      typeof audit.ref !== "string" ||
      !isRecord(audit.args) ||
      !isJsonValue(audit.args)
    )
      return undefined;
    if (typeof audit.success !== "boolean") return undefined;
    if (audit.error !== undefined && typeof audit.error !== "string") return undefined;
    const identity = lexicalIdentity(audit.ref);
    operations.push({
      sequence,
      ref: audit.ref,
      ...(identity.provider ? { provider: identity.provider } : {}),
      ...(identity.action ? { action: identity.action } : {}),
      tool: toolOf(audit.ref, identity.provider, identity.action),
      args: audit.args as Record<string, RaftTraceJsonValue>,
      outcome: audit.success ? "succeeded" : "failed",
      ...(audit.error !== undefined ? { error: audit.error } : {}),
      source: "legacy",
    });
  }
  return { source: "legacy", phases: [], operations };
};

export const readRaftProjectionTrace = (details: unknown): RaftProjectionTrace | undefined => {
  if (!isRecord(details)) return undefined;
  if (Object.prototype.hasOwnProperty.call(details, "trace")) {
    const trace = readRaftExecutionTraceV1(details.trace);
    if (!trace) return undefined;
    return {
      source: "trace",
      outcome: trace.outcome,
      phases: [...trace.phases],
      operations: trace.operations.map((operation) => {
        const lexical = lexicalIdentity(operation.ref);
        const provider = operation.provider ?? lexical.provider;
        const action = operation.action ?? lexical.action;
        return {
          sequence: operation.sequence,
          ref: operation.ref,
          ...(provider ? { provider } : {}),
          ...(action ? { action } : {}),
          tool: toolOf(operation.ref, provider, action),
          args: operation.args,
          outcome: operation.outcome,
          ...(operation.error !== undefined ? { error: operation.error } : {}),
          ...(operation.result !== undefined ? { result: operation.result } : {}),
          source: "trace",
        };
      }),
    };
  }
  return readLegacyAudits(details.audits);
};
