import { TranscriptAccumulator } from "./transcript-parser.js";
import { AgentTranscriptReader } from "./transcript-reader.js";
import { recordOf } from "./transcript-sanitization.js";

type RaftTranscriptEntryStatus = "running" | "completed" | "failed";

export interface RaftTranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "error" | "status";
  label: string;
  text?: string;
  status?: RaftTranscriptEntryStatus;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  parentId?: string;
  depth?: number;
  /** Count only when the original stderr chunk contains warnings exclusively. */
  warningCount?: number;
}

export interface RaftAgentTranscript {
  entries: RaftTranscriptEntry[];
  /** Kept for compatibility; true means older pages are available. */
  truncated: boolean;
  hasMore?: boolean;
  hasNewer?: boolean;
  updatedAt?: number;
}

export interface RaftTranscriptSource {
  id: string;
  status: string;
  logFile?: string;
}

export interface RaftAgentToolPreviewNode {
  id: string;
  name: string;
  status?: string;
  runner?: "pi" | "claude";
  owner?: "agent";
  /** Most recent tool the agent was observed running, when known. */
  currentTool?: string;
  text?: string;
  tools: RaftTranscriptEntry[];
  /** Descendant previews, one branch per spawned nested agent run. */
  agents?: RaftAgentToolPreviewNode[];
  /** True when descendant previews were cut by the preview tree budget. */
  agentsTruncated?: boolean;
}

export interface RaftAgentToolPreview extends RaftAgentToolPreviewNode {
  kind: "raft-agent-tools";
}

export const projectAgentTranscript = (
  events: Array<Record<string, unknown>>,
  olderAvailable = false,
): RaftAgentTranscript => {
  const accumulator = new TranscriptAccumulator();
  accumulator.append(events);
  return accumulator.snapshot(olderAvailable);
};

const PREVIEW_TREE_GUARD_MAX_DEPTH = 8;

const isRaftAgentToolPreviewNode = (
  value: unknown,
  depth: number,
): value is RaftAgentToolPreviewNode => {
  const record = recordOf(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    (record.text !== undefined && typeof record.text !== "string") ||
    (record.currentTool !== undefined && typeof record.currentTool !== "string") ||
    !Array.isArray(record.tools)
  ) {
    return false;
  }
  if (record.agents === undefined) return true;
  if (depth >= PREVIEW_TREE_GUARD_MAX_DEPTH || !Array.isArray(record.agents)) return false;
  return record.agents.every((child) => isRaftAgentToolPreviewNode(child, depth + 1));
};

export const isRaftAgentToolPreview = (value: unknown): value is RaftAgentToolPreview =>
  recordOf(value)?.kind === "raft-agent-tools" && isRaftAgentToolPreviewNode(value, 0);

export const recentTranscriptTools = (
  transcript: RaftAgentTranscript,
  limit = 2,
): RaftTranscriptEntry[] => {
  const tools = transcript.entries.filter((entry) => entry.kind === "tool");
  const boundedLimit = Math.max(1, limit);
  const running = tools.filter((entry) => entry.status === "running");
  const completed = tools.filter((entry) => entry.status !== "running");
  const completedSlots = Math.max(0, boundedLimit - Math.min(running.length, boundedLimit));
  const retained = new Set([...running.slice(-boundedLimit), ...completed.slice(-completedSlots)]);
  return tools
    .filter((entry) => retained.has(entry))
    .slice(-boundedLimit)
    .map((entry) => ({ ...entry }));
};

export { AgentTranscriptReader };
