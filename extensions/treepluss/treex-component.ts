import {
   AgentSession,
   AssistantMessageComponent,
   BashExecutionComponent,
   BranchSummaryMessageComponent,
   buildSessionContext,
   calculateContextTokens,
   CompactionSummaryMessageComponent,
   CustomMessageComponent,
   estimateTokens,
   getLastAssistantUsage,
   getLatestCompactionEntry,
   InteractiveMode,
   ToolExecutionComponent,
   TreeSelectorComponent,
   UserMessageComponent,
   type MessageRenderer,
   type SessionEntry,
   type SessionManager,
   type Theme,
   type ToolDefinition,
   type TruncationResult
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const DETAIL_BODY_LINES = 3;
const EXPANDED_DETAIL_CHROME_LINES = 4;
const EXPANDED_DETAIL_MIN_BODY_LINES = 3;
const EXPANDED_DETAIL_MIN_LINES = EXPANDED_DETAIL_CHROME_LINES + EXPANDED_DETAIL_MIN_BODY_LINES;
const EXPANDED_DETAIL_PREFERRED_TREE_ROWS = 12;
// Tree selector chrome after TreeX removes the native status/spacer line.
const TREE_SELECTOR_CHROME_LINES = 8;
const EXPANDED_DETAIL_COLLAPSE_HINT = "Esc/Ctrl+R collapse";
const CURRENT_ROW_MARKER = "◆";
const METADATA_SEPARATOR = " · ";
const METADATA_GROUP_SEPARATOR = "  │  ";
const REVIEW_DETAIL_KEY = Key.ctrl("r");
const TRUNCATED_DETAIL_HINT = "… Ctrl+R full";
const FILTER_LABELS: Record<FilterMode, string> = {
   "no-tools": "[no-tools]",
   "user-only": "[user]",
   "labeled-only": "[labeled]",
   all: "[all]",
   default: "[default]"
};
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const SHOW_SELECTOR_PATCH = Symbol.for("pi-treex:show-selector-patch");
const ESCAPE_CODE = 27;
const BELL_CODE = 7;
const TREE_STICKY_STATUS_LINE_INDEX = 6;
const NATIVE_TREE_STATUS_LINE_FROM_END = 2;

type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

interface SessionTreeNode {
   entry: SessionEntry;
   children: SessionTreeNode[];
   label?: string;
   labelTimestamp?: string;
}

interface Gutter {
   position: number;
}

interface FlatNode {
   node: SessionTreeNode;
   indent: number;
   gutters: Gutter[];
}

interface ToolCall {
   arguments: Record<string, unknown>;
}

interface TreeListLike extends Component {
   filteredNodes: FlatNode[];
   selectedIndex: number;
   maxVisibleLines: number;
   multipleRoots: boolean;
   currentLeafId: string | null;
   flatNodes: FlatNode[];
   foldedNodes: Set<string>;
   filterMode: FilterMode;
   showLabelTimestamps: boolean;
   toolCallMap: Map<string, ToolCall>;
   findNearestVisibleIndex(leafId: string): number;
   formatToolCall(name: string, args: unknown): string;
   render(width: number): string[];
}

interface TreeSelectorResult {
   component: Component;
   focus: Component;
}

type AgentSessionWithInternals = AgentSession & {
   extensionRunner?: {
      getMessageRenderer?(customType: string): MessageRenderer | undefined;
   };
};

interface InteractiveModeWithInternals {
   readonly ui: TUI;
   readonly session: AgentSessionWithInternals;
   readonly hideThinkingBlock: boolean;
   readonly hiddenThinkingLabel: string | undefined;
   readonly sessionManager: SessionManager;
   getMarkdownThemeWithSettings(): MarkdownTheme;
   getUserMessageText(message: AgentMessage): string;
   getRegisteredToolDefinition(name: string): ToolDefinition | undefined;
}

interface NativeComponents {
   assistantMessageComponent: typeof AssistantMessageComponent;
   bashExecutionComponent: typeof BashExecutionComponent;
   branchSummaryMessageComponent: typeof BranchSummaryMessageComponent;
   compactionSummaryMessageComponent: typeof CompactionSummaryMessageComponent;
   customMessageComponent: typeof CustomMessageComponent;
   toolExecutionComponent: typeof ToolExecutionComponent;
   userMessageComponent: typeof UserMessageComponent;
}

type ContentBlock =
   | { type: "text"; text: string }
   | { type: "toolCall"; name: string; arguments: Record<string, unknown> }
   | { type: "image" };

interface ExtractOptions {
   includeToolCalls?: boolean;
   verboseToolCalls?: boolean;
}

interface EntryInfo {
   kind: string;
   full?: string;
   toolName?: string;
}

interface ContextUsageInfo {
   percent: number | null;
   contextWindow: number;
}

interface ModelIdentity {
   provider: string;
   modelId: string;
}

interface ExpandableEntryComponent extends Component {
   setExpanded(expanded: boolean): void;
   render(width: number): string[];
}

interface ExpandableEntryComponentConstructor {
   new (message: SessionEntry, markdownTheme?: MarkdownTheme): ExpandableEntryComponent;
}

interface CustomMessageLike {
   role: "custom";
   customType: string;
   content: string | unknown[];
   display: boolean;
   details?: unknown;
   timestamp?: number;
}

type BashExecutionMessageLike = AgentMessage & {
   role: "bashExecution";
   command: string;
   output: string;
   exitCode: number | undefined;
   cancelled: boolean;
   truncated?: boolean;
   fullOutputPath?: string;
   excludeFromContext: boolean;
};

interface ShowSelectorPatch {
   original: (create: (done: () => void) => TreeSelectorResult) => void;
   patched: (create: (done: () => void) => TreeSelectorResult) => void;
}

interface InteractiveModePrototype {
   showSelector(create: (done: () => void) => TreeSelectorResult): void;
   [SHOW_SELECTOR_PATCH]?: ShowSelectorPatch | undefined;
}

type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;

function getTheme(): Theme {
   return (globalThis as unknown as Record<symbol, Theme>)[THEME_KEY];
}

function normalizeDetail(text: unknown): string {
   return String(text ?? "")
      .replace(/\r/g, "")
      .replace(/\t/g, "    ")
      .trim();
}

function isAnsiFinalByte(char: string): boolean {
   const code = char.charCodeAt(0);
   return code >= 0x40 && code <= 0x7e;
}

function getAnsiSequenceLength(text: string, startIndex: number): number {
   if (text.charCodeAt(startIndex) !== ESCAPE_CODE) return 0;

   const marker = text[startIndex + 1];
   if (marker === "[") {
      let index = startIndex + 2;
      while (index < text.length && !isAnsiFinalByte(text[index] ?? "")) {
         index++;
      }
      return index < text.length ? index - startIndex + 1 : 0;
   }

   if (marker !== "]" && marker !== "_") return 0;

   let index = startIndex + 2;
   while (index < text.length) {
      if (text.charCodeAt(index) === BELL_CODE) return index - startIndex + 1;
      if (text.charCodeAt(index) === ESCAPE_CODE && text[index + 1] === "\\") return index - startIndex + 2;
      index++;
   }
   return 0;
}

function stripAnsi(text: string): string {
   let result = "";
   for (let index = 0; index < text.length; ) {
      const ansiLength = getAnsiSequenceLength(text, index);
      if (ansiLength) {
         index += ansiLength;
      } else {
         result += text[index];
         index++;
      }
   }
   return result;
}

function hasVisibleText(line: string): boolean {
   return visibleWidth(stripAnsi(line).trim()) > 0;
}

function stringifyJson(value: unknown, spacing = 0): string {
   return JSON.stringify(value, null, spacing) ?? "";
}

function formatCustomEntryData(data: unknown): string {
   return typeof data === "string" ? normalizeDetail(data) : stringifyJson(data, 2);
}

function formatAgo(value: number, singular: string, plural = `${singular}S`): string {
   return `${value} ${value === 1 ? singular : plural} AGO`;
}

function formatRelativeTime(timestamp: string): string {
   const then = new Date(timestamp).getTime();
   if (!Number.isFinite(then)) return "UNKNOWN TIME";

   const diffMinutes = Math.floor(Math.max(0, Date.now() - then) / 60000);
   if (diffMinutes < 1) return "JUST NOW";
   if (diffMinutes < 60) return formatAgo(diffMinutes, "MIN");

   const diffHours = Math.floor(diffMinutes / 60);
   if (diffHours < 24) return formatAgo(diffHours, "HR");

   const diffDays = Math.floor(diffHours / 24);
   if (diffDays < 30) return formatAgo(diffDays, "DAY");

   const diffMonths = Math.floor(diffDays / 30);
   if (diffMonths < 12) return formatAgo(diffMonths, "MO");

   return formatAgo(Math.floor(diffMonths / 12), "YR");
}

function fitLine(line: string, width: number): string {
   return truncateToWidth(line, width, "...", true);
}

function getDisplayIndent(treeList: TreeListLike, flatNode: FlatNode): number {
   return treeList.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
}

function getDisplayDepth(treeList: TreeListLike, flatNode: FlatNode): number {
   return getDisplayIndent(treeList, flatNode) + 1;
}

interface VisibleWindow {
   startIndex: number;
   endIndex: number;
}

function getVisibleWindow(treeList: TreeListLike): VisibleWindow {
   if (treeList.filteredNodes.length === 0) {
      return { startIndex: 0, endIndex: 0 };
   }

   const startIndex = Math.max(
      0,
      Math.min(
         treeList.selectedIndex - Math.floor(treeList.maxVisibleLines / 2),
         treeList.filteredNodes.length - treeList.maxVisibleLines
      )
   );

   return {
      startIndex,
      endIndex: Math.min(startIndex + treeList.maxVisibleLines, treeList.filteredNodes.length)
   };
}

interface StickyLeftState extends VisibleWindow {
   stickyLeftShift: number;
   stickyLeftDepth: number | null;
}

function getStickyLeftState(treeList: TreeListLike): StickyLeftState {
   const { startIndex, endIndex } = getVisibleWindow(treeList);
   if (startIndex === endIndex) {
      return {
         startIndex,
         endIndex,
         stickyLeftShift: 0,
         stickyLeftDepth: null
      };
   }

   let minVisibleDisplayIndent = Number.POSITIVE_INFINITY;
   for (let index = startIndex; index < endIndex; index++) {
      const flatNode = treeList.filteredNodes[index];
      if (!flatNode) continue;
      minVisibleDisplayIndent = Math.min(minVisibleDisplayIndent, getDisplayIndent(treeList, flatNode));
   }

   const stickyLeftShift = Math.max(0, minVisibleDisplayIndent - 1);

   return {
      startIndex,
      endIndex,
      stickyLeftShift,
      stickyLeftDepth: stickyLeftShift > 0 ? minVisibleDisplayIndent + 1 : null
   };
}

function shiftGutters(gutters: Gutter[], stickyLeftShift: number): Gutter[] {
   if (stickyLeftShift === 0) return gutters;
   return gutters
      .map((gutter) => ({ ...gutter, position: gutter.position - stickyLeftShift }))
      .filter((gutter) => gutter.position >= 0);
}

function getLeadingAnsiLength(line: string): number {
   let length = 0;
   while (length < line.length) {
      const ansiLength = getAnsiSequenceLength(line, length);
      if (!ansiLength) break;
      length += ansiLength;
   }
   return length;
}

function replaceCursorSlot(line: string, replacement: string): string {
   const prefixLength = getLeadingAnsiLength(line);
   // Native tree rows start with a 2-cell cursor slot ("› " or "  "), possibly after ANSI styling.
   return `${line.slice(0, prefixLength)}${replacement}${line.slice(prefixLength + 2)}`;
}

function markCurrentLine(treeList: TreeListLike, lines: string[]): string[] {
   if (!treeList.currentLeafId) return lines;

   const { startIndex, endIndex } = getVisibleWindow(treeList);
   let currentIndex = treeList.filteredNodes.findIndex((node) => node?.node.entry.id === treeList.currentLeafId);
   if (currentIndex === -1) {
      if (treeList.foldedNodes.size === 0) return lines;
      currentIndex = treeList.findNearestVisibleIndex(treeList.currentLeafId);
   }
   if (currentIndex < startIndex || currentIndex >= endIndex) return lines;

   const theme = getTheme();
   const marker = `${theme.bold(theme.fg("accent", CURRENT_ROW_MARKER))} `;
   lines[currentIndex - startIndex] = replaceCursorSlot(lines[currentIndex - startIndex] ?? "", marker);
   return lines;
}

function renderWithStickyLeft(
   treeList: TreeListLike,
   width: number,
   originalRender: (width: number) => string[]
): string[] {
   const { startIndex, endIndex, stickyLeftShift } = getStickyLeftState(treeList);
   if (stickyLeftShift === 0) {
      return originalRender(width);
   }

   const originalNodes: { flatNode: FlatNode; indent: number; gutters: Gutter[] }[] = [];
   for (let index = startIndex; index < endIndex; index++) {
      const flatNode = treeList.filteredNodes[index];
      if (!flatNode) continue;
      const shiftedIndent = Math.max(0, getDisplayIndent(treeList, flatNode) - stickyLeftShift);

      originalNodes.push({
         flatNode,
         indent: flatNode.indent,
         gutters: flatNode.gutters
      });

      flatNode.indent = treeList.multipleRoots ? shiftedIndent + 1 : shiftedIndent;
      flatNode.gutters = shiftGutters(flatNode.gutters, stickyLeftShift);
   }

   try {
      return originalRender(width);
   } finally {
      for (const originalNode of originalNodes) {
         originalNode.flatNode.indent = originalNode.indent;
         originalNode.flatNode.gutters = originalNode.gutters;
      }
   }
}

function patchTreeListRender(treeList: TreeListLike): void {
   if ((treeList as unknown as { __treexStickyLeftPatched?: boolean }).__treexStickyLeftPatched) return;

   const originalRender = treeList.render.bind(treeList);
   (treeList as unknown as { __treexStickyLeftPatched: boolean }).__treexStickyLeftPatched = true;

   treeList.render = function renderStickyLeft(width: number): string[] {
      const lines = renderWithStickyLeft(this as unknown as TreeListLike, width, originalRender);
      lines.pop();
      return markCurrentLine(this as unknown as TreeListLike, lines);
   };
}

function formatToolCallVerbose(name: string, args: unknown): string {
   const json = stringifyJson(args, 2);
   return json ? `${name}\n${json}` : name;
}

function extractDetailContent(treeList: TreeListLike, content: unknown, options: ExtractOptions = {}): string {
   const { includeToolCalls = false, verboseToolCalls = false } = options;

   if (typeof content === "string") {
      return normalizeDetail(content);
   }

   if (!Array.isArray(content)) return "";

   const parts: string[] = [];
   for (const block of content as ContentBlock[]) {
      if (!block || typeof block !== "object") continue;

      if (block.type === "text") {
         parts.push(normalizeDetail(block.text));
         continue;
      }

      if (block.type === "toolCall" && includeToolCalls) {
         parts.push(
            verboseToolCalls
               ? formatToolCallVerbose(block.name, block.arguments)
               : treeList.formatToolCall(block.name, block.arguments)
         );
         continue;
      }

      if (block.type === "image") {
         parts.push("[image]");
      }
   }

   return parts.filter(Boolean).join("\n\n");
}

function describeEntry(treeList: TreeListLike, node: SessionTreeNode): EntryInfo {
   const entry = node.entry;

   switch (entry.type) {
      case "message": {
         const message = entry.message;

         if (message.role === "user") {
            return {
               kind: "USER",
               full: extractDetailContent(treeList, message.content, { includeToolCalls: true }) || "(empty)"
            };
         }

         if (message.role === "assistant") {
            return {
               kind: "ASSISTANT",
               full:
                  extractDetailContent(treeList, message.content, { includeToolCalls: true, verboseToolCalls: true }) ||
                  (message as { errorMessage?: string }).errorMessage ||
                  ((message as { stopReason?: string }).stopReason === "aborted" ? "(aborted)" : "(no content)")
            };
         }

         if (message.role === "toolResult") {
            return {
               kind: "TOOL RESULT",
               toolName: (message as { toolName?: string }).toolName
            };
         }

         if ((message as { role: string }).role === "bashExecution") {
            const bashMessage = message as unknown as BashExecutionMessageLike;
            return {
               kind: "BASH",
               full: normalizeDetail(bashMessage.command ?? "") || "(empty)",
               toolName: "bash"
            };
         }

         return {
            kind: String((message as { role?: string }).role ?? "MESSAGE").toUpperCase(),
            full: `[${(message as { role?: string }).role ?? "message"}]`
         };
      }

      case "custom_message":
         return {
            kind: entry.customType ? `${entry.customType}`.toUpperCase() : "CUSTOM MESSAGE",
            full: extractDetailContent(treeList, entry.content, { includeToolCalls: true }) || "(empty)"
         };

      case "compaction": {
         const tokenCount = Math.round((entry.tokensBefore ?? 0) / 1000);
         const fallback = `[compaction: ${tokenCount}k tokens]`;
         return {
            kind: "COMPACTION",
            full: normalizeDetail(entry.summary ?? fallback) || fallback
         };
      }

      case "branch_summary":
         return {
            kind: "BRANCH SUMMARY",
            full: normalizeDetail(entry.summary ?? "") || "(empty)"
         };

      case "model_change":
         return {
            kind: "MODEL",
            full: `[model: ${entry.modelId}]`
         };

      case "thinking_level_change":
         return {
            kind: "THINKING",
            full: `[thinking: ${entry.thinkingLevel}]`
         };

      case "custom":
         return {
            kind: entry.customType ? `${entry.customType}`.toUpperCase() : "CUSTOM",
            full: entry.data === undefined ? `[custom: ${entry.customType}]` : formatCustomEntryData(entry.data)
         };

      case "label":
         return {
            kind: "LABEL",
            full: entry.label ?? "(cleared)"
         };

      case "session_info":
         return {
            kind: "SESSION TITLE",
            full: entry.name ?? "(empty)"
         };

      default:
         return {
            kind: "ENTRY",
            full: "[entry]"
         };
   }
}

function getExpandedDetailLayout(tui: TUI): { treeRows: number; detailBodyRows: number } {
   const availableRows = Math.max(1, tui.terminal.rows - TREE_SELECTOR_CHROME_LINES);
   const treeRows = Math.min(
      EXPANDED_DETAIL_PREFERRED_TREE_ROWS,
      Math.max(1, availableRows - EXPANDED_DETAIL_MIN_LINES)
   );
   const detailBodyRows = Math.max(1, availableRows - treeRows - EXPANDED_DETAIL_CHROME_LINES);

   return { treeRows, detailBodyRows };
}

function getExpandedDetailBodyLines(tui: TUI): number {
   return getExpandedDetailLayout(tui).detailBodyRows;
}

function getVisibleTreeRows(tui: TUI, detailExpanded: boolean): number {
   if (detailExpanded) {
      return getExpandedDetailLayout(tui).treeRows;
   }

   return Math.max(5, Math.floor(tui.terminal.rows / 2) - (DETAIL_BODY_LINES + 2));
}

// Detail pane context helpers
function getDetailContextUsage(session: AgentSessionWithInternals, entry: SessionEntry): ContextUsageInfo | null {
   const branchEntries = session.sessionManager.getBranch(entry.id);
   const sessionContext = buildSessionContext(session.sessionManager.getEntries(), entry.id);
   const modelIdentity = sessionContext.model ?? findLastAssistantModel(branchEntries);
   if (!modelIdentity) return null;

   const contextWindow = session.modelRegistry.find(modelIdentity.provider, modelIdentity.modelId)?.contextWindow;
   if (!contextWindow) return null;

   const latestCompaction = getLatestCompactionEntry(branchEntries);
   if (latestCompaction) {
      const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
      const usage = getLastAssistantUsage(branchEntries.slice(compactionIndex + 1));
      if (!usage || calculateContextTokens(usage) === 0) {
         return { percent: null, contextWindow };
      }
   }

   return {
      percent: (estimateContextTokensFromMessages(sessionContext.messages) / contextWindow) * 100,
      contextWindow
   };
}

function findLastAssistantModel(branchEntries: SessionEntry[]): ModelIdentity | null {
   for (let index = branchEntries.length - 1; index >= 0; index--) {
      const entry = branchEntries[index];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      if (!entry.message.provider || !entry.message.model) continue;
      return {
         provider: entry.message.provider,
         modelId: entry.message.model
      };
   }

   return null;
}

function estimateContextTokensFromMessages(messages: AgentMessage[]): number {
   for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (
         (message as { stopReason?: string }).stopReason === "aborted" ||
         (message as { stopReason?: string }).stopReason === "error" ||
         !message.usage
      )
         continue;

      let trailingTokens = 0;
      for (let trailingIndex = index + 1; trailingIndex < messages.length; trailingIndex++) {
         const trailingMessage = messages[trailingIndex];
         if (!trailingMessage) continue;
         trailingTokens += estimateTokens(trailingMessage);
      }

      return calculateContextTokens(message.usage) + trailingTokens;
   }

   let estimatedTokens = 0;
   for (const message of messages) {
      estimatedTokens += estimateTokens(message);
   }
   return estimatedTokens;
}

