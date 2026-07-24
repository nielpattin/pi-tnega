import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { isBuiltinAgentName } from "../agents/builtins.ts";
import { deleteAgent, loadAllAgents, saveAgent } from "../agents/types.ts";
import type { AgentDefinition } from "../agents/types.ts";
import type { BackendName, ReasoningEffort } from "../domain.ts";
import { REASONING_EFFORTS } from "../domain.ts";
import { AGY_BASE_MODELS, AGY_CLI_MODELS, AGY_REASONING_EFFORTS } from "../backends/agy.ts";
import { loadAgentsConfig, saveAgentsConfig, switchHarness } from "../agents/store.ts";
import type { AgentProfile, AgentsConfig, ProfileName } from "../agents/types.ts";

export interface AgentToolInfo {
   name: string;
   description?: string;
   source?: string;
}

export interface AgentsConfigPanelOptions {
   getAllTools?: () => AgentToolInfo[];
}

export async function openAgentsConfigPanel(
   ctx: ExtensionCommandContext,
   options?: AgentsConfigPanelOptions
): Promise<void> {
   await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) => new FullScreenAgentsManager(tui, theme, keybindings, done, ctx, options),
      {
         overlay: true,
         overlayOptions: {
            anchor: "center",
            width: "100%",
            maxHeight: "100%"
         }
      }
   );
}

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { TextContent } from "@earendil-works/pi-ai";

type MainTab = "subagents" | "vibe";
type ViewState =
   | "list"
   | "edit"
   | "create_name"
   | "create_intent"
   | "generating"
   | "select_model"
   | "select_thinking"
   | "select_tools"
   | "select_vibe_model"
   | "select_vibe_thinking"
   | "select_vibe_tools";

export interface ParsedAgentGeneration {
   display_name?: string;
   description?: string;
   guidance?: string;
   body?: string;
}

