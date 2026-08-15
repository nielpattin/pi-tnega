/// <reference lib="es2023" />

/**
 * /wf dashboard: a full-screen overlay with a run list and a per-run
 * detail view (phases sidebar + agents panel), modeled after:
 *
 *   name                                             5/5 agents · 31m18s · done
 *   description
 *   ╭ Phases ────────────╮ ╭ Gather · 3 agents ──────────────────────────────╮
 *   │ ❯ ■ Gather     3/3 │ │ ■ CodeRabbit feedback   gpt-5 · 7%/372k  5m37s│
 *   │   ■ Verify     1/1 │ │ ■ Other bot feedback    gpt-5 · 9%/372k  4m43s│
 *   ╰────────────────────╯ ╰─────────────────────────────────────────────────╯
 *   up/down select · s settings · esc back
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
   copyToClipboard,
   buildSessionContext,
   getAgentDir,
   type AgentSession,
   type ExtensionContext,
   type KeybindingsManager
} from "@earendil-works/pi-coding-agent";
import {
   Key,
   matchesKey,
   sliceByColumn,
   stripTerminalSequences,
   truncateToWidth,
   visibleWidth,
   wrapTextWithAnsi,
   type Component,
   type TUI
} from "@earendil-works/pi-tui";
import { persistWorkflowJson, recoverWorkflowDetails } from "./artifacts.ts";
import { transcriptFromMessages } from "./runner.ts";
import {
   agentContext,
   countStates,
   formatAgentModel,
   formatElapsed,
   formatUsage,
   aggregateUsage,
   phaseGroups,
   resultJson,
   shortenHome,
   stateSquare,
   statusColor,
   statusWord,
   SQUARE,
   type Theme,
   type AgentRecord,
   type PhaseGroup,
   type TranscriptEntry,
   type WorkflowDetails
} from "./model.ts";

const NOTICE_TTL_MS = 4000;
const DOUBLE_X_ABORT_WINDOW_MS = 750;
const MIN_HEIGHT = 10;
const TRANSCRIPT_SCROLL_STEP = 20;
const WHEEL_SCROLL_LINES = 3;
const MOUSE_ENABLE = "\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1004h\u001b[?1006h";

function isAgentPending(agent: Pick<AgentRecord, "state">): boolean {
   return agent.state === "waiting" || agent.state === "running";
}

const MOUSE_DISABLE = "\u001b[?1006l\u001b[?1004l\u001b[?1003l\u001b[?1002l\u001b[?1000l";
const ALTERNATE_SCREEN_ENTER = `\u001b[?1049h\u001b[2J\u001b[H${MOUSE_ENABLE}`;
const ALTERNATE_SCREEN_EXIT = `${MOUSE_DISABLE}\u001b[?1049l`;

type ToolMarkerColor = Parameters<Theme["fg"]>[0];

const TOOL_MARKER_COLORS: Partial<Record<string, ToolMarkerColor>> = {
   read: "success",
   write: "warning",
   edit: "accent",
   ls: "mdLink",
   find: "thinkingText",
   fffind: "thinkingOff",
   glob: "userMessageText",
   grep: "toolTitle",
   ffgrep: "customMessageText",
   bash: "mdCode",
   structured_output: "mdHeading"
};

const TOOL_MARKER_PALETTE: readonly ToolMarkerColor[] = [
   "accent",
   "success",
   "warning",
   "thinkingText",
   "userMessageText",
   "toolTitle",
   "mdCode",
   "mdHeading",
   "mdLink",
   "customMessageText"
];

export function toolMarkerColor(toolName: string | undefined): ToolMarkerColor {
   const known = toolName ? TOOL_MARKER_COLORS[toolName] : undefined;
   if (known) return known;
   const name = toolName ?? "unknown";
   let hash = 0;
   for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
   return TOOL_MARKER_PALETTE[hash % TOOL_MARKER_PALETTE.length];
}

/**
 * Use a terminal alternate buffer only when Pi is still using its regular renderer.
 * Pi fullscreen mode already owns an alternate buffer and must not be nested.
 */
export function shouldUseWorkflowAlternateScreen(mode: TUI["mode"], isTTY = Boolean(process.stdout.isTTY)): boolean {
   return mode === "regular" && isTTY;
}

/** Return the transcript scroll delta for a terminal wheel event. */
export function workflowWheelDelta(data: string): number {
   const sgr = /^\u001b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
   if (sgr) {
      const button = Number.parseInt(sgr[1], 10);
      if ((button & 64) === 0) return 0;
      const direction = button & 3;
      if (direction === 0) return -WHEEL_SCROLL_LINES;
      if (direction === 1) return WHEEL_SCROLL_LINES;
      return 0;
   }

   if (data.length === 6 && data.startsWith("\u001b[M")) {
      const button = data.charCodeAt(3) - 32;
      if ((button & 64) === 0) return 0;
      const direction = button & 3;
      if (direction === 0) return -WHEEL_SCROLL_LINES;
      if (direction === 1) return WHEEL_SCROLL_LINES;
   }
   return 0;
}

export interface WorkflowMouseEvent {
   button: number;
   x: number;
   y: number;
   release: boolean;
}

/** Parse a terminal mouse event for the regular-mode alternate screen. */
export function parseWorkflowMouseEvent(data: string): WorkflowMouseEvent | undefined {
   const sgr = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
   if (sgr) {
      return {
         button: Number.parseInt(sgr[1], 10),
         x: Number.parseInt(sgr[2], 10) - 1,
         y: Number.parseInt(sgr[3], 10) - 1,
         release: sgr[4] === "m"
      };
   }

   if (data.length === 6 && data.startsWith("\u001b[M")) {
      return {
         button: data.charCodeAt(3) - 32,
         x: data.charCodeAt(4) - 33,
         y: data.charCodeAt(5) - 33,
         release: false
      };
   }
   return undefined;
}

type WorkflowInputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

function configureFullscreenViewport(tui: TUI, keybindings: KeybindingsManager, screen: Component): () => void {
   if (tui.mode !== "fullscreen") return () => {};

   // TuiAltScreen exposes this constructor option, but the extension UI does not.
   // Feature-detect the runtime field so older Pi versions remain compatible.
   const runtimeTui = tui as TUI & { wheelScrollLines?: number };
   const previousWheelLines = runtimeTui.wheelScrollLines;
   if (typeof previousWheelLines === "number") runtimeTui.wheelScrollLines = WHEEL_SCROLL_LINES;

   // Pi's fullscreen viewport consumes these keys before focused overlays receive them.
   // Temporarily release them so this screen can handle page navigation itself.
   const previousBindings = keybindings.getUserBindings();
   keybindings.setUserBindings({
      ...previousBindings,
      "tui.altScreen.pageUp": [],
      "tui.altScreen.pageDown": [],
      "tui.altScreen.top": [],
      "tui.altScreen.bottom": []
   });

   const runtimeListeners = tui as TUI & { inputListeners?: Set<WorkflowInputListener> };
   const listeners = runtimeListeners.inputListeners;
   const previousListeners = listeners ? [...listeners] : undefined;
   const wheelListener: WorkflowInputListener = (data) => {
      const isPageNavigation = matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown);
      if (workflowWheelDelta(data) === 0 && !isPageNavigation) return undefined;
      screen.handleInput?.(data);
      return { consume: true };
   };
   if (listeners) {
      listeners.clear();
      listeners.add(wheelListener);
      for (const listener of previousListeners ?? []) listeners.add(listener);
   }

   return () => {
      if (typeof previousWheelLines === "number") runtimeTui.wheelScrollLines = previousWheelLines;
      keybindings.setUserBindings(previousBindings);
      if (listeners && previousListeners) {
         listeners.clear();
         for (const listener of previousListeners) listeners.add(listener);
      }
   };
}

function enterWorkflowAlternateScreen(tui: TUI, keybindings: KeybindingsManager, screen: Component): () => void {
   const useAlternateScreen = shouldUseWorkflowAlternateScreen(tui.mode);
   const previousChildren = useAlternateScreen ? [...tui.children] : undefined;
   const releaseFullscreenViewport = configureFullscreenViewport(tui, keybindings, screen);
   if (useAlternateScreen) {
      tui.clear();
      tui.addChild(screen);
      tui.terminal.write(ALTERNATE_SCREEN_ENTER);
   }
   tui.requestRender(true);

   let released = false;
   return () => {
      if (released) return;
      released = true;
      releaseFullscreenViewport();
      if (previousChildren) {
         tui.clear();
         for (const child of previousChildren) tui.addChild(child);
      }
      if (useAlternateScreen) tui.terminal.write(ALTERNATE_SCREEN_EXIT);
      tui.requestRender(true);
   };
}