function formatShortTokenCount(count: number): string {
   if (count < 1000) return count.toString();
   if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
   if (count < 1000000) return `${Math.round(count / 1000)}k`;
   if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
   return `${Math.round(count / 1000000)}M`;
}

function formatDetailContextUsage(theme: Theme, contextUsage: ContextUsageInfo | null): string | null {
   if (!contextUsage) return null;

   const display =
      contextUsage.percent === null
         ? `?/${formatShortTokenCount(contextUsage.contextWindow)}`
         : `${contextUsage.percent.toFixed(1)}%/${formatShortTokenCount(contextUsage.contextWindow)}`;

   if (contextUsage.percent === null) {
      return theme.fg("muted", display);
   }
   if (contextUsage.percent > 90) {
      return theme.fg("error", display);
   }
   if (contextUsage.percent > 70) {
      return theme.fg("warning", display);
   }
   return theme.fg("muted", display);
}

function getCurrentDirection(treeList: TreeListLike, selected: FlatNode): "up" | "down" | null {
   if (!treeList.currentLeafId || selected.node.entry.id === treeList.currentLeafId) return null;

   const currentFlatIndex = treeList.flatNodes.findIndex((node) => node?.node.entry.id === treeList.currentLeafId);
   const selectedFlatIndex = treeList.flatNodes.findIndex((node) => node?.node.entry.id === selected.node.entry.id);
   return currentFlatIndex < selectedFlatIndex ? "up" : "down";
}

