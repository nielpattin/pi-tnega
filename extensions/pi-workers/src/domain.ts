import { Schema } from "effect";

// --- Domain Types ---
export type JobKind = "agent" | "bash";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type HarnessName = "pi" | "agy";
export type ControlMode = "steer" | "followUp";

export interface BackendCapabilities {
   readonly steering: boolean;
   readonly followUp: boolean;
   readonly midTurnTools: boolean;
   readonly modelSelection: boolean;
   readonly reasoningEffort: boolean;
}

export type JobTranscriptContent =
   | { readonly type: "text"; readonly text: string }
   | { readonly type: "image"; readonly mimeType: string };

export type JobTranscriptEntry =
   | { readonly type: "user"; readonly text: string; readonly timestamp?: number }
   | { readonly type: "thinking"; readonly text: string; readonly timestamp?: number }
   | { readonly type: "assistant"; readonly text: string; readonly timestamp?: number }
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
   readonly kind: JobKind;
   readonly harness?: HarnessName;
   readonly agent?: string;
   readonly model?: string;
   readonly thinking?: string;
   readonly cwd?: string;
   readonly context?: string;
   readonly contextTokens?: number;
   readonly origin?: "standard" | "btw";
   readonly batchId?: string;
   readonly batchSize?: number;
   readonly promptOrCommand: string;
   systemPrompt?: string;
   status: JobStatus;
   readonly createdAt: number;
   startedAt?: number;
   settledAt?: number;
   pid?: number;
   exitCode?: number;
   signal?: string;
   resultData?: unknown;
   errorText?: string;
   transcript?: ReadonlyArray<JobTranscriptEntry>;
   waitInterest: number;
   killInterest: number;
   sessionFile?: string;
   sessionId?: string;
}

export interface ProcessReadyState {
   ready: boolean;
   logMatched: boolean;
   portMatched: boolean;
   timedOut?: boolean;
   error?: string;
}

export interface ProcessEntry {
   readonly id: string;
   readonly name: string | null;
   readonly command: string;
   readonly cwd: string;
   readonly pid: number;
   status: "starting" | "running" | "exited" | "failed";
   readonly readyCondition?: { log?: string; port?: number; timeoutSec?: number };
   readyState: ProcessReadyState;
   readonly spawnTime: number;
   settledAt?: number;
   exitCode?: number;
   signal?: string;
   errorText?: string;
   resultText?: string;
   stdoutBytes: number;
   stderrBytes: number;
   processWaitInterest: number;
   processKillInterest: number;
}

export interface AgentDefinition {
   readonly name: string;
   readonly display_name?: string;
   readonly description: string;
   readonly tools: readonly string[];
   readonly guidance?: string;
   readonly harness: HarnessName;
   readonly enabled: boolean;
   readonly source: "builtin" | "global" | "project";
   readonly body: string;
   readonly model?: string;
   readonly thinking?: string;
   readonly filePath?: string;
   readonly isOverride?: boolean;
   readonly scope?: "project" | "global" | "both" | "builtin";
   readonly scopes?: readonly ("project" | "global")[];
}

export interface WorkerSpec {
   task: string;
   name?: string;
   agent: string;
   thinking?: string;
   tools?: readonly string[];
   harness?: HarnessName;
   systemPrompt?: string;
   cwd?: string;
   readonly context?: string;
   outputSchema?: unknown;
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

export class SchemaConversionError extends Schema.TaggedError<SchemaConversionError>()("SchemaConversionError", {
   message: Schema.String
}) {}

export class SchemaValidationError extends Schema.TaggedError<SchemaValidationError>()("SchemaValidationError", {
   message: Schema.String
}) {}

export class ControlError extends Schema.TaggedError<ControlError>()("ControlError", {
   message: Schema.String
}) {}

export class CancelError extends Schema.TaggedError<CancelError>()("CancelError", {
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

export function formatProcessId(seq: number): string {
   return `process-${seq}`;
}

export function normalizeWorkerSpecs(params: {
   readonly workers?: ReadonlyArray<
      { readonly task?: string; readonly worker?: string } & Pick<WorkerSpec, "name" | "agent" | "outputSchema">
   >;
}): WorkerSpec[] {
   return (
      params.workers?.map((spec) => ({
         task: spec.task ?? spec.worker ?? "",
         name: spec.name,
         agent: spec.agent,
         outputSchema: spec.outputSchema
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

export function mapThinkingLevel(reasoningEffort?: string): string {
   switch (reasoningEffort) {
      case "off":
         return "off";
      case "minimal":
         return "minimal";
      case "low":
         return "low";
      case "medium":
         return "medium";
      case "high":
         return "high";
      case "xhigh":
         return "xhigh";
      case "max":
         return "max";
      default:
         return "medium";
   }
}

export function mapAgyEffort(reasoningEffort?: string): "low" | "medium" | "high" {
   switch (reasoningEffort) {
      case "off":
      case "minimal":
      case "low":
         return "low";
      case "medium":
         return "medium";
      case "high":
      case "xhigh":
      case "max":
         return "high";
      default:
         return "medium";
   }
}

export function resolveHarness(specHarness?: HarnessName, agentHarness?: HarnessName): HarnessName {
   return specHarness ?? agentHarness ?? "pi";
}
