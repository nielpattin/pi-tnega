import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type TranscriptTheme = ExtensionContext["ui"]["theme"];
export type TranscriptColor = Parameters<TranscriptTheme["fg"]>[0];

export type TranscriptViewContent =
   | { readonly type: "text"; readonly text: string }
   | { readonly type: "image"; readonly mimeType?: string };

export type TranscriptViewEntry =
   | { readonly type: "user" | "assistant" | "thinking" | "error"; readonly text: string; readonly timestamp?: number }
   | {
        readonly type: "tool-call";
        readonly toolCallId?: string;
        readonly toolName: string;
        readonly arguments?: unknown;
        readonly timestamp?: number;
     }
   | {
        readonly type: "tool-result";
        readonly toolCallId?: string;
        readonly toolName: string;
        readonly text: string;
        readonly imageCount?: number;
        readonly isError?: boolean;
        readonly timestamp?: number;
     };

export interface WorkflowTranscriptLike {
   readonly role?: string;
   readonly text?: unknown;
   readonly name?: unknown;
   readonly toolCallId?: unknown;
   readonly isError?: unknown;
   readonly timestamp?: unknown;
}

export interface WorkerTranscriptLike {
   readonly type?: string;
   readonly text?: unknown;
   readonly toolCallId?: unknown;
   readonly toolName?: unknown;
   readonly arguments?: unknown;
   readonly content?: unknown;
   readonly isError?: unknown;
   readonly timestamp?: unknown;
}