function getCurrentPositionPart(treeList: TreeListLike, selected: FlatNode, theme: Theme): string | null {
   if (selected.node.entry.id === treeList.currentLeafId) {
      return theme.fg("accent", "CURRENT");
   }

   const currentDirection = getCurrentDirection(treeList, selected);
   if (!currentDirection) return null;

   return theme.bold(theme.fg("accent", currentDirection === "up" ? "↑ CURRENT" : "↓ CURRENT"));
}

function getTreeFilterParts(treeList: TreeListLike, theme: Theme): string[] {
   const filterLabel = FILTER_LABELS[treeList.filterMode];
   const labels = filterLabel ? [filterLabel] : [];

   if (treeList.showLabelTimestamps) {
      labels.push("[+label time]");
   }

   return labels.map((label) => theme.fg("muted", label));
}

function joinMetadataParts(theme: Theme, parts: (string | null | undefined)[]): string {
   return parts.filter(Boolean).join(theme.fg("muted", METADATA_SEPARATOR));
}

function getTreeSelector(result: TreeSelectorResult | null): TreeSelectorComponent | null {
   const focus = result?.focus as TreeSelectorComponent | undefined;
   if (typeof focus?.getTreeList === "function") {
      return focus;
   }
   const component = result?.component as TreeSelectorComponent | undefined;
   if (typeof component?.getTreeList === "function") {
      return component;
   }
   return null;
}

