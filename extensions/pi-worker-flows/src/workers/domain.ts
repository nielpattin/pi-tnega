import { Schema } from "effect";

export { normalizeAgentThinkingLevel as mapThinkingLevel } from "../services/agent-profiles.ts";

// --- Domain Types ---
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type ControlMode = "steer" | "followUp";

export type JobTranscriptContent =
   | { readonly type: "text"; readonly text: string }
   | { readonly type: "image"; readonly mimeType: string };

export type JobTranscriptEntry =
   | { readonly type: "user"; readonly text: string; readonly timestamp?: number }
   | { readonly type: "thinking"; readonly text: string; readonly timestamp?: number }
   | { readonly type: "assistant"; readonly text: string; readonly timestamp?: number }
   | { readonly type: "error"; readonly text: string; readonly timestamp?: number }
   | {
        readonly type: "tool-call";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly arguments: unknown;
        readonly raw?: unknown;
        readonly timestamp?: number;
     }
   | {
        readonly type: "tool-result";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly content: ReadonlyArray<JobTranscriptContent>;
        readonly isError: boolean;
        readonly raw?: unknown;
        readonly timestamp?: number;
     };

export interface Job {
   readonly id: string;
   readonly ownerSessionId: string;
   readonly name: string | null; // display-only handle
   readonly agent?: string;
   readonly model?: string;
   readonly thinking?: string;
   readonly cwd?: string;
   readonly context?: string;
   readonly contextTokens?: number;
   readonly batchId?: string;
   readonly batchSize?: number;
   readonly promptOrCommand: string;
   systemPrompt?: string;
   status: JobStatus;
   readonly createdAt: number;
   startedAt?: number;
   settledAt?: number;
   resultData?: unknown;
   errorText?: string;
   transcript?: ReadonlyArray<JobTranscriptEntry>;
   sessionFile?: string;
   sessionId?: string;
}

export interface WorkerSpec {
   task: string;
   name?: string;
   agent: string;
   thinking?: string;
   tools?: readonly string[];
   systemPrompt?: string;
   cwd?: string;
   readonly context?: string;
}

// --- Tagged Error Classes (Effect Schema) ---
export class CapacityError extends Schema.TaggedError<CapacityError>()("CapacityError", {
   message: Schema.String,
   limit: Schema.Number
}) {}

export class ConcurrencyLimitError extends Schema.TaggedError<ConcurrencyLimitError>()("ConcurrencyLimitError", {
   message: Schema.String,
   limit: Schema.Number
}) {}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()("AgentNotFoundError", {
   message: Schema.String,
   agent: Schema.String
}) {}

export class ControlError extends Schema.TaggedError<ControlError>()("ControlError", {
   message: Schema.String
}) {}

export class DuplicateJobError extends Schema.TaggedError<DuplicateJobError>()("DuplicateJobError", {
   message: Schema.String,
   id: Schema.String
}) {}

export class ManifestSerializationError extends Schema.TaggedError<ManifestSerializationError>()(
   "ManifestSerializationError",
   {
      message: Schema.String,
      cause: Schema.Unknown
   }
) {}

export class ManifestPersistenceError extends Schema.TaggedError<ManifestPersistenceError>()(
   "ManifestPersistenceError",
   {
      message: Schema.String,
      cause: Schema.Unknown
   }
) {}

export class ParentSessionActivationError extends Schema.TaggedError<ParentSessionActivationError>()(
   "ParentSessionActivationError",
   {
      message: Schema.String,
      parentSessionFile: Schema.optional(Schema.String),
      cause: Schema.optional(Schema.Unknown)
   }
) {}

// --- Domain Pure Helpers ---

export function formatJobId(seq: number): string {
   return `worker-${seq}`;
}

export function normalizeWorkerSpecs(params: {
   readonly workers?: ReadonlyArray<
      { readonly task?: string; readonly worker?: string } & Pick<WorkerSpec, "name" | "agent">
   >;
}): WorkerSpec[] {
   return (
      params.workers?.map((spec) => ({
         task: spec.task ?? spec.worker ?? "",
         name: spec.name,
         agent: spec.agent
      })) ?? []
   );
}

export function prependContext(workers: WorkerSpec[], context?: string): WorkerSpec[] {
   if (!context || context.trim().length === 0) {
      return workers;
   }
   return workers.map((t) => ({
      ...t,
      task: `${context}\n\n${t.task}`
   }));
}