const TOOL_MARKER_COLORS: Partial<Record<string, TranscriptColor>> = {
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

const TOOL_MARKER_PALETTE: readonly TranscriptColor[] = [
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

const RESULT_COUNT_TOOLS = new Set([
   "find",
   "fffind",
   "glob",
   "grep",
   "ffgrep",
   "rtkfind",
   "rtkgrep",
   "web_search_exa",
   "deep_search_exa",
   "cortex_search",
   "cortex_list"
]);

const LINE_COUNT_TOOLS = new Set(["read", "write", "edit", "ls", "bash", "web_fetch_exa", "web_reader"]);

export function toolMarkerColor(toolName: string | undefined): TranscriptColor {
   const known = toolName ? TOOL_MARKER_COLORS[toolName] : undefined;
   if (known) return known;
   const name = toolName ?? "unknown";
   let hash = 0;
   for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
   return TOOL_MARKER_PALETTE[hash % TOOL_MARKER_PALETTE.length];
}

function stringValue(value: unknown): string | undefined {
   return typeof value === "string" ? value : undefined;
}

function contentText(content: unknown): { readonly text: string; readonly imageCount: number } {
   if (!Array.isArray(content)) return { text: "", imageCount: 0 };
   let imageCount = 0;
   const text = content
      .flatMap((part) => {
         if (!part || typeof part !== "object") return [];
         const value = part as { readonly type?: unknown; readonly text?: unknown };
         if (value.type === "image") {
            imageCount += 1;
            return [];
         }
         return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      })
      .join("\n");
   return { text, imageCount };
}

function parseArguments(value: string | undefined): unknown {
   if (!value) return undefined;
   try {
      return JSON.parse(value);
   } catch {
      return undefined;
   }
}

export function normalizeWorkflowTranscript(entries: ReadonlyArray<WorkflowTranscriptLike>): TranscriptViewEntry[] {
   return entries.flatMap((entry): TranscriptViewEntry[] => {
      const text = stringValue(entry.text);
      if (!text) return [];
      const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : undefined;
      if (entry.role === "user" || entry.role === "assistant" || entry.role === "thinking") {
         return [{ type: entry.role, text, timestamp }];
      }
      if (entry.role === "tool") {
         return [
            {
               type: "tool-call",
               toolCallId: stringValue(entry.toolCallId),
               toolName: stringValue(entry.name) ?? "unknown",
               arguments: parseArguments(text),
               timestamp
            }
         ];
      }
      if (entry.role === "toolResult") {
         return [
            {
               type: "tool-result",
               toolCallId: stringValue(entry.toolCallId),
               toolName: stringValue(entry.name) ?? "unknown",
               text,
               isError: entry.isError === true,
               timestamp
            }
         ];
      }
      return [];
   });
}

export function normalizeWorkerTranscript(entries: ReadonlyArray<WorkerTranscriptLike>): TranscriptViewEntry[] {
   return entries.flatMap((entry): TranscriptViewEntry[] => {
      const type = entry.type;
      const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : undefined;
      if (type === "user" || type === "assistant" || type === "thinking" || type === "error") {
         return typeof entry.text === "string" ? [{ type, text: entry.text, timestamp }] : [];
      }
      if (type === "tool-call") {
         return [
            {
               type,
               toolCallId: stringValue(entry.toolCallId),
               toolName: stringValue(entry.toolName) ?? "unknown",
               arguments: entry.arguments,
               timestamp
            }
         ];
      }
      if (type === "tool-result") {
         const content = contentText(entry.content);
         return [
            {
               type,
               toolCallId: stringValue(entry.toolCallId),
               toolName: stringValue(entry.toolName) ?? "unknown",
               text: content.text,
               imageCount: content.imageCount,
               isError: entry.isError === true,
               timestamp
            }
         ];
      }
      return [];
   });
}

function compactPreview(value: string, limit = 100): string {
   const compact = value.replace(/\s+/g, " ").trim();
   return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function textArgument(args: unknown, key: string): string | undefined {
   if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
   const value = (args as Record<string, unknown>)[key];
   return typeof value === "string" ? value : undefined;
}

function textArguments(args: unknown, key: string): string[] {
   if (!args || typeof args !== "object" || Array.isArray(args)) return [];
   const value = (args as Record<string, unknown>)[key];
   return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function toolArgumentSummary(toolName: string, args: unknown): string {
   const values = (() => {
      switch (toolName) {
         case "find":
         case "fffind":
         case "glob":
         case "rtkfind":
            return [textArgument(args, "path"), textArgument(args, "pattern")];
         case "grep":
         case "ffgrep":
         case "rtkgrep":
            return [textArgument(args, "pattern"), textArgument(args, "path")];
         case "read":
         case "write":
         case "edit":
         case "ls":
            return [textArgument(args, "path")];
         case "bash":
         case "worker_list":
            return [textArgument(args, "command")];
         case "worker_spawn":
            return [textArgument(args, "name"), textArgument(args, "command"), textArgument(args, "agent")];
         case "worker_cancel":
            return [textArgument(args, "id")];
         case "web_search_exa":
         case "deep_search_exa":
         case "cortex_search":
            return [textArgument(args, "query")];
         case "web_fetch_exa":
            return [...textArguments(args, "urls"), textArgument(args, "url")];
         case "web_reader":
            return [textArgument(args, "url")];
         case "describe_image":
            return [textArgument(args, "filePath")];
         case "read_session":
            return [textArgument(args, "sessionId"), textArgument(args, "path")];
         case "ask_user":
            return [textArgument(args, "prompt"), textArgument(args, "question")];
         case "workflow":
            return [textArgument(args, "name")];
         default:
            return [
               textArgument(args, "path"),
               textArgument(args, "command"),
               textArgument(args, "query"),
               textArgument(args, "url"),
               textArgument(args, "pattern"),
               textArgument(args, "key"),
               textArgument(args, "name"),
               textArgument(args, "filePath"),
               textArgument(args, "prompt")
            ];
      }
   })();
   const separator = toolName === "worker_list" ? " " : " · ";
   return compactPreview(values.filter((value): value is string => value !== undefined).join(separator));
}

function resultLineCount(entry: Extract<TranscriptViewEntry, { type: "tool-result" }>): number {
   const lines = entry.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
   return lines.length === 1 && /^No files found\b/i.test(lines[0]) ? 0 : lines.length;
}

export interface TranscriptRenderOptions {
   readonly showThinking?: boolean;
   readonly resultSummary?: (entry: Extract<TranscriptViewEntry, { type: "tool-result" }>) => string | undefined;
}

export function compactToolCall(entry: Extract<TranscriptViewEntry, { type: "tool-call" }>): string {
   const args = toolArgumentSummary(entry.toolName, entry.arguments);
   return args ? `■ ${entry.toolName} ${args}` : `■ ${entry.toolName}`;
}

export function compactToolResult(
   entry: Extract<TranscriptViewEntry, { type: "tool-result" }>,
   includeMark = true,
   resultSummary?: TranscriptRenderOptions["resultSummary"]
): string {
   const mark = entry.isError ? "✗ " : "✓ ";
   const prefix = includeMark ? mark : "";
   const custom = resultSummary?.(entry);
   if (custom) return custom;
   const text = entry.text.trim();
   if (!text) {
      return `${prefix}${entry.toolName}${entry.imageCount ? ` (${entry.imageCount} image${entry.imageCount === 1 ? "" : "s"})` : ""}`;
   }
   if (RESULT_COUNT_TOOLS.has(entry.toolName)) {
      const count = resultLineCount(entry);
      return `${prefix}${entry.toolName} (${count} ${count === 1 ? "result" : "results"})`;
   }
   if (LINE_COUNT_TOOLS.has(entry.toolName)) {
      const count = resultLineCount(entry);
      return `${prefix}${entry.toolName} (${count} ${count === 1 ? "line" : "lines"})`;
   }
   return `${prefix}${entry.toolName} · ${compactPreview(text)}`;
}

function structuredOutputLines(entry: Extract<TranscriptViewEntry, { type: "tool-call" }>): string[] {
   const raw = typeof entry.arguments === "string" ? entry.arguments : JSON.stringify(entry.arguments ?? "");
   if (!raw || raw === '""') return [];
   try {
      const formatted =
         JSON.stringify(typeof entry.arguments === "string" ? JSON.parse(raw) : entry.arguments, null, 2) ?? raw;
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

function findToolResult(
   entries: ReadonlyArray<TranscriptViewEntry>,
   toolCallId: string | undefined
): Extract<TranscriptViewEntry, { type: "tool-result" }> | undefined {
   if (!toolCallId) return undefined;
   return entries.find(
      (candidate): candidate is Extract<TranscriptViewEntry, { type: "tool-result" }> =>
         candidate.type === "tool-result" && candidate.toolCallId === toolCallId
   );
}

function compactCombinedToolLine(
   call: Extract<TranscriptViewEntry, { type: "tool-call" }>,
   result: Extract<TranscriptViewEntry, { type: "tool-result" }>,
   resultSummary?: TranscriptRenderOptions["resultSummary"]
): string {
   return `${compactToolCall(call)} → ${compactToolResult(result, true, resultSummary)}`;
}

function styleToolCall(
   theme: TranscriptTheme,
   entry: Extract<TranscriptViewEntry, { type: "tool-call" }>,
   call: string
) {
   return theme.fg(toolMarkerColor(entry.toolName), "■") + theme.fg("warning", call.slice(1));
}

export function buildTranscriptRows(
   entries: ReadonlyArray<TranscriptViewEntry>,
   width: number,
   theme: TranscriptTheme,
   options: TranscriptRenderOptions = {}
): string[] {
   const contentWidth = Math.max(8, width);
   const rows: string[] = [];
   const pushWrapped = (text: string, color: TranscriptColor, prefix = "") => {
      for (const sourceLine of text.split("\n")) {
         const wrapped = wrapTextWithAnsi(
            theme.fg(color, sourceLine),
            Math.max(1, contentWidth - visibleWidth(prefix))
         );
         rows.push(...(wrapped.length > 0 ? wrapped.map((line) => `${prefix}${line}`) : [prefix]));
      }
   };
   const renderedResults = new Set<TranscriptViewEntry>();

   for (const entry of entries) {
      if (entry.type === "tool-call") {
         const result = findToolResult(entries, entry.toolCallId);
         if (entry.toolName === "structured_output") {
            const call = styleToolCall(theme, entry, "■ structured_output");
            pushWrapped(call, result?.isError ? "error" : "warning", " ");
            for (const line of structuredOutputLines(entry))
               pushWrapped(line, result?.isError ? "error" : "muted", "  ");
            if (result) renderedResults.add(result);
         } else if (result) {
            const call = styleToolCall(theme, entry, compactToolCall(entry));
            const combined = `${call}${theme.fg("dim", " → ")}${theme.fg(
               result.isError ? "error" : "muted",
               compactToolResult(result, true, options.resultSummary)
            )}`;
            pushWrapped(combined, result.isError ? "error" : "warning", " ");
            renderedResults.add(result);
         } else {
            pushWrapped(styleToolCall(theme, entry, compactToolCall(entry)), "warning", " ");
         }
         continue;
      }
      if (entry.type === "tool-result") {
         if (renderedResults.has(entry)) continue;
         pushWrapped(compactToolResult(entry, true, options.resultSummary), entry.isError ? "error" : "muted", " ");
         continue;
      }
      if (entry.type === "error") {
         pushWrapped(`Error: ${entry.text}`, "error", " ");
         continue;
      }
      const label = entry.type === "user" ? "User" : entry.type === "assistant" ? "Assistant" : "Thinking";
      const color: TranscriptColor = entry.type === "user" ? "accent" : entry.type === "assistant" ? "success" : "dim";
      if (entry.type === "thinking" && options.showThinking === false) {
         rows.push(` ${theme.fg(color, "■")} ${theme.bold(theme.fg(color, `${label}...`))}`);
      } else {
         rows.push(` ${theme.fg(color, "■")} ${theme.bold(theme.fg(color, label))}`);
         pushWrapped(entry.text, entry.type === "thinking" ? "dim" : "text", "  ");
      }
      rows.push("");
   }
   return rows;
}

export interface SystemPromptRenderOptions {
   readonly label?: string;
   readonly toggleKey?: string;
}

const SYSTEM_PROMPT_TRUNCATION_SUFFIX = /\n?… \[truncated \d+ characters\]$/;

export function buildSystemPromptRows(
   systemPrompt: string,
   width: number,
   theme: TranscriptTheme,
   expanded: boolean,
   options: SystemPromptRenderOptions = {}
): string[] {
   const label = options.label ?? "[System prompt]";
   const toggleKey = options.toggleKey ?? "Ctrl+S";
   const rows = [theme.fg("accent", theme.bold(`${label} (${toggleKey} to ${expanded ? "collapse" : "expand"})`))];
   if (expanded) {
      for (const line of wrapTextWithAnsi(
         theme.fg("dim", systemPrompt.replace(SYSTEM_PROMPT_TRUNCATION_SUFFIX, "")),
         Math.max(1, width)
      )) {
         rows.push(line);
      }
   }
   rows.push(theme.fg("border", "─".repeat(Math.max(1, width))));
   return rows;
}

export function buildTranscriptCopyBody(entries: ReadonlyArray<TranscriptViewEntry>): string {
   return entries
      .map((entry) => {
         if (entry.type === "user") return `User:\n${entry.text}`;
         if (entry.type === "assistant") return `Assistant:\n${entry.text}`;
         if (entry.type === "thinking") return `Thinking:\n${entry.text}`;
         if (entry.type === "error") return `Error:\n${entry.text}`;
         if (entry.type === "tool-call") {
            const args = entry.arguments === undefined ? "" : JSON.stringify(entry.arguments);
            return `Tool ${entry.toolName}:\n${args}`;
         }
         if (entry.type === "tool-result")
            return `${entry.isError ? "Error" : "Result"} ${entry.toolName}:\n${entry.text}`;
         return "";
      })
      .join("\n\n");
}

export function buildTranscriptSummary(
   entries: ReadonlyArray<TranscriptViewEntry>,
   resultSummary?: TranscriptRenderOptions["resultSummary"]
): string {
   const lines: string[] = [];
   const renderedResults = new Set<TranscriptViewEntry>();
   for (const entry of entries) {
      if (entry.type === "user") lines.push(`User:\n${entry.text}`);
      else if (entry.type === "assistant") lines.push(`Assistant:\n${entry.text}`);
      else if (entry.type === "thinking") lines.push(`Thinking:\n${entry.text}`);
      else if (entry.type === "error") lines.push(`Error:\n${entry.text}`);
      else if (entry.type === "tool-call") {
         const result = findToolResult(entries, entry.toolCallId);
         lines.push(result ? compactCombinedToolLine(entry, result, resultSummary) : compactToolCall(entry));
         if (result) renderedResults.add(result);
      } else if (entry.type === "tool-result" && !renderedResults.has(entry)) {
         lines.push(compactToolResult(entry, true, resultSummary));
      }
   }
   return lines.join("\n\n");
}