function isToolResultEntry(entry: SessionEntry): boolean {
   return entry.type === "message" && entry.message.role === "toolResult";
}

function compactDetailLines(lines: string[]): string[] {
   return lines.filter(hasVisibleText);
}

function removeSharedPrefix(baseLines: string[], lines: string[]): string[] {
   let index = 0;
   while (
      index < baseLines.length &&
      index < lines.length &&
      stripAnsi(lines[index] ?? "").trimEnd() === stripAnsi(baseLines[index] ?? "").trimEnd()
   ) {
      index++;
   }
   return lines.slice(index);
}

function appendTruncatedDetailHint(line: string, width: number, theme: Theme): string {
   const hintWidth = visibleWidth(TRUNCATED_DETAIL_HINT);
   const hint = theme.fg("muted", TRUNCATED_DETAIL_HINT);

   if (width <= hintWidth) {
      return truncateToWidth(hint, width);
   }

   return truncateToWidth(line, Math.max(1, width - hintWidth), "") + hint;
}

function getDetailBodyLines(lines: string[], width: number, theme: Theme): string[] {
   const bodyLines = lines.slice(0, DETAIL_BODY_LINES);

   if (lines.length > DETAIL_BODY_LINES) {
      const lastLineIndex = bodyLines.length - 1;
      bodyLines[lastLineIndex] = appendTruncatedDetailHint(bodyLines[lastLineIndex] ?? "", width, theme);
   }

   while (bodyLines.length < DETAIL_BODY_LINES) {
      bodyLines.push("");
   }

   return bodyLines;
}

