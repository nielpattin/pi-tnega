import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── TPS timing model ───────────────────────────────────────────────────────
// Adopted from @monotykamary/pi-tps: measures generation speed from turn-level
// events (turn_start / message_start / message_update / message_end / turn_end)
// using performance.now() sub-millisecond timing. TPS divides by the active
// streaming window (inter-update span minus stalls), excluding TTFT and
// tool-execution gaps. A three-branch gate nulls structurally unidentifiable
// rates (burst delivery, too few updates).

/** Minimum gap between token updates to count as a stall (ms) */
const STALL_THRESHOLD_MS = 500;

// Three-branch gate constants:
//   Primary:   ≥5 updates, avg inter-chunk gap ≥1ms, stall time < active
//              streaming time → genuine generation timing.
//   Fallback:  ≥2 updates, ≥200ms generation window → conservative rate that
//              includes TTFT (underestimates, never overshoots).
//   Else:      null — structurally unidentifiable.
const MIN_STREAM_MS = 1;
const MIN_STREAM_UPDATES = 5;
const MIN_INTER_CHUNK_MS = 1;
const MIN_GENERATION_MS = 200;
const ACTIVE_TIME_THRESHOLD_MS = 200;
const STALL_REDUCTION_DENOM = 2;
const STALL_DOMINANCE_RATIO = 0.85;

/** Maximum plausible generation speed (tok/s). Above this the measured rate is
 * a buffer-flush dispatch artifact, not inference. 5× the fastest known
 * commercial inference (Cerebras ~2,000 tok/s). */
const MAX_PLAUSIBLE_TPS = 10_000;

/** Per-turn timing accumulated from turn-level events, feeding computeTps. */
export interface TurnTiming {
   turnStartMs: number;
   /** Time of the first message_update — the effective first token. */
   firstTokenMs: number | null;
   /** message_update events after the first (TTFT) one. */
   updateCount: number;
   firstStreamUpdateMs: number | null;
   lastStreamUpdateMs: number;
   /** Sum of message_start → message_end spans across the turn. */
   totalGenerationMs: number;
   /** Accumulated gaps ≥ STALL_THRESHOLD_MS between streaming updates. */
   stallMs: number;
   stallCount: number;
   assistantMessages: AssistantMessage[];
}

