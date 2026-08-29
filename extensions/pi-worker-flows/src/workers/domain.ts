import { Schema } from "effect";

export { normalizeAgentThinkingLevel as mapThinkingLevel } from "../services/worker-profiles.ts";
// --- Domain Types ---
/**
 * Task lifecycle. `paused` no longer exists; a worker that stopped or failed
 * after doing work transitions to `recoverable` so the main session can resume
 * the same session in place instead of re-spawning.
 */
export type TaskStatus = "pending" | "running" | "completed" | "recoverable" | "failed" | "cancelled";

export type TaskTranscriptContent =
   | { readonly type: "text"; readonly text: string }
   | { readonly type: "image"; readonly mimeType: string };

export type TaskTranscriptEntry =
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
        readonly content: ReadonlyArray<TaskTranscriptContent>;
        readonly isError: boolean;
        readonly raw?: unknown;
        readonly timestamp?: number;
     };

export interface Task {
   readonly id: string;
   readonly ownerSessionId: string;
   readonly name: string | null; // display-only handle
   /** Executor profile name: worker, explorer, planner, librarian, critic, gatekeeper. */
   readonly worker?: string;
   readonly model?: string;
   readonly thinking?: string;
   readonly cwd?: string;
   readonly context?: string;
   readonly contextTokens?: number;
   readonly batchId?: string;
   readonly batchSize?: number;
   readonly promptOrCommand: string;
   readonly background?: boolean;
   systemPrompt?: string;
   status: TaskStatus;
   readonly createdAt: number;
   startedAt?: number;
   settledAt?: number;
   resultData?: unknown;
   errorText?: string;
   transcript?: ReadonlyArray<TaskTranscriptEntry>;
   sessionFile?: string;
   sessionId?: string;
}

export interface WorkerSpec {
   task: string;
   name?: string;
   /** Executor profile name (replaces the legacy `agent` selector). */
   worker: string;
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

export class WorkerProfileNotFoundError extends Schema.TaggedError<WorkerProfileNotFoundError>()(
   "WorkerProfileNotFoundError",
   {
      message: Schema.String,
      worker: Schema.String
   }
) {}

export class DuplicateTaskError extends Schema.TaggedError<DuplicateTaskError>()("DuplicateTaskError", {
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

export class ControlError extends Schema.TaggedError<ControlError>()("ControlError", {
   message: Schema.String
}) {}

// Modes supported by live worker control. Kept for compatibility with the
// takeover overlay; pause/continue are removed.
export type ControlMode = "steer" | "followUp";

// --- Domain Pure Helpers ---

export function formatTaskId(seq: number): string {
   return `task-${seq}`;
}

/** Accept a legacy `worker-<seq>` id and map it to the task vocabulary. */
export function normalizeTaskId(id: string): string {
   return id.replace(/^worker-(\d+)$/, "task-$1");
}

export function normalizeWorkerSpecs(params: {
   readonly workers?: ReadonlyArray<
      { readonly task?: string; readonly worker?: string; readonly agent?: string } & Pick<WorkerSpec, "name">
   >;
}): WorkerSpec[] {
   return (
      params.workers?.map((spec) => ({
         task: spec.task ?? "",
         name: spec.name,
         worker: spec.worker ?? spec.agent ?? ""
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

/** Terminal outcomes: the task will never change state again without a recover. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
   return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Settled outcomes: the worker run has ended. `recoverable` is settled (the
 * worker stopped) but not terminal (the main session may resume it).
 */
export function isSettledTaskStatus(status: TaskStatus): boolean {
   return isTerminalTaskStatus(status) || status === "recoverable";
}

/** A failed/stalled task can be resumed in place only when its session file exists. */
export function canRecoverTask(task: { readonly status?: string; readonly sessionFile?: string }): boolean {
   return task.status === "recoverable" && typeof task.sessionFile === "string" && task.sessionFile.length > 0;
}
