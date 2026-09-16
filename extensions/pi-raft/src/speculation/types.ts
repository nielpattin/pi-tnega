import type { RaftSpeculationConfig } from "../config.js";
import type { RaftMediaBlock } from "../protocol.js";

// Config shape lives with the other Raft config sections in ../config.ts;
// re-exported here so the speculation package keeps a local import surface.
export type { RaftSpeculationConfig };

/** One literal-argument call discovered in the partially streamed program. */
export interface RaftSpeculationCandidate {
  ref: string;
  args: Record<string, unknown>;
}

/** Side-channel outputs captured during a speculative provider invoke, replayed into the real audit when served. */
export interface RaftSpeculationReplay {
  media?: RaftMediaBlock[];
  mediaNote?: string;
  updatedArgs?: Record<string, unknown>;
  preview?: unknown;
}

export interface RaftSpeculationStats {
  launched: number;
  served: number;
  epochInvalidated: number;
  freshnessInvalidated: number;
  failed: number;
  wasted: number;
  skipped: number;
}

export type RaftSpeculationServeResult =
  | { hit: true; value: unknown; replay: RaftSpeculationReplay }
  | { hit: false; reason: "absent" | "epoch" | "freshness" | "failed" };

/**
 * Host-side store consumed by ActionRegistry.invoke. Implemented by
 * RaftSpeculationStore; declared structurally so the registry never imports
 * the speculation package.
 */
export interface RaftSpeculationRuntime {
  tryServe(
    parentToolCallId: string,
    ref: string,
    preparedArgs: Record<string, unknown>,
    bindingToken: string,
  ): Promise<RaftSpeculationServeResult>;
  bumpEpoch(): void;
  reset?(): void;
  onInvocationEnd?(parentToolCallId: string): void;
}
