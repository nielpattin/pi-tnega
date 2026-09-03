import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tokenSpeed";
const SLIDING_WINDOW_MS = 1000;
const MIN_SLIDING_WINDOW_MS = 100;
const STALL_THRESHOLD_MS = 500;
const MAX_PLAUSIBLE_TPS = 10_000;
const COMPACTION_THRESHOLD = 5000;

const MIN_STREAM_MS = 1;
const MIN_STREAM_UPDATES = 5;
const MIN_INTER_CHUNK_MS = 1;
const MIN_GENERATION_MS = 200;
const ACTIVE_TIME_THRESHOLD_MS = 200;
const STALL_REDUCTION_DENOM = 2;
const STALL_DOMINANCE_RATIO = 0.85;

const TPS_THRESHOLD_SLOW = 0;
const TPS_THRESHOLD_MEDIUM = 15;
const TPS_THRESHOLD_FAST = 30;
const TPS_THRESHOLD_BLAZING = 45;

const COLOR_SLOW = "#ff4444";
const COLOR_MEDIUM = "#ffaa00";
const COLOR_FAST = "#00ff88";
const COLOR_BLAZING = "#44ddff";

const TOKEN_GENERATION_TOOLS = new Set(["edit", "write"]);

type StreamUpdate = {
   type: string;
   delta?: string;
   contentIndex?: number;
   partial?: {
      content?: Array<{ type?: unknown; name?: unknown }>;
      usage?: { output?: number };
   };
   toolCall?: { name?: unknown };
};

/** Timing accumulated across one complete agent loop. */
export interface TurnTiming {
   /** The start of the complete agent loop, not an individual assistant message. */
   turnStartMs: number;
   /** The user prompt timestamp used as the TTFT baseline when available. */
   ttftStartMs?: number;
   /** Time of the first assistant content event. */
   firstTokenMs: number | null;
   /** Assistant message updates after the first content event. */
   updateCount: number;
   firstStreamUpdateMs: number | null;
   lastStreamUpdateMs: number;
   /** Sum of assistant message_start to message_end spans across the loop. */
   totalGenerationMs: number;
   /** Duration of the most recently completed assistant message. */
   lastMessageMs: number | null;
   /** Accumulated gaps at or above STALL_THRESHOLD_MS between updates. */
   stallMs: number;
   stallCount: number;
   assistantMessages: AssistantMessage[];
}

/** Result of the TPS computation for one agent loop. */
export interface TpsComputation {
   tps: number | null;
   isPrimaryBranch: boolean;
   ttftMs: number | null;
   totalMs: number;
   lastMessageMs: number | null;
   streamMs: number | null;
   stallMs: number;
   stallCount: number;
   tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
   };
}

/**
 * Compute generation TPS from timing accumulated across an agent loop.
 * Returns null when the loop produced no assistant output.
 */
