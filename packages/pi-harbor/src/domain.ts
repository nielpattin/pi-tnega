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

export interface Job {
   readonly id: string;
   readonly ownerSessionId: string;
   readonly name: string | null; // display-only handle
   readonly kind: JobKind;
   readonly harness?: HarnessName;
   readonly agent?: string;
   readonly origin?: "standard" | "vibe" | "btw";
   readonly promptOrCommand: string;
   status: JobStatus;
   readonly createdAt: number;
   startedAt?: number;
   settledAt?: number;
   pid?: number;
   exitCode?: number;
   signal?: string;
   resultData?: unknown;
   errorText?: string;
   rawText?: string;
   schemaWarning?: string;
   waitInterest: number;
   killInterest: number;
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
   stdoutBytes: number;
   stderrBytes: number;
   processWaitInterest: number;
   processKillInterest: number;
}

export interface MailboxMessage {
   readonly id: string;
   readonly senderId: string;
   readonly recipientId: string;
   readonly payload: string;
   readonly replyTo?: string;
   readonly timestamp: number;
   readonly consumed: boolean;
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
}

export interface TaskSpec {
   task: string;
   name?: string;
   agent?: string;
   model?: string;
   outputSchema?: unknown;
   schemaMode?: "strict" | "permissive";
   async?: boolean;
}

// --- Tagged Error Classes (Effect Schema) ---
export class CapacityError extends Schema.TaggedErrorClass<CapacityError>()("CapacityError", {
   message: Schema.String,
   limit: Schema.Number
}) {}

export class ConcurrencyLimitError extends Schema.TaggedErrorClass<ConcurrencyLimitError>()("ConcurrencyLimitError", {
   message: Schema.String,
   limit: Schema.Number
}) {}

export class SchemaConversionError extends Schema.TaggedErrorClass<SchemaConversionError>()("SchemaConversionError", {
   message: Schema.String
}) {}

export class SchemaValidationError extends Schema.TaggedErrorClass<SchemaValidationError>()("SchemaValidationError", {
   message: Schema.String
}) {}

export class ControlError extends Schema.TaggedErrorClass<ControlError>()("ControlError", {
   message: Schema.String
}) {}

export class CancelError extends Schema.TaggedErrorClass<CancelError>()("CancelError", {
   message: Schema.String
}) {}

// --- Domain Pure Helpers ---

export function formatJobId(seq: number): string {
   return `task-${seq}`;
}

export function formatProcessId(seq: number): string {
   return `bash-${seq}`;
}

export function normalizeTaskSpecs(params: any): TaskSpec[] {
   if (Array.isArray(params?.tasks)) {
      return params.tasks;
   }
   if (params && typeof params.task === "string") {
      return [
         {
            task: params.task,
            name: params.name,
            agent: params.agent,
            model: params.model,
            outputSchema: params.outputSchema,
            schemaMode: params.schemaMode,
            async: params.async
         }
      ];
   }
   return [];
}

export function prependContext(tasks: TaskSpec[], context?: string): TaskSpec[] {
   if (!context || context.trim().length === 0) {
      return tasks;
   }
   return tasks.map((t) => ({
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