function wrapSelection(index: number, delta: number, length: number): number {
   if (length === 0) return 0;
   return (index + delta + length) % length;
}

export interface RunEntry {
   runId: string;
   details: WorkflowDetails;
   live: boolean;
}

function runsDir(): string {
   return path.join(getAgentDir(), "workflows");
}

export function loadSessionTranscript(sessionFile: string): TranscriptEntry[] {
   try {
      const entries = fs
         .readFileSync(sessionFile, "utf8")
         .split(/\r?\n/)
         .filter(Boolean)
         .map((line) => JSON.parse(line) as { type?: string; id?: string })
         .filter((entry) => entry.type !== "session") as Parameters<typeof buildSessionContext>[0];
      return transcriptFromMessages(buildSessionContext(entries, entries.at(-1)?.id).messages);
   } catch {
      return [];
   }
}

export function normalizeTranscript(value: unknown): TranscriptEntry[] {
   if (!Array.isArray(value)) return [];
   const transcript: TranscriptEntry[] = [];
   for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (
         entry.role !== "user" &&
         entry.role !== "assistant" &&
         entry.role !== "thinking" &&
         entry.role !== "tool" &&
         entry.role !== "toolResult"
      ) {
         continue;
      }
      if (typeof entry.text !== "string") continue;
      transcript.push({
         role: entry.role,
         text: entry.text,
         name: typeof entry.name === "string" ? entry.name : undefined,
         toolCallId: typeof entry.toolCallId === "string" ? entry.toolCallId : undefined,
         isError: entry.isError === true,
         timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
         startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
         finishedAt: typeof entry.finishedAt === "number" ? entry.finishedAt : undefined,
         durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined
      });
   }
   return transcript;
}

/** Leniently normalize a workflow.json (including runs from older tooling). */
function normalizeDetails(runId: string, raw: unknown): WorkflowDetails | undefined {
   if (!raw || typeof raw !== "object") return undefined;
   const record = raw as Record<string, unknown>;
   const meta = (record.meta ?? {}) as Record<string, unknown>;

   const rawAgents = Array.isArray(record.agents) ? record.agents : [];
   const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
   const agents: AgentRecord[] = [];
   for (const item of rawAgents) {
      if (!item || typeof item !== "object") continue;
      const a = item as Record<string, unknown>;
      const state =
         a.state === "error" || a.state === "failed"
            ? "error"
            : a.state === "waiting"
              ? "waiting"
              : a.state === "running"
                ? "running"
                : "done";
      agents.push({
         index: typeof a.index === "number" ? a.index : agents.length + 1,
         label: typeof a.label === "string" ? a.label : `agent-${agents.length + 1}`,
         phase: typeof a.phase === "string" ? a.phase : undefined,
         state,
         profile: typeof a.profile === "string" && a.profile !== "[undefined]" ? a.profile : undefined,
         provider: typeof a.provider === "string" && a.provider !== "[undefined]" ? a.provider : undefined,
         model: typeof a.model === "string" && a.model !== "[undefined]" ? a.model : undefined,
         sessionId: typeof a.sessionId === "string" && a.sessionId !== "[undefined]" ? a.sessionId : undefined,
         sessionFile: typeof a.sessionFile === "string" && a.sessionFile !== "[undefined]" ? a.sessionFile : undefined,
         cwd: typeof a.cwd === "string" && a.cwd !== "[undefined]" ? a.cwd : undefined,
         systemPrompt:
            typeof a.systemPrompt === "string" && a.systemPrompt !== "[undefined]" ? a.systemPrompt : undefined,
         contextWindow:
            typeof a.contextWindow === "number" && Number.isFinite(a.contextWindow) && a.contextWindow > 0
               ? a.contextWindow
               : undefined,
         startedAt: typeof a.startedAt === "number" ? a.startedAt : startedAt,
         finishedAt: typeof a.finishedAt === "number" ? a.finishedAt : undefined,
         error: typeof a.error === "string" && a.error !== "[undefined]" ? a.error : undefined,
         preview: typeof a.preview === "string" ? a.preview : "",
         result: a.result,
         usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
            ...(a.usage && typeof a.usage === "object" ? (a.usage as object) : {})
         },
         transcript: normalizeTranscript(a.transcript)
      });
   }
   const summaryAgents = agents.filter((agent) => agent.phase === "Summary");
   if (summaryAgents.length > 0) {
      agents.splice(0, agents.length, ...agents.filter((agent) => agent.phase !== "Summary"), ...summaryAgents);
   }

   const rawPhases = Array.isArray(record.phases) ? record.phases : Array.isArray(meta.phases) ? meta.phases : [];
   const phases: WorkflowDetails["phases"] = [];
   for (const item of rawPhases) {
      if (!item || typeof item !== "object") continue;
      const p = item as Record<string, unknown>;
      if (typeof p.title !== "string") continue;
      phases.push({
         title: p.title,
         ...(typeof p.detail === "string" ? { detail: p.detail } : {})
      });
   }

   const status =
      record.status === "running" || record.status === "failed" || record.status === "aborted"
         ? record.status
         : "completed";

   return {
      runId,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      parentSessionFile:
         typeof record.parentSessionFile === "string" && record.parentSessionFile !== "[undefined]"
            ? record.parentSessionFile
            : undefined,
      name: typeof record.name === "string" ? record.name : typeof meta.name === "string" ? meta.name : undefined,
      description:
         typeof record.description === "string"
            ? record.description
            : typeof meta.description === "string"
              ? meta.description
              : undefined,
      background: record.background === true,
      status,
      startedAt,
      finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : undefined,
      phases,
      currentPhase: typeof record.currentPhase === "string" ? record.currentPhase : undefined,
      agents,
      result: record.result,
      error: typeof record.error === "string" ? record.error : undefined
   };
}

export function sessionWorkflowRunIds(ctx: ExtensionContext): Set<string> {
   const runIds = new Set<string>();
   for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "workflow") {
         continue;
      }
      const details = entry.message.details;
      if (!details || typeof details !== "object") continue;
      const runId = (details as Record<string, unknown>).runId;
      if (typeof runId === "string") runIds.add(runId);
   }
   return runIds;
}

export function loadRunEntries(
   active: Map<string, WorkflowDetails>,
   sessionId: string,
   referencedRunIds: ReadonlySet<string>
): RunEntry[] {
   let names: string[] = [];
   try {
      names = fs.readdirSync(runsDir()).filter((name) => name.startsWith("wf_"));
   } catch {
      // No runs yet.
   }
   const entries: RunEntry[] = [];
   for (const runId of names) {
      const live = active.get(runId);
      if (live) {
         entries.push({ runId, details: live, live: true });
         continue;
      }
      try {
         const raw = JSON.parse(fs.readFileSync(path.join(runsDir(), runId, "workflow.json"), "utf8"));
         const details = normalizeDetails(runId, raw);
         if (details && (details.sessionId === sessionId || referencedRunIds.has(runId))) {
            const runDir = path.join(runsDir(), runId);
            for (const agent of details.agents) {
               if (agent.sessionFile) agent.transcript = loadSessionTranscript(agent.sessionFile);
            }
            const recovered = recoverWorkflowDetails(details);
            if (recovered !== details) {
               try {
                  persistWorkflowJson(runDir, recovered);
               } catch {
                  // The dashboard can still inspect the recovered in-memory state.
               }
            }
            entries.push({ runId, details: recovered, live: false });
         }
      } catch {
         // Skip unreadable runs.
      }
   }
   return entries.toSorted((a, b) => b.details.startedAt - a.details.startedAt);
}

function copiedTranscriptBody(transcript: ReadonlyArray<TranscriptEntry>): string {
   return transcript
      .map((entry) => {
         if (entry.role === "user") return `User:\n${entry.text}`;
         if (entry.role === "assistant") return `Assistant:\n${entry.text}`;
         if (entry.role === "thinking") return `Thinking:\n${entry.text}`;
         if (entry.role === "tool") return `Tool ${entry.name ?? "unknown"}:\n${entry.text}`;
         return `${entry.isError ? "Error" : "Result"} ${entry.name ?? "unknown"}:\n${entry.text}`;
      })
      .join("\n\n");
}

function compactPreview(value: string): string {
   return value.replace(/\s+/g, " ").trim();
}

