import type { UsageSnapshot } from "./utils/usage.ts";

/**
 * Agent agent model types.
 *
 * Agents-only extraction of the types `shared/agent-runner.ts` needs.
 * Usage counters and optional session transcript entries support compatibility
 * callers. External agents publish their final message through the session file.
 */

/** Normalized usage counters for one agent run. */
export type AgentUsage = UsageSnapshot;

export type TranscriptRole = "user" | "assistant" | "thinking" | "tool" | "toolResult";

export interface TranscriptEntry {
   role: TranscriptRole;
   text: string;
   /** Tool name for tool calls/results. */
   name?: string;
   /** Stable tool-call identifier used to pair calls, results, and timings. */
   toolCallId?: string;
   isError?: boolean;
   /** Original message timestamp, when provided by the model/session. */
   timestamp?: number;
   /** Tool execution lifecycle timestamps, measured by the child session. */
   startedAt?: number;
   finishedAt?: number;
   durationMs?: number;
}
