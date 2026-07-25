/**
 * pi-tps — Tokens-per-second tracker for pi
 *
 * Tracks LLM token usage and timing after every assistant run and renders a
 * compact usage row inline in the chat transcript.
 *
 * Toggle icon style with `/tps <text|nerdfont>`. Default is text-only icons.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
   ExtensionAPI,
   AgentEndEvent,
   AgentStartEvent,
   ExtensionCommandContext,
   ExtensionContext,
   Theme,
   ContextEvent
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";

// Event types not exported from main package - define locally
interface MessageStartEvent {
   type: "message_start";
   message: unknown;
}

interface MessageEndEvent {
   type: "message_end";
   message: unknown;
}

interface UsageStats {
   input: number;
   output: number;
   cacheRead: number;
   cacheWrite: number;
   agentStartMs: number;
   firstContextMs?: number;
   firstTokenMs: number;
   lastTokenMs: number;
}

interface TPSRowData extends UsageStats {
   timestamp: number;
}

interface TurnTiming {
   agentStartMs: number;
   firstContextMs?: number; // Right before the first provider request; more precise than agentStartMs
   firstTokenMs: number | null;
   lastTokenMs: number | null;
   assistantMessages: AssistantMessage[]; // Messages generated in this agent run
   totalGenerationMs: number; // Accumulated streaming time (excludes gaps)
   currentMessageStartMs: number | null; // When the current message started streaming
}

type IconMode = "text" | "nerdfont";

const ICONS: Record<IconMode, { input: string; output: string; cache: string; time: string; throughput: string }> = {
   nerdfont: {
      input: "\uf090", // 
      output: "\uf08b", // 
      cache: "\uf1c0", // 
      time: "\uf017", // 
      throughput: "\uf0e4" // 
   },
   text: {
      input: "in:",
      output: "out:",
      cache: "cache:",
      time: "ttft:",
      throughput: "tok/s:"
   }
};

const CONFIG_DIR = join(homedir(), ".pi");
const CONFIG_FILE = join(CONFIG_DIR, "tps-mode.json");
const TPS_CUSTOM_TYPE = "tps";

/** Below this the rate is mostly noise (cached / near-instant responses). */
const MIN_DURATION_MS = 100;

function loadMode(): IconMode {
   try {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { mode?: unknown };
      if (data.mode === "nerdfont" || data.mode === "text") {
         return data.mode;
      }
   } catch {
      // Missing or unreadable config falls back to default.
   }
   return "text";
}

function saveMode(mode: IconMode): void {
   try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify({ mode }, null, 2), "utf8");
   } catch {
      // Config write failure is non-fatal.
   }
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
   if (!message || typeof message !== "object") return false;
   const role = (message as { role?: unknown }).role;
   return role === "assistant";
}

function isTpsMessage(message: { role?: unknown; customType?: unknown }): boolean {
   return message.role === "custom" && message.customType === TPS_CUSTOM_TYPE;
}

/**
 * Compact number formatter for token counts:
 *   < 1_000   -> 606
 *   < 1_000_000 -> 1.2K / 126K
 *   >= 1_000_000 -> 1.5M
 */
function formatNumberCompact(num: number): string {
   const abs = Math.abs(num);
   if (abs < 1_000) {
      return num.toLocaleString();
   }
   if (abs < 1_000_000) {
      const value = num / 1_000;
      const fixed = value.toFixed(1);
      return `${fixed.endsWith(".0") ? Math.round(value) : fixed}K`;
   }
   const value = num / 1_000_000;
   const fixed = value.toFixed(1);
   return `${fixed.endsWith(".0") ? Math.round(value) : fixed}M`;
}

/**
 * Format duration in seconds to human-readable string.
 * Rules: no decimals, up to 2 units, includes weeks.
 * Exported for testing.
 */