function toolArgumentSummary(entry: TranscriptEntry): string {
   if (entry.role !== "tool") return "";
   try {
      const parsed = JSON.parse(entry.text) as Record<string, unknown>;
      const text = (key: string) => (typeof parsed[key] === "string" ? parsed[key] : undefined);
      const values = (() => {
         if (entry.name === "find" || entry.name === "fffind" || entry.name === "glob") {
            return [text("path"), text("pattern")];
         }
         if (entry.name === "grep" || entry.name === "ffgrep") {
            return [text("pattern"), text("path")];
         }
         if (entry.name === "read" || entry.name === "write" || entry.name === "edit" || entry.name === "ls") {
            return [text("path")];
         }
         if (entry.name === "bash") return [text("command")];
         return [text("path"), text("command"), text("query"), text("url"), text("name")];
      })();
      return compactPreview(values.filter((value): value is string => value !== undefined).join(" "));
   } catch {
      return "";
   }
}

function compactToolResult(entry: TranscriptEntry, includeMark = true): string {
   const mark = entry.isError ? "✗ " : "✓ ";
   const prefix = includeMark ? mark : "";
   const text = entry.text.trim();
   if (!text) return `${prefix}${entry.name ?? "unknown"}`;
   if (["find", "fffind", "glob", "grep", "ffgrep"].includes(entry.name ?? "")) {
      const count = text.split("\n").filter((line) => line.trim()).length;
      return `${prefix}${entry.name ?? "unknown"} (${count} ${count === 1 ? "result" : "results"})`;
   }
   if (["read", "write", "edit", "ls", "bash"].includes(entry.name ?? "")) {
      const count = text.split("\n").filter((line) => line.trim()).length;
      return `${prefix}${entry.name ?? "unknown"} (${count} ${count === 1 ? "line" : "lines"})`;
   }
   return `${prefix}${entry.name ?? "unknown"} · ${compactPreview(text)}`;
}

function compactToolCall(entry: TranscriptEntry): string {
   const name = entry.name ?? "unknown";
   const args = toolArgumentSummary(entry);
   return args ? `${SQUARE} ${name} ${args}` : `${SQUARE} ${name}`;
}

function styleToolCall(theme: Theme, entry: TranscriptEntry, call: string, textColor: ToolMarkerColor): string {
   if (!call.startsWith(SQUARE)) return theme.fg(textColor, call);
   return theme.fg(toolMarkerColor(entry.name), SQUARE) + theme.fg(textColor, call.slice(SQUARE.length));
}

function structuredOutputLines(entry: TranscriptEntry): string[] {
   const raw = entry.text.trim();
   if (!raw) return [];
   try {
      const formatted = JSON.stringify(JSON.parse(raw), null, 2) ?? raw;
      return formatted.split("\n").flatMap((line) => {
         const parts = line.split("\\n");
         if (parts.length === 1) return [line];
         const indent = line.match(/^\s*/)?.[0] ?? "";
         return parts.map((part, index) => (index === 0 ? part : `${indent}${part}`));
      });
   } catch {
      return raw.split("\n");
   }
}

function compactCombinedToolLine(
   call: TranscriptEntry,
   result: TranscriptEntry
): { readonly result: string; readonly call: string } {
   return {
      result: compactToolResult(result, false),
      call: compactToolCall(call)
   };
}

/**
 * Resolve the most useful path for a selected workflow agent.
 *
 * @param details - The workflow run containing the agent.
 * @param agent - The selected agent record.
 * @returns The child session file, working directory, or parent session file.
 */
export function workflowAgentPath(
   details: Pick<WorkflowDetails, "parentSessionFile">,
   agent: Pick<AgentRecord, "sessionFile" | "cwd">
): string | undefined {
   const candidate = agent.sessionFile ?? agent.cwd ?? details.parentSessionFile;
   return candidate ? path.resolve(candidate) : undefined;
}

/**
 * Build the clipboard representation of one workflow agent transcript.
 *
 * @param details - The workflow run containing the agent.
 * @param agent - The selected agent record.
 * @returns A labeled transcript payload suitable for pasting into another session.
 */
export function buildWorkflowTranscriptPayload(
   details: Pick<WorkflowDetails, "runId" | "name">,
   agent: Pick<AgentRecord, "label" | "systemPrompt" | "transcript">
): string {
   const body = copiedTranscriptBody(agent.transcript) || "(no transcript recorded)";
   const prompt = agent.systemPrompt
      ? `\n\n---SYSTEM-PROMPT-START---\n\n${agent.systemPrompt}\n\n---SYSTEM-PROMPT-END---`
      : "";
   const name = details.name ? ` ${details.name}` : "";
   return `Workflow ${details.runId}${name} · agent ${agent.label}${prompt}\n\n---TRANSCRIPT-START---\n\n${body}\n\n---TRANSCRIPT-END---`;
}

function buildReport(details: WorkflowDetails): string {
   const { done, failed } = countStates(details);
   const lines: string[] = [
      `# Workflow ${details.name ?? details.runId}`,
      "",
      `- Run: ${details.runId}`,
      `- Status: ${statusWord(details.status)}`,
      `- Agents: ${done}/${details.agents.length} ok${failed ? `, ${failed} failed` : ""}`,
      `- Elapsed: ${formatElapsed(details.startedAt, details.finishedAt)}`
   ];
   const totals = formatUsage(aggregateUsage(details.agents));
   if (totals) lines.push(`- Usage: ${totals}`);
   if (details.description) lines.push("", details.description);
   if (details.error) lines.push("", `**Error:** ${details.error}`);

   for (const group of phaseGroups(details, true)) {
      lines.push("", `## ${group.title}`, "");
      if (group.agents.length === 0) {
         lines.push("_no agents_");
         continue;
      }
      for (const agent of group.agents) {
         const status =
            agent.state === "done"
               ? "ok"
               : agent.state === "error"
                 ? "failed"
                 : agent.state === "waiting"
                   ? "waiting"
                   : "running";
         const stats = [
            agent.profile,
            formatAgentModel(agent),
            agentContext(agent),
            formatElapsed(agent.startedAt, agent.finishedAt)
         ]
            .filter(Boolean)
            .join(" · ");
         lines.push(`- **${agent.label}** — ${status}${stats ? ` (${stats})` : ""}`);
         if (agent.error) lines.push(`  - error: ${agent.error}`);
      }
   }

   if (details.result !== undefined) {
      lines.push("", "## Result", "", "```json", resultJson(details.result), "```");
   }
   lines.push("");
   return lines.join("\n");
}

type View = "list" | "detail" | "transcript";
type DetailFocus = "phases" | "agents";
type WorkflowSelectionPoint = { x: number; y: number };
type WorkflowMouseSelection = {
   anchor: WorkflowSelectionPoint;
   focus: WorkflowSelectionPoint;
   dragging: boolean;
   dragged: boolean;
};

export const WRAP_UP_STEER_PROMPT =
   "Wrap up your current task now. Stop further tool calls, finalize your work based on what has already been done, and submit your final response using structured_output.";

export type GetActiveAgentSession = (runId: string, agentIndex: number) => AgentSession | undefined;

export type AbortActiveAgent = (runId: string, agentIndex: number) => boolean;
export type AbortWorkflow = (runId: string) => boolean;
export type OpenWorkflowSettings = () => void | Promise<void>;
export type GetAvailableModels = () => string[];

export class WorkflowDashboard {
   private view: View = "list";
   private entries: RunEntry[] = [];
   private listIndex = 0;
   private phaseIndex = 0;
   private agentIndex = 0;
   private detailFocus: DetailFocus = "phases";
   private transcriptScroll = 0;
   private followTail = true;
   private showThinking = true;
   private showSystemPrompt = false;
   private transcriptRowCount = 0;
   private transcriptViewportSize = 1;
   private renderedLines: string[] = [];
   private mouseSelection?: WorkflowMouseSelection;
   private current?: RunEntry;
   private notice?: string;
   private noticeAt = 0;
   private lastAbortKeyAt = 0;
   private deletePendingRunId?: string;
   private disposed = false;
   private timer: ReturnType<typeof setInterval>;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private getActive: () => Map<string, WorkflowDetails>;
   private getActiveAgentSession?: GetActiveAgentSession;
   private abortActiveAgent?: AbortActiveAgent;
   private abortWorkflow?: AbortWorkflow;
   private openWorkflowSettings?: OpenWorkflowSettings;
   private getAvailableModels?: GetAvailableModels;
   private sessionId: string;
   private referencedRunIds: ReadonlySet<string>;
   private close: () => void;

   private isSelectingModel = false;
   private modelFilterInput = "";
   private modelSelectedIndex = 0;