export function normalizeGeneratedBody(body: string): string {
   if (!body) return body;
   let result = body;
   // 1. Convert literal double-escaped \n to real newlines if present
   if (result.includes("\\n")) {
      result = result.replace(/\\n/g, "\n");
   }
   // 2. If body missing newlines before markdown headers (# or ##), insert breaks
   result = result.replace(/([^\n])\s*(#{1,6}\s+)/g, "$1\n\n$2");
   return result.trim();
}

export function parseGenerationResponse(raw: string): ParsedAgentGeneration | null {
   if (!raw || !raw.trim()) return null;
   let clean = raw.trim();
   // Remove markdown backticks if present
   if (clean.startsWith("```")) {
      clean = clean
         .replace(/^```(?:json)?\n?/, "")
         .replace(/\n?```$/, "")
         .trim();
   }
   try {
      const parsed = JSON.parse(clean);
      if (typeof parsed === "object" && parsed !== null) {
         const rawBody = typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim() : undefined;
         return {
            display_name:
               typeof parsed.display_name === "string" && parsed.display_name.trim()
                  ? parsed.display_name.trim()
                  : undefined,
            description:
               typeof parsed.description === "string" && parsed.description.trim()
                  ? parsed.description.trim()
                  : undefined,
            guidance:
               typeof parsed.guidance === "string" && parsed.guidance.trim() ? parsed.guidance.trim() : undefined,
            body: rawBody ? normalizeGeneratedBody(rawBody) : undefined
         };
      }
   } catch {
      // Ignore JSON parse errors
   }
   return null;
}

export function isCtrlS(data: string, keybindings?: KeybindingsManager): boolean {
   if (data === "\x13" || data === "\u0013" || (data.length === 1 && data.charCodeAt(0) === 19)) {
      return true;
   }
   if (keybindings && typeof keybindings.matches === "function") {
      return (
         keybindings.matches(data, "save" as any) ||
         keybindings.matches(data, "tui.editor.save" as any) ||
         keybindings.matches(data, "app.save" as any)
      );
   }
   return false;
}

export function clampBodyScroll(offset: number, totalLines: number, viewportHeight: number): number {
   const maxOffset = Math.max(0, totalLines - viewportHeight);
   return Math.max(0, Math.min(offset, maxOffset));
}

export function ensureCursorVisible(
   scrollOffset: number,
   cursorRow: number,
   viewportHeight: number,
   totalLines: number
): number {
   if (viewportHeight <= 0) return scrollOffset;
   let newOffset = scrollOffset;
   if (cursorRow < newOffset) {
      newOffset = cursorRow;
   } else if (cursorRow >= newOffset + viewportHeight) {
      newOffset = cursorRow - viewportHeight + 1;
   }
   return clampBodyScroll(newOffset, totalLines, viewportHeight);
}

export function visibleBodyWindow(
   lines: string[],
   offset: number,
   viewportHeight: number
): { visible: string[]; above: number; below: number } {
   if (lines.length === 0 || viewportHeight <= 0) {
      return { visible: [], above: 0, below: 0 };
   }
   const clampedOffset = clampBodyScroll(offset, lines.length, viewportHeight);
   const visible = lines.slice(clampedOffset, clampedOffset + viewportHeight);
   const above = clampedOffset;
   const below = Math.max(0, lines.length - (clampedOffset + visible.length));
   return { visible, above, below };
}

export function computeCursorRowCol(
   rawBody: string,
   cursorIndex: number,
   width: number
): { cursorRow: number; cursorCol: number } {
   const clampedWidth = Math.max(1, width);
   const lines = rawBody.split("\n");
   let currentOffset = 0;
   let targetLineIdx = 0;
   let targetColInLine = 0;

   const clampedCursor = Math.max(0, Math.min(cursorIndex, rawBody.length));

   for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length;
      if (clampedCursor <= currentOffset + lineLen) {
         targetLineIdx = i;
         targetColInLine = clampedCursor - currentOffset;
         break;
      }
      currentOffset += lineLen + 1; // +1 for '\n'
   }

   let cursorRow = 0;
   for (let i = 0; i < targetLineIdx; i++) {
      const wrapped = wrapTextWithAnsi(lines[i], clampedWidth);
      cursorRow += Math.max(1, wrapped.length);
   }

   const targetLine = lines[targetLineIdx] ?? "";
   const wrappedTarget = wrapTextWithAnsi(targetLine, clampedWidth);

   let colRem = targetColInLine;
   let rowInTarget = 0;
   for (let i = 0; i < wrappedTarget.length; i++) {
      const wLen = wrappedTarget[i].length;
      if (colRem < wLen || (colRem === wLen && i === wrappedTarget.length - 1)) {
         rowInTarget = i;
         break;
      }
      colRem -= wLen;
      rowInTarget = i + 1;
   }

   if (rowInTarget >= wrappedTarget.length) {
      rowInTarget = Math.max(0, wrappedTarget.length - 1);
      colRem = wrappedTarget[rowInTarget]?.length ?? 0;
   }

   return {
      cursorRow: cursorRow + rowInTarget,
      cursorCol: colRem
   };
}

export function renderBodyLines(
   rawBody: string,
   width: number,
   scrollOffset: number,
   viewportHeight: number,
   isEditingBody: boolean,
   cursorIndex: number,
   theme: Theme
): string[] {
   const wrappedLines = rawBody ? wrapTextWithAnsi(rawBody, width) : [];
   const { visible, above } = visibleBodyWindow(wrappedLines, scrollOffset, viewportHeight);

   if (!isEditingBody) {
      return visible.map((l) => theme.fg("muted", l));
   }

   const { cursorRow, cursorCol } = computeCursorRowCol(rawBody, cursorIndex, width);

   return visible.map((line, idx) => {
      const lineRow = above + idx;
      let styledLine = "";
      if (lineRow === cursorRow) {
         const charAtCursor = cursorCol < line.length ? line[cursorCol] : " ";
         const before = line.slice(0, cursorCol);
         const after = line.slice(cursorCol + 1);

         const formattedBefore = theme.fg("text", theme.bold(before));
         const formattedCursor = theme.inverse(charAtCursor);
         const formattedAfter = theme.fg("text", theme.bold(after));

         styledLine = `${formattedBefore}${formattedCursor}${formattedAfter}`;
      } else {
         styledLine = theme.fg("text", theme.bold(line));
      }
      return styledLine;
   });
}

export function styleSaveHelpUnit(unit: string, isDirty: boolean, theme: Theme): string {
   if (unit === "Ctrl+S:save") {
      return isDirty ? theme.fg("warning", theme.bold(unit)) : theme.fg("dim", unit);
   }
   return theme.fg("dim", unit);
}

export function isEditDirty(
   editDef: AgentDefinition | null,
   editOriginalSnap: AgentDefinition | null,
   isNewUnsaved: boolean = false
): boolean {
   if (isNewUnsaved) return true;
   if (editDef && editOriginalSnap) {
      return JSON.stringify(editDef) !== JSON.stringify(editOriginalSnap);
   }
   return false;
}

/** Tab / [ / ] may switch Subagents ↔ Vibe only on list (or vibe, which is always list-like). */
export function canSwitchAgentsTab(activeTab: MainTab, viewState: ViewState): boolean {
   if (activeTab === "vibe") return true;
   return activeTab === "subagents" && viewState === "list";
}

/** Shared content-area height: termRows - header(3) - footer. */
export function computeManagerContentBudget(termRows: number, footerLinesCount: number): number {
   const managerHeader = 3;
   return Math.max(1, termRows - managerHeader - Math.max(0, footerLinesCount));
}

export function isSubagentsDirty(
   savedAgents: AgentDefinition[],
   currentAgents: AgentDefinition[],
   viewState: ViewState,
   editDef: AgentDefinition | null,
   editOriginalSnap: AgentDefinition | null,
   isNewUnsaved: boolean = false
): boolean {
   if (
      viewState === "edit" ||
      viewState === "select_model" ||
      viewState === "select_thinking" ||
      viewState === "select_tools"
   ) {
      return isEditDirty(editDef, editOriginalSnap, isNewUnsaved);
   }
   if (savedAgents.length !== currentAgents.length) return true;
   for (let i = 0; i < savedAgents.length; i++) {
      if (JSON.stringify(savedAgents[i]) !== JSON.stringify(currentAgents[i])) {
         return true;
      }
   }
   return false;
}

export function isVibeDirty(savedConfig: AgentsConfig, currentConfig: AgentsConfig): boolean {
   return JSON.stringify(savedConfig) !== JSON.stringify(currentConfig);
}

export const CHILD_TOOL_DENYLIST: readonly string[] = [
   "subagent_spawn",
   "subagent_wait",
   "subagent_cancel",
   "subagent_check",
   "subagent_list",
   "vibe_spawn",
   "vibe_send",
   "vibe_wait",
   "vibe_kill",
   "vibe_list",
   "workflow",
   "ask_user"
];

export function getSelectableTools(
   allTools: AgentToolInfo[],
   denylist: readonly string[] | string[] = CHILD_TOOL_DENYLIST
): AgentToolInfo[] {
   const denySet = new Set(denylist);
   return allTools.filter((t) => !denySet.has(t.name));
}

export function toggleToolSelection(current: string[] | undefined, name: string): string[] {
   const list = current ? [...current] : [];
   const idx = list.indexOf(name);
   if (idx >= 0) {
      list.splice(idx, 1);
   } else {
      list.push(name);
   }
   return list;
}

export function formatToolsSummary(tools?: string[]): string {
   if (!tools || tools.length === 0) {
      return "(inherit all)";
   }
   if (tools.length <= 3) {
      return tools.join(", ");
   }
   const shown = tools.slice(0, 3).join(", ");
   const extra = tools.length - 3;
   return `${shown} (+${extra} more)`;
}

/** List-row tag for agent origin. Override = builtin name with disk filePath. */
export function formatAgentListTag(agent: Pick<AgentDefinition, "name" | "filePath" | "source">): string {
   if (!isBuiltinAgentName(agent.name)) {
      return "";
   }
   if (agent.filePath) {
      return "[built-in] (override)";
   }
   return "[built-in]";
}

/** Theme list-row origin tags: pure built-in stays dim; override uses warning. */
export function styleAgentListTag(agent: Pick<AgentDefinition, "name" | "filePath" | "source">, theme: Theme): string {
   if (!isBuiltinAgentName(agent.name)) {
      return "";
   }
   if (agent.filePath) {
      return theme.fg("dim", "[built-in] ") + theme.fg("warning", "(override)");
   }
   return theme.fg("dim", "[built-in]");
}

/** Bottom description panel for selected agent in list view (above key-hint footer). */
export function renderAgentDescriptionPanel(
   description: string | undefined,
   width: number,
   theme: Theme,
   maxLines: number = 4
): string[] {
   const lines: string[] = [];
   lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
   lines.push(theme.fg("dim", "Description"));
   const desc = description?.trim() || "No description";
   const wrapped = wrapTextWithAnsi(desc, Math.max(1, width));
   const display = wrapped.slice(0, Math.max(1, maxLines));
   for (const line of display) {
      lines.push(theme.fg("muted", line));
   }
   if (wrapped.length > display.length) {
      const extra = wrapped.length - display.length;
      lines.push(theme.fg("dim", `… +${extra} line${extra === 1 ? "" : "s"}`));
   }
   return lines;
}

export function filterSelectableTools(tools: AgentToolInfo[], query: string): AgentToolInfo[] {
   const cleanQuery = query.trim().toLowerCase();
   if (!cleanQuery) return tools;
   return tools.filter(
      (t) =>
         t.name.toLowerCase().includes(cleanQuery) ||
         (t.description && t.description.toLowerCase().includes(cleanQuery))
   );
}

export interface SelectorOption {
   label: string;
   value: string;
}

export function getBaseSelectorOptions(
   type: "model" | "thinking",
   harness: BackendName,
   modelRegistry?: any
): SelectorOption[] {
   const options: SelectorOption[] = [];

   if (type === "model") {
      options.push({ label: "(inherit parent)", value: "" });

      if (harness === "pi") {
         let addedCount = 0;
         if (modelRegistry) {
            try {
               const rawModels = (modelRegistry.getAvailable?.() ?? modelRegistry.getAll?.() ?? []) as any[];
               if (Array.isArray(rawModels) && rawModels.length > 0) {
                  for (const m of rawModels) {
                     if (!m || typeof m !== "object") continue;
                     const id = String(m.id || "");
                     const provider = m.provider ? String(m.provider) : "";
                     const name = m.name ? String(m.name) : id;
                     if (!id) continue;

                     const cleanProvider = provider.endsWith("/") ? provider.slice(0, -1) : provider;
                     let val = id;
                     if (cleanProvider) {
                        val = id.startsWith(`${cleanProvider}/`) ? id : `${cleanProvider}/${id}`;
                     }
                     const label = name && name !== id && name !== val ? `${name} (${val})` : val;
                     options.push({ label, value: val });
                     addedCount++;
                  }
               }
            } catch {
               // Fallback if modelRegistry throws
            }
         }

         if (addedCount === 0) {
            const fallbackPiModels = [
               "claude-3-5-sonnet",
               "claude-3-7-sonnet",
               "gpt-4o",
               "gpt-4o-mini",
               "gemini-2.5-pro",
               "gemini-2.5-flash"
            ];
            for (const modelId of fallbackPiModels) {
               options.push({ label: modelId, value: modelId });
            }
         }
      } else {
         const agyModels = Array.from(new Set([...AGY_BASE_MODELS, ...AGY_CLI_MODELS]));
         for (const m of agyModels) {
            options.push({ label: m, value: m });
         }
      }
   } else {
      options.push({ label: "(inherit parent)", value: "" });
      const efforts = harness === "pi" ? REASONING_EFFORTS : AGY_REASONING_EFFORTS;
      for (const e of efforts) {
         options.push({ label: e, value: e });
      }
   }

   return options;
}

export function filterSelectorOptions(options: SelectorOption[], query: string): SelectorOption[] {
   const q = query.trim().toLowerCase();
   if (!q) return options;

   const filtered = options.filter((opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q));

   const exactMatch = options.some((opt) => opt.value.toLowerCase() === q || opt.label.toLowerCase() === q);
   if (!exactMatch) {
      filtered.push({ label: `Custom: "${query.trim()}"`, value: query.trim() });
   }

   return filtered;
}

export function clampSelectorScroll(offset: number, totalItems: number, viewportHeight: number): number;
export function clampSelectorScroll(
   offset: number,
   selectedIndex: number,
   totalItems: number,
   viewportHeight: number
): number;
export function clampSelectorScroll(offset: number, arg2: number, arg3: number, arg4?: number): number {
   let selectedIndex: number | undefined;
   let totalItems: number;
   let viewportHeight: number;

   if (arg4 !== undefined) {
      selectedIndex = arg2;
      totalItems = arg3;
      viewportHeight = arg4;
   } else {
      totalItems = arg2;
      viewportHeight = arg3;
   }

   if (totalItems <= 0 || viewportHeight <= 0) return 0;
   const maxOffset = Math.max(0, totalItems - viewportHeight);
   let clamped = Math.max(0, Math.min(offset, maxOffset));

   if (selectedIndex !== undefined) {
      const clampedSelected = Math.max(0, Math.min(selectedIndex, totalItems - 1));
      if (clampedSelected < clamped) {
         clamped = clampedSelected;
      } else if (clampedSelected >= clamped + viewportHeight) {
         clamped = clampedSelected - viewportHeight + 1;
      }
      clamped = Math.max(0, Math.min(clamped, maxOffset));
   }

   return clamped;
}

export function visibleSelectorWindow<T>(
   items: T[],
   offset: number,
   viewportHeight: number
): { visible: T[]; startIndex: number; above: number; below: number } {
   if (items.length === 0 || viewportHeight <= 0) {
      return { visible: [], startIndex: 0, above: 0, below: 0 };
   }
   const clampedOffset = clampSelectorScroll(offset, items.length, viewportHeight);
   const visible = items.slice(clampedOffset, clampedOffset + viewportHeight);
   const above = clampedOffset;
   const below = Math.max(0, items.length - (clampedOffset + visible.length));
   return { visible, startIndex: clampedOffset, above, below };
}

export function renderToolOptionBlock(
   tool: AgentToolInfo,
   options: {
      selected: boolean;
      checked: boolean;
      width: number;
      theme: Theme;
   }
): string[] {
   const { selected, checked, width, theme } = options;
   const cursorPlain = selected ? "❯ " : "  ";
   const checkboxPlain = checked ? "[✓] " : "[ ] ";
   const cursor = selected ? theme.fg("accent", cursorPlain) : cursorPlain;
   const checkbox = checked ? theme.fg("success", checkboxPlain) : theme.fg("dim", checkboxPlain);
   const labelStr = selected ? theme.fg("accent", theme.bold(tool.name)) : theme.fg("text", tool.name);

   const desc = tool.description?.trim();
   if (!desc) {
      return [`${cursor}${checkbox}${labelStr}`];
   }

   const prefixWithSepPlain = `${cursorPlain}${checkboxPlain}${tool.name} - `;
   const prefixWidth = visibleWidth(prefixWithSepPlain);
   const availWidthLine1 = width - prefixWidth;

   if (availWidthLine1 >= 5) {
      const availWidth = Math.max(1, availWidthLine1);
      const wrappedDesc = wrapTextWithAnsi(desc, availWidth);
      const indent = " ".repeat(prefixWidth);
      const lines: string[] = [];
      const sepStr = theme.fg("dim", " - ");

      for (let i = 0; i < wrappedDesc.length; i++) {
         const styledDesc = theme.fg("dim", wrappedDesc[i]);
         if (i === 0) {
            lines.push(`${cursor}${checkbox}${labelStr}${sepStr}${styledDesc}`);
         } else {
            lines.push(`${indent}${styledDesc}`);
         }
      }
      return lines;
   } else {
      const indentWidth = visibleWidth(`${cursorPlain}${checkboxPlain}`);
      const availWidth = Math.max(1, width - indentWidth);
      const wrappedDesc = wrapTextWithAnsi(desc, availWidth);
      const indent = " ".repeat(indentWidth);
      const lines: string[] = [`${cursor}${checkbox}${labelStr}`];

      for (const descLine of wrappedDesc) {
         lines.push(`${indent}${theme.fg("dim", descLine)}`);
      }
      return lines;
   }
}

export function renderSelectorOptionBlock(
   opt: SelectorOption,
   options: {
      selected: boolean;
      current: boolean;
      width: number;
      theme: Theme;
   }
): string[] {
   const { selected, current, width, theme } = options;
   const cursorPlain = selected ? "❯ " : "  ";
   const checkmarkPlain = current ? "[✓] " : "    ";
   const cursor = selected ? theme.fg("accent", cursorPlain) : cursorPlain;
   const checkmark = current ? theme.fg("success", checkmarkPlain) : checkmarkPlain;

   const valSuffix = opt.label !== opt.value && opt.value ? ` (${opt.value})` : "";
   const fullText = `${opt.label}${valSuffix}`;

   const prefixWidth = visibleWidth(`${cursorPlain}${checkmarkPlain}`);
   const availWidth = Math.max(1, width - prefixWidth);

   const wrapped = wrapTextWithAnsi(fullText, availWidth);
   const indent = " ".repeat(prefixWidth);
   const lines: string[] = [];

   for (let i = 0; i < wrapped.length; i++) {
      const lineText = wrapped[i];
      const styledText = selected ? theme.fg("accent", theme.bold(lineText)) : theme.fg("text", lineText);
      if (i === 0) {
         lines.push(`${cursor}${checkmark}${styledText}`);
      } else {
         lines.push(`${indent}${styledText}`);
      }
   }
   return lines;
}

export interface MultiLineWindowResult {
   startIndex: number;
   endIndex: number;
   aboveCount: number;
   belowCount: number;
   renderedLinesCount: number;
}

export function computeMultiLineVisibleWindow(
   heights: number[],
   listBudget: number,
   requestedOffset: number,
   selectedIndex: number
): MultiLineWindowResult {
   const totalItems = heights.length;
   if (totalItems === 0 || listBudget <= 0) {
      return { startIndex: 0, endIndex: 0, aboveCount: 0, belowCount: 0, renderedLinesCount: 0 };
   }

   const clampedSelected = Math.max(0, Math.min(selectedIndex, totalItems - 1));
   let offset = Math.max(0, Math.min(requestedOffset, totalItems - 1));

   if (clampedSelected < offset) {
      offset = clampedSelected;
   }

   while (offset < clampedSelected) {
      const window = evaluateWindowAtOffset(heights, listBudget, offset, totalItems);
      if (clampedSelected < window.endIndex) {
         break;
      }
      offset++;
   }

   return evaluateWindowAtOffset(heights, listBudget, offset, totalItems);
}

function evaluateWindowAtOffset(
   heights: number[],
   listBudget: number,
   offset: number,
   totalItems: number
): MultiLineWindowResult {
   const hasAbove = offset > 0;
   const reservedAbove = hasAbove ? 1 : 0;

   let usedLines = reservedAbove;
   let endIndex = offset;

   while (endIndex < totalItems) {
      const itemHeight = heights[endIndex];
      const willHaveBelow = endIndex < totalItems - 1;
      const reservedBelow = willHaveBelow ? 1 : 0;

      if (usedLines + itemHeight + reservedBelow > listBudget) {
         if (endIndex === offset) {
            usedLines += itemHeight;
            endIndex++;
         }
         break;
      }

      usedLines += itemHeight;
      endIndex++;
   }

   const aboveCount = offset;
   const belowCount = totalItems - endIndex;
   const renderedLinesCount = (aboveCount > 0 ? 1 : 0) + (belowCount > 0 ? 1 : 0) + (usedLines - reservedAbove);

   return {
      startIndex: offset,
      endIndex,
      aboveCount,
      belowCount,
      renderedLinesCount
   };
}

export function padLineToWidth(line: string, width: number): string {
   const targetWidth = Math.max(0, width);
   if (targetWidth === 0) return "";
   const truncated = truncateToWidth(line, targetWidth, "");
   const vWidth = visibleWidth(truncated);
   if (vWidth < targetWidth) {
      return truncated + " ".repeat(targetWidth - vWidth);
   }
   return truncated;
}

export function fixedFrameLines(lines: string[], termRows: number, width: number): string[] {
   const targetHeight = Math.max(1, termRows);
   const result = lines.slice(0, targetHeight);
   while (result.length < targetHeight) {
      result.push("");
   }
   return result.map((line) => padLineToWidth(line, width));
}

/**
 * Pin header and footer; squeeze content into the middle only.
 * Guarantees: output length === max(1, termRows - 1), starts with header, ends with footer.
 * Never slices the full frame from the top (which would drop the header).
 */
export function assembleManagerFrame(options: {
   header: string[];
   content: string[];
   footer: string[];
   termRows: number;
   width: number;
}): string[] {
   const { header, footer, width } = options;
   const targetHeight = Math.max(1, options.termRows);
   const headerLen = header.length;
   const footerLen = footer.length;
   const fixedLen = headerLen + footerLen;

   // Extreme case: header+footer alone exceed target — keep as much header then footer as fits.
   if (fixedLen >= targetHeight) {
      const keptHeader = header.slice(0, Math.min(headerLen, targetHeight));
      const remaining = targetHeight - keptHeader.length;
      const keptFooter = remaining > 0 ? footer.slice(Math.max(0, footerLen - remaining)) : [];
      const result = [...keptHeader, ...keptFooter];
      while (result.length < targetHeight) {
         result.push("");
      }
      return result.map((line) => padLineToWidth(line, width));
   }

   const contentBudget = targetHeight - fixedLen;
   let content = options.content.slice(0, contentBudget);
   while (content.length < contentBudget) {
      content.push("");
   }

   return [...header, ...content, ...footer].map((line) => padLineToWidth(line, width));
}

export function computeSelectorViewport(
   termRows: number,
   width: number,
   helpUnits: string[],
   totalItems: number,
   offset: number,
   selectedIndex: number
): { contentBudget: number; listBudget: number; viewportHeight: number } {
   const managerHeader = 3;
   const wrappedHelp = wrapHelpUnits(helpUnits, width);
   const footer = 2 + wrappedHelp.length;
   const contentBudget = Math.max(1, termRows - managerHeader - footer);
   const selectorOverhead = 5;
   const listBudget = Math.max(1, contentBudget - selectorOverhead);

   let viewportHeight = Math.max(1, listBudget);
   if (totalItems > listBudget) {
      let vHeight = Math.max(1, listBudget - 1);
      let clamped = clampSelectorScroll(offset, selectedIndex, totalItems, vHeight);
      let aboveCount = clamped;
      let belowCount = Math.max(0, totalItems - (clamped + vHeight));
      if (aboveCount > 0 && belowCount > 0 && listBudget >= 3) {
         vHeight = listBudget - 2;
      }
      viewportHeight = Math.max(1, vHeight);
   }

   return { contentBudget, listBudget, viewportHeight };
}

export interface RenderWrappedFieldOptions {
   label: string;
   val: string;
   isSelected: boolean;
   isEditingText: boolean;
   width: number;
   theme: Theme;
   textInputLines?: string[];
   maxWrappedLines?: number;
}

export function renderWrappedFieldLines(options: RenderWrappedFieldOptions): string[] {
   const { label, val, isSelected, isEditingText, width, theme, textInputLines, maxWrappedLines = 4 } = options;

   const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";
   const labelStr = isSelected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);

   if (isSelected && isEditingText) {
      const lines = [`${cursor}${labelStr}: Editing ->`];
      if (textInputLines) {
         lines.push(...textInputLines);
      }
      return lines;
   }

   const prefixPlain = `${isSelected ? "❯ " : "  "}${label}: `;
   const prefixWidth = visibleWidth(prefixPlain);
   const indent = " ".repeat(prefixWidth);
   const availWidth = Math.max(10, width - prefixWidth);

   const wrapped = val ? wrapTextWithAnsi(val, availWidth) : [theme.fg("muted", "(empty)")];
   const lines: string[] = [];

   const displayLines = wrapped.slice(0, maxWrappedLines);
   const overflowCount = wrapped.length - displayLines.length;

   for (let idx = 0; idx < displayLines.length; idx++) {
      const lineText = displayLines[idx];
      const styledVal = val ? theme.fg("muted", lineText) : lineText;
      if (idx === 0) {
         lines.push(`${cursor}${labelStr}: ${styledVal}`);
      } else {
         lines.push(`${indent}${styledVal}`);
      }
   }

   if (overflowCount > 0) {
      const overflowMsg = theme.fg("dim", `… +${overflowCount} line${overflowCount === 1 ? "" : "s"}`);
      lines.push(`${indent}${overflowMsg}`);
   }

   return lines;
}