export function computeTps(
   timing: TurnTiming,
   loopEndMs: number,
   options?: { isToolCall?: boolean; tpsCap?: number; activeStreamMs?: number }
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

   const totalMs = loopEndMs - timing.turnStartMs;
   const streamMs =
      timing.updateCount > 0 && timing.firstStreamUpdateMs !== null
         ? timing.lastStreamUpdateMs - timing.firstStreamUpdateMs
         : null;
   const avgInterChunkGap = streamMs !== null && timing.updateCount > 1 ? streamMs / (timing.updateCount - 1) : 0;

   let tps: number | null = null;
   let isPrimaryBranch = false;

   if (options?.activeStreamMs !== undefined) {
      if (Number.isFinite(options.activeStreamMs) && options.activeStreamMs >= MIN_GENERATION_MS) {
         tps = Math.round((output / (options.activeStreamMs / 1000)) * 10) / 10;
         isPrimaryBranch = true;
      }
   } else if (
      streamMs !== null &&
      streamMs >= MIN_STREAM_MS &&
      timing.updateCount >= MIN_STREAM_UPDATES &&
      avgInterChunkGap >= MIN_INTER_CHUNK_MS &&
      timing.stallMs < streamMs &&
      streamMs - timing.stallMs >= MIN_GENERATION_MS &&
      timing.stallMs < streamMs - timing.stallMs
   ) {
      const effectiveStreamMs = streamMs - timing.stallMs;
      tps = Math.round((output / (effectiveStreamMs / 1000)) * 10) / 10;
      isPrimaryBranch = true;
   } else if (timing.updateCount >= 2 && timing.totalGenerationMs >= MIN_GENERATION_MS) {
      let effectiveGenerationMs = timing.totalGenerationMs - timing.stallMs;
      const stallsDominate =
         effectiveGenerationMs < ACTIVE_TIME_THRESHOLD_MS ||
         timing.stallMs > timing.totalGenerationMs * STALL_DOMINANCE_RATIO;

      if (stallsDominate) {
         effectiveGenerationMs = Math.max(
            timing.totalGenerationMs - timing.stallMs / STALL_REDUCTION_DENOM,
            MIN_GENERATION_MS
         );
      } else {
         effectiveGenerationMs = Math.max(effectiveGenerationMs, MIN_GENERATION_MS);
      }

      tps = Math.round((output / (effectiveGenerationMs / 1000)) * 10) / 10;
   }

   if (tps !== null && tps > MAX_PLAUSIBLE_TPS) {
      tps = null;
      isPrimaryBranch = false;
   }

   if (options?.isToolCall && options.tpsCap !== undefined && tps !== null) {
      tps = Math.min(tps, options.tpsCap);
   }

   const ttftStartMs = timing.ttftStartMs ?? timing.turnStartMs;
   return {
      tps,
      isPrimaryBranch,
      ttftMs: timing.firstTokenMs === null ? null : Math.max(timing.firstTokenMs - ttftStartMs, 0),
      totalMs,
      lastMessageMs: timing.lastMessageMs,
      streamMs,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      tokens: {
         input,
         output,
         cacheRead,
         cacheWrite,
         total: totalTokens
      }
   };
}

function nowMs(): number {
   return performance.now();
}

function isAssistantRole(message: unknown): boolean {
   return message !== null && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
   if (!isAssistantRole(message)) return false;

   const candidate = message as { usage?: unknown };
   if (typeof candidate.usage !== "object" || candidate.usage === null) return false;

   const usage = candidate.usage as { input?: unknown; output?: unknown };
   return typeof usage.input === "number" && typeof usage.output === "number";
}

function isUserMessage(message: unknown): boolean {
   return message !== null && typeof message === "object" && (message as { role?: unknown }).role === "user";
}

