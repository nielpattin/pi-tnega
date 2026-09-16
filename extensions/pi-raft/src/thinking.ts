/**
 * Shared thinking (reasoning effort) level type and helpers.
 *
 * Raft resolves a thinking level per run (explicit call value, else the
 * Raft default, "medium"). Pi receives it via "--thinking" and clamps it to
 * the model's supported levels using next-highest fallback (see pi-ai
 * clampThinkingLevel). Claude receives it via "--effort"; off/minimal map to
 * low. Raft itself only selects the requested/default level.
 */
export type RaftThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Raft-wide default thinking level, used when a call omits one. */
export const DEFAULT_RAFT_THINKING: RaftThinking = "medium";

/** Ordered lowest -> highest; matches pi-ai's EXTENDED_THINKING_LEVELS. */
export const THINKING_LEVELS: readonly RaftThinking[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Type guard for a Raft thinking level value (config, CLI args, JSON). */
export const isRaftThinking = (value: unknown): value is RaftThinking =>
  typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

const LABELS: Record<RaftThinking, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** Human-readable label for a thinking level (shown in pickers and settings). */
export const thinkingLabel = (level: RaftThinking): string => LABELS[level];