export function formatDuration(totalSeconds: number): string {
   if (totalSeconds < 60) {
      return `${Math.round(totalSeconds)}s`;
   }

   const seconds = Math.round(totalSeconds);
   const units = [
      { label: "mo", seconds: 30 * 24 * 60 * 60 }, // 30 days
      { label: "w", seconds: 7 * 24 * 60 * 60 },
      { label: "d", seconds: 24 * 60 * 60 },
      { label: "h", seconds: 60 * 60 },
      { label: "m", seconds: 60 },
      { label: "s", seconds: 1 }
   ];

   const parts: { value: number; label: string }[] = [];
   let remaining = seconds;

   for (const unit of units) {
      if (remaining >= unit.seconds) {
         const value = Math.floor(remaining / unit.seconds);
         parts.push({ value, label: unit.label });
         remaining %= unit.seconds;
      }
   }

   const firstPart = parts[0];
   if (parts.length === 1 && firstPart) {
      const firstUnitIndex = units.findIndex((u) => u.label === firstPart.label);
      if (firstUnitIndex < units.length - 1) {
         let nextIndex = firstUnitIndex + 1;
         let nextUnit = units[nextIndex];
         if (firstPart.label === "mo" && nextUnit?.label === "w") {
            nextIndex++;
            nextUnit = units[nextIndex];
         }
         if (nextUnit) {
            parts.push({ value: 0, label: nextUnit.label });
         }
      }
   }

   const top2 = parts.slice(0, 2);
   return top2.map((p) => `${p.value}${p.label}`).join(" ");
}

function buildUsageStats(timing: TurnTiming): UsageStats | null {
   let input = 0;
   let output = 0;
   let cacheRead = 0;
   let cacheWrite = 0;

   for (const message of timing.assistantMessages) {
      input += message.usage.input || 0;
      output += message.usage.output || 0;
      cacheRead += message.usage.cacheRead || 0;
      cacheWrite += message.usage.cacheWrite || 0;
   }

   if (output <= 0) return null;
   if (!timing.firstTokenMs || !timing.lastTokenMs) return null;

   return {
      input,
      output,
      cacheRead,
      cacheWrite,
      agentStartMs: timing.agentStartMs,
      firstContextMs: timing.firstContextMs,
      firstTokenMs: timing.firstTokenMs,
      lastTokenMs: timing.lastTokenMs
   };
}

/**
 * Build a compact usage row from aggregated stats.
 * Returns null when there is nothing meaningful to show.
 * Uses firstContextMs when available because it is captured right before the
 * first provider request, which is more precise than agentStartMs for TTFT.
 */
function formatUsageStats(stats: UsageStats, mode: IconMode): string | null {
   if (stats.output <= 0) return null;

   const startMs = stats.firstContextMs ?? stats.agentStartMs;
   const ttftMs = stats.firstTokenMs - startMs;
   const totalMs = stats.lastTokenMs - startMs;
   const icons = ICONS[mode];

   const parts: string[] = [];
   parts.push(`${icons.input} ${formatNumberCompact(stats.input + stats.cacheWrite)}`);
   parts.push(`${icons.output} ${formatNumberCompact(stats.output)}`);
   if (stats.cacheRead > 0) {
      parts.push(`${icons.cache} ${formatNumberCompact(stats.cacheRead)}`);
   }
   if (ttftMs > 0) {
      parts.push(`${icons.time} ${(ttftMs / 1000).toFixed(1)}s`);
   }
   if (totalMs > MIN_DURATION_MS) {
      // Generation window is total wall time minus TTFT.
      const genMs = totalMs - ttftMs;
      if (genMs > MIN_DURATION_MS) {
         const tokPerSec = (stats.output / genMs) * 1000;
         parts.push(`${icons.throughput} ${tokPerSec.toFixed(1)}/s`);
      }
   }

   return parts.join("  ");
}

/**
 * Build a compact usage row for the current run.
 * Returns null when there is nothing meaningful to show.
 * Exported for testing.
 */
export function formatUsageRow(timing: TurnTiming, mode: IconMode): string | null {
   const stats = buildUsageStats(timing);
   return stats ? formatUsageStats(stats, mode) : null;
}

/**
 * Custom transcript component that renders the usage row left-aligned (under the
 * assistant bubble) and dim. The text is recomputed on every render so toggling
 * `/tps` updates existing rows. Exported for testing.
 */
export class UsageRowComponent implements Component {
   constructor(
      private getText: () => string,
      private theme: Theme
   ) {}

   invalidate(): void {}

   render(_width: number): string[] {
      return [this.theme.fg("dim", this.getText())];
   }
}