function formatFullDetailTitle(info: EntryInfo): string {
   if (info.kind === "USER" || info.kind === "ASSISTANT") {
      return `FULL ${info.kind} MESSAGE`;
   }

   const titleParts = [`FULL ${info.kind}`];
   if (info.toolName) titleParts.push(String(info.toolName).toUpperCase());
   return titleParts.join(" · ");
}

function renderCompactComponentLines(component: Component, width: number): string[] {
   return compactDetailLines(component.render(width));
}

function renderPlainTextLines(text: unknown, width: number): string[] {
   return wrapTextWithAnsi(normalizeDetail(text) || "(no text)", width);
}

function renderCompactPlainTextLines(text: unknown, width: number): string[] {
   return compactDetailLines(renderPlainTextLines(text, width));
}

function removeNativeTreeStatusLine(lines: string[]): string[] {
   const result = [...lines];
   result.splice(result.length - NATIVE_TREE_STATUS_LINE_FROM_END, 1);
   return result;
}

class ExpandedDetailPane {
   private tui: TUI;
   expanded: boolean;
   private scrollOffset: number;

   constructor(tui: TUI) {
      this.tui = tui;
      this.expanded = false;
      this.scrollOffset = 0;
   }

   toggle(): void {
      if (this.expanded) {
         this.collapse();
      } else {
         this.expanded = true;
         this.scrollOffset = 0;
      }
   }

   collapse(): void {
      this.expanded = false;
      this.scrollOffset = 0;
   }