   constructor(
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      getActive: () => Map<string, WorkflowDetails>,
      sessionId: string,
      referencedRunIds: ReadonlySet<string>,
      close: () => void,
      initialRunId?: string,
      getActiveAgentSession?: GetActiveAgentSession,
      abortActiveAgent?: AbortActiveAgent,
      getAvailableModels?: GetAvailableModels,
      abortWorkflow?: AbortWorkflow,
      openWorkflowSettings?: OpenWorkflowSettings
   ) {
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.getActive = getActive;
      this.getActiveAgentSession = getActiveAgentSession;
      this.abortActiveAgent = abortActiveAgent;
      this.getAvailableModels = getAvailableModels;
      this.abortWorkflow = abortWorkflow;
      this.openWorkflowSettings = openWorkflowSettings;
      this.sessionId = sessionId;
      this.referencedRunIds = referencedRunIds;
      this.close = close;
      this.refresh();
      if (initialRunId) {
         const entry = this.entries.find((e) => e.runId === initialRunId || e.runId.endsWith(initialRunId));
         if (entry) {
            this.current = entry;
            this.listIndex = this.entries.indexOf(entry);
            this.view = "detail";
         }
      } else if (this.entries.length > 0) {
         const runningIndex = this.entries.findIndex((e) => e.details.status === "running");
         if (runningIndex >= 0) {
            this.listIndex = runningIndex;
         }
      }
      this.timer = setInterval(() => {
         if (this.entries.some((e) => e.live) || this.current?.live || this.notice) {
            this.refresh();
            this.tui.requestRender();
         }
      }, 500);
   }

   dispose() {
      if (this.disposed) return;
      this.disposed = true;
      clearInterval(this.timer);
   }

   invalidate() {}

   private refresh() {
      const selected = this.entries[this.listIndex]?.runId;
      this.entries = loadRunEntries(this.getActive(), this.sessionId, this.referencedRunIds);
      if (selected) {
         const index = this.entries.findIndex((e) => e.runId === selected);
         if (index >= 0) this.listIndex = index;
      }
      this.listIndex = Math.min(this.listIndex, Math.max(0, this.entries.length - 1));
      if (this.current) {
         const refreshed = this.entries.find((e) => e.runId === this.current?.runId);
         if (refreshed) this.current = refreshed;
      }
      if (this.notice && Date.now() - this.noticeAt > NOTICE_TTL_MS) {
         this.notice = undefined;
         this.deletePendingRunId = undefined;
      }
   }

   private groups(): PhaseGroup[] {
      if (!this.current) return [];
      return phaseGroups(this.current.details);
   }

   private selectedGroup(): PhaseGroup | undefined {
      return this.groups()[this.phaseIndex];
   }

   private selectedAgent(): AgentRecord | undefined {
      return this.selectedGroup()?.agents[this.agentIndex];
   }

   private clampAgentIndex() {
      const agents = this.selectedGroup()?.agents ?? [];
      this.agentIndex = Math.min(this.agentIndex, Math.max(0, agents.length - 1));
   }

   private consumeDoubleXAbort(data: string): boolean {
      const selected = this.view === "list" ? this.entries[this.listIndex] : undefined;
      const running = selected?.details.status === "running" && selected.live;
      if (!running || (data !== "x" && data !== "xx")) {
         this.lastAbortKeyAt = 0;
         return false;
      }
      if (data === "xx") {
         this.lastAbortKeyAt = 0;
         return true;
      }
      const now = Date.now();
      const isDouble = now - this.lastAbortKeyAt <= DOUBLE_X_ABORT_WINDOW_MS;
      this.lastAbortKeyAt = isDouble ? 0 : now;
      return isDouble;
   }

   private abortCurrentWorkflow(): boolean {
      const entry = this.view === "list" ? this.entries[this.listIndex] : this.current;
      if (!entry || entry.details.status !== "running" || !entry.live) return false;
      const ok = this.abortWorkflow?.(entry.runId) ?? false;
      if (ok) {
         this.notice = "aborted workflow";
         this.noticeAt = Date.now();
      }
      return ok;
   }

   private requestDeleteSelectedRun() {
      const entry = this.entries[this.listIndex];
      if (!entry) return;
      if (entry.live || entry.details.status === "running") {
         this.deletePendingRunId = undefined;
         this.notice = "cannot delete a running workflow";
         this.noticeAt = Date.now();
         return;
      }

      const isConfirmed = this.deletePendingRunId === entry.runId && Date.now() - this.noticeAt <= NOTICE_TTL_MS;
      if (!isConfirmed) {
         this.deletePendingRunId = entry.runId;
         this.notice = `press d again to delete ${entry.details.name ?? entry.runId}`;
         this.noticeAt = Date.now();
         return;
      }

      this.deleteSelectedRun();
   }

