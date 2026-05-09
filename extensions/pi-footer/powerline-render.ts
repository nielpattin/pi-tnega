import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ColorScheme, SegmentContext } from "./types";
import type { PowerlineConfig } from "./powerline-config";
import { collectHiddenExtensionStatusKeys, getNotificationExtensionStatuses } from "./powerline-config";
import { DEFAULT_POWERLINE_LAYOUT } from "./helpers";
import { getGitStatus } from "./git-status";
import { readCoreContextUsage } from "./context-usage.ts";
import { getDefaultColors } from "./theme";
import { ansi, getFgAnsiCode } from "./colors";
import {
   getUsageTokenTotal,
   isRecord,
   isSessionAssistantMessage,
   computeResponsiveLayout,
   type SessionAssistantUsage,
   STREAMING_LAYOUT_CACHE_TTL_MS,
   LAYOUT_CACHE_TTL_MS,
   EDITOR_STATUS_DEFER_MS,
   CUSTOM_COMPACTION_STATUS_KEY,
} from "./helpers";

// ═══════════════════════════════════════════════════════════════════════════
// Skill Counts
// ═══════════════════════════════════════════════════════════════════════════

let cachedSkillCountCwd: string | null = null;
let cachedSkillCount = 0;

function collectSkillFiles(dir: string, files: Set<string>): void {
   if (!existsSync(dir)) return;
   let entries;
   try {
      entries = readdirSync(dir, { withFileTypes: true });
   } catch {
      return;
   }

   for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
         collectSkillFiles(entryPath, files);
         continue;
      }
      if (entry.name !== "SKILL.md") continue;
      try {
         files.add(realpathSync(entryPath));
      } catch {
         files.add(entryPath);
      }
   }
}