   handleInput(keyData: string): void {
      if (matchesKey(keyData, Key.escape) || matchesKey(keyData, Key.ctrl("c"))) {
         this.collapse();
         return;
      }
      if (matchesKey(keyData, Key.up)) {
         this.scrollOffset = Math.max(0, this.scrollOffset - 1);
         return;
      }
      if (matchesKey(keyData, Key.down)) {
         this.scrollOffset++;
         return;
      }
      if (matchesKey(keyData, Key.pageUp) || matchesKey(keyData, Key.left)) {
         this.scrollOffset = Math.max(0, this.scrollOffset - getExpandedDetailBodyLines(this.tui));
         return;
      }
      if (matchesKey(keyData, Key.pageDown) || matchesKey(keyData, Key.right)) {
         this.scrollOffset += getExpandedDetailBodyLines(this.tui);
         return;
      }
      if (matchesKey(keyData, Key.home)) {
         this.scrollOffset = 0;
         return;
      }
      if (matchesKey(keyData, Key.end)) {
         this.scrollOffset = Number.POSITIVE_INFINITY;
      }
   }

   renderEmpty(theme: Theme, width: number): string[] {
      const bodyHeight = getExpandedDetailBodyLines(this.tui);

      return [
         fitLine(theme.fg("muted", "NO SELECTION"), width),
         fitLine(theme.fg("border", "─".repeat(width)), width),
         ...Array.from({ length: bodyHeight }, () => fitLine("", width)),
         fitLine(theme.fg("muted", EXPANDED_DETAIL_COLLAPSE_HINT), width),
         fitLine(theme.fg("border", "─".repeat(width)), width)
      ];
   }

   render(theme: Theme, width: number, title: string, contentLines: string[]): string[] {
      const bodyHeight = getExpandedDetailBodyLines(this.tui);
      const lines = contentLines.length ? contentLines : [theme.fg("muted", "(no text)")];
      const maxOffset = Math.max(0, lines.length - bodyHeight);
      this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);

      const visibleLines = lines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
      while (visibleLines.length < bodyHeight) {
         visibleLines.push("");
      }

      const firstVisibleLine = Math.min(lines.length, this.scrollOffset + 1);
      const lastVisibleLine = Math.min(lines.length, this.scrollOffset + bodyHeight);
      const percent = lines.length <= bodyHeight ? 100 : Math.round((lastVisibleLine / lines.length) * 100);
      const footerParts = [
         EXPANDED_DETAIL_COLLAPSE_HINT,
         `${firstVisibleLine}-${lastVisibleLine}/${lines.length}`,
         `${percent}%`,
         "↑↓ scroll",
         "←/→ page",
         "Home/End"
      ];

      return [
         fitLine(theme.bold(title), width),
         fitLine(theme.fg("border", "─".repeat(width)), width),
         ...visibleLines.map((line) => fitLine(line, width)),
         fitLine(theme.fg("muted", footerParts.join(METADATA_SEPARATOR)), width),
         fitLine(theme.fg("border", "─".repeat(width)), width)
      ];
   }
}

class DetailContentRenderer {
   private mode: InteractiveModeWithInternals;
   private treeList: TreeListLike;
   private tui: TUI;
   private components: NativeComponents;

   constructor(mode: InteractiveModeWithInternals, treeList: TreeListLike, components: NativeComponents) {
      this.mode = mode;
      this.treeList = treeList;
      this.tui = mode.ui;
      this.components = components;
   }

   createToolExecutionComponent(
      entry: SessionMessageEntry & { message: { role: "toolResult"; toolName: string; toolCallId: string } }
   ): ToolExecutionComponent {
      const message = entry.message;
      const toolCall = this.treeList.toolCallMap.get(message.toolCallId);
      return new this.components.toolExecutionComponent(
         message.toolName,
         message.toolCallId,
         toolCall?.arguments ?? {},
         { showImages: false },
         this.mode.getRegisteredToolDefinition(message.toolName),
         this.tui,
         this.mode.sessionManager.getCwd()
      );
   }

   createUserMessageComponent(entry: SessionMessageEntry & { message: { role: "user" } }): UserMessageComponent {
      const text = this.mode.getUserMessageText(entry.message);
      return new this.components.userMessageComponent(text, this.mode.getMarkdownThemeWithSettings());
   }