/** Result of the TPS computation for one turn. */
export interface TpsComputation {
   tps: number | null;
   isPrimaryBranch: boolean;
   ttftMs: number | null;
   totalMs: number;
   streamMs: number | null;
   stallMs: number;
   stallCount: number;
   tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * Compute generation TPS from accumulated turn timing.
 * Returns null when the turn had no meaningful LLM output.
 *
 * Options:
 * - `isToolCall`: tool-call turns are clamped to the per-model cap (or nulled
 *   when no cap is known) to prevent inflation from short outputs over tiny
 *   time windows. They never set the cap.
 * - `tpsCap`: highest reliable (primary-branch, non-tool-call) TPS observed for
 *   this model. Only applied to tool-call turns.
 */
export function computeTps(
   timing: TurnTiming,
   turnEndMs: number,
   options?: { isToolCall?: boolean; tpsCap?: number }
): TpsComputation | null {
   let input = 0;
   let output = 0;
   let cacheRead = 0;
   let cacheWrite = 0;
   let totalTokens = 0;

   for (const message of timing.assistantMessages) {
      input += message.usage.input || 0;
      output += message.usage.output || 0;
      cacheRead += message.usage.cacheRead || 0;
      cacheWrite += message.usage.cacheWrite || 0;
      totalTokens += message.usage.totalTokens || 0;
   }

   if (output <= 0) return null;

   const totalMs = turnEndMs - timing.turnStartMs;

   const streamMs =
      timing.updateCount > 0 && timing.firstStreamUpdateMs !== null
         ? timing.lastStreamUpdateMs - timing.firstStreamUpdateMs
         : null;

   const avgInterChunkGap = streamMs !== null && timing.updateCount > 1 ? streamMs / (timing.updateCount - 1) : 0;

   let tps: number | null = null;
   let isPrimaryBranch = false;
   if (
      streamMs !== null &&
      streamMs >= MIN_STREAM_MS &&
      timing.updateCount >= MIN_STREAM_UPDATES &&
      avgInterChunkGap >= MIN_INTER_CHUNK_MS &&
      timing.stallMs < streamMs && // stalls must not dominate the streaming span
      streamMs - timing.stallMs >= MIN_GENERATION_MS && // effective span must be measurable
      timing.stallMs < streamMs - timing.stallMs // stall time < active time
   ) {
      const effectiveStreamMs = streamMs - timing.stallMs;
      tps = Math.round((output / (effectiveStreamMs / 1000)) * 10) / 10;
      isPrimaryBranch = true;
   } else if (timing.updateCount >= 2 && timing.totalGenerationMs >= MIN_GENERATION_MS) {
      let effectiveGenMs = timing.totalGenerationMs - timing.stallMs;
      const stallsDominate =
         effectiveGenMs < ACTIVE_TIME_THRESHOLD_MS || timing.stallMs > timing.totalGenerationMs * STALL_DOMINANCE_RATIO;
      if (stallsDominate) {
         effectiveGenMs = Math.max(
            timing.totalGenerationMs - timing.stallMs / STALL_REDUCTION_DENOM,
            MIN_GENERATION_MS
         );
      } else {
         effectiveGenMs = Math.max(effectiveGenMs, MIN_GENERATION_MS);
      }
      tps = Math.round((output / (effectiveGenMs / 1000)) * 10) / 10;
   }

   // Extraordinary claims require extraordinary evidence: a large token volume
   // in a tiny window is dispatch overhead, not inference speed.
   if (tps !== null && tps > MAX_PLAUSIBLE_TPS) {
      tps = null;
      isPrimaryBranch = false;
   }

   // Tool-call turns only get clamped, never set the cap.
   if (options?.isToolCall && tps !== null) {
      tps = options.tpsCap !== undefined ? Math.min(tps, options.tpsCap) : null;
   }

   return {
      tps,
      isPrimaryBranch,
      ttftMs: timing.firstTokenMs !== null ? timing.firstTokenMs - timing.turnStartMs : null,
      totalMs,
      streamMs,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      tokens: { input, output, cacheRead, cacheWrite, total: totalTokens }
   };
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
   if (!message || typeof message !== "object") return false;
   const msg = message as Record<string, unknown>;
   if (msg.role !== "assistant") return false;
   // Guard: ensure usage exists with required numeric fields before downstream access.
   if (typeof msg.usage !== "object" || msg.usage === null) return false;
   const usage = msg.usage as Record<string, unknown>;
   if (typeof usage.input !== "number" || typeof usage.output !== "number") return false;
   return true;
}

function composeMessage(t: TpsComputation): string {
   const tpsStr = t.tps !== null ? `${t.tps.toFixed(1)} tok/s` : "— tok/s";
   return `TPS ${tpsStr}. out ${t.tokens.output.toLocaleString()}, in ${t.tokens.input.toLocaleString()}, cache r/w ${t.tokens.cacheRead.toLocaleString()}/${t.tokens.cacheWrite.toLocaleString()}, total ${t.tokens.total.toLocaleString()}, ${(t.totalMs / 1000).toFixed(1)}s`;
}

export default function (pi: ExtensionAPI) {
   interface TurnState {
      timing: TurnTiming;
      currentMessageStartMs: number | null;
      lastUpdateMs: number;
      inStall: boolean;
      isToolCall: boolean;
      modelKey: string | null;
   }

   let current: TurnState | null = null;

   // Per-model TPS cap: highest reliable (primary-branch, non-tool-call) TPS observed.
   const tpsCaps = new Map<string, number>();

   pi.on("turn_start", () => {
      current = {
         timing: {
            turnStartMs: performance.now(),
            firstTokenMs: null,
            updateCount: 0,
            firstStreamUpdateMs: null,
            lastStreamUpdateMs: 0,
            totalGenerationMs: 0,
            stallMs: 0,
            stallCount: 0,
            assistantMessages: []
         },
         currentMessageStartMs: null,
         lastUpdateMs: 0,
         inStall: false,
         isToolCall: false,
         modelKey: null
      };
   });

   // message_start fires at stream creation (before any tokens), so TTFT is
   // captured at the first message_update. Reset stall-tracking so
   // tool-execution gaps between messages don't count as inference stalls.
   pi.on("message_start", (event) => {
      if (!current || !isAssistantMessage(event.message)) return;
      const now = performance.now();
      current.currentMessageStartMs = now;
      current.lastUpdateMs = now;
      current.inStall = false;
   });

   pi.on("message_update", (event) => {
      if (!current || !isAssistantMessage(event.message)) return;
      const now = performance.now();

      // First token: capture TTFT and seed stall timing, then bail. No stall
      // detection here — the gap from message_start is provider parsing
      // overhead, not a stall.
      if (current.timing.firstTokenMs === null) {
         current.timing.firstTokenMs = now;
         current.lastUpdateMs = now;
         return;
      }

      current.timing.updateCount++;
      if (current.timing.firstStreamUpdateMs === null) {
         current.timing.firstStreamUpdateMs = now;
      }
      current.timing.lastStreamUpdateMs = now;

      // Detect stall: gap exceeds threshold. The full gap counts as stall time.
      const gap = now - current.lastUpdateMs;
      if (gap >= STALL_THRESHOLD_MS) {
         if (!current.inStall) {
            current.timing.stallCount++;
         }
         current.inStall = true;
         current.timing.stallMs += gap;
      } else {
         current.inStall = false;
      }

      current.lastUpdateMs = now;
   });

   // Marks this turn as a tool call for the dynamic TPS cap.
   pi.on("tool_execution_start", () => {
      if (current) current.isToolCall = true;
   });

   pi.on("message_end", (event) => {
      if (!current || !isAssistantMessage(event.message)) return;
      const now = performance.now();

      if (current.currentMessageStartMs) {
         current.timing.totalGenerationMs += now - current.currentMessageStartMs;
         current.currentMessageStartMs = null;
      }

      current.timing.assistantMessages.push(event.message);
      current.lastUpdateMs = now;

      if (current.modelKey === null && event.message.provider && event.message.model) {
         current.modelKey = `${event.message.provider}:${event.message.model}`;
      }
   });

   pi.on("turn_end", (_event, ctx) => {
      if (!current) return;
      const state = current;
      current = null;

      const tpsCap = state.modelKey ? tpsCaps.get(state.modelKey) : undefined;
      const result = computeTps(state.timing, performance.now(), {
         isToolCall: state.isToolCall,
         tpsCap
      });
      if (!result) return;

      // Only non-tool-call, primary-branch (reliable) measurements set the cap.
      if (!state.isToolCall && state.modelKey && result.isPrimaryBranch && result.tps !== null) {
         const currentCap = tpsCaps.get(state.modelKey);
         if (currentCap === undefined || result.tps > currentCap) {
            tpsCaps.set(state.modelKey, result.tps);
         }
      }

      if (!ctx.hasUI) return;
      ctx.ui.notify(composeMessage(result), "info");
   });
}