function countDiscoveredSkills(cwd: string): number {
   if (cachedSkillCountCwd === cwd) return cachedSkillCount;

   const roots = [
      resolve(cwd, "skills"),
      join(homedir(), ".pi", "agent", "skills"),
      join(homedir(), ".agents", "skills"),
   ];
   const files = new Set<string>();
   for (const root of roots) {
      try {
         if (!existsSync(root) || !statSync(root).isDirectory()) continue;
         collectSkillFiles(root, files);
      } catch {
         // Ignore unreadable skill roots.
      }
   }

   cachedSkillCountCwd = cwd;
   cachedSkillCount = files.size;
   return cachedSkillCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// Layout Cache
// ═══════════════════════════════════════════════════════════════════════════

export interface LayoutCache {
   lastLayoutWidth: number;
   lastLayoutResult: {
      pathContent: string;
      topContent: string;
      extensionContent: string;
      secondaryContent: string;
   } | null;
   lastLayoutTimestamp: number;
   layoutDirty: boolean;
   forceNextLayoutRecompute: boolean;
}

export function createLayoutCache(): LayoutCache {
   return {
      lastLayoutWidth: 0,
      lastLayoutResult: null,
      lastLayoutTimestamp: 0,
      layoutDirty: true,
      forceNextLayoutRecompute: false,
   };
}

// ═══════════════════════════════════════════════════════════════════════════
// Render Dependencies
// ═══════════════════════════════════════════════════════════════════════════

export interface RenderDeps {
   config: PowerlineConfig;
   currentCtx: any;
   footerDataRef: ReadonlyFooterDataProvider | null;
   isStreaming: boolean;
   liveAssistantUsage: SessionAssistantUsage | null;
   bashModeActive: boolean;
   bashTranscript: {
      getSnapshot(): {
         commands: Array<{ command: string; exitCode: number | null; output: string[] }>;
         truncatedCommands: number;
      };
   };
   shellSession: { state: { running: boolean; shellName: string; cwd: string } } | null;
   transcriptScrollState: { offset: number; maxScroll: number; totalLines: number; prevCommandCount: number };
   showLastPrompt: boolean;
   lastUserPrompt: string;
   customCompactionEnabled: boolean;
   sessionStartTime: number;
   currentThinkingLevel: string | null;
   getThinkingLevelFn: (() => string) | null;
   lastEditorInputAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Render Functions Factory
// ═══════════════════════════════════════════════════════════════════════════

export function createRenderFunctions(deps: RenderDeps, cache: LayoutCache) {
   function buildSegmentContext(ctx: any, theme: Theme): SegmentContext {
      const layoutDef = DEFAULT_POWERLINE_LAYOUT;
      const colors: ColorScheme = layoutDef.colors ?? getDefaultColors();

      let input = 0,
         output = 0,
         cacheRead = 0,
         cacheWrite = 0,
         cost = 0;
      let lastAssistant: AssistantMessage | undefined;
      let thinkingLevelFromSession: string | null = null;

      const systemPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
      const availableSkillMatches =
         systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0].match(/<skill>/g) ?? [];
      const skillsActive = availableSkillMatches.length;
      const skillsTotal = Math.max(countDiscoveredSkills(ctx.cwd ?? process.cwd()), skillsActive);

      const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
      for (const e of sessionEvents) {
         if (!isRecord(e)) continue;
         if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
            thinkingLevelFromSession = e.thinkingLevel;
         }
         if (e.type !== "message" || !isSessionAssistantMessage(e.message)) continue;
         const m = e.message;
         if (m.stopReason === "error" || m.stopReason === "aborted") continue;
         input += m.usage.input;
         output += m.usage.output;
         cacheRead += m.usage.cacheRead;
         cacheWrite += m.usage.cacheWrite;
         cost += m.usage.cost.total;
         if (getUsageTokenTotal(m.usage) > 0) lastAssistant = m;
      }

      const latestUsage = deps.isStreaming ? (deps.liveAssistantUsage ?? lastAssistant?.usage) : lastAssistant?.usage;
      const coreContextUsage = deps.isStreaming && deps.liveAssistantUsage ? null : readCoreContextUsage(ctx);
      const contextTokens = coreContextUsage?.contextTokens ?? (latestUsage ? getUsageTokenTotal(latestUsage) : 0);
      const contextWindow = coreContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const contextPercent =
         coreContextUsage?.contextPercent ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);
      const availableProviderCount = Array.isArray(ctx.modelRegistry?.getAvailableProviders?.())
         ? ctx.modelRegistry.getAvailableProviders().length
         : 0;

      const gitBranch = deps.footerDataRef?.getGitBranch() ?? null;
      const gitStatus = getGitStatus(gitBranch);
      const extensionStatuses = deps.footerDataRef?.getExtensionStatuses() ?? new Map();
      const customItemsById = new Map(deps.config.customItems.map((item) => [item.id, item]));
      const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(deps.config.customItems);

      const usingSubscription = ctx.model ? (ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false) : false;

      const thinkingLevel =
         deps.currentThinkingLevel ?? thinkingLevelFromSession ?? deps.getThinkingLevelFn?.() ?? "off";

      return {
         model: ctx.model,
         thinkingLevel,
         sessionId: ctx.sessionManager?.getSessionId?.(),
         usageStats: { input, output, cacheRead, cacheWrite, cost },
         contextPercent,
         contextWindow,
         contextUsed: contextTokens,
         autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
         customCompactionEnabled: deps.customCompactionEnabled || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
         usingSubscription,
         sessionStartTime: deps.sessionStartTime,
         shellModeActive: deps.bashModeActive,
         shellRunning: deps.shellSession?.state.running ?? false,
         shellName: deps.shellSession?.state.shellName ?? null,
         shellCwd: deps.shellSession?.state.cwd ?? null,
         git: gitStatus,
         availableProviderCount,
         skillsActive,
         skillsTotal,
         extensionStatuses,
         hiddenExtensionStatusKeys,
         customItemsById,
         options: layoutDef.segmentOptions ?? {},
         theme,
         colors,
      };
   }

   function getResponsiveLayout(
      width: number,
      theme: Theme,
   ): { pathContent: string; topContent: string; extensionContent: string; secondaryContent: string } {
      const now = Date.now();
      const cacheTtl = deps.isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

      if (cache.lastLayoutResult && cache.lastLayoutWidth === width) {
         const msSinceInput = now - deps.lastEditorInputAt;
         const typingRecently = msSinceInput < EDITOR_STATUS_DEFER_MS;

         if (
            !cache.forceNextLayoutRecompute &&
            typingRecently &&
            (cache.layoutDirty || now - cache.lastLayoutTimestamp >= cacheTtl)
         ) {
            return cache.lastLayoutResult;
         }
         if (!cache.layoutDirty && now - cache.lastLayoutTimestamp < cacheTtl) {
            return cache.lastLayoutResult;
         }
      }

      const layoutDef = DEFAULT_POWERLINE_LAYOUT;
      const segmentCtx = buildSegmentContext(deps.currentCtx, theme);

      cache.lastLayoutWidth = width;
      cache.lastLayoutResult = computeResponsiveLayout(segmentCtx, layoutDef, width, deps.config.customItems);
      cache.lastLayoutTimestamp = now;
      cache.layoutDirty = false;
      cache.forceNextLayoutRecompute = false;

      return cache.lastLayoutResult;
   }

   function renderPowerlineStatusLines(width: number): string[] {
      if (!deps.currentCtx || !deps.footerDataRef) return [];
      const statuses = deps.footerDataRef.getExtensionStatuses();
      if (!statuses || statuses.size === 0) return [];
      const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(deps.config.customItems);
      const notifications: string[] = [];
      for (const value of getNotificationExtensionStatuses(statuses, hiddenExtensionStatusKeys)) {
         const lineContent = ` ${value}`;
         if (visibleWidth(lineContent) <= width) notifications.push(lineContent);
      }
      return notifications;
   }

   function renderPowerlinePathLines(width: number, theme: Theme): string[] {
      if (!deps.currentCtx) return [];
      const layout = getResponsiveLayout(width, theme);
      return layout.pathContent ? [layout.pathContent] : [];
   }

   function renderPowerlineTopLines(width: number, theme: Theme): string[] {
      if (!deps.currentCtx) return [];
      const layout = getResponsiveLayout(width, theme);
      return layout.topContent ? [layout.topContent] : [];
   }

   function renderPowerlineExtensionLines(width: number, theme: Theme): string[] {
      if (!deps.currentCtx) return [];
      const layout = getResponsiveLayout(width, theme);
      return layout.extensionContent ? [layout.extensionContent] : [];
   }

   function renderPowerlineSecondaryLines(width: number, theme: Theme): string[] {
      if (!deps.currentCtx) return [];
      const layout = getResponsiveLayout(width, theme);
      return layout.secondaryContent ? [layout.secondaryContent] : [];
   }

   const MAX_TRANSCRIPT_LINES = 200;

   function renderBashTranscriptLines(width: number, theme: Theme): string[] {
      if (!deps.bashModeActive) return [];
      const snapshot = deps.bashTranscript.getSnapshot();
      if (snapshot.commands.length === 0) return [];

      // Build all lines (no cap)
      const allLines: string[] = [];
      if (snapshot.truncatedCommands > 0) {
         allLines.push(
            ` ${theme.fg("dim", `… ${snapshot.truncatedCommands} earlier command${snapshot.truncatedCommands === 1 ? "" : "s"} truncated`)}`,
         );
      }

      for (const command of snapshot.commands) {
         const promptGlyph = (deps.shellSession?.state.shellName ?? "shell") === "fish" ? ">" : "$";
         const status =
            command.exitCode === null
               ? theme.fg("accent", "running")
               : command.exitCode === 0
                 ? theme.fg("success", "ok")
                 : theme.fg("error", `exit ${command.exitCode}`);
         const commandLine = truncateToWidth(command.command.replace(/\s+/g, " ").trim(), Math.max(8, width - 8), "…");
         allLines.push(
            ` ${theme.fg("accent", promptGlyph)} ${commandLine} ${theme.fg("dim", "(")}${status}${theme.fg("dim", ")")}`,
         );
         const outputTail = command.output;
         for (const outputLine of outputTail) {
            allLines.push(`   ${truncateToWidth(outputLine, Math.max(1, width - 3), "…")}`);
         }
      }

      const totalLines = allLines.length;
      const scrollState = deps.transcriptScrollState;

      // Follow-tail: when new commands arrive while scrolled back, keep viewing same content.
      if (snapshot.commands.length !== scrollState.prevCommandCount) {
         if (scrollState.offset > 0) {
            scrollState.offset += totalLines - scrollState.totalLines;
         }
         scrollState.prevCommandCount = snapshot.commands.length;
         scrollState.totalLines = totalLines;
      }

      // Clamp offset and update maxScroll for the compositor.
      scrollState.maxScroll = Math.max(0, totalLines - 1);
      scrollState.offset = Math.max(0, Math.min(scrollState.offset, scrollState.maxScroll));

      // Visible window: offset=0 shows newest lines at the bottom.
      const end = totalLines - scrollState.offset;
      const start = Math.max(0, end - MAX_TRANSCRIPT_LINES);
      return allLines.slice(start, end);
   }

   function renderLastPromptLines(width: number): string[] {
      if (deps.bashModeActive || !deps.showLastPrompt || !deps.lastUserPrompt) return [];
      const prefix = ` ${getFgAnsiCode("sep")}↳${ansi.reset} `;
      const availableWidth = width - visibleWidth(prefix);
      if (availableWidth < 10) return [];
      let promptText = deps.lastUserPrompt.replace(/\s+/g, " ").trim();
      if (!promptText) return [];
      promptText = truncateToWidth(promptText, availableWidth, "…");
      const styledPrompt = `${getFgAnsiCode("sep")}${promptText}${ansi.reset}`;
      const line = `${prefix}${styledPrompt}`;
      return [truncateToWidth(line, width, "…")];
   }

   function resetRenderCache() {
      cache.lastLayoutResult = null;
      cache.layoutDirty = true;
   }

   return {
      buildSegmentContext,
      getResponsiveLayout,
      renderPowerlineStatusLines,
      renderPowerlinePathLines,
      renderPowerlineTopLines,
      renderPowerlineExtensionLines,
      renderPowerlineSecondaryLines,
      renderBashTranscriptLines,
      renderLastPromptLines,
      resetRenderCache,
   };
}

export type RenderFunctions = ReturnType<typeof createRenderFunctions>;