export default function tpsExtension(pi: ExtensionAPI) {
   // Current turn timing state
   let currentTiming: TurnTiming | null = null;
   // Track if we've seen any assistant messages in this turn
   let hasSeenAssistantMessage = false;
   // Icon style preference (loaded from ~/.pi/tps-mode.json, defaults to text)
   let currentIconMode: IconMode = loadMode();

   // Render the inline usage row in TUI mode.
   pi.registerMessageRenderer<TPSRowData>(TPS_CUSTOM_TYPE, (message, _options, theme) => {
      const details = message.details as TPSRowData | { message: string; timestamp: number } | undefined;
      if (!details) return undefined;
      // Legacy rows created before the dynamic renderer stored a precomputed string.
      if ("message" in details) {
         return new UsageRowComponent(() => details.message, theme);
      }
      if (!details.output) return undefined;
      return new UsageRowComponent((): string => formatUsageStats(details, currentIconMode) ?? "", theme);
   });

   // Register /tps slash command to toggle icon style.
   pi.registerCommand("tps", {
      description: "Toggle TPS usage-row icon style (text or nerdfont)",
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] => {
         const options: IconMode[] = ["text", "nerdfont"];
         const prefix = argumentPrefix.toLowerCase();
         return options
            .filter((option) => option.startsWith(prefix))
            .map((option) => ({ value: option, label: option }));
      },
      handler: async (args: string, ctx: ExtensionCommandContext) => {
         const requested = args.trim().toLowerCase();
         const nextMode: IconMode =
            requested === "text" || requested === "nerdfont"
               ? requested
               : currentIconMode === "text"
                 ? "nerdfont"
                 : "text";
         currentIconMode = nextMode;
         saveMode(nextMode);
         ctx.ui.notify(`TPS icon mode set to ${nextMode}`, "info");
      }
   });

   // Keep the TPS row out of LLM context. Custom messages participate by default,
   // so we strip our own injected rows before every provider request.
   // Also capture the moment right before the first provider request; this is a
   // much better TTFT baseline than agent_start.
   pi.on("context", (event: ContextEvent) => {
      if (currentTiming && currentTiming.firstContextMs === undefined) {
         currentTiming.firstContextMs = performance.now();
      }
      const messages = event.messages.filter(
         (message) => !isTpsMessage(message as { role?: unknown; customType?: unknown })
      );
      return { messages };
   });

   // Track when the agent run starts (request sent to LLM).
   // We aggregate across the whole run so multi-turn tool loops collapse into one row.
   pi.on("agent_start", (_event: AgentStartEvent) => {
      currentTiming = {
         agentStartMs: performance.now(),
         firstTokenMs: null,
         lastTokenMs: null,
         assistantMessages: [],
         totalGenerationMs: 0,
         currentMessageStartMs: null
      };
      hasSeenAssistantMessage = false;
   });

   // Track when a message starts (first token received)
   pi.on("message_start", (event: MessageStartEvent) => {
      if (!currentTiming) return;
      if (!isAssistantMessage(event.message)) return;

      const now = performance.now();

      if (!hasSeenAssistantMessage) {
         currentTiming.firstTokenMs = now;
         hasSeenAssistantMessage = true;
      }

      currentTiming.currentMessageStartMs = now;
   });

   // Track when a message ends
   pi.on("message_end", (event: MessageEndEvent) => {
      if (!currentTiming) return;
      if (!isAssistantMessage(event.message)) return;

      const now = performance.now();

      currentTiming.lastTokenMs = now;

      if (currentTiming.currentMessageStartMs) {
         const messageGenerationMs = now - currentTiming.currentMessageStartMs;
         currentTiming.totalGenerationMs += messageGenerationMs;
         currentTiming.currentMessageStartMs = null;
      }

      currentTiming.assistantMessages.push(event.message);
   });

   // Inject the usage row as a custom message once the agent run is fully idle.
   // During agent_end Pi still considers itself streaming, so calling sendMessage
   // synchronously would be delivered as a steering message and loop forever.
   // We defer to the next tick; by then finishRun() has cleared isStreaming and
   // the message appends as a pure display row.
   pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!currentTiming) return;

      const timing = currentTiming;
      currentTiming = null;
      hasSeenAssistantMessage = false;

      const stats = buildUsageStats(timing);
      if (!stats) return;

      setTimeout(() => {
         if (!ctx.isIdle()) return;
         pi.sendMessage(
            {
               customType: TPS_CUSTOM_TYPE,
               content: "",
               display: true,
               details: { ...stats, timestamp: performance.now() }
            },
            { triggerTurn: false }
         );
      }, 0);
   });
}