   createAssistantMessageComponent(
      entry: SessionMessageEntry & { message: { role: "assistant" } }
   ): AssistantMessageComponent {
      return new this.components.assistantMessageComponent(
         entry.message as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0],
         this.mode.hideThinkingBlock,
         this.mode.getMarkdownThemeWithSettings(),
         this.mode.hiddenThinkingLabel
      );
   }

   renderBashExecutionLines(
      entry: SessionMessageEntry & { message: BashExecutionMessageLike },
      width: number
   ): string[] {
      const message = entry.message;
      const component = new this.components.bashExecutionComponent(
         message.command,
         this.tui,
         message.excludeFromContext
      );
      if (message.output) {
         component.appendOutput(message.output);
      }
      component.setExpanded(true);
      component.setComplete(
         message.exitCode,
         message.cancelled,
         message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
         message.fullOutputPath
      );
      return component.render(width);
   }

   renderBashPreviewLines(entry: SessionMessageEntry & { message: BashExecutionMessageLike }, width: number): string[] {
      const message = entry.message;
      const output = normalizeDetail(message.output);
      const text = output || normalizeDetail(message.command) || "(no output)";
      const theme = getTheme();
      return compactDetailLines(wrapTextWithAnsi(theme.fg("muted", text), width));
   }

   renderExpandableEntryLines(
      Component: ExpandableEntryComponentConstructor,
      message: SessionEntry,
      width: number
   ): string[] {
      const component = new Component(message, this.mode.getMarkdownThemeWithSettings());
      component.setExpanded(true);
      return component.render(width);
   }

   renderCustomMessageLines(entry: SessionEntry & { type: "custom_message" }, width: number): string[] {
      const renderer = this.mode.session.extensionRunner?.getMessageRenderer?.(entry.customType);
      const component = new this.components.customMessageComponent(
         entry as unknown as ConstructorParameters<typeof CustomMessageComponent>[0],
         renderer,
         this.mode.getMarkdownThemeWithSettings()
      );
      component.setExpanded(true);
      return component.render(width);
   }

   renderToolLines(
      entry: SessionMessageEntry & { message: { role: "toolResult"; toolName: string; toolCallId: string } },
      width: number,
      result?: AgentMessage
   ): string[] {
      const component = this.createToolExecutionComponent(entry);
      component.setExpanded(true);
      if (result) {
         component.updateResult(
            result as unknown as {
               content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
               details?: unknown;
               isError: boolean;
            }
         );
      }
      return component.render(width);
   }

   renderToolResultPreviewLines(
      entry: SessionMessageEntry & { message: { role: "toolResult"; toolName: string; toolCallId: string } },
      width: number
   ): string[] {
      const callLines = compactDetailLines(this.renderToolLines(entry, width));
      const fullLines = compactDetailLines(this.renderToolLines(entry, width, entry.message));
      const resultLines = removeSharedPrefix(callLines, fullLines);
      return resultLines.length > 0 ? resultLines : fullLines;
   }

   renderPreview(entry: SessionEntry, info: EntryInfo, width: number): string[] {
      if (isToolResultEntry(entry)) {
         return this.renderToolResultPreviewLines(
            entry as SessionMessageEntry & { message: { role: "toolResult"; toolName: string; toolCallId: string } },
            width
         );
      }

      if (entry.type === "message") {
         switch (entry.message.role) {
            case "user":
               return renderCompactComponentLines(
                  this.createUserMessageComponent(entry as SessionMessageEntry & { message: { role: "user" } }),
                  width
               );
            case "assistant":
               return renderCompactComponentLines(
                  this.createAssistantMessageComponent(
                     entry as SessionMessageEntry & { message: { role: "assistant" } }
                  ),
                  width
               );
            case "bashExecution":
               return this.renderBashPreviewLines(
                  entry as SessionMessageEntry & { message: BashExecutionMessageLike },
                  width
               );
         }
      }

      return renderCompactPlainTextLines(info.full, width);
   }

   renderExpanded(entry: SessionEntry, info: EntryInfo, width: number): string[] {
      if (isToolResultEntry(entry)) {
         return this.renderToolLines(
            entry as SessionMessageEntry & { message: { role: "toolResult"; toolName: string; toolCallId: string } },
            width,
            (entry as SessionMessageEntry).message
         );
      }

      if (entry.type === "message") {
         switch (entry.message.role) {
            case "user":
               return this.createUserMessageComponent(
                  entry as SessionMessageEntry & { message: { role: "user" } }
               ).render(width);
            case "assistant":
               return this.createAssistantMessageComponent(
                  entry as SessionMessageEntry & { message: { role: "assistant" } }
               ).render(width);
            case "bashExecution":
               return this.renderBashExecutionLines(
                  entry as SessionMessageEntry & { message: BashExecutionMessageLike },
                  width
               );
         }
      }

      if (entry.type === "compaction") {
         return this.renderExpandableEntryLines(
            this.components.compactionSummaryMessageComponent as unknown as ExpandableEntryComponentConstructor,
            entry,
            width
         );
      }

      if (entry.type === "branch_summary") {
         return this.renderExpandableEntryLines(
            this.components.branchSummaryMessageComponent as unknown as ExpandableEntryComponentConstructor,
            entry,
            width
         );
      }

      if (entry.type === "custom_message") {
         return this.renderCustomMessageLines(entry, width);
      }

      return renderPlainTextLines(info.full, width);
   }
}

class TreeXWrapper implements Component {
   private selector: TreeSelectorComponent;
   private treeList: TreeListLike;
   private mode: InteractiveModeWithInternals;
   private tui: TUI;
   private detailContent: DetailContentRenderer;
   private expandedDetail: ExpandedDetailPane;

   constructor(selector: TreeSelectorComponent, mode: InteractiveMode, nativeComponents: NativeComponents) {
      this.selector = selector;
      this.treeList = selector.getTreeList() as unknown as TreeListLike;
      this.mode = mode as unknown as InteractiveModeWithInternals;
      this.tui = this.mode.ui;
      this.detailContent = new DetailContentRenderer(this.mode, this.treeList, nativeComponents);
      this.expandedDetail = new ExpandedDetailPane(this.tui);
      patchTreeListRender(this.treeList);
   }

   updateVisibleRows(): void {
      this.treeList.maxVisibleLines = getVisibleTreeRows(this.tui, this.expandedDetail.expanded);
   }

   get focused(): boolean {
      return this.selector.focused;
   }

   set focused(value: boolean) {
      this.selector.focused = value;
   }

   invalidate(): void {
      this.selector.invalidate();
   }

   handleInput(keyData: string): void {
      this.updateVisibleRows();

      if (
         !(this.selector as unknown as { labelInput?: boolean }).labelInput &&
         matchesKey(keyData, REVIEW_DETAIL_KEY)
      ) {
         this.expandedDetail.toggle();
      } else if (this.expandedDetail.expanded) {
         this.expandedDetail.handleInput(keyData);
      } else {
         this.selector.handleInput(keyData);
      }

      this.updateVisibleRows();
      this.tui.requestRender();
   }