   private deleteSelectedRun() {
      const entry = this.entries[this.listIndex];
      if (!entry) return;
      if (entry.live || entry.details.status === "running") {
         this.notice = "cannot delete a running workflow";
         this.noticeAt = Date.now();
         return;
      }

      const runName = path.basename(entry.runId);
      if (runName !== entry.runId || !runName.startsWith("wf_")) {
         this.notice = "delete failed: invalid workflow id";
         this.noticeAt = Date.now();
         return;
      }

      try {
         fs.rmSync(path.join(runsDir(), runName), { recursive: true, force: true });
         this.entries.splice(this.listIndex, 1);
         this.listIndex = Math.min(this.listIndex, Math.max(0, this.entries.length - 1));
         this.deletePendingRunId = undefined;
         this.current = undefined;
         this.notice = `deleted ${entry.details.name ?? entry.runId}`;
      } catch (error) {
         this.deletePendingRunId = undefined;
         this.notice = `delete failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.noticeAt = Date.now();
   }

   private saveReport() {
      const entry = this.current;
      if (!entry) return;
      const target = path.join(runsDir(), entry.runId, "report.md");
      try {
         fs.writeFileSync(target, buildReport(entry.details), "utf8");
         this.notice = `saved ${shortenHome(target)}`;
      } catch (error) {
         this.notice = `save failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.noticeAt = Date.now();
   }

   private async copyAgentTranscript(details: WorkflowDetails, agent: AgentRecord) {
      try {
         await copyToClipboard(buildWorkflowTranscriptPayload(details, agent));
         this.notice = `copied transcript for ${agent.label}`;
      } catch (error) {
         this.notice = `copy failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.noticeAt = Date.now();
      this.tui.requestRender();
   }

   private async copyAgentPath(details: WorkflowDetails, agent: AgentRecord) {
      const target = workflowAgentPath(details, agent);
      if (!target) {
         this.notice = `no session path for ${agent.label}`;
         this.noticeAt = Date.now();
         this.tui.requestRender();
         return;
      }

      try {
         await copyToClipboard(target);
         this.notice = `copied path: ${shortenHome(target)}`;
      } catch (error) {
         this.notice = `copy failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.noticeAt = Date.now();
      this.tui.requestRender();
   }

   private getAvailableModelOptions(): string[] {
      if (this.getAvailableModels) {
         try {
            const models = this.getAvailableModels();
            if (models.length > 0) return models;
         } catch {}
      }
      return [
         "anthropic/claude-3-5-haiku",
         "anthropic/claude-3-5-sonnet",
         "anthropic/claude-3-7-sonnet",
         "anthropic/claude-opus-4-6-thinking",
         "openai/gpt-4o-mini",
         "openai/gpt-4o",
         "openai/o1-mini",
         "openai/o3-mini",
         "google/gemini-2.5-flash",
         "google/gemini-2.5-pro",
         "deepseek/deepseek-chat",
         "deepseek/deepseek-reasoner"
      ];
   }

   private commitModelSwap(modelId: string) {
      if (!this.current) return;
      const agent = this.selectedAgent();
      if (!agent || agent.state !== "running") return;
      const activeSession = this.getActiveAgentSession?.(this.current.runId, agent.index);
      if (activeSession && typeof (activeSession as any).setModel === "function") {
         try {
            // Find model in modelRegistry or construct model object
            const modelRegistry = (activeSession as any).modelRegistry;
            let modelObj: any;
            if (modelId.includes("/")) {
               const [provider, ...rest] = modelId.split("/");
               const id = rest.join("/");
               modelObj = modelRegistry?.find?.(provider, id) ?? { provider, id };
            } else {
               modelObj = modelRegistry?.find?.(modelId) ?? { id: modelId };
            }
            Promise.resolve((activeSession as any).setModel(modelObj)).catch(() => {});
            agent.model = modelObj.id ?? modelId;
            agent.provider = modelObj.provider ?? agent.provider;
            this.notice = `swapped ${agent.label} to ${modelId}`;
         } catch (error) {
            this.notice = `model swap failed: ${error instanceof Error ? error.message : String(error)}`;
         }
         this.noticeAt = Date.now();
         this.tui.requestRender();
      }
   }

   private mouseSelectionBounds() {
      const selection = this.mouseSelection;
      if (!selection) return undefined;
      const { anchor, focus } = selection;
      if (anchor.x === focus.x && anchor.y === focus.y) return undefined;
      const anchorBeforeFocus = anchor.y < focus.y || (anchor.y === focus.y && anchor.x < focus.x);
      const start = anchorBeforeFocus ? anchor : focus;
      const end = anchorBeforeFocus ? focus : anchor;
      return {
         start,
         end: { x: end.x + 1, y: end.y }
      };
   }

   private mouseSelectionPoint(event: WorkflowMouseEvent): WorkflowSelectionPoint {
      const maxY = Math.max(0, this.renderedLines.length - 1);
      const y = Math.max(0, Math.min(maxY, event.y));
      const lineWidth = visibleWidth(this.renderedLines[y] ?? "");
      const terminalWidth = typeof this.tui.terminal.columns === "number" ? this.tui.terminal.columns : lineWidth;
      return {
         x: Math.max(0, Math.min(Math.max(lineWidth, terminalWidth), event.x)),
         y
      };
   }

   private applyMouseSelection(lines: string[]): string[] {
      const bounds = this.mouseSelectionBounds();
      if (!bounds) return lines;
      return lines.map((line, row) => {
         if (row < bounds.start.y || row > bounds.end.y) return line;
         const lineWidth = visibleWidth(line);
         const start = row === bounds.start.y ? Math.min(bounds.start.x, lineWidth) : 0;
         const end = row === bounds.end.y ? Math.min(bounds.end.x, lineWidth) : lineWidth;
         if (end <= start) return line;
         const before = sliceByColumn(line, 0, start, true);
         const selected = sliceByColumn(line, start, end - start, true);
         const after = sliceByColumn(line, end, Math.max(0, lineWidth - end), true);
         return `${before}\u001b[7m${selected}\u001b[27m${after}`;
      });
   }

   private mouseSelectionText(): string | undefined {
      const bounds = this.mouseSelectionBounds();
      if (!bounds) return undefined;
      const lines: string[] = [];
      for (let row = bounds.start.y; row <= bounds.end.y; row++) {
         const line = this.renderedLines[row] ?? "";
         const lineWidth = visibleWidth(line);
         const start = row === bounds.start.y ? Math.min(bounds.start.x, lineWidth) : 0;
         const end = row === bounds.end.y ? Math.min(bounds.end.x, lineWidth) : lineWidth;
         if (end <= start) {
            lines.push("");
            continue;
         }
         lines.push(stripTerminalSequences(sliceByColumn(line, start, end - start, true)).trimEnd());
      }
      const text = lines.join("\n");
      return text.length > 0 ? text : undefined;
   }

   private async copyMouseSelection() {
      const text = this.mouseSelectionText();
      if (!text) return;
      try {
         await copyToClipboard(text);
         this.notice = "copied selection";
      } catch (error) {
         this.notice = `copy failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.noticeAt = Date.now();
      this.tui.requestRender();
   }

   private handleMouseSelection(data: string): boolean {
      const event = parseWorkflowMouseEvent(data);
      if (!event || workflowWheelDelta(data) !== 0 || (event.button & 64) !== 0 || (event.button & 3) !== 0) {
         return false;
      }

      if (event.release) {
         const selection = this.mouseSelection;
         if (!selection?.dragging) return true;
         selection.focus = this.mouseSelectionPoint(event);
         selection.dragging = false;
         if (selection.dragged) void this.copyMouseSelection();
         this.tui.requestRender();
         return true;
      }

      if ((event.button & 32) !== 0) {
         const selection = this.mouseSelection;
         if (!selection?.dragging) return true;
         selection.focus = this.mouseSelectionPoint(event);
         selection.dragged = true;
         this.tui.requestRender();
         return true;
      }

      const point = this.mouseSelectionPoint(event);
      this.mouseSelection = {
         anchor: point,
         focus: point,
         dragging: true,
         dragged: false
      };
      this.tui.requestRender();
      return true;
   }

   handleInput(data: string) {
      if (this.handleMouseSelection(data)) return;

      const up = matchesKey(data, Key.up) || this.keybindings.matches(data, "tui.select.up") || data === "k";
      const down = matchesKey(data, Key.down) || this.keybindings.matches(data, "tui.select.down") || data === "j";
      const left =
         matchesKey(data, Key.left) || this.keybindings.matches(data, "tui.editor.cursorLeft") || data === "h";
      const right =
         matchesKey(data, Key.right) || this.keybindings.matches(data, "tui.editor.cursorRight") || data === "l";
      const confirm = matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm");
      const cancel = matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel");
      const pageUp =
         matchesKey(data, Key.pageUp) ||
         this.keybindings.matches(data, "tui.altScreen.pageUp") ||
         this.keybindings.matches(data, "tui.select.pageUp") ||
         this.keybindings.matches(data, "tui.editor.pageUp");
      const pageDown =
         matchesKey(data, Key.pageDown) ||
         this.keybindings.matches(data, "tui.altScreen.pageDown") ||
         this.keybindings.matches(data, "tui.select.pageDown") ||
         this.keybindings.matches(data, "tui.editor.pageDown");
      const top = this.keybindings.matches(data, "tui.altScreen.top");
      const bottom = this.keybindings.matches(data, "tui.altScreen.bottom");
      const wheelDelta = workflowWheelDelta(data);

      if (this.isSelectingModel) {
         const models = this.getAvailableModelOptions();
         const filtered = models.filter((m) => m.toLowerCase().includes(this.modelFilterInput.toLowerCase()));
         if (up) {
            this.modelSelectedIndex = wrapSelection(this.modelSelectedIndex, -1, Math.max(1, filtered.length));
         } else if (down) {
            this.modelSelectedIndex = wrapSelection(this.modelSelectedIndex, 1, Math.max(1, filtered.length));
         } else if (confirm) {
            const chosen = filtered[this.modelSelectedIndex];
            if (chosen) this.commitModelSwap(chosen);
            this.isSelectingModel = false;
            return;
         } else if (cancel) {
            this.isSelectingModel = false;
         } else if (data === "\b" || data === "\x7f") {
            this.modelFilterInput = this.modelFilterInput.slice(0, -1);
            this.modelSelectedIndex = 0;
         } else if (data.length === 1 && data >= " " && data <= "~") {
            this.modelFilterInput += data;
            this.modelSelectedIndex = 0;
         }
         this.tui.requestRender();
         return;
      }

      const doubleXAbort = this.consumeDoubleXAbort(data);
      if (doubleXAbort) {
         this.abortCurrentWorkflow();
         return;
      }

      if (this.view === "list") {
         if (up) {
            this.listIndex = wrapSelection(this.listIndex, -1, this.entries.length);
         } else if (down) {
            this.listIndex = wrapSelection(this.listIndex, 1, this.entries.length);
         } else if (data === "g") {
            this.listIndex = 0;
         } else if (data === "G") {
            this.listIndex = Math.max(0, this.entries.length - 1);
         } else if (data === "d") {
            this.requestDeleteSelectedRun();
         } else if (data === "X") {
            this.abortCurrentWorkflow();
         } else if (data === "s") {
            void this.openWorkflowSettings?.();
         } else if (confirm) {
            const entry = this.entries[this.listIndex];
            if (entry) {
               this.current = entry;
               this.phaseIndex = 0;
               this.agentIndex = 0;
               this.detailFocus = "phases";
               this.view = "detail";
            }
         } else if (cancel) {
            this.close();
            return;
         }
      } else if (this.view === "detail") {
         if (this.detailFocus === "phases") {
            if (up) {
               this.phaseIndex = wrapSelection(this.phaseIndex, -1, this.groups().length);
               this.agentIndex = 0;
            } else if (down) {
               this.phaseIndex = wrapSelection(this.phaseIndex, 1, this.groups().length);
               this.agentIndex = 0;
            } else if (data === "g") {
               this.phaseIndex = 0;
               this.agentIndex = 0;
            } else if (data === "G") {
               this.phaseIndex = Math.max(0, this.groups().length - 1);
               this.agentIndex = 0;
            } else if (right || (confirm && (this.selectedGroup()?.agents.length ?? 0) > 0)) {
               if ((this.selectedGroup()?.agents.length ?? 0) > 0) {
                  this.detailFocus = "agents";
                  this.clampAgentIndex();
               }
            } else if (cancel) {
               this.view = "list";
               this.refresh();
            }
         } else {
            const agents = this.selectedGroup()?.agents ?? [];
            if (up) {
               this.agentIndex = wrapSelection(this.agentIndex, -1, agents.length);
            } else if (down) {
               this.agentIndex = wrapSelection(this.agentIndex, 1, agents.length);
            } else if (data === "g") {
               this.agentIndex = 0;
            } else if (data === "G") {
               this.agentIndex = Math.max(0, agents.length - 1);
            } else if (left || cancel) {
               this.detailFocus = "phases";
            } else if (confirm && this.selectedAgent()) {
               this.transcriptScroll = 0;
               this.showThinking = true;
               this.showSystemPrompt = this.selectedAgent()?.profile === "summary";
               this.followTail = true;
               this.view = "transcript";
            }
         }
         if (data === "s") {
            void this.openWorkflowSettings?.();
         } else if (data === "r") {
            this.saveReport();
         } else if (data === "X") {
            this.abortCurrentWorkflow();
         } else if (
            data === "x" &&
            this.current &&
            this.current.details.status === "running" &&
            this.current.live &&
            this.detailFocus === "agents"
         ) {
            const agent = this.selectedAgent();
            if (agent && agent.state === "running") {
               const ok = this.abortActiveAgent?.(this.current.runId, agent.index);
               if (ok) {
                  this.notice = `aborted ${agent.label}`;
                  this.noticeAt = Date.now();
               }
            }
         } else if (
            data === "m" &&
            this.current &&
            this.current.details.status === "running" &&
            this.current.live &&
            this.detailFocus === "agents"
         ) {
            const agent = this.selectedAgent();
            if (agent && agent.state === "running") {
               this.isSelectingModel = true;
               this.modelFilterInput = "";
               this.modelSelectedIndex = 0;
            }
         } else if ((data === "y" || data === "p") && this.detailFocus === "agents") {
            const agent = this.selectedAgent();
            if (agent && this.current) void this.copyAgentPath(this.current.details, agent);
         }
      } else {
         const maxScroll = Math.max(0, this.transcriptRowCount - this.transcriptViewportSize);
         const scrollStep = data === "j" || data === "k" ? TRANSCRIPT_SCROLL_STEP : 1;
         const pageStep = Math.max(1, this.transcriptViewportSize - 2);
         if (data === "X") {
            this.abortCurrentWorkflow();
         } else if (data === "w" && this.current && this.current.details.status === "running" && this.current.live) {
            const agent = this.selectedAgent();
            if (agent && agent.state === "running") {
               const activeSession = this.getActiveAgentSession?.(this.current.runId, agent.index);
               if (activeSession && typeof (activeSession as any).steer === "function") {
                  Promise.resolve((activeSession as any).steer(WRAP_UP_STEER_PROMPT)).catch(() => {});
                  this.notice = `sent wrap-up to ${agent.label}`;
                  this.noticeAt = Date.now();
               }
            }
         } else if (data === "x" && this.current && this.current.details.status === "running" && this.current.live) {
            const agent = this.selectedAgent();
            if (agent && agent.state === "running") {
               const ok = this.abortActiveAgent?.(this.current.runId, agent.index);
               if (ok) {
                  this.notice = `aborted ${agent.label}`;
                  this.noticeAt = Date.now();
               }
            }
         } else if (data === "m" && this.current && this.current.details.status === "running" && this.current.live) {
            const agent = this.selectedAgent();
            if (agent && agent.state === "running") {
               this.isSelectingModel = true;
               this.modelFilterInput = "";
               this.modelSelectedIndex = 0;
            }
         } else if (data === "s") {
            void this.openWorkflowSettings?.();
         } else if (data === "c" && this.current) {
            const agent = this.selectedAgent();
            if (agent) void this.copyAgentTranscript(this.current.details, agent);
         } else if ((data === "y" || data === "p") && this.current) {
            const agent = this.selectedAgent();
            if (agent) void this.copyAgentPath(this.current.details, agent);
         } else if (data === "t") {
            this.showThinking = !this.showThinking;
            if (this.followTail) this.transcriptScroll = maxScroll;
         } else if (data === "\x13") {
            this.showSystemPrompt = !this.showSystemPrompt;
            if (this.followTail) this.transcriptScroll = maxScroll;
         } else if (wheelDelta !== 0) {
            this.transcriptScroll = Math.max(0, Math.min(maxScroll, this.transcriptScroll + wheelDelta));
            this.followTail = this.transcriptScroll >= maxScroll;
         } else if (pageUp || matchesKey(data, Key.ctrl("u"))) {
            this.transcriptScroll = Math.max(0, this.transcriptScroll - pageStep);
            this.followTail = this.transcriptScroll >= maxScroll;
         } else if (pageDown || matchesKey(data, Key.ctrl("d"))) {
            this.transcriptScroll = Math.min(maxScroll, this.transcriptScroll + pageStep);
            this.followTail = this.transcriptScroll >= maxScroll;
         } else if (up) {
            this.transcriptScroll = Math.max(0, this.transcriptScroll - scrollStep);
            this.followTail = this.transcriptScroll >= maxScroll;
         } else if (down) {
            this.transcriptScroll = Math.min(maxScroll, this.transcriptScroll + scrollStep);
            this.followTail = this.transcriptScroll >= maxScroll;
         } else if (top || data === "g") {
            this.transcriptScroll = 0;
            this.followTail = maxScroll === 0;
         } else if (bottom || data === "G") {
            this.transcriptScroll = maxScroll;
            this.followTail = true;
         } else if (cancel || left) {
            this.view = "detail";
            this.detailFocus = "agents";
         }
      }
      this.tui.requestRender();
   }

   private renderModelSelector(width: number, height: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];
      const header = this.split(
         " " + theme.bold(theme.fg("accent", "Select Model")),
         theme.fg("dim", "Esc cancel · Enter swap "),
         width
      );
      lines.push(header);

      const filterLine = ` Filter: ${this.modelFilterInput}${theme.fg("accent", "█")}`;
      lines.push(theme.fg("dim", filterLine));

      const models = this.getAvailableModelOptions();
      const filtered = models.filter((m) => m.toLowerCase().includes(this.modelFilterInput.toLowerCase()));
      const panelHeight = Math.max(2, height - 4);
      const bodyHeight = Math.max(0, panelHeight - 2);

      const { items, offset } = this.windowed(filtered, this.modelSelectedIndex, bodyHeight);
      const rows = items.map((modelId, i) => {
         const index = offset + i;
         const selected = index === this.modelSelectedIndex;
         const marker = selected ? theme.fg("accent", "❯") : " ";
         const label = selected ? theme.fg("accent", modelId) : theme.fg("text", modelId);
         return ` ${marker} ${label}`;
      });

      if (rows.length === 0) {
         rows.push(theme.fg("dim", "  (no matching models)"));
      }

      lines.push(...this.panel("Models", rows, width, panelHeight));
      lines.push(theme.fg("dim", " Type to filter · Up/Down select · Enter swap immediately"));
      return lines;
   }

   render(width: number): string[] {
      const height = Math.max(MIN_HEIGHT, this.tui.terminal.rows);
      let lines: string[];
      if (this.isSelectingModel) {
         lines = this.renderModelSelector(width, height);
      } else if (this.view === "transcript" && this.current && this.selectedAgent()) {
         lines = this.renderTranscript(this.current.details, this.selectedAgent()!, width, height);
      } else if (this.view === "detail" && this.current) {
         lines = this.renderDetail(this.current.details, width, height);
      } else {
         lines = this.renderList(width, height);
      }
      const renderedLines = lines.map((line) => truncateToWidth(line, width, ""));
      this.renderedLines = renderedLines;
      return this.applyMouseSelection(renderedLines);
   }

   /** Compose `left ... right` within `width`, truncating left when needed. */
   private split(left: string, right: string, width: number): string {
      const rightWidth = visibleWidth(right);
      let text = left;
      if (visibleWidth(text) + rightWidth + 1 > width) {
         text = truncateToWidth(text, Math.max(0, width - rightWidth - 2), "…");
      }
      const pad = Math.max(1, width - visibleWidth(text) - rightWidth);
      return text + " ".repeat(pad) + right;
   }

   /** Bordered panel with a title in the top border, padded to exact height. */
   private panel(title: string, rows: string[], width: number, height: number): string[] {
      const theme = this.theme;
      const inner = Math.max(0, width - 2);
      const border = (s: string) => theme.fg("borderMuted", s);
      const titleText = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
      const dashes = Math.max(0, inner - visibleWidth(titleText) - 1);
      const lines: string[] = [border("╭─") + titleText + border("─".repeat(dashes) + "╮")];
      const bodyHeight = Math.max(0, height - 2);
      for (let i = 0; i < bodyHeight; i++) {
         const row = rows[i] ?? "";
         const clipped = truncateToWidth(row, inner, "");
         const pad = Math.max(0, inner - visibleWidth(clipped));
         lines.push(border("│") + clipped + " ".repeat(pad) + border("│"));
      }
      lines.push(border("╰" + "─".repeat(inner) + "╯"));
      return lines;
   }

   /** Scroll window keeping `selected` visible. */
   private windowed<T>(items: T[], selected: number, size: number): { items: T[]; offset: number } {
      if (items.length <= size) return { items, offset: 0 };
      const offset = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
      return { items: items.slice(offset, offset + size), offset };
   }

   private keys(binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
      return this.keybindings.getKeys(binding).join("/") || "unbound";
   }

   private hintLines(hint: string, width: number): string[] {
      const theme = this.theme;
      const text = this.notice ? theme.fg("accent", ` ${this.notice}`) : theme.fg("dim", ` ${hint}`);
      return wrapTextWithAnsi(text, Math.max(1, width));
   }

   private renderList(width: number, height: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];
      const header = this.split(
         " " + theme.bold(theme.fg("accent", "Workflows")),
         theme.fg("dim", `${this.entries.length} run${this.entries.length === 1 ? "" : "s"} `),
         width
      );
      lines.push(header);

      const selectedRun = this.entries[this.listIndex];
      const workflowAbortHint =
         selectedRun?.details.status === "running" && selectedRun.live ? " · xx abort workflow" : "";
      const hint = this.hintLines(
         `${this.keys("tui.select.up")}/${this.keys("tui.select.down")} select · ${this.keys("tui.select.confirm")} open${workflowAbortHint} · s settings · d d delete · ${this.keys("tui.select.cancel")} close`,
         width
      );
      const panelHeight = Math.max(2, height - 1 - hint.length);
      const bodyHeight = Math.max(0, panelHeight - 2);

      if (this.entries.length === 0) {
         lines.push(...this.panel("Runs", [theme.fg("dim", " no workflow runs yet")], width, panelHeight));
         lines.push(...hint);
         return lines;
      }

      const { items, offset } = this.windowed(this.entries, this.listIndex, bodyHeight);
      const rows = items.map((entry, i) => {
         const index = offset + i;
         const selected = index === this.listIndex;
         const d = entry.details;
         const marker = selected ? theme.fg("accent", "❯") : " ";
         const name = d.name ?? d.runId;
         const label = selected ? theme.fg("accent", name) : theme.fg("text", name);
         const { done, failed } = countStates(d);
         const settled = done + failed;
         const right =
            theme.fg("dim", `${settled}/${d.agents.length} agents · ${formatElapsed(d.startedAt, d.finishedAt)} · `) +
            theme.fg(statusColor(d.status), statusWord(d.status)) +
            " ";
         const left = ` ${marker} ${statusSquareFor(d, theme)} ${label} ${theme.fg("dim", d.runId)}`;
         return this.split(left, right, width - 2);
      });
      lines.push(...this.panel("Runs", rows, width, panelHeight));
      lines.push(...hint);
      return lines;
   }

   private renderDetail(d: WorkflowDetails, width: number, height: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];

      const { done, failed } = countStates(d);
      const settled = done + failed;
      const right =
         theme.fg("dim", `${settled}/${d.agents.length} agents · ${formatElapsed(d.startedAt, d.finishedAt)} · `) +
         theme.fg(statusColor(d.status), statusWord(d.status)) +
         " ";
      lines.push(this.split(" " + theme.bold(theme.fg("accent", d.name ?? d.runId)), right, width));
      const totals = formatUsage(aggregateUsage(d.agents));
      const subLeft = " " + theme.fg("muted", d.description ?? d.runId);
      lines.push(this.split(subLeft, totals ? theme.fg("dim", `${totals} `) : " ", width));

      const groups = this.groups();
      this.phaseIndex = Math.min(this.phaseIndex, Math.max(0, groups.length - 1));
      const selectedGroup = groups[this.phaseIndex];
      this.clampAgentIndex();

      const isAgentRunning = selectedGroup?.agents[this.agentIndex]?.state === "running" && d.status === "running";
      const runningActions = isAgentRunning ? " · x abort · m swap model" : "";
      const hintText =
         this.detailFocus === "phases"
            ? `select phase · l/${this.keys("tui.editor.cursorRight")}/${this.keys("tui.select.confirm")} agents · ${this.keys("tui.select.cancel")} back · s settings · r save report`
            : `select agent · y/p copy path · h/${this.keys("tui.editor.cursorLeft")}/${this.keys("tui.select.cancel")} phases · ${this.keys("tui.select.confirm")} transcript${runningActions} · s settings · r save report`;
      const hint = this.hintLines(hintText, width);
      const panelHeight = Math.max(2, height - 2 - hint.length);
      const bodyHeight = Math.max(0, panelHeight - 2);

      // Left: phases sidebar.
      const maxTitle = Math.max(8, ...groups.map((g) => g.title.length));
      const sidebarWidth = Math.min(Math.max(maxTitle + 12, 20), Math.floor(width / 3));
      const sidebarInner = sidebarWidth - 2;
      const phaseWindow = this.windowed(groups, this.phaseIndex, bodyHeight);
      const phaseRows = phaseWindow.items.map((group, i) => {
         const index = phaseWindow.offset + i;
         const selected = index === this.phaseIndex;
         const marker = selected ? theme.fg(this.detailFocus === "phases" ? "accent" : "muted", "❯") : " ";
         const groupDone = group.agents.filter((a) => !isAgentPending(a)).length;
         const square = groupSquare(group, theme);
         const title =
            selected && this.detailFocus === "phases" ? theme.fg("accent", group.title) : theme.fg("text", group.title);
         const counts =
            group.agents.length > 0 ? theme.fg("dim", `${groupDone}/${group.agents.length} `) : theme.fg("dim", "- ");
         return this.split(` ${marker} ${square} ${title}`, counts, sidebarInner);
      });

      // Right: agents in the selected phase.
      const agentsWidth = width - sidebarWidth - 1;
      const agentsInner = agentsWidth - 2;
      const agentRows: string[] = [];
      if (selectedGroup) {
         const maxLabel = Math.max(0, ...selectedGroup.agents.map((a) => a.label.length));
         const agentWindow = this.windowed(selectedGroup.agents, this.agentIndex, bodyHeight);
         for (const [visibleIndex, agent] of agentWindow.items.entries()) {
            const index = agentWindow.offset + visibleIndex;
            const selected = index === this.agentIndex;
            const marker = selected && this.detailFocus === "agents" ? theme.fg("accent", "❯") : " ";
            const stats = [
               agent.state === "waiting" ? "waiting" : undefined,
               agent.profile,
               formatAgentModel(agent),
               agentContext(agent)
            ]
               .filter(Boolean)
               .join(" · ");
            const label =
               selected && this.detailFocus === "agents"
                  ? theme.fg("accent", agent.label.padEnd(Math.min(maxLabel, 40)))
                  : theme.fg("text", agent.label.padEnd(Math.min(maxLabel, 40)));
            const left = ` ${marker} ${stateSquare(agent.state, theme)} ${label}  ${theme.fg("dim", stats)}`;
            const elapsed = theme.fg("dim", `${formatElapsed(agent.startedAt, agent.finishedAt)} `);
            agentRows.push(this.split(left, elapsed, agentsInner));
            if (agent.error) {
               const errorLines = wrapTextWithAnsi(`       ${theme.fg("error", agent.error)}`, agentsInner);
               agentRows.push(...errorLines);
            }
         }
         if (selectedGroup.agents.length === 0) {
            agentRows.push(theme.fg("dim", " no agents in this phase yet"));
         }
      }
      if (d.error) {
         agentRows.push("");
         const workflowErrorLines = wrapTextWithAnsi(
            ` ${theme.fg("error", `workflow error: ${d.error}`)}`,
            agentsInner
         );
         agentRows.push(...workflowErrorLines);
      }

      const agentCount = selectedGroup?.agents.length ?? 0;
      const agentsTitle = selectedGroup
         ? `${selectedGroup.title} · ${agentCount} agent${agentCount === 1 ? "" : "s"}`
         : "Agents";
      const leftPanel = this.panel("Phases", phaseRows, sidebarWidth, panelHeight);
      const rightPanel = this.panel(agentsTitle, agentRows, agentsWidth, panelHeight);
      for (let i = 0; i < panelHeight; i++) {
         lines.push(`${leftPanel[i] ?? ""} ${rightPanel[i] ?? ""}`);
      }

      lines.push(...hint);
      return lines;
   }

   private transcriptRows(agent: AgentRecord, width: number): string[] {
      const theme = this.theme;
      const rows: string[] = [];
      const contentWidth = Math.max(8, width - 5);
      const systemPrompt = agent.systemPrompt;

      if (systemPrompt) {
         const systemPromptLabel = this.showSystemPrompt
            ? "[System prompt] (Ctrl+S to collapse)"
            : "[System prompt] (Ctrl+S to expand)";
         rows.push(theme.fg("accent", theme.bold(systemPromptLabel)));
         if (this.showSystemPrompt) {
            const styledPrompt = theme.fg("dim", systemPrompt);
            for (const line of wrapTextWithAnsi(styledPrompt, contentWidth)) rows.push(line);
         }
         rows.push(theme.fg("border", "─".repeat(Math.max(1, width - 2))));
      }

      if (agent.transcript.length === 0) {
         rows.push(theme.fg("dim", " transcript unavailable (this run predates transcript capture)"));
         return rows;
      }

      const renderedResults = new Set<TranscriptEntry>();
      for (const entry of agent.transcript) {
         if (entry.role === "tool") {
            const result = entry.toolCallId
               ? agent.transcript.find(
                    (candidate) => candidate.role === "toolResult" && candidate.toolCallId === entry.toolCallId
                 )
               : undefined;
            if (entry.name === "structured_output") {
               const callColor = result?.isError ? "error" : "warning";
               rows.push(` ${styleToolCall(theme, entry, `${SQUARE} structured_output`, callColor)}`);
               const payloadColor = result?.isError ? "error" : "muted";
               for (const rawLine of structuredOutputLines(entry)) {
                  for (const line of wrapTextWithAnsi(theme.fg(payloadColor, rawLine), Math.max(1, contentWidth - 2))) {
                     rows.push(`  ${line}`);
                  }
               }
               if (result) renderedResults.add(result);
            } else if (result) {
               const line = compactCombinedToolLine(entry, result);
               const resultColor = result.isError ? "error" : "muted";
               const callColor = result.isError ? "error" : "warning";
               const styled =
                  styleToolCall(theme, entry, line.call, callColor) +
                  theme.fg("dim", " → ") +
                  theme.fg(resultColor, line.result);
               for (const l of wrapTextWithAnsi(styled, contentWidth)) {
                  rows.push(` ${l}`);
               }
               renderedResults.add(result);
            } else {
               const styled = styleToolCall(theme, entry, compactToolCall(entry), "warning");
               for (const l of wrapTextWithAnsi(styled, contentWidth)) {
                  rows.push(` ${l}`);
               }
            }
            continue;
         }
         if (entry.role === "toolResult") {
            if (renderedResults.has(entry)) continue;
            const styled = theme.fg(entry.isError ? "error" : "muted", compactToolResult(entry));
            for (const l of wrapTextWithAnsi(styled, contentWidth)) {
               rows.push(` ${l}`);
            }
            continue;
         }

         const label = transcriptLabel(entry);
         const color = transcriptColor(entry);
         if (entry.role === "thinking" && !this.showThinking) {
            rows.push(` ${theme.fg(color, SQUARE)} ${theme.bold(theme.fg(color, `${label}...`))}`);
         } else {
            rows.push(` ${theme.fg(color, SQUARE)} ${theme.bold(theme.fg(color, label))}`);
            const styled = theme.fg(entry.role === "thinking" ? "dim" : entry.isError ? "error" : "text", entry.text);
            for (const line of wrapTextWithAnsi(styled, contentWidth)) {
               rows.push(`  ${line}`);
            }
         }
         rows.push("");
      }
      return rows;
   }

   private renderTranscript(details: WorkflowDetails, agent: AgentRecord, width: number, height: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];
      const right = theme.fg(
         "dim",
         [agent.profile, formatAgentModel(agent), agentContext(agent), formatElapsed(agent.startedAt, agent.finishedAt)]
            .filter(Boolean)
            .join(" · ") + " "
      );
      lines.push(
         this.split(` ${stateSquare(agent.state, theme)} ${theme.bold(theme.fg("accent", agent.label))}`, right, width)
      );
      lines.push(
         this.split(
            ` ${theme.fg("muted", `${details.name ?? details.runId} · ${agent.phase ?? "unphased"}`)}`,
            theme.fg("dim", `${agent.transcript.length} entries `),
            width
         )
      );

      const isLiveRunning = details.status === "running" && this.current?.live;
      const runningActions = isLiveRunning ? "w wrap up · x abort · m swap model · " : "";
      const hint = this.hintLines(
         `${runningActions}s settings · c copy transcript · y/p copy path · t ${this.showThinking ? "collapse" : "expand"} thinking · ctrl-s system prompt · ${this.keys("tui.altScreen.pageUp")}/${this.keys("tui.altScreen.pageDown")} page · g/G top/bottom · h/left/esc back`,
         width
      );
      const panelHeight = Math.max(2, height - 2 - hint.length);
      const bodyHeight = Math.max(1, panelHeight - 2);
      const rows = this.transcriptRows(agent, width - 2);
      this.transcriptRowCount = rows.length;
      this.transcriptViewportSize = bodyHeight;
      const maxScroll = Math.max(0, rows.length - bodyHeight);
      if (this.followTail) {
         this.transcriptScroll = maxScroll;
      } else {
         this.transcriptScroll = Math.min(this.transcriptScroll, maxScroll);
      }
      const visible = rows.slice(this.transcriptScroll, this.transcriptScroll + bodyHeight);
      const position =
         rows.length > bodyHeight
            ? `Transcript · ${this.transcriptScroll + 1}-${Math.min(rows.length, this.transcriptScroll + bodyHeight)}/${rows.length}`
            : "Transcript";
      lines.push(...this.panel(position, visible, width, panelHeight));
      lines.push(...hint);
      return lines;
   }
}

function transcriptLabel(entry: TranscriptEntry): string {
   if (entry.role === "user") return "User";
   if (entry.role === "assistant") return "Assistant";
   if (entry.role === "thinking") return "Thinking";
   if (entry.role === "tool") return `Tool ${entry.name ?? "unknown"}`;
   return `Result ${entry.name ?? "unknown"}`;
}

function transcriptColor(entry: TranscriptEntry): "accent" | "success" | "dim" | "warning" | "error" | "muted" {
   if (entry.isError) return "error";
   if (entry.role === "user") return "accent";
   if (entry.role === "assistant") return "success";
   if (entry.role === "thinking") return "dim";
   if (entry.role === "tool") return "warning";
   return "muted";
}

function statusSquareFor(details: WorkflowDetails, theme: Theme): string {
   return theme.fg(statusColor(details.status), SQUARE);
}

function groupSquare(group: PhaseGroup, theme: Theme): string {
   if (group.agents.length === 0) return theme.fg("dim", SQUARE);
   if (group.agents.some(isAgentPending)) return theme.fg("warning", SQUARE);
   if (group.agents.some((a) => a.state === "error")) return theme.fg("error", SQUARE);
   return theme.fg("success", SQUARE);
}

/** Open the dashboard as a full-screen overlay. */
export async function showWorkflowDashboard(
   ctx: ExtensionContext,
   getActive: () => Map<string, WorkflowDetails>,
   initialRunId?: string,
   getActiveAgentSession?: GetActiveAgentSession,
   abortActiveAgent?: AbortActiveAgent,
   getAvailableModels?: GetAvailableModels,
   abortWorkflow?: AbortWorkflow,
   openWorkflowSettings?: OpenWorkflowSettings
): Promise<void> {
   await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
         const dashboard: WorkflowDashboard = new WorkflowDashboard(
            tui,
            theme,
            keybindings,
            getActive,
            ctx.sessionManager.getSessionId(),
            sessionWorkflowRunIds(ctx),
            () => {
               dashboard.dispose();
               done(undefined);
            },
            initialRunId,
            getActiveAgentSession,
            abortActiveAgent,
            getAvailableModels,
            abortWorkflow,
            openWorkflowSettings
         );
         const releaseAlternateScreen = enterWorkflowAlternateScreen(tui, keybindings, dashboard);
         return {
            render: (width: number) => dashboard.render(width),
            handleInput: (data: string) => dashboard.handleInput(data),
            invalidate: () => dashboard.invalidate(),
            dispose: () => {
               dashboard.dispose();
               releaseAlternateScreen();
            }
         };
      },
      {
         // Use Pi's existing renderer in both regular and fullscreen modes.
         // A full-size overlay avoids nesting or taking over the terminal buffer.
         overlay: true,
         overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 }
      }
   );
}