export function computeFrontmatterLinesCount(
   editDef: AgentDefinition,
   editFieldIndex: number,
   isEditingText: boolean,
   width: number,
   theme: Theme,
   textInputLines?: string[]
): number {
   let count = 0;
   for (let i = 0; i < 7; i++) {
      if (i === 1 || i === 2) {
         const label = i === 1 ? "Description" : "Guidance";
         const rawVal = i === 1 ? editDef.description || "" : (editDef.guidance ?? "");
         count += renderWrappedFieldLines({
            label,
            val: rawVal,
            isSelected: editFieldIndex === i,
            isEditingText: editFieldIndex === i && isEditingText,
            width,
            theme,
            textInputLines: editFieldIndex === i && isEditingText ? textInputLines : undefined,
            maxWrappedLines: 4
         }).length;
      } else {
         if (editFieldIndex === i && isEditingText) {
            count += 1 + (textInputLines?.length ?? 1);
         } else {
            count += 1;
         }
      }
   }
   return count;
}

export const SUBAGENTS_HELP_UNITS = [
   "Tab/[/]:switch tab",
   "↑/↓:navigate",
   "Enter/e:edit",
   "Space:toggle",
   "d:delete",
   "PgUp/PgDn:scroll body",
   "n:new",
   "Ctrl+S:save",
   "Esc/q:quit"
];

export const SELECT_TOOLS_HELP_UNITS = [
   "↑/↓:navigate",
   "Space:toggle",
   "Enter:confirm",
   "Esc:cancel",
   "a:all",
   "n:none"
];

export const VIBE_HELP_UNITS = [
   "Tab/[/]:switch tab",
   "h/l:fast/good",
   "↑/↓:navigate",
   "Enter/Space:toggle/edit",
   "Ctrl+S:save",
   "Esc/q:quit"
];

export function wrapHelpUnits(units: string[], width: number): string[] {
   if (units.length === 0) return [];
   const lines: string[] = [];
   let currentLine = "";
   let currentLineWidth = 0;
   const targetWidth = Math.max(1, width);
   const sep = " · ";
   const sepWidth = visibleWidth(sep);

   for (const unit of units) {
      const uWidth = visibleWidth(unit);
      if (uWidth > targetWidth) {
         if (currentLine) {
            lines.push(currentLine);
            currentLine = "";
            currentLineWidth = 0;
         }
         const wrapped = wrapTextWithAnsi(unit, targetWidth);
         for (let i = 0; i < wrapped.length - 1; i++) {
            lines.push(wrapped[i]);
         }
         currentLine = wrapped[wrapped.length - 1] ?? "";
         currentLineWidth = visibleWidth(currentLine);
         continue;
      }

      if (!currentLine) {
         currentLine = unit;
         currentLineWidth = uWidth;
      } else if (currentLineWidth + sepWidth + uWidth <= targetWidth) {
         currentLine += sep + unit;
         currentLineWidth += sepWidth + uWidth;
      } else {
         lines.push(currentLine);
         currentLine = unit;
         currentLineWidth = uWidth;
      }
   }

   if (currentLine) {
      lines.push(currentLine);
   }

   return lines;
}

export function renderHelpUnits(units: string[], width: number, isDirty: boolean, theme: Theme): string[] {
   if (units.length === 0) return [];
   const wrappedPlainLines = wrapHelpUnits(units, width);
   const sep = " · ";
   const dimSep = theme.fg("dim", sep);

   return wrappedPlainLines.map((plainLine) => {
      const parts = plainLine.split(sep);
      return parts.map((unit) => styleSaveHelpUnit(unit, isDirty, theme)).join(dimSep);
   });
}

export class BodyEditor {
   private value: string = "";
   private cursorIndex: number = 0;

   setValue(val: string): void {
      this.value = val;
      this.cursorIndex = val.length;
   }

   getValue(): string {
      return this.value;
   }

   getCursorIndex(): number {
      return this.cursorIndex;
   }

   handleInput(data: string): void {
      if (!data) return;

      if (data === "\r" || data === "\n") {
         this.insertText("\n");
         return;
      }

      if (data === "\x7f" || data === "\x08") {
         // Backspace
         if (this.cursorIndex > 0) {
            this.value = this.value.slice(0, this.cursorIndex - 1) + this.value.slice(this.cursorIndex);
            this.cursorIndex--;
         }
         return;
      }

      if (data === "\x1b[D") {
         // Left arrow
         if (this.cursorIndex > 0) this.cursorIndex--;
         return;
      }

      if (data === "\x1b[C") {
         // Right arrow
         if (this.cursorIndex < this.value.length) this.cursorIndex++;
         return;
      }

      if (data === "\x1b[A") {
         // Up arrow
         this.moveVertical(-1);
         return;
      }

      if (data === "\x1b[B") {
         // Down arrow
         this.moveVertical(1);
         return;
      }

      if (data === "\x1b[H" || data === "\x01") {
         // Home / Ctrl+A (move to start of line)
         const lineStart = this.value.lastIndexOf("\n", this.cursorIndex - 1);
         this.cursorIndex = lineStart === -1 ? 0 : lineStart + 1;
         return;
      }

      if (data === "\x1b[F" || data === "\x05") {
         // End / Ctrl+E (move to end of line)
         const nextNewline = this.value.indexOf("\n", this.cursorIndex);
         this.cursorIndex = nextNewline === -1 ? this.value.length : nextNewline;
         return;
      }

      // Ignore other control / escape sequences
      if (data.startsWith("\x1b")) {
         return;
      }

      // Regular character insertion (handles pasted text or single char)
      this.insertText(data);
   }

   private insertText(text: string): void {
      this.value = this.value.slice(0, this.cursorIndex) + text + this.value.slice(this.cursorIndex);
      this.cursorIndex += text.length;
   }

   private moveVertical(dir: -1 | 1): void {
      const lines = this.value.split("\n");
      let lineIdx = 0;
      let charCount = 0;
      let colIdx = 0;

      for (let i = 0; i < lines.length; i++) {
         const lineLen = lines[i].length;
         if (this.cursorIndex <= charCount + lineLen) {
            lineIdx = i;
            colIdx = this.cursorIndex - charCount;
            break;
         }
         charCount += lineLen + 1;
      }

      const targetLineIdx = lineIdx + dir;
      if (targetLineIdx < 0 || targetLineIdx >= lines.length) return;

      let targetPos = 0;
      for (let i = 0; i < targetLineIdx; i++) {
         targetPos += lines[i].length + 1;
      }
      targetPos += Math.min(colIdx, lines[targetLineIdx].length);
      this.cursorIndex = targetPos;
   }
}

class FullScreenAgentsManager implements Component, Focusable {
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private done: (value: null) => void;
   private ctx: ExtensionCommandContext;

   private activeTab: MainTab = "subagents";

   // --- Subagents tab state ---
   private savedAgents: AgentDefinition[] = [];
   private agents: AgentDefinition[] = [];
   private selectedListIndex = 0;
   private viewState: ViewState = "list";

   // Subagents Edit form state
   private editDef: AgentDefinition | null = null;
   private editOriginalSnap: AgentDefinition | null = null;
   private isNewUnsavedAgent = false;
   private editFieldIndex = 0;
   private isEditingText = false;
   private isEditingBody = false;
   private bodyBackup = "";
   private textInput = new Input();
   private bodyEditor = new BodyEditor();
   private editError = "";
   private bodyScrollOffset = 0;

   // Subagents Create flow state
   private createNameInput = new Input();
   private createIntentInput = new Input();
   private newName = "";
   private newIntent = "";
   private statusMessage = "";

   // --- Vibe tab state ---
   private savedVibeConfig: AgentsConfig;
   private vibeConfig: AgentsConfig;
   private vibeSelectedProfile: ProfileName = "fast";
   private vibeFieldIndex = 0; // 0: Harness, 1: Model, 2: Reasoning Effort
   private isEditingVibeText = false;
   private vibeTextInput = new Input();
   private vibeStatusMessage = "";