function getMessageTimestamp(message: unknown): number | null {
   if (message === null || typeof message !== "object") return null;

   const timestamp = (message as { timestamp?: unknown }).timestamp;
   return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function getToolName(event: StreamUpdate): string | undefined {
   if (typeof event.toolCall?.name === "string") return event.toolCall.name;

   const content = event.partial?.content?.[event.contentIndex ?? 0];
   if (content?.type === "toolCall" && typeof content.name === "string") {
      return content.name;
   }

   return undefined;
}

function colorHex(text: string, hex: string): string {
   if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return text;

   const red = parseInt(hex.slice(1, 3), 16);
   const green = parseInt(hex.slice(3, 5), 16);
   const blue = parseInt(hex.slice(5, 7), 16);
   return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

function getTpsColor(tps: number | null): string {
   if (tps === null || !Number.isFinite(tps)) return "";
   if (tps >= TPS_THRESHOLD_BLAZING) return COLOR_BLAZING;
   if (tps >= TPS_THRESHOLD_FAST) return COLOR_FAST;
   if (tps >= TPS_THRESHOLD_MEDIUM) return COLOR_MEDIUM;
   if (tps >= TPS_THRESHOLD_SLOW) return COLOR_SLOW;
   return "";
}

function renderStatus(ctx: ExtensionContext, tps: number | null): void {
   if (!ctx.hasUI) return;

   const theme = ctx.ui.theme;
   const measurement = tps !== null && Number.isFinite(tps) ? `${tps.toFixed(1)} tok/s` : "--";
   const coloredMeasurement = colorHex(measurement, getTpsColor(tps));
   ctx.ui.setStatus(STATUS_KEY, `${theme.fg("dim", "⚡ TPS:")} ${coloredMeasurement}`);
}

function formatLocalTime(timestampMs: number | null): string {
   return timestampMs === null ? "--" : new Date(timestampMs).toLocaleTimeString();
}

function composeMessage(
   result: TpsComputation,
   times?: { promptTimeMs: number | null; loopEndTimeMs: number }
): string {
   const tps = result.tps !== null ? `${result.tps.toFixed(1)} tok/s` : "-- tok/s";
   const ttft = result.ttftMs === null ? "--" : `${Math.round(result.ttftMs)} ms`;
   const elapsedSeconds = result.totalMs / 1000;
   const lastMessage = result.lastMessageMs === null ? "--" : `${(result.lastMessageMs / 1000).toFixed(1)}s`;
   const localTimes =
      times === undefined
         ? ""
         : `, prompt ${formatLocalTime(times.promptTimeMs)}, end ${formatLocalTime(times.loopEndTimeMs)}`;

   return `TPS ${tps}. TTFT ${ttft}. out ${result.tokens.output.toLocaleString()}, in ${result.tokens.input.toLocaleString()}, cache r/w ${result.tokens.cacheRead.toLocaleString()}/${result.tokens.cacheWrite.toLocaleString()}, total ${result.tokens.total.toLocaleString()}, loop ${elapsedSeconds.toFixed(1)}s, last message ${lastMessage}${localTimes}`;
}

class SlidingWindow {
   private readonly events: Array<{ time: number; tokens: number }> = [];
   private windowStartIndex = 0;

   constructor(private readonly windowMs: number) {}

   record(tokens: number, time: number): void {
      this.events.push({ time, tokens });
      if (this.windowStartIndex >= COMPACTION_THRESHOLD) this.compact();
   }

   getTps(time: number): number {
      if (this.events.length === 0) return 0;

      const windowStart = time - this.windowMs;
      while (this.windowStartIndex < this.events.length && this.events[this.windowStartIndex].time < windowStart) {
         this.windowStartIndex++;
      }

      if (this.windowStartIndex >= this.events.length) return 0;

      let tokenCount = 0;
      for (let index = this.windowStartIndex; index < this.events.length; index++) {
         tokenCount += this.events[index].tokens;
      }

      if (tokenCount === 0) return 0;

      const rawSpan = time - this.events[this.windowStartIndex].time;
      const span = Math.max(rawSpan, MIN_SLIDING_WINDOW_MS);
      return (1000 * tokenCount) / span;
   }

   reset(): void {
      this.events.length = 0;
      this.windowStartIndex = 0;
   }

   private compact(): void {
      if (this.windowStartIndex === 0) return;
      this.events.splice(0, this.windowStartIndex);
      this.windowStartIndex = 0;
   }
}

class LiveTokenTracker {
   private readonly slidingWindow = new SlidingWindow(SLIDING_WINDOW_MS);
   private streaming = false;
   private paused = false;
   private tokenCount = 0;
   private countedUsageOutput = 0;
   private startTime: number | null = null;
   private endTime: number | null = null;
   private pauseStart: number | null = null;
   private pausedMs = 0;
   private tpsValue = 0;

   get tps(): number {
      if (this.streaming) return this.tpsValue;
      const elapsed = this.activeMs;
      return elapsed > 0 ? this.tokenCount / (elapsed / 1000) : 0;
   }

   get activeMs(): number {
      return this.elapsedMs;
   }

   resetMessageUsage(): void {
      this.countedUsageOutput = 0;
   }

   start(): void {
      if (this.streaming) return;

      this.streaming = true;
      this.paused = false;
      this.tokenCount = 0;
      this.countedUsageOutput = 0;
      this.startTime = nowMs();
      this.endTime = null;
      this.pauseStart = null;
      this.pausedMs = 0;
      this.tpsValue = 0;
      this.slidingWindow.reset();
   }

   recordDelta(usageOutput?: number): void {
      if (!this.streaming) return;
      if (this.paused) this.resume();

      if (typeof usageOutput === "number" && Number.isFinite(usageOutput) && usageOutput > 0) {
         if (usageOutput <= this.countedUsageOutput) return;

         const tokens = usageOutput - this.countedUsageOutput;
         this.countedUsageOutput = usageOutput;
         this.tokenCount += tokens;
         const time = nowMs();
         this.slidingWindow.record(tokens, time);
         this.tpsValue = this.slidingWindow.getTps(time);
         return;
      }

      this.tokenCount++;
      const time = nowMs();
      this.slidingWindow.record(1, time);
      this.tpsValue = this.slidingWindow.getTps(time);
   }

   pause(): void {
      if (!this.streaming || this.paused) return;
      this.paused = true;
      this.pauseStart = nowMs();
   }

   stop(): void {
      if (!this.streaming) return;
      const time = nowMs();
      if (this.paused && this.pauseStart !== null) {
         this.pausedMs += time - this.pauseStart;
         this.paused = false;
         this.pauseStart = null;
      }
      this.streaming = false;
      this.endTime = time;
      this.slidingWindow.reset();
   }

   reconcileTotal(tokens: number): void {
      if (tokens > 0) this.tokenCount = tokens;
   }

   private resume(): void {
      if (!this.paused || this.pauseStart === null) return;
      this.pausedMs += nowMs() - this.pauseStart;
      this.paused = false;
      this.pauseStart = null;
   }

   private get elapsedMs(): number {
      if (this.startTime === null) return 0;

      const end = this.endTime ?? nowMs();
      const activePauseMs = this.paused && this.pauseStart !== null ? end - this.pauseStart : 0;
      return Math.max(end - this.startTime - this.pausedMs - activePauseMs, 0);
   }
}

interface LoopState {
   timing: TurnTiming;
   promptTimeMs: number | null;
   tracker: LiveTokenTracker;
   currentMessageStartMs: number | null;
   lastUpdateMs: number;
   inStall: boolean;
   isToolCall: boolean;
   modelKey: string | null;
   hasToolExecutionInTurn: boolean;
   toolBatchTerminates: boolean;
}

function createLoopState(startMs: number, ttftStartMs?: number): LoopState {
   return {
      timing: {
         turnStartMs: startMs,
         ttftStartMs,
         firstTokenMs: null,
         updateCount: 0,
         firstStreamUpdateMs: null,
         lastStreamUpdateMs: 0,
         totalGenerationMs: 0,
         lastMessageMs: null,
         stallMs: 0,
         stallCount: 0,
         assistantMessages: []
      },
      promptTimeMs: null,
      tracker: new LiveTokenTracker(),
      currentMessageStartMs: null,
      lastUpdateMs: 0,
      inStall: false,
      isToolCall: false,
      modelKey: null,
      hasToolExecutionInTurn: false,
      toolBatchTerminates: true
   };
}

function recordTimingUpdate(state: LoopState, time: number): void {
   if (state.timing.firstTokenMs === null) {
      state.timing.firstTokenMs = time;
      state.lastUpdateMs = time;
      return;
   }

   state.timing.updateCount++;
   if (state.timing.firstStreamUpdateMs === null) {
      state.timing.firstStreamUpdateMs = time;
   }
   state.timing.lastStreamUpdateMs = time;

   const gap = time - state.lastUpdateMs;
   if (gap >= STALL_THRESHOLD_MS) {
      if (!state.inStall) state.timing.stallCount++;
      state.inStall = true;
      state.timing.stallMs += gap;
   } else {
      state.inStall = false;
   }

   state.lastUpdateMs = time;
}

function shouldReportIntermediate(state: LoopState, event: { toolResults: unknown[] }, ctx: ExtensionContext): boolean {
   const hasPendingMessages = typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages();
   const hasContinuingToolBatch =
      event.toolResults.length > 0 && (!state.hasToolExecutionInTurn || !state.toolBatchTerminates);

   return hasPendingMessages || hasContinuingToolBatch;
}

export default function (pi: ExtensionAPI) {
   let current: LoopState | null = null;
   let pendingUserPromptStartMs: number | null = null;
   let pendingUserPromptTimeMs: number | null = null;
   let lastUserPromptTimeMs: number | null = null;
   const tpsCaps = new Map<string, number>();

   pi.on("session_start", (_event, ctx) => {
      current?.tracker.stop();
      current = null;
      pendingUserPromptStartMs = null;
      pendingUserPromptTimeMs = null;
      lastUserPromptTimeMs = null;
      renderStatus(ctx, null);
   });

   pi.on("session_shutdown", (_event, ctx) => {
      current?.tracker.stop();
      current = null;
      pendingUserPromptStartMs = null;
      pendingUserPromptTimeMs = null;
      lastUserPromptTimeMs = null;
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
   });

   pi.on("before_agent_start", () => {
      if (current) return;
      pendingUserPromptTimeMs = Date.now();
   });

   pi.on("agent_start", () => {
      const startMs = nowMs();
      if (pendingUserPromptTimeMs !== null) lastUserPromptTimeMs = pendingUserPromptTimeMs;
      current = createLoopState(startMs, pendingUserPromptStartMs ?? undefined);
      pendingUserPromptStartMs = null;
      pendingUserPromptTimeMs = null;
   });

   pi.on("turn_start", () => {
      if (!current) return;
      current.hasToolExecutionInTurn = false;
      current.toolBatchTerminates = true;
   });

   pi.on("message_start", (event) => {
      const message = event.message;
      if (isUserMessage(message)) {
         const promptStartMs = nowMs();
         const promptTimeMs = getMessageTimestamp(message) ?? Date.now();
         if (!current) {
            pendingUserPromptStartMs = promptStartMs;
            pendingUserPromptTimeMs = promptTimeMs;
         } else {
            if (current.promptTimeMs === null) {
               current.promptTimeMs = promptTimeMs;
               lastUserPromptTimeMs = promptTimeMs;
            }
            if (current.timing.firstTokenMs === null && current.timing.ttftStartMs === undefined) {
               current.timing.ttftStartMs = promptStartMs;
            }
         }
         return;
      }

      if (!current || !isAssistantRole(message)) return;
      current.tracker.resetMessageUsage();
      const time = nowMs();
      current.currentMessageStartMs = time;
      current.lastUpdateMs = time;
      current.inStall = false;
   });

   pi.on("message_update", (event, ctx) => {
      if (!current || !isAssistantRole(event.message)) return;

      const streamEvent = event.assistantMessageEvent as unknown as StreamUpdate;
      const time = nowMs();
      recordTimingUpdate(current, time);

      if (
         streamEvent.type === "text_start" ||
         streamEvent.type === "thinking_start" ||
         streamEvent.type === "toolcall_start"
      ) {
         current.tracker.start();
         renderStatus(ctx, current.tracker.tps);
         return;
      }

      if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta") {
         current.tracker.start();
         current.tracker.recordDelta(streamEvent.partial?.usage?.output);
         renderStatus(ctx, current.tracker.tps);
         return;
      }

      if (streamEvent.type === "toolcall_delta") {
         if (TOKEN_GENERATION_TOOLS.has(getToolName(streamEvent) ?? "")) {
            current.tracker.start();
            current.tracker.recordDelta(streamEvent.partial?.usage?.output);
            renderStatus(ctx, current.tracker.tps);
         }
         return;
      }

      if (streamEvent.type === "toolcall_end") {
         if (!TOKEN_GENERATION_TOOLS.has(getToolName(streamEvent) ?? "")) {
            current.tracker.pause();
         }
      }
   });

   pi.on("tool_execution_start", (event) => {
      if (!current) return;
      current.isToolCall = true;
      current.hasToolExecutionInTurn = true;
      if (!TOKEN_GENERATION_TOOLS.has(event.toolName)) current.tracker.pause();
   });

   pi.on("tool_execution_end", (event) => {
      if (!current) return;
      if (event.result?.terminate !== true) current.toolBatchTerminates = false;
   });

   pi.on("message_end", (event, ctx) => {
      if (!current || !isAssistantMessage(event.message)) return;

      const time = nowMs();
      if (current.currentMessageStartMs !== null) {
         const messageMs = time - current.currentMessageStartMs;
         current.timing.totalGenerationMs += messageMs;
         current.timing.lastMessageMs = messageMs;
         current.currentMessageStartMs = null;
      }

      current.timing.assistantMessages.push(event.message);
      current.lastUpdateMs = time;
      current.inStall = false;

      if (current.modelKey === null && event.message.provider && event.message.model) {
         current.modelKey = `${event.message.provider}:${event.message.model}`;
      }

      renderStatus(ctx, current.tracker.tps);
   });

   pi.on("turn_end", (event, ctx) => {
      if (!current || !isAssistantMessage(event.message)) return;

      renderStatus(ctx, current.tracker.tps);
      if (!shouldReportIntermediate(current, event, ctx)) return;

      const outputTokens = current.timing.assistantMessages.reduce(
         (total, message) => total + (message.usage.output || 0),
         0
      );
      current.tracker.reconcileTotal(outputTokens);

      const tpsCap = current.modelKey ? tpsCaps.get(current.modelKey) : undefined;
      const result = computeTps(current.timing, nowMs(), {
         isToolCall: current.isToolCall,
         tpsCap,
         activeStreamMs: current.tracker.activeMs
      });
      if (result && ctx.hasUI) ctx.ui.notify(composeMessage(result), "info");
   });

   pi.on("agent_end", (event: AgentEndEvent, ctx) => {
      if (!current) return;

      const state = current;
      current = null;
      pendingUserPromptStartMs = null;
      pendingUserPromptTimeMs = null;

      const finalAssistantMessages = event.messages.filter(isAssistantMessage);
      if (finalAssistantMessages.length > 0) {
         state.timing.assistantMessages = finalAssistantMessages;
         if (state.modelKey === null) {
            const firstMessage = finalAssistantMessages[0];
            if (firstMessage.provider && firstMessage.model) {
               state.modelKey = `${firstMessage.provider}:${firstMessage.model}`;
            }
         }
      }

      const outputTokens = state.timing.assistantMessages.reduce(
         (total, message) => total + (message.usage.output || 0),
         0
      );
      state.tracker.stop();
      state.tracker.reconcileTotal(outputTokens);

      const loopEndMs = nowMs();
      const loopEndTimeMs = Date.now();
      const tpsCap = state.modelKey ? tpsCaps.get(state.modelKey) : undefined;
      const result = computeTps(state.timing, loopEndMs, {
         isToolCall: state.isToolCall,
         tpsCap,
         activeStreamMs: state.tracker.activeMs
      });

      if (!state.isToolCall && state.modelKey && result?.isPrimaryBranch && result.tps !== null) {
         const previousCap = tpsCaps.get(state.modelKey);
         if (previousCap === undefined || result.tps > previousCap) {
            tpsCaps.set(state.modelKey, result.tps);
         }
      }

      if (!ctx.hasUI) return;
      renderStatus(ctx, state.tracker.tps);
      if (result) {
         ctx.ui.notify(
            composeMessage(result, { promptTimeMs: state.promptTimeMs ?? lastUserPromptTimeMs, loopEndTimeMs }),
            "info"
         );
      }
   });
}
