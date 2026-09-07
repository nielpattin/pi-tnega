import { Schema } from "effect";
import { uuidv7 } from "@earendil-works/pi-ai";

export { normalizeAgentThinkingLevel as mapThinkingLevel } from "./services/agent-profiles.ts";
// --- Domain Types ---
/** Task lifecycle. */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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

export type AgentActivityPhase = "starting" | "active" | "waiting" | "done";
export type AgentActivityScope = "agent" | "turn" | "provider" | "streaming" | "tool";
export type AgentActivityEvent =
   | "session_start"
   | "input"
   | "before_agent_start"
   | "agent_start"
   | "agent_end"
   | "turn_start"
   | "turn_end"
   | "before_provider_request"
   | "after_provider_response"
   | "message_update"
   | "tool_execution_start"
   | "tool_call"
   | "tool_execution_update"
   | "tool_result"
   | "tool_execution_end"
   | "subagent_done"
   | "session_shutdown";

export interface AgentActivityState {
   readonly version: 1;
   readonly runningChildId: string;
   readonly createdAt: number;
   readonly updatedAt: number;
   readonly sequence: number;
   readonly latestEvent: AgentActivityEvent;
   readonly phase: AgentActivityPhase;
   readonly agentActive: boolean;
   readonly turnActive: boolean;
   readonly providerActive: boolean;
   readonly toolActive: boolean;
   readonly activeScope?: AgentActivityScope;
   readonly activeSince?: number;
   readonly waitingSince?: number;
   readonly turnIndex?: number;
   readonly messageEventType?: string;
   readonly toolCallId?: string;
   readonly toolName?: string;
   readonly toolStartedAt?: number;
   readonly toolEndedAt?: number;
}

/** Per-agent run stats persisted at settle for the one-line rendering. */
export interface TaskUsageStats {
   /** Total model cost in dollars. */
   readonly cost: number;
   /** Number of tool calls issued by the agent. */
   readonly toolCalls: number;
   /** Largest observed context footprint in tokens. */
   readonly contextTokens: number;
}

export interface Task {
   readonly id: string;
   readonly ownerSessionId: string;
   readonly name: string | null; // display-only handle
   /** Executor profile name: worker, explorer, planner, librarian, critic. */
   readonly profile?: string;
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
   paneId?: string;
   /** Runtime-only dismissal: the agent pane was closed, hiding the settled widget entry. Never persisted. */
   paneClosed?: boolean;
   /** Runtime-only acknowledgement: the parent session already received this settled result. Never persisted. */
   resultDelivered?: boolean;
   /** Runtime-only ownership: set for agents spawned by this process. Restored history stays out of the widget. Never persisted. */
   runtimeOwned?: boolean;
   activity?: AgentActivityState;
   usage?: TaskUsageStats;
   sessionId?: string;
}

export interface AgentSpec {
   task: string;
   name?: string;
   /** Executor profile name (replaces the legacy `agent` and `agent` selectors). */
   profile: string;
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

export class AgentProfileNotFoundError extends Schema.TaggedError<AgentProfileNotFoundError>()(
   "AgentProfileNotFoundError",
   {
      message: Schema.String,
      profile: Schema.String
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

// Modes supported by live agent control. Kept for compatibility with the
// takeover overlay; pause/continue are removed.
export type ControlMode = "steer" | "followUp";

// --- Domain Helpers ---

export function formatTaskId(): string {
   return `task-${uuidv7()}`;
}

export function normalizeAgentSpecs(params: {
   readonly agents?: ReadonlyArray<{ readonly task?: string; readonly profile?: string } & Pick<AgentSpec, "name">>;
}): AgentSpec[] {
   return (
      params.agents?.map((spec) => ({
         task: spec.task ?? "",
         name: spec.name,
         profile: spec.profile ?? ""
      })) ?? []
   );
}

export function prependContext(agents: AgentSpec[], context?: string): AgentSpec[] {
   if (!context || context.trim().length === 0) {
      return agents;
   }
   return agents.map((t) => ({
      ...t,
      task: `${context}

${t.task}`
   }));
}

/** Terminal outcomes. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
   return status === "completed" || status === "failed" || status === "cancelled";
}

/** Settled outcomes are no longer active. */
export function isSettledTaskStatus(status: TaskStatus): boolean {
   return isTerminalTaskStatus(status);
}