   renderStickyLeftLine(theme: Theme, width: number, stickyLeftDepth: number): string {
      const badge = theme.bg(
         "selectedBg",
         ` ${theme.bold(theme.fg("accent", "⇤"))} ${theme.bold(theme.fg("accent", `depth ${stickyLeftDepth}`))} `
      );

      return fitLine(`  ${badge}`, width);
   }

   getSelectedNode(): FlatNode | null {
      return this.treeList.filteredNodes[this.treeList.selectedIndex] ?? null;
   }

   getDetailMetadata(theme: Theme, selected: FlatNode, info: EntryInfo): string {
      const entry = selected.node.entry;
      const contextUsage = getDetailContextUsage(this.mode.session, entry);
      const treeParts = [
         theme.fg("muted", `${this.treeList.selectedIndex + 1}/${this.treeList.filteredNodes.length}`),
         ...getTreeFilterParts(this.treeList, theme),
         theme.bold(theme.fg("accent", `DEPTH ${getDisplayDepth(this.treeList, selected)}`)),
         getCurrentPositionPart(this.treeList, selected, theme)
      ];

      const entryParts: (string | null | undefined)[] = [
         theme.bold(info.kind),
         theme.fg("muted", formatRelativeTime(entry.timestamp))
      ];
      if (info.toolName) entryParts.push(theme.fg("muted", String(info.toolName).toUpperCase()));
      if (selected.node.label) entryParts.push(theme.fg("warning", `[${selected.node.label}]`));

      const metadataGroups = [joinMetadataParts(theme, treeParts), joinMetadataParts(theme, entryParts)];
      const contextPart = formatDetailContextUsage(theme, contextUsage);
      if (contextPart) {
         metadataGroups.push(joinMetadataParts(theme, [theme.fg("muted", "CTX"), contextPart]));
      }

      return metadataGroups.join(theme.fg("muted", METADATA_GROUP_SEPARATOR));
   }

   renderDetailPane(theme: Theme, width: number): string[] {
      const selected = this.getSelectedNode();
      if (!selected) {
         return [
            fitLine(theme.fg("muted", "NO SELECTION"), width),
            ...Array.from({ length: DETAIL_BODY_LINES }, () => fitLine("", width)),
            fitLine(theme.fg("border", "─".repeat(width)), width)
         ];
      }

      const entry = selected.node.entry;
      const info = describeEntry(this.treeList, selected.node);
      const bodyLines = getDetailBodyLines(this.detailContent.renderPreview(entry, info, width), width, theme);

      return [
         fitLine(this.getDetailMetadata(theme, selected, info), width),
         ...bodyLines.map((line) => fitLine(line, width)),
         fitLine(theme.fg("border", "─".repeat(width)), width)
      ];
   }

   renderExpandedDetailPane(theme: Theme, width: number): string[] {
      const selected = this.getSelectedNode();
      if (!selected) {
         return this.expandedDetail.renderEmpty(theme, width);
      }

      const entry = selected.node.entry;
      const info = describeEntry(this.treeList, selected.node);

      return this.expandedDetail.render(
         theme,
         width,
         formatFullDetailTitle(info),
         this.detailContent.renderExpanded(entry, info, width)
      );
   }

   render(width: number): string[] {
      const theme = getTheme();
      const renderWidth = Math.max(20, width);

      this.updateVisibleRows();
      const lines = removeNativeTreeStatusLine(this.selector.render(renderWidth));
      const { stickyLeftDepth } = getStickyLeftState(this.treeList);

      if (stickyLeftDepth) {
         lines[TREE_STICKY_STATUS_LINE_INDEX] = this.renderStickyLeftLine(theme, renderWidth, stickyLeftDepth);
      }

      const detailLines = this.expandedDetail.expanded
         ? this.renderExpandedDetailPane(theme, renderWidth)
         : this.renderDetailPane(theme, renderWidth);

      return [...lines, ...detailLines];
   }
}

function uninstallTreeXNativePatches(InteractiveModeClass: typeof InteractiveMode): void {
   const proto = InteractiveModeClass.prototype as unknown as InteractiveModePrototype;
   const patch = proto[SHOW_SELECTOR_PATCH];
   if (!patch) return;

   if (proto.showSelector === patch.patched) {
      proto.showSelector = patch.original;
   }
   delete proto[SHOW_SELECTOR_PATCH];
}

export function installTreeXNativePatches(
   InteractiveModeClass: typeof InteractiveMode,
   nativeComponents: NativeComponents
): () => void {
   const proto = InteractiveModeClass.prototype as unknown as InteractiveModePrototype;
   uninstallTreeXNativePatches(InteractiveModeClass);

   const originalShowSelector = proto.showSelector;
   const patchedShowSelector = function treexShowSelector(
      this: InteractiveMode,
      create: (done: () => void) => TreeSelectorResult
   ): void {
      return originalShowSelector.call(this, (done) => {
         const result = create(done);
         const selector = getTreeSelector(result);
         if (!selector) {
            return result;
         }

         const wrapper = new TreeXWrapper(selector, this, nativeComponents);
         return { component: wrapper, focus: wrapper };
      });
   };

   proto.showSelector = patchedShowSelector;
   proto[SHOW_SELECTOR_PATCH] = {
      original: originalShowSelector,
      patched: patchedShowSelector
   };
   return () => uninstallTreeXNativePatches(InteractiveModeClass);
}