   // --- Selector UI state ---
   private selectorFilterInput = new Input();
   private selectorSelectedIndex = 0;
   private selectorScrollOffset = 0;
   private tempSelectedTools: string[] = [];
   private options?: AgentsConfigPanelOptions;

   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      this.textInput.focused = value;
      this.createNameInput.focused = value;
      this.createIntentInput.focused = value;
      this.vibeTextInput.focused = value;
      this.selectorFilterInput.focused = value;
   }

   constructor(
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (value: null) => void,
      ctx: ExtensionCommandContext,
      options?: AgentsConfigPanelOptions
   ) {
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.done = done;
      this.ctx = ctx;
      this.options = options;

      const vibeCfg = loadAgentsConfig();
      this.savedVibeConfig = JSON.parse(JSON.stringify(vibeCfg));
      this.vibeConfig = JSON.parse(JSON.stringify(vibeCfg));
      this.reloadAgents();

      this.textInput.onSubmit = (val) => {
         this.handleTextSubmit(val);
      };

      this.vibeTextInput.onSubmit = (val) => {
         this.handleVibeTextSubmit(val);
      };

      this.createNameInput.onSubmit = (val) => {
         const clean = val
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "");
         if (!clean) {
            this.statusMessage = "Invalid agent name. Use lowercase alphanumeric, dash, or underscore.";
            this.tui.requestRender();
            return;
         }
         if (this.agents.some((a) => a.name === clean)) {
            this.statusMessage = `Agent "${clean}" already exists.`;
            this.tui.requestRender();
            return;
         }
         this.newName = clean;
         this.viewState = "create_intent";
         this.createIntentInput.setValue("");
         this.createIntentInput.focused = true;
         this.statusMessage = "";
         this.tui.requestRender();
      };

      this.createIntentInput.onSubmit = async (val) => {
         this.newIntent = val.trim();
         this.viewState = "generating";
         this.statusMessage = "Generating agent definition draft with main model...";
         this.tui.requestRender();

         await this.generateAndOpenDraft();
      };

      this.requestRedraw(true);
   }

   private reloadAgents() {
      const map = loadAllAgents(this.ctx.cwd);
      this.agents = Array.from(map.values()).map((a) => ({ ...a, tools: a.tools ? [...a.tools] : undefined }));
      this.savedAgents = JSON.parse(JSON.stringify(this.agents));
      if (this.selectedListIndex >= this.agents.length) {
         this.selectedListIndex = Math.max(0, this.agents.length - 1);
      }
   }

   private getAvailableTools(): AgentToolInfo[] {
      let rawTools: AgentToolInfo[] = [];
      if (this.options?.getAllTools) {
         rawTools = this.options.getAllTools();
      }
      if (this.editDef?.tools) {
         const existingNames = new Set(rawTools.map((t) => t.name));
         for (const name of this.editDef.tools) {
            if (!existingNames.has(name)) {
               rawTools.push({ name, description: "Configured tool" });
            }
         }
      }
      return getSelectableTools(rawTools, CHILD_TOOL_DENYLIST);
   }

   private async generateAndOpenDraft() {
      let generatedFields: ParsedAgentGeneration | null = null;
      let generationFailed = false;

      if (this.ctx.model) {
         try {
            const systemPrompt =
               "You are an expert AI subagent designer. When given a subagent name and user intent, return a JSON object with display_name, description, guidance, and body.";
            const userPrompt = `Create a specialized subagent definition.
Agent Name: ${this.newName}
User Intent: ${this.newIntent || "General assistance"}

Return JSON ONLY with exact keys:
- "display_name": nice title string (e.g. "${this.newName}")
- "description": concise description of role
- "guidance": when to use this agent (e.g. "Use this agent when...")
- "body": system prompt instructions for the subagent.

CRITICAL INSTRUCTIONS FOR "body":
- MUST be multi-line structured markdown (using real \\n newline characters inside the JSON string).
- MUST start with "# ${this.newName.toUpperCase()} AGENT" or "# ${this.newName}" heading.
- MUST use blank lines between sections.
- MUST use markdown sections with "##" headers, for example:
  ## Role
  ...
  ## Capabilities / Tools
  ...
  ## Workflow
  ...
  ## Constraints
  ...
  ## Output
  ...
- MUST be several paragraphs minimum, NOT one continuous paragraph block.

Example body structure:
# ${this.newName}

You are a specialized subagent designed to...

## Role
You excel at...

## Workflow
1. Analyze request...
2. Perform checks...

## Constraints
- Do not modify...

## Output
- Clear summary...`;

            const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(this.ctx.model);
            const apiKey = auth.ok ? auth.apiKey : undefined;
            const headers = auth.ok ? auth.headers : undefined;

            const response = await completeSimple(
               this.ctx.model,
               {
                  systemPrompt,
                  messages: [
                     {
                        role: "user",
                        content: userPrompt,
                        timestamp: Date.now()
                     }
                  ]
               },
               { apiKey, headers }
            );

            let responseText = "";
            if (response && response.content) {
               const textBlocks = response.content.filter((c): c is TextContent => c.type === "text");
               responseText = textBlocks.map((b) => b.text).join("");
            }

            generatedFields = parseGenerationResponse(responseText);
            if (
               !generatedFields ||
               !generatedFields.description ||
               !generatedFields.guidance ||
               !generatedFields.body
            ) {
               generationFailed = true;
            }
         } catch {
            generationFailed = true;
         }
      } else {
         generationFailed = true;
      }

      const fallbackBody = `# ${this.newName.toUpperCase()} AGENT\n\nYou are a specialized subagent designed for: ${this.newIntent || "custom tasks"}.\n\n## Role\nExecute tasks according to user intent with precision and clarity.\n\n## Workflow\n1. Understand request and gather necessary context.\n2. Execute step-by-step using available tools.\n3. Verify results before finalizing.\n\n## Constraints\n- Follow guidelines strictly.\n- Do not make unauthorized modifications.\n\n## Output\n- Provide clear, structured output.`;

      const draft: Partial<AgentDefinition> = {
         name: this.newName,
         display_name: generatedFields?.display_name || this.newName,
         description: generatedFields?.description || this.newIntent || "Subagent for custom tasks",
         guidance: generatedFields?.guidance || `Use this agent when ${this.newIntent || "performing assigned tasks"}.`,
         harness: "pi",
         tools: ["read", "bash", "grep", "find"],
         enabled: true,
         body: generatedFields?.body || fallbackBody
      };

      this.editDef = {
         name: this.newName,
         display_name: draft.display_name,
         description: draft.description || "",
         guidance: draft.guidance || "",
         harness: (draft.harness as BackendName) || "pi",
         model: draft.model,
         thinking: draft.thinking as ReasoningEffort,
         tools: draft.tools || ["read", "bash", "grep", "find"],
         enabled: true,
         body: draft.body || ""
      };
      this.editOriginalSnap = JSON.parse(JSON.stringify(this.editDef));
      this.isNewUnsavedAgent = true;

      this.viewState = "edit";
      this.editFieldIndex = 0;
      this.bodyScrollOffset = 0;
      this.editError = "";
      if (generationFailed) {
         this.statusMessage =
            "AI generation unavailable/failed; opened template draft. Edit fields and press Ctrl+S to save.";
      } else {
         this.statusMessage = "Draft generated with AI model. Edit fields and press Ctrl+S to save.";
      }
      this.tui.requestRender();
   }

   private handleTextSubmit(val: string) {
      if (!this.editDef) return;
      const v = val.trim();
      switch (this.editFieldIndex) {
         case 0: // display_name
            this.editDef.display_name = v || undefined;
            break;
         case 1: // description
            this.editDef.description = v;
            break;
         case 2: // guidance
            this.editDef.guidance = v || undefined;
            break;
         case 3: // model
            this.editDef.model = v || undefined;
            break;
         case 4: // thinking
            this.editDef.thinking = (v || undefined) as ReasoningEffort | undefined;
            break;
         case 5: // tools
            this.editDef.tools = v
               ? v
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
               : undefined;
            break;
         case 6: // harness
            // text submission fallback if needed
            break;
         case 7: // body
            this.editDef.body = v;
            break;
      }
      this.isEditingText = false;
      this.tui.requestRender();
   }

   private handleVibeTextSubmit(val: string) {
      const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
      const harness = profile.harness;
      const v = val.trim();

      if (this.vibeFieldIndex === 1) {
         // Model
         if (harness === "pi") {
            profile.pi.model = v || null;
         } else {
            profile.agy.model = v || "gemini-3.6-flash";
         }
      } else if (this.vibeFieldIndex === 2) {
         // Reasoning Effort
         if (harness === "pi") {
            profile.pi.reasoning_effort = (v || null) as any;
         } else {
            const effort = v === "medium" || v === "high" || v === "low" ? v : "low";
            profile.agy.reasoning_effort = effort;
         }
      } else if (this.vibeFieldIndex === 4) {
         // System Prompt Body
         const bodyVal = v || undefined;
         if (harness === "pi") {
            profile.pi.body = bodyVal;
         } else {
            profile.agy.body = bodyVal;
         }
         profile.body = bodyVal;
      }
      this.isEditingVibeText = false;
      this.tui.requestRender();
   }

   private saveEdit() {
      if (!this.editDef) return;
      if (!this.editDef.name.trim()) {
         this.editError = "Name cannot be empty.";
         this.tui.requestRender();
         return;
      }
      if (!this.editDef.description.trim()) {
         this.editError = "Description cannot be empty.";
         this.tui.requestRender();
         return;
      }
      if (!this.editDef.guidance?.trim()) {
         this.editError = "Guidance cannot be empty.";
         this.tui.requestRender();
         return;
      }
      if (!this.editDef.body.trim()) {
         this.editError = `Agent "${this.editDef.name}" has no system prompt body. Edit it in /agents and add instructions under the frontmatter.`;
         this.tui.requestRender();
         return;
      }

      saveAgent(this.editDef);
      this.reloadAgents();

      this.isEditingBody = false;
      this.isEditingText = false;
      this.bodyBackup = this.editDef.body;
      this.bodyEditor.setValue(this.editDef.body);
      this.editOriginalSnap = JSON.parse(JSON.stringify(this.editDef));
      this.isNewUnsavedAgent = false;
      this.editError = "";
      this.statusMessage = `Agent "${this.editDef.name}" saved successfully!`;
      this.tui.requestRender();
   }

   private saveSubagentListToggles() {
      for (const agent of this.agents) {
         saveAgent(agent);
      }
      this.reloadAgents();
      this.statusMessage = "Agent list changes saved successfully.";
      this.tui.requestRender();
   }

   private saveVibeConfig() {
      saveAgentsConfig(this.vibeConfig);
      this.savedVibeConfig = JSON.parse(JSON.stringify(this.vibeConfig));
      this.vibeStatusMessage = "Vibe profiles saved to agents.json.";
      this.tui.requestRender();
   }

   handleInput(data: string): void {
      // Tab / [ / ] switch only when canSwitchAgentsTab allows it; otherwise fall through
      // so text/filter inputs still receive [ / ] characters.
      if ((data === "\t" || data === "[" || data === "]") && canSwitchAgentsTab(this.activeTab, this.viewState)) {
         this.activeTab = this.activeTab === "subagents" ? "vibe" : "subagents";
         // Leaving a vibe selector should not leave select_* state on the subagents tab
         if (
            this.activeTab === "subagents" &&
            (this.viewState === "select_vibe_model" || this.viewState === "select_vibe_thinking")
         ) {
            this.viewState = "list";
         }
         this.tui.requestRender();
         return;
      }

      if (this.activeTab === "subagents") {
         this.handleSubagentsInput(data);
      } else {
         this.handleVibeInput(data);
      }
   }

   private reclampSelectorScroll(totalItems: number): void {
      const width = this.tui.terminal.columns || 80;
      const termRows = this.tui.terminal.rows || 30;
      const { listBudget } = computeSelectorViewport(
         termRows,
         width,
         SELECT_TOOLS_HELP_UNITS,
         totalItems,
         this.selectorScrollOffset,
         this.selectorSelectedIndex
      );

      let heights: number[] = [];
      if (this.viewState === "select_tools") {
         const availableTools = this.getAvailableTools();
         const query = this.selectorFilterInput.getValue();
         const filteredTools = filterSelectableTools(availableTools, query);
         heights = filteredTools.map(
            (tool, idx) =>
               renderToolOptionBlock(tool, {
                  selected: idx === this.selectorSelectedIndex,
                  checked: this.tempSelectedTools.includes(tool.name),
                  width,
                  theme: this.theme
               }).length
         );
      } else if (
         this.viewState === "select_model" ||
         this.viewState === "select_thinking" ||
         this.viewState === "select_vibe_model" ||
         this.viewState === "select_vibe_thinking"
      ) {
         const isModel = this.viewState === "select_model" || this.viewState === "select_vibe_model";
         const type = isModel ? "model" : "thinking";
         const isVibe = this.viewState === "select_vibe_model" || this.viewState === "select_vibe_thinking";
         const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
         const harness = isVibe ? profile.harness : (this.editDef?.harness ?? "pi");
         let currentVal = "";
         if (isVibe) {
            if (isModel) {
               currentVal = (harness === "pi" ? profile.pi.model : profile.agy.model) ?? "";
            } else {
               currentVal = (harness === "pi" ? profile.pi.reasoning_effort : profile.agy.reasoning_effort) ?? "";
            }
         } else {
            currentVal = (isModel ? this.editDef?.model : this.editDef?.thinking) ?? "";
         }
         const baseOpts = getBaseSelectorOptions(type, harness, this.ctx.modelRegistry);
         const query = this.selectorFilterInput.getValue();
         const options = filterSelectorOptions(baseOpts, query);
         heights = options.map(
            (opt, idx) =>
               renderSelectorOptionBlock(opt, {
                  selected: idx === this.selectorSelectedIndex,
                  current: opt.value === currentVal,
                  width,
                  theme: this.theme
               }).length
         );
      }

      if (heights.length > 0) {
         const win = computeMultiLineVisibleWindow(
            heights,
            listBudget,
            this.selectorScrollOffset,
            this.selectorSelectedIndex
         );
         this.selectorScrollOffset = win.startIndex;
      }
   }

   private requestRedraw(forceFull = true): void {
      this.invalidate();
      const tui = this.tui as any;
      if (typeof tui?.requestRender === "function") {
         try {
            tui.requestRender(forceFull);
            return;
         } catch {
            // fallback
         }
      }
      this.tui.requestRender();
   }

   private handleSubagentsInput(data: string): void {
      if (this.viewState === "select_tools") {
         const availableTools = this.getAvailableTools();
         const query = this.selectorFilterInput.getValue();
         const filteredTools = filterSelectableTools(availableTools, query);

         if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
            this.viewState = "edit";
            this.requestRedraw(true);
            return;
         }

         if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
            if (this.editDef) {
               this.editDef.tools = this.tempSelectedTools.length > 0 ? [...this.tempSelectedTools] : undefined;
            }
            this.viewState = "edit";
            this.requestRedraw(true);
            return;
         }

         const isUp = this.keybindings.matches(data, "tui.select.up") || data === "\x1b[A";
         if (isUp) {
            this.selectorSelectedIndex = Math.max(0, this.selectorSelectedIndex - 1);
            this.reclampSelectorScroll(filteredTools.length);
            this.requestRedraw(true);
            return;
         }

         const isDown = this.keybindings.matches(data, "tui.select.down") || data === "\x1b[B";
         if (isDown) {
            this.selectorSelectedIndex = Math.min(
               Math.max(0, filteredTools.length - 1),
               this.selectorSelectedIndex + 1
            );
            this.reclampSelectorScroll(filteredTools.length);
            this.requestRedraw(true);
            return;
         }

         if (data === " ") {
            if (filteredTools.length > 0) {
               const targetIdx = Math.min(this.selectorSelectedIndex, filteredTools.length - 1);
               const targetTool = filteredTools[targetIdx];
               if (targetTool) {
                  this.tempSelectedTools = toggleToolSelection(this.tempSelectedTools, targetTool.name);
               }
            }
            this.requestRedraw(true);
            return;
         }

         if (data === "\x01" || (data === "a" && !query)) {
            const visibleNames = filteredTools.map((t) => t.name);
            const combined = new Set([...this.tempSelectedTools, ...visibleNames]);
            this.tempSelectedTools = Array.from(combined);
            this.requestRedraw(true);
            return;
         }

         if (data === "\x0e" || (data === "n" && !query)) {
            if (query) {
               const visibleSet = new Set(filteredTools.map((t) => t.name));
               this.tempSelectedTools = this.tempSelectedTools.filter((t) => !visibleSet.has(t));
            } else {
               this.tempSelectedTools = [];
            }
            this.requestRedraw(true);
            return;
         }

         this.selectorFilterInput.handleInput(data);
         const newQuery = this.selectorFilterInput.getValue();
         const newFiltered = filterSelectableTools(availableTools, newQuery);
         if (this.selectorSelectedIndex >= newFiltered.length) {
            this.selectorSelectedIndex = Math.max(0, newFiltered.length - 1);
         }
         this.reclampSelectorScroll(newFiltered.length);
         this.requestRedraw(true);
         return;
      }

      if (this.viewState === "select_model" || this.viewState === "select_thinking") {
         const isModel = this.viewState === "select_model";
         const type = isModel ? "model" : "thinking";
         const harness = this.editDef?.harness ?? "pi";
         const baseOpts = getBaseSelectorOptions(type, harness, this.ctx.modelRegistry);
         const currentQuery = this.selectorFilterInput.getValue();
         const options = filterSelectorOptions(baseOpts, currentQuery);

         if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
            this.viewState = "edit";
            this.requestRedraw(true);
            return;
         }

         if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
            if (this.editDef && options.length > 0) {
               const selectedOpt = options[Math.min(this.selectorSelectedIndex, options.length - 1)];
               if (selectedOpt) {
                  if (isModel) {
                     this.editDef.model = selectedOpt.value || undefined;
                  } else {
                     this.editDef.thinking = (selectedOpt.value || undefined) as ReasoningEffort | undefined;
                  }
               }
            }
            this.viewState = "edit";
            this.requestRedraw(true);
            return;
         }

         const isUp = this.keybindings.matches(data, "tui.select.up") || data === "\x1b[A";
         if (isUp) {
            this.selectorSelectedIndex = Math.max(0, this.selectorSelectedIndex - 1);
            this.reclampSelectorScroll(options.length);
            this.requestRedraw(true);
            return;
         }

         const isDown = this.keybindings.matches(data, "tui.select.down") || data === "\x1b[B";
         if (isDown) {
            this.selectorSelectedIndex = Math.min(Math.max(0, options.length - 1), this.selectorSelectedIndex + 1);
            this.reclampSelectorScroll(options.length);
            this.requestRedraw(true);
            return;
         }

         this.selectorFilterInput.handleInput(data);
         const newQuery = this.selectorFilterInput.getValue();
         const newOptions = filterSelectorOptions(baseOpts, newQuery);
         if (this.selectorSelectedIndex >= newOptions.length) {
            this.selectorSelectedIndex = Math.max(0, newOptions.length - 1);
         }
         this.reclampSelectorScroll(newOptions.length);
         this.requestRedraw(true);
         return;
      }

      if (this.viewState === "create_name") {
         if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
            this.viewState = "list";
            this.tui.requestRender();
            return;
         }
         this.createNameInput.handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.viewState === "create_intent") {
         if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
            this.viewState = "list";
            this.tui.requestRender();
            return;
         }
         this.createIntentInput.handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.viewState === "edit") {
         if (this.isEditingBody) {
            if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
               this.isEditingBody = false;
               if (this.editDef) {
                  this.editDef.body = this.bodyBackup;
               }
               this.tui.requestRender();
               return;
            }

            if (isCtrlS(data, this.keybindings)) {
               this.saveEdit();
               return;
            }

            const isPageUp = data === "\x1b[5~" || data === "\x15"; // PageUp or Ctrl+U
            const isPageDown = data === "\x1b[6~" || data === "\x04"; // PageDown or Ctrl+D

            if (isPageUp || isPageDown) {
               const rawBody = this.editDef?.body ?? "";
               const width = this.tui.terminal.columns || 80;
               const wrappedLines = rawBody ? wrapTextWithAnsi(rawBody, width) : [];
               const termRows = this.tui.terminal.rows || 30;
               const units = SUBAGENTS_HELP_UNITS;
               const wrappedHelp = wrapHelpUnits(units, width);
               const footerLinesCount = 2 + wrappedHelp.length;
               const frontmatterCount = this.editDef
                  ? computeFrontmatterLinesCount(
                       this.editDef,
                       this.editFieldIndex,
                       this.isEditingText,
                       width,
                       this.theme,
                       this.isEditingText ? this.textInput.render(width) : undefined
                    )
                  : 7;
               const nonBodyFixedRows = 3 + (this.editError ? 4 : 3) + frontmatterCount + 3 + 2 + footerLinesCount;
               const viewportHeight = Math.max(5, termRows - nonBodyFixedRows);
               const delta = 5;

               if (isPageUp) {
                  this.bodyScrollOffset = clampBodyScroll(
                     this.bodyScrollOffset - delta,
                     wrappedLines.length,
                     viewportHeight
                  );
               } else {
                  this.bodyScrollOffset = clampBodyScroll(
                     this.bodyScrollOffset + delta,
                     wrappedLines.length,
                     viewportHeight
                  );
               }
               this.tui.requestRender();
               return;
            }

            this.bodyEditor.handleInput(data);
            if (this.editDef) {
               this.editDef.body = this.bodyEditor.getValue();
            }

            const rawBody = this.editDef?.body ?? "";
            const width = this.tui.terminal.columns || 80;
            const wrappedLines = rawBody ? wrapTextWithAnsi(rawBody, width) : [];
            const termRows = this.tui.terminal.rows || 30;
            const units = SUBAGENTS_HELP_UNITS;
            const wrappedHelp = wrapHelpUnits(units, width);
            const footerLinesCount = 2 + wrappedHelp.length;
            const frontmatterCount = this.editDef
               ? computeFrontmatterLinesCount(
                    this.editDef,
                    this.editFieldIndex,
                    this.isEditingText,
                    width,
                    this.theme,
                    this.isEditingText ? this.textInput.render(width) : undefined
                 )
               : 7;
            const nonBodyFixedRows = 3 + (this.editError ? 4 : 3) + frontmatterCount + 3 + 2 + footerLinesCount;
            const viewportHeight = Math.max(5, termRows - nonBodyFixedRows);
            const { cursorRow } = computeCursorRowCol(rawBody, this.bodyEditor.getCursorIndex(), width);
            this.bodyScrollOffset = ensureCursorVisible(
               this.bodyScrollOffset,
               cursorRow,
               viewportHeight,
               wrappedLines.length
            );

            this.tui.requestRender();
            return;
         }

         if (this.isEditingText) {
            if (this.keybindings.matches(data, "tui.select.cancel")) {
               this.isEditingText = false;
               this.tui.requestRender();
               return;
            }
            this.textInput.handleInput(data);
            this.tui.requestRender();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel") || data === "q" || data === "\x1b") {
            this.viewState = "list";
            this.editDef = null;
            this.editOriginalSnap = null;
            this.isNewUnsavedAgent = false;
            this.reloadAgents();
            this.tui.requestRender();
            return;
         }

         if (isCtrlS(data, this.keybindings)) {
            this.saveEdit();
            return;
         }

         const isPageUp = data === "\x1b[5~" || data === "\x15"; // PageUp or Ctrl+U
         const isPageDown = data === "\x1b[6~" || data === "\x04"; // PageDown or Ctrl+D

         if (isPageUp || isPageDown) {
            const rawBody = this.editDef?.body ?? "";
            const width = this.tui.terminal.columns || 80;
            const wrappedLines = rawBody ? wrapTextWithAnsi(rawBody, width) : [];
            const termRows = this.tui.terminal.rows || 30;
            const units = SUBAGENTS_HELP_UNITS;
            const wrappedHelp = wrapHelpUnits(units, width);
            const footerLinesCount = 2 + wrappedHelp.length;
            const frontmatterCount = this.editDef
               ? computeFrontmatterLinesCount(
                    this.editDef,
                    this.editFieldIndex,
                    this.isEditingText,
                    width,
                    this.theme,
                    this.isEditingText ? this.textInput.render(width) : undefined
                 )
               : 7;
            const nonBodyFixedRows = 3 + (this.editError ? 4 : 3) + frontmatterCount + 3 + 2 + footerLinesCount;
            const viewportHeight = Math.max(5, termRows - nonBodyFixedRows);
            const delta = 5;

            if (isPageUp) {
               this.bodyScrollOffset = clampBodyScroll(
                  this.bodyScrollOffset - delta,
                  wrappedLines.length,
                  viewportHeight
               );
            } else {
               this.bodyScrollOffset = clampBodyScroll(
                  this.bodyScrollOffset + delta,
                  wrappedLines.length,
                  viewportHeight
               );
            }
            this.tui.requestRender();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.up")) {
            this.editFieldIndex = (this.editFieldIndex + 7) % 8;
            this.tui.requestRender();
            return;
         }
         if (this.keybindings.matches(data, "tui.select.down")) {
            this.editFieldIndex = (this.editFieldIndex + 1) % 8;
            this.tui.requestRender();
            return;
         }

         const isConfirm = this.keybindings.matches(data, "tui.select.confirm");
         if (isConfirm || (data === " " && this.editFieldIndex !== 7)) {
            if (!this.editDef) return;

            if (this.editFieldIndex === 3) {
               // Open Model selector
               this.viewState = "select_model";
               this.selectorFilterInput.setValue("");
               this.selectorFilterInput.focused = true;
               const initialOptions = getBaseSelectorOptions("model", this.editDef.harness, this.ctx.modelRegistry);
               const currentVal = this.editDef.model ?? "";
               const matchedIdx = initialOptions.findIndex((opt) => opt.value === currentVal);
               this.selectorSelectedIndex = matchedIdx >= 0 ? matchedIdx : 0;
               this.selectorScrollOffset = 0;
               this.requestRedraw(true);
               return;
            }

            if (this.editFieldIndex === 4) {
               // Open Thinking selector
               this.viewState = "select_thinking";
               this.selectorFilterInput.setValue("");
               this.selectorFilterInput.focused = true;
               const initialOptions = getBaseSelectorOptions("thinking", this.editDef.harness, this.ctx.modelRegistry);
               const currentVal = this.editDef.thinking ?? "";
               const matchedIdx = initialOptions.findIndex((opt) => opt.value === currentVal);
               this.selectorSelectedIndex = matchedIdx >= 0 ? matchedIdx : 0;
               this.selectorScrollOffset = 0;
               this.requestRedraw(true);
               return;
            }

            if (this.editFieldIndex === 5) {
               // Open Tools selector
               this.viewState = "select_tools";
               this.selectorFilterInput.setValue("");
               this.selectorFilterInput.focused = true;
               this.selectorSelectedIndex = 0;
               this.selectorScrollOffset = 0;
               this.tempSelectedTools = this.editDef.tools ? [...this.editDef.tools] : [];
               this.requestRedraw(true);
               return;
            }

            if (this.editFieldIndex === 6) {
               // Toggle harness
               this.editDef.harness = this.editDef.harness === "pi" ? "agy" : "pi";
               this.tui.requestRender();
               return;
            }

            if (this.editFieldIndex === 7) {
               // Enter body edit mode
               this.isEditingBody = true;
               this.bodyBackup = this.editDef.body;
               this.bodyEditor.setValue(this.editDef.body);

               const rawBody = this.editDef.body;
               const width = this.tui.terminal.columns || 80;
               const wrappedLines = rawBody ? wrapTextWithAnsi(rawBody, width) : [];
               const termRows = this.tui.terminal.rows || 30;
               const units = SUBAGENTS_HELP_UNITS;
               const wrappedHelp = wrapHelpUnits(units, width);
               const footerLinesCount = 2 + wrappedHelp.length;
               const frontmatterCount = computeFrontmatterLinesCount(
                  this.editDef,
                  this.editFieldIndex,
                  this.isEditingText,
                  width,
                  this.theme,
                  this.isEditingText ? this.textInput.render(width) : undefined
               );
               const nonBodyFixedRows = 3 + (this.editError ? 4 : 3) + frontmatterCount + 3 + 2 + footerLinesCount;
               const viewportHeight = Math.max(5, termRows - nonBodyFixedRows);
               const { cursorRow } = computeCursorRowCol(rawBody, this.bodyEditor.getCursorIndex(), width);
               this.bodyScrollOffset = ensureCursorVisible(
                  this.bodyScrollOffset,
                  cursorRow,
                  viewportHeight,
                  wrappedLines.length
               );

               this.tui.requestRender();
               return;
            }

            // Short text edit for 0 (Display Name), 1 (Description), 2 (Guidance)
            this.isEditingText = true;
            let val = "";
            switch (this.editFieldIndex) {
               case 0:
                  val = this.editDef.display_name ?? "";
                  break;
               case 1:
                  val = this.editDef.description;
                  break;
               case 2:
                  val = this.editDef.guidance ?? "";
                  break;
            }
            this.textInput.setValue(val);
            this.tui.requestRender();
         }
         return;
      }

      // View state == "list"
      if (this.keybindings.matches(data, "tui.select.cancel") || data === "q" || data === "\x1b") {
         this.reloadAgents();
         this.done(null);
         return;
      }

      if (isCtrlS(data, this.keybindings)) {
         this.saveSubagentListToggles();
         return;
      }

      if (data === "n") {
         this.viewState = "create_name";
         this.createNameInput.setValue("");
         this.createNameInput.focused = true;
         this.statusMessage = "";
         this.tui.requestRender();
         return;
      }

      if (this.agents.length === 0) return;

      if (this.keybindings.matches(data, "tui.select.up")) {
         this.selectedListIndex = (this.selectedListIndex - 1 + this.agents.length) % this.agents.length;
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.select.down")) {
         this.selectedListIndex = (this.selectedListIndex + 1) % this.agents.length;
         this.tui.requestRender();
         return;
      }

      if (data === " ") {
         // Toggle enabled (in-memory only, save on Ctrl+S)
         const agent = this.agents[this.selectedListIndex];
         agent.enabled = !agent.enabled;
         this.tui.requestRender();
         return;
      }

      if (data === "d") {
         const agent = this.agents[this.selectedListIndex];
         const res = deleteAgent(agent.name, this.ctx.cwd);
         if (!res.success) {
            this.statusMessage = res.error || "Failed to delete agent.";
         } else {
            this.statusMessage = `Deleted agent "${agent.name}".`;
            this.reloadAgents();
            this.savedAgents = JSON.parse(JSON.stringify(this.agents));
         }
         this.tui.requestRender();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm") || data === "e") {
         const agent = this.agents[this.selectedListIndex];
         this.editDef = { ...agent, tools: agent.tools ? [...agent.tools] : undefined };
         this.editOriginalSnap = JSON.parse(JSON.stringify(this.editDef));
         this.isNewUnsavedAgent = false;
         this.viewState = "edit";
         this.editFieldIndex = 0;
         this.bodyScrollOffset = 0;
         this.editError = "";
         this.statusMessage = agent.source === "builtin" ? "Editing built-in (save writes override)" : "";
         this.tui.requestRender();
         return;
      }
   }

   private handleVibeInput(data: string): void {
      if (this.viewState === "select_vibe_tools") {
         const availableTools = this.getAvailableTools();
         const query = this.selectorFilterInput.getValue();
         const filteredTools = filterSelectableTools(availableTools, query);
         const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];

         if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
            this.viewState = "list";
            this.requestRedraw(true);
            return;
         }

         if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
            const toolsVal = this.tempSelectedTools.length > 0 ? [...this.tempSelectedTools] : undefined;
            if (profile.harness === "pi") {
               profile.pi.tools = toolsVal;
            }
            profile.tools = toolsVal;
            this.viewState = "list";
            this.requestRedraw(true);
            return;
         }

         const isUp = this.keybindings.matches(data, "tui.select.up") || data === "\x1b[A";
         if (isUp) {
            this.selectorSelectedIndex = Math.max(0, this.selectorSelectedIndex - 1);
            this.reclampSelectorScroll(filteredTools.length);
            this.requestRedraw(true);
            return;
         }

         const isDown = this.keybindings.matches(data, "tui.select.down") || data === "\x1b[B";
         if (isDown) {
            this.selectorSelectedIndex = Math.min(
               Math.max(0, filteredTools.length - 1),
               this.selectorSelectedIndex + 1
            );
            this.reclampSelectorScroll(filteredTools.length);
            this.requestRedraw(true);
            return;
         }

         if (data === " ") {
            if (filteredTools.length > 0) {
               const targetIdx = Math.min(this.selectorSelectedIndex, filteredTools.length - 1);
               const targetTool = filteredTools[targetIdx];
               if (targetTool) {
                  this.tempSelectedTools = toggleToolSelection(this.tempSelectedTools, targetTool.name);
               }
            }
            this.requestRedraw(true);
            return;
         }

         if (data === "\x01" || (data === "a" && !query)) {
            const visibleNames = filteredTools.map((t) => t.name);
            const combined = new Set([...this.tempSelectedTools, ...visibleNames]);
            this.tempSelectedTools = Array.from(combined);
            this.requestRedraw(true);
            return;
         }

         if (data === "n" && !query) {
            this.tempSelectedTools = [];
            this.requestRedraw(true);
            return;
         }

         this.selectorFilterInput.handleInput(data);
         const newQuery = this.selectorFilterInput.getValue();
         const newFiltered = filterSelectableTools(availableTools, newQuery);
         if (this.selectorSelectedIndex >= newFiltered.length) {
            this.selectorSelectedIndex = Math.max(0, newFiltered.length - 1);
         }
         this.reclampSelectorScroll(newFiltered.length);
         this.requestRedraw(true);
         return;
      }

      if (this.viewState === "select_vibe_model" || this.viewState === "select_vibe_thinking") {
         const isModel = this.viewState === "select_vibe_model";
         const type = isModel ? "model" : "thinking";
         const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
         const harness = profile.harness;
         const baseOpts = getBaseSelectorOptions(type, harness, this.ctx.modelRegistry);
         const currentQuery = this.selectorFilterInput.getValue();
         const options = filterSelectorOptions(baseOpts, currentQuery);

         if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
            this.viewState = "list";
            this.requestRedraw(true);
            return;
         }

         if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
            if (options.length > 0) {
               const selectedOpt = options[Math.min(this.selectorSelectedIndex, options.length - 1)];
               if (selectedOpt) {
                  this.applyVibeSelectorValue(isModel, selectedOpt.value);
               }
            }
            this.viewState = "list";
            this.requestRedraw(true);
            return;
         }

         const isUp = this.keybindings.matches(data, "tui.select.up") || data === "\x1b[A";
         if (isUp) {
            this.selectorSelectedIndex = Math.max(0, this.selectorSelectedIndex - 1);
            this.reclampSelectorScroll(options.length);
            this.requestRedraw(true);
            return;
         }

         const isDown = this.keybindings.matches(data, "tui.select.down") || data === "\x1b[B";
         if (isDown) {
            this.selectorSelectedIndex = Math.min(Math.max(0, options.length - 1), this.selectorSelectedIndex + 1);
            this.reclampSelectorScroll(options.length);
            this.requestRedraw(true);
            return;
         }

         this.selectorFilterInput.handleInput(data);
         const newQuery = this.selectorFilterInput.getValue();
         const newOptions = filterSelectorOptions(baseOpts, newQuery);
         if (this.selectorSelectedIndex >= newOptions.length) {
            this.selectorSelectedIndex = Math.max(0, newOptions.length - 1);
         }
         this.reclampSelectorScroll(newOptions.length);
         this.requestRedraw(true);
         return;
      }

      if (this.isEditingVibeText) {
         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.isEditingVibeText = false;
            this.tui.requestRender();
            return;
         }
         this.vibeTextInput.handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel") || data === "q" || data === "\x1b") {
         this.done(null);
         return;
      }

      if (isCtrlS(data, this.keybindings)) {
         this.saveVibeConfig();
         return;
      }

      if (data === "h" || data === "\x1b[D") {
         this.vibeSelectedProfile = "fast";
         this.tui.requestRender();
         return;
      }

      if (data === "l" || data === "\x1b[C") {
         this.vibeSelectedProfile = "good";
         this.tui.requestRender();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.up")) {
         this.vibeFieldIndex = (this.vibeFieldIndex + 4) % 5;
         this.tui.requestRender();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.down")) {
         this.vibeFieldIndex = (this.vibeFieldIndex + 1) % 5;
         this.tui.requestRender();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm") || data === " ") {
         const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
         if (this.vibeFieldIndex === 0) {
            // Toggle harness
            const targetHarness = profile.harness === "pi" ? "agy" : "pi";
            this.vibeConfig.profiles[this.vibeSelectedProfile] = switchHarness(profile, targetHarness);
            this.vibeStatusMessage = "";
            this.tui.requestRender();
            return;
         }

         if (this.vibeFieldIndex === 3) {
            // Open tools multi-select
            this.tempSelectedTools = Array.from(
               profile.harness === "pi" ? (profile.pi.tools ?? profile.tools ?? []) : []
            );
            this.viewState = "select_vibe_tools";
            this.selectorFilterInput.setValue("");
            this.selectorFilterInput.focused = true;
            this.selectorSelectedIndex = 0;
            this.selectorScrollOffset = 0;
            this.vibeStatusMessage = "";
            this.requestRedraw(true);
            return;
         }

         if (this.vibeFieldIndex === 4) {
            // Edit system prompt text
            const currentBody =
               profile.harness === "pi" ? (profile.pi.body ?? profile.body) : (profile.agy.body ?? profile.body);
            this.isEditingVibeText = true;
            this.vibeTextInput.setValue(currentBody || "");
            this.vibeTextInput.focused = true;
            this.vibeStatusMessage = "";
            this.tui.requestRender();
            return;
         }

         // Open searchable Model or Reasoning Effort selector
         const isModel = this.vibeFieldIndex === 1;
         this.viewState = isModel ? "select_vibe_model" : "select_vibe_thinking";
         this.selectorFilterInput.setValue("");
         this.selectorFilterInput.focused = true;
         const type = isModel ? "model" : "thinking";
         const initialOptions = getBaseSelectorOptions(type, profile.harness, this.ctx.modelRegistry);
         const currentVal = isModel
            ? profile.harness === "pi"
               ? (profile.pi.model ?? "")
               : (profile.agy.model ?? "")
            : profile.harness === "pi"
              ? (profile.pi.reasoning_effort ?? "")
              : (profile.agy.reasoning_effort ?? "");
         const matchedIdx = initialOptions.findIndex((opt) => opt.value === currentVal);
         this.selectorSelectedIndex = matchedIdx >= 0 ? matchedIdx : 0;
         this.selectorScrollOffset = 0;
         this.vibeStatusMessage = "";
         this.requestRedraw(true);
      }
   }

   private applyVibeSelectorValue(isModel: boolean, value: string): void {
      const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
      const harness = profile.harness;
      const v = value.trim();

      if (isModel) {
         if (harness === "pi") {
            profile.pi.model = v || null;
         } else {
            profile.agy.model = v || "gemini-3.6-flash";
         }
      } else {
         if (harness === "pi") {
            profile.pi.reasoning_effort = (v || null) as any;
         } else {
            const effort = v === "medium" || v === "high" || v === "low" ? v : "low";
            profile.agy.reasoning_effort = effort;
         }
      }
   }

   render(width: number): string[] {
      const theme = this.theme;
      const termRows = this.tui.terminal.rows || 30;
      const border = theme.fg("border", "─".repeat(Math.max(1, width)));

      // Header: always exactly 3 lines (border, title+tabs, border) — pinned by assembleManagerFrame
      const titleStr = theme.bold("Agents Manager");
      const tabSub =
         this.activeTab === "subagents"
            ? theme.fg("accent", theme.bold("[ Subagents ]"))
            : theme.fg("dim", "[ Subagents ]");
      const tabVibe =
         this.activeTab === "vibe" ? theme.fg("accent", theme.bold("[ Vibe ]")) : theme.fg("dim", "[ Vibe ]");
      const headerLine = ` ${titleStr}  ${tabSub}  ${tabVibe}`;
      const headerLines = [border, truncateToWidth(headerLine, width), border];

      // Keys help footer (compute first so contentBudget is exact)
      const isSelectorView =
         this.viewState === "select_tools" ||
         this.viewState === "select_model" ||
         this.viewState === "select_thinking" ||
         this.viewState === "select_vibe_model" ||
         this.viewState === "select_vibe_thinking";
      const units =
         this.activeTab === "subagents"
            ? isSelectorView
               ? SELECT_TOOLS_HELP_UNITS
               : SUBAGENTS_HELP_UNITS
            : isSelectorView
              ? SELECT_TOOLS_HELP_UNITS
              : VIBE_HELP_UNITS;
      const dirty =
         this.activeTab === "subagents"
            ? isSubagentsDirty(
                 this.savedAgents,
                 this.agents,
                 this.viewState,
                 this.editDef,
                 this.editOriginalSnap,
                 this.isNewUnsavedAgent
              )
            : isVibeDirty(this.savedVibeConfig, this.vibeConfig);

      const wrappedHelp = renderHelpUnits(units, width, dirty, theme);
      const footerLines = [border, ...wrappedHelp, border];

      // Content only (no header/footer). List view already budgets to content area.
      const contentLines = this.activeTab === "subagents" ? this.renderSubagentsTab(width) : this.renderVibeTab(width);

      return assembleManagerFrame({
         header: headerLines,
         content: contentLines,
         footer: footerLines,
         termRows,
         width
      });
   }

   private renderSubagentsTab(width: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];

      if (this.viewState === "select_tools" && this.editDef) {
         this.selectorFilterInput.invalidate();
         const availableTools = this.getAvailableTools();
         const query = this.selectorFilterInput.getValue();
         const filteredTools = filterSelectableTools(availableTools, query);

         const title = `Select Tools (Agent: ${this.editDef.name})`;
         const harness = this.editDef.harness;
         const harnessNote = harness === "agy" ? " · Note: tools are ignored for agy harness" : "";

         lines.push(truncateToWidth(theme.bold(title), width, ""));
         lines.push(truncateToWidth(theme.fg("dim", `Harness: ${harness}${harnessNote}`), width, ""));
         lines.push("");

         const filterLine = "Filter: " + (this.selectorFilterInput.render(Math.max(1, width - 8))[0] ?? "");
         lines.push(truncateToWidth(filterLine, width, ""));
         lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

         const termRows = this.tui.terminal.rows || 30;
         const { contentBudget, listBudget } = computeSelectorViewport(
            termRows,
            width,
            SELECT_TOOLS_HELP_UNITS,
            filteredTools.length,
            this.selectorScrollOffset,
            this.selectorSelectedIndex
         );

         if (filteredTools.length === 0) {
            lines.push(theme.fg("muted", "  No matching tools found."));
         } else {
            const blocks = filteredTools.map((tool, idx) =>
               renderToolOptionBlock(tool, {
                  selected: idx === this.selectorSelectedIndex,
                  checked: this.tempSelectedTools.includes(tool.name),
                  width,
                  theme
               })
            );
            const heights = blocks.map((b) => b.length);

            const win = computeMultiLineVisibleWindow(
               heights,
               listBudget,
               this.selectorScrollOffset,
               this.selectorSelectedIndex
            );
            this.selectorScrollOffset = win.startIndex;

            if (win.aboveCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↑ ${win.aboveCount} item${win.aboveCount === 1 ? "" : "s"} above`),
                     width,
                     ""
                  )
               );
            }
            for (let idx = win.startIndex; idx < win.endIndex; idx++) {
               const block = blocks[idx];
               for (const line of block) {
                  lines.push(padLineToWidth(line, width));
               }
            }
            if (win.belowCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↓ ${win.belowCount} item${win.belowCount === 1 ? "" : "s"} below`),
                     width,
                     ""
                  )
               );
            }
         }

         while (lines.length < contentBudget) {
            lines.push("");
         }
         if (lines.length > contentBudget) {
            lines.splice(contentBudget);
         }

         return lines;
      }

      if ((this.viewState === "select_model" || this.viewState === "select_thinking") && this.editDef) {
         this.selectorFilterInput.invalidate();
         const isModel = this.viewState === "select_model";
         const type = isModel ? "model" : "thinking";
         const harness = this.editDef.harness;
         const currentVal = (isModel ? this.editDef.model : this.editDef.thinking) ?? "";
         const baseOpts = getBaseSelectorOptions(type, harness, this.ctx.modelRegistry);
         const query = this.selectorFilterInput.getValue();
         const options = filterSelectorOptions(baseOpts, query);

         const title = isModel
            ? `Select Model (Agent: ${this.editDef.name})`
            : `Select Reasoning Effort (Agent: ${this.editDef.name})`;

         lines.push(truncateToWidth(theme.bold(title), width, ""));
         lines.push(
            truncateToWidth(
               theme.fg("dim", `Harness: ${harness} · Current: ${currentVal || "(inherit parent)"}`),
               width,
               ""
            )
         );
         lines.push("");

         const filterLine = "Filter: " + (this.selectorFilterInput.render(Math.max(1, width - 8))[0] ?? "");
         lines.push(truncateToWidth(filterLine, width, ""));
         lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

         const termRows = this.tui.terminal.rows || 30;
         const { contentBudget, listBudget } = computeSelectorViewport(
            termRows,
            width,
            SELECT_TOOLS_HELP_UNITS,
            options.length,
            this.selectorScrollOffset,
            this.selectorSelectedIndex
         );

         if (options.length === 0) {
            lines.push(theme.fg("muted", "  No matching options found."));
         } else {
            const blocks = options.map((opt, idx) =>
               renderSelectorOptionBlock(opt, {
                  selected: idx === this.selectorSelectedIndex,
                  current: opt.value === currentVal,
                  width,
                  theme
               })
            );
            const heights = blocks.map((b) => b.length);

            const win = computeMultiLineVisibleWindow(
               heights,
               listBudget,
               this.selectorScrollOffset,
               this.selectorSelectedIndex
            );
            this.selectorScrollOffset = win.startIndex;

            if (win.aboveCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↑ ${win.aboveCount} item${win.aboveCount === 1 ? "" : "s"} above`),
                     width,
                     ""
                  )
               );
            }
            for (let idx = win.startIndex; idx < win.endIndex; idx++) {
               const block = blocks[idx];
               for (const line of block) {
                  lines.push(padLineToWidth(line, width));
               }
            }
            if (win.belowCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↓ ${win.belowCount} item${win.belowCount === 1 ? "" : "s"} below`),
                     width,
                     ""
                  )
               );
            }
         }

         while (lines.length < contentBudget) {
            lines.push("");
         }
         if (lines.length > contentBudget) {
            lines.splice(contentBudget);
         }

         return lines;
      }

      if (this.viewState === "create_name") {
         lines.push(theme.bold("Create New Agent (Step 1/2)"));
         lines.push("Enter agent filename/identifier (lowercase alphanumeric, dash, underscore):");
         lines.push(...this.createNameInput.render(width));
         if (this.statusMessage) lines.push(theme.fg("error", this.statusMessage));
         return lines;
      }

      if (this.viewState === "create_intent") {
         lines.push(theme.bold(`Create New Agent: "${this.newName}" (Step 2/2)`));
         lines.push("Describe what this agent should do:");
         lines.push(...this.createIntentInput.render(width));
         return lines;
      }

      if (this.viewState === "generating") {
         lines.push(theme.fg("accent", "Generating agent definition draft with model..."));
         return lines;
      }

      if (this.viewState === "edit" && this.editDef) {
         lines.push(theme.bold(`Editing Agent: ${this.editDef.name}`));
         if (this.editError) lines.push(theme.fg("error", `Error: ${this.editError}`));
         lines.push("");

         const frontmatterLines: string[] = [];
         const fieldDefs = [
            { label: "Display Name", val: this.editDef.display_name ?? "(none)" },
            { label: "Description", val: this.editDef.description || "" },
            { label: "Guidance", val: this.editDef.guidance ?? "" },
            { label: "Model", val: this.editDef.model ?? "(inherit parent)" },
            { label: "Thinking", val: this.editDef.thinking ?? "(inherit parent)" },
            {
               label: "Tools",
               val:
                  formatToolsSummary(this.editDef.tools) + (this.editDef.harness === "agy" ? " (ignored for agy)" : "")
            },
            { label: "Harness", val: this.editDef.harness }
         ];

         for (let i = 0; i < fieldDefs.length; i++) {
            const isSelected = i === this.editFieldIndex;
            const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";
            const field = fieldDefs[i];

            if (i === 1 || i === 2) {
               const wrapped = renderWrappedFieldLines({
                  label: field.label,
                  val: field.val,
                  isSelected,
                  isEditingText: isSelected && this.isEditingText,
                  width,
                  theme,
                  textInputLines: isSelected && this.isEditingText ? this.textInput.render(width) : undefined,
                  maxWrappedLines: 4
               });
               frontmatterLines.push(...wrapped);
            } else {
               const labelStr = isSelected
                  ? theme.fg("accent", theme.bold(field.label))
                  : theme.fg("text", field.label);
               const valStr = theme.fg("muted", field.val);

               if (isSelected && this.isEditingText) {
                  frontmatterLines.push(`${cursor}${labelStr}: Editing ->`);
                  frontmatterLines.push(...this.textInput.render(width));
               } else {
                  frontmatterLines.push(`${cursor}${labelStr}: ${valStr}`);
               }
            }
         }

         lines.push(...frontmatterLines);

         // Render separator line & system prompt body
         lines.push("");
         lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
         lines.push("");

         const isBodySelected = this.editFieldIndex === 7;
         const bodyCursor = isBodySelected ? theme.fg("accent", "❯ ") : "  ";
         const bodyLabel = isBodySelected
            ? theme.fg(
                 "accent",
                 theme.bold(
                    "System Prompt" +
                       (this.isEditingBody ? " (Editing - Enter for newline, Esc to stop, Ctrl+S to save)" : "")
                 )
              )
            : theme.fg("text", "System Prompt");

         lines.push(`${bodyCursor}${bodyLabel}`);
         lines.push("");

         const rawBody = this.editDef.body;
         if (!rawBody.trim()) {
            lines.push(theme.fg("error", "(EMPTY)"));
         } else {
            const wrappedLines = wrapTextWithAnsi(rawBody, width);
            const termRows = this.tui.terminal.rows || 30;
            const units = SUBAGENTS_HELP_UNITS;
            const wrappedHelp = wrapHelpUnits(units, width);
            const footerLinesCount = 2 + wrappedHelp.length;
            const frontmatterCount = frontmatterLines.length;
            const nonBodyFixedRows = 3 + (this.editError ? 4 : 3) + frontmatterCount + 3 + 2 + footerLinesCount;
            const viewportHeight = Math.max(5, termRows - nonBodyFixedRows);

            const { visible, above, below } = visibleBodyWindow(wrappedLines, this.bodyScrollOffset, viewportHeight);

            if (above > 0) {
               lines.push(theme.fg("dim", `  ↑ ${above} line${above === 1 ? "" : "s"} above`));
            }
            const renderedBodyLines = renderBodyLines(
               rawBody,
               width,
               this.bodyScrollOffset,
               viewportHeight,
               this.isEditingBody,
               this.bodyEditor.getCursorIndex(),
               theme
            );
            for (const line of renderedBodyLines) {
               lines.push(`  ${line}`);
            }
            if (below > 0) {
               lines.push(theme.fg("dim", `  ↓ ${below} line${below === 1 ? "" : "s"} below`));
            }
         }

         return lines;
      }

      // List View
      if (this.statusMessage) {
         lines.push(theme.fg("accent", this.statusMessage));
         lines.push("");
      }

      if (this.agents.length === 0) {
         lines.push(theme.fg("muted", "No agent definitions found in ~/.pi/agent/agents/"));
         lines.push("Press 'n' to create your first subagent definition.");
         return lines;
      }

      const listRows: string[] = [];
      for (let i = 0; i < this.agents.length; i++) {
         const isSelected = i === this.selectedListIndex;
         const agent = this.agents[i];
         const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";
         const enabledStr = agent.enabled ? theme.fg("success", "[ON]") : theme.fg("error", "[OFF]");
         const tagStyled = styleAgentListTag(agent, theme);
         const tagStr = tagStyled ? tagStyled + " " : "";
         const nameStr = isSelected ? theme.bold(agent.name) : agent.name;
         const harnessStr = theme.fg("dim", `(${agent.harness})`);

         // Row: cursor + enabled + name + optional tags + harness (no description)
         listRows.push(`${cursor}${enabledStr} ${nameStr} ${tagStr}${harnessStr}`);
      }

      const selectedAgent = this.agents[this.selectedListIndex];
      const descPanel = selectedAgent ? renderAgentDescriptionPanel(selectedAgent.description, width, theme, 4) : [];
      let panelBlock = descPanel.length > 0 ? ["", ...descPanel] : [];

      // Content only (no header). Pin description panel at bottom of content area.
      // contentBudget matches assembleManagerFrame middle: termRows - 1 - header(3) - footer.
      const termRows = this.tui.terminal.rows || 30;
      const wrappedHelp = wrapHelpUnits(SUBAGENTS_HELP_UNITS, width);
      const footerLinesCount = 2 + wrappedHelp.length;
      const contentBudget = computeManagerContentBudget(termRows, footerLinesCount);

      // Shrink list rows first; if panel alone is still too tall, keep panel head (label/desc start).
      if (panelBlock.length > contentBudget) {
         panelBlock = panelBlock.slice(0, contentBudget);
      }

      const topLines = [...lines, ...listRows];
      const listArea = Math.max(0, contentBudget - panelBlock.length);
      const listSlice = topLines.slice(0, listArea);
      const padCount = Math.max(0, listArea - listSlice.length);
      const result = [...listSlice];
      for (let i = 0; i < padCount; i++) {
         result.push("");
      }
      result.push(...panelBlock);
      // Exact contentBudget so outer assembleManagerFrame only pads/truncates content middle.
      while (result.length < contentBudget) {
         result.push("");
      }
      return result.slice(0, contentBudget);
   }

   private renderVibeTab(width: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];

      if (this.viewState === "select_vibe_tools") {
         this.selectorFilterInput.invalidate();
         const availableTools = this.getAvailableTools();
         const query = this.selectorFilterInput.getValue();
         const filteredTools = filterSelectableTools(availableTools, query);
         const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
         const harness = profile.harness;

         const title = `Select Tools (Vibe Profile: ${this.vibeSelectedProfile})`;
         const harnessNote = harness === "agy" ? " · Note: tools are ignored for agy harness" : "";

         lines.push(truncateToWidth(theme.bold(title), width, ""));
         lines.push(truncateToWidth(theme.fg("dim", `Harness: ${harness}${harnessNote}`), width, ""));
         lines.push("");

         const filterLine = "Filter: " + (this.selectorFilterInput.render(Math.max(1, width - 8))[0] ?? "");
         lines.push(truncateToWidth(filterLine, width, ""));
         lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

         const termRows = this.tui.terminal.rows || 30;
         const { contentBudget, listBudget } = computeSelectorViewport(
            termRows,
            width,
            SELECT_TOOLS_HELP_UNITS,
            filteredTools.length,
            this.selectorScrollOffset,
            this.selectorSelectedIndex
         );

         if (filteredTools.length === 0) {
            lines.push(theme.fg("muted", "  No matching tools found."));
         } else {
            const blocks = filteredTools.map((tool, idx) =>
               renderToolOptionBlock(tool, {
                  selected: idx === this.selectorSelectedIndex,
                  checked: this.tempSelectedTools.includes(tool.name),
                  width,
                  theme
               })
            );
            const heights = blocks.map((b) => b.length);

            const win = computeMultiLineVisibleWindow(
               heights,
               listBudget,
               this.selectorScrollOffset,
               this.selectorSelectedIndex
            );
            this.selectorScrollOffset = win.startIndex;

            if (win.aboveCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↑ ${win.aboveCount} item${win.aboveCount === 1 ? "" : "s"} above`),
                     width,
                     ""
                  )
               );
            }
            for (let idx = win.startIndex; idx < win.endIndex; idx++) {
               const block = blocks[idx];
               for (const line of block) {
                  lines.push(padLineToWidth(line, width));
               }
            }
            if (win.belowCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↓ ${win.belowCount} item${win.belowCount === 1 ? "" : "s"} below`),
                     width,
                     ""
                  )
               );
            }
         }

         while (lines.length < contentBudget) {
            lines.push("");
         }
         if (lines.length > contentBudget) {
            lines.splice(contentBudget);
         }

         return lines;
      }

      if (this.viewState === "select_vibe_model" || this.viewState === "select_vibe_thinking") {
         this.selectorFilterInput.invalidate();
         const isModel = this.viewState === "select_vibe_model";
         const type = isModel ? "model" : "thinking";
         const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
         const harness = profile.harness;
         let currentVal = "";
         if (isModel) {
            currentVal = (harness === "pi" ? profile.pi.model : profile.agy.model) ?? "";
         } else {
            currentVal = (harness === "pi" ? profile.pi.reasoning_effort : profile.agy.reasoning_effort) ?? "";
         }
         const baseOpts = getBaseSelectorOptions(type, harness, this.ctx.modelRegistry);
         const query = this.selectorFilterInput.getValue();
         const options = filterSelectorOptions(baseOpts, query);

         const title = isModel
            ? `Select Model (Vibe: ${this.vibeSelectedProfile})`
            : `Select Reasoning Effort (Vibe: ${this.vibeSelectedProfile})`;

         lines.push(truncateToWidth(theme.bold(title), width, ""));
         lines.push(
            truncateToWidth(
               theme.fg(
                  "dim",
                  `Harness: ${harness} · Current: ${currentVal || (isModel ? "(inherit / default)" : "(inherit / low)")}`
               ),
               width,
               ""
            )
         );
         lines.push("");

         const filterLine = "Filter: " + (this.selectorFilterInput.render(Math.max(1, width - 8))[0] ?? "");
         lines.push(truncateToWidth(filterLine, width, ""));
         lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

         const termRows = this.tui.terminal.rows || 30;
         const { contentBudget, listBudget } = computeSelectorViewport(
            termRows,
            width,
            SELECT_TOOLS_HELP_UNITS,
            options.length,
            this.selectorScrollOffset,
            this.selectorSelectedIndex
         );

         if (options.length === 0) {
            lines.push(theme.fg("muted", "  No matching options found."));
         } else {
            const blocks = options.map((opt, idx) =>
               renderSelectorOptionBlock(opt, {
                  selected: idx === this.selectorSelectedIndex,
                  current: opt.value === currentVal,
                  width,
                  theme
               })
            );
            const heights = blocks.map((b) => b.length);

            const win = computeMultiLineVisibleWindow(
               heights,
               listBudget,
               this.selectorScrollOffset,
               this.selectorSelectedIndex
            );
            this.selectorScrollOffset = win.startIndex;

            if (win.aboveCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↑ ${win.aboveCount} item${win.aboveCount === 1 ? "" : "s"} above`),
                     width,
                     ""
                  )
               );
            }
            for (let idx = win.startIndex; idx < win.endIndex; idx++) {
               const block = blocks[idx];
               for (const line of block) {
                  lines.push(padLineToWidth(line, width));
               }
            }
            if (win.belowCount > 0) {
               lines.push(
                  truncateToWidth(
                     theme.fg("dim", `  ↓ ${win.belowCount} item${win.belowCount === 1 ? "" : "s"} below`),
                     width,
                     ""
                  )
               );
            }
         }

         while (lines.length < contentBudget) {
            lines.push("");
         }
         if (lines.length > contentBudget) {
            lines.splice(contentBudget);
         }

         return lines;
      }

      lines.push(theme.bold("Vibe Profiles (agents.json)"));
      lines.push(theme.fg("dim", "Configure worker profiles used by vibe_spawn (fast/good)."));
      lines.push("");

      if (this.vibeStatusMessage) {
         lines.push(theme.fg("accent", this.vibeStatusMessage));
         lines.push("");
      }

      // Profile selector
      const fastTitle =
         this.vibeSelectedProfile === "fast"
            ? theme.fg("accent", theme.bold("▶ [ fast ]"))
            : theme.fg("dim", "  [ fast ]");
      const goodTitle =
         this.vibeSelectedProfile === "good"
            ? theme.fg("accent", theme.bold("▶ [ good ]"))
            : theme.fg("dim", "  [ good ]");
      lines.push(`${fastTitle}     ${goodTitle}`);
      lines.push("");

      const profile = this.vibeConfig.profiles[this.vibeSelectedProfile];
      const harness = profile.harness;

      const currentTools = harness === "pi" ? (profile.pi.tools ?? profile.tools) : undefined;
      const currentBody = harness === "pi" ? (profile.pi.body ?? profile.body) : (profile.agy.body ?? profile.body);

      const fields = [
         {
            label: "Harness",
            val: harness
         },
         {
            label: "Model",
            val: (harness === "pi" ? profile.pi.model : profile.agy.model) ?? "(inherit / default)"
         },
         {
            label: "Reasoning Effort",
            val: (harness === "pi" ? profile.pi.reasoning_effort : profile.agy.reasoning_effort) ?? "(inherit / low)"
         },
         {
            label: "Tools",
            val: formatToolsSummary(currentTools) + (harness === "agy" ? " (ignored for agy)" : "")
         },
         {
            label: "System Prompt",
            val: currentBody ? `${currentBody.split("\n")[0].slice(0, 40)}...` : "(none / default)"
         }
      ];

      for (let i = 0; i < fields.length; i++) {
         const isSelected = i === this.vibeFieldIndex;
         const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";
         const field = fields[i];
         const labelStr = isSelected ? theme.fg("accent", theme.bold(field.label)) : theme.fg("text", field.label);
         const valStr = theme.fg("muted", String(field.val));

         if (isSelected && this.isEditingVibeText) {
            lines.push(`${cursor}${labelStr}: Editing ->`);
            lines.push(...this.vibeTextInput.render(width));
         } else {
            lines.push(`${cursor}${labelStr}: ${valStr}`);
         }
      }

      return lines;
   }

   invalidate(): void {
      this.textInput.invalidate();
      this.createNameInput.invalidate();
      this.createIntentInput.invalidate();
      this.vibeTextInput.invalidate();
      this.selectorFilterInput.invalidate();
   }
}
