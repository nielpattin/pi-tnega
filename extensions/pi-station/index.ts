import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SelectList, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AutocompleteProvider, SelectItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StationBarState } from "./features/state/index.ts";
import {
   STASH_PREVIEW_WIDTH,
   buildStashPreview,
   persistStashHistory,
   pushStashHistory,
   readPersistedStashHistory
} from "./features/stash/index.ts";
import { homedir } from "node:os";
import type { ColorScheme, SegmentContext } from "./types.ts";
import type { StationConfig } from "./station-config.ts";
import {
   BashAutocompleteProvider,
   ModeAwareAutocompleteProvider,
   OneOffBashAutocompleteProvider,
   getOneOffBashCommandContext
} from "./features/bash-mode/completion.ts";
import { BashModeEditor } from "./features/bash-mode/editor.ts";
import { registerHashline } from "./features/hashline/register.ts";
import { BashModeIntegration } from "./features/bash-integration/index.ts";
import type { BashModeSettings } from "./features/bash-mode/types.ts";
import { DEFAULT_LAYOUT } from "./default-layout.ts";
import {
   collectHiddenExtensionStatusKeys,
   getNotificationExtensionStatuses,
   parseStationConfig
} from "./station-config.ts";
import { computeResponsiveLayout } from "./features/layout/index.ts";
import { getGitStatus, invalidateGitBranch, invalidateGitStatus } from "./git-status.ts";
import { ansi, getFgAnsiCode } from "./colors.ts";
import { createRenderScheduler } from "./render-scheduler.ts";
import { readCoreContextUsage } from "./context-usage.ts";
import { renderFixedEditorCluster } from "./features/fixed-editor/cluster.ts";
import { TerminalSplitCompositor, emergencyTerminalModeReset } from "./features/fixed-editor/terminal-split.ts";
import { getDefaultColors } from "./theme.ts";
import { DEFAULT_STATION_SHORTCUTS } from "./features/shortcut-manager/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

let config: StationConfig = {
   customItems: [],
   fixedEditor: true,
   scrollBar: true,
   hashline: true,
   shortcuts: { ...DEFAULT_STATION_SHORTCUTS }
};

const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";
let customCompactionEnabled = false;

const PROJECT_PROMPT_HISTORY_LIMIT = 50;
const PROMPT_HISTORY_LIMIT = 100;
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const CONTEXT_STATUS_RENDER_MS = 250;
const EDITOR_STATUS_DEFER_MS = 150;
const PROMPT_HISTORY_TRACKED = Symbol.for("stationPromptHistoryTracked");
const PROMPT_HISTORY_STATE_KEY = Symbol.for("stationPromptHistoryState");

interface PromptHistoryState {
   savedPromptHistory: string[];
}
type SessionAssistantUsage = AssistantMessage["usage"];

function getUsageTokenTotal(usage: SessionAssistantUsage): number {
   if ("totalTokens" in usage && typeof usage.totalTokens === "number") {
      return usage.totalTokens;
   }
   return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function hasSessionAssistantUsage(value: unknown): value is SessionAssistantUsage {
   if (!isRecord(value)) {
      return false;
   }

   if (
      typeof value.input !== "number" ||
      typeof value.output !== "number" ||
      typeof value.cacheRead !== "number" ||
      typeof value.cacheWrite !== "number"
   ) {
      return false;
   }

   return isRecord(value.cost) && typeof value.cost.total === "number";
}

function isSessionAssistantMessage(value: unknown): value is AssistantMessage {
   return (
      isRecord(value) &&
      value.role === "assistant" &&
      hasSessionAssistantUsage(value.usage) &&
      (value.stopReason === undefined || typeof value.stopReason === "string")
   );
}

function isPromptHistoryState(value: unknown): value is PromptHistoryState {
   return (
      isRecord(value) &&
      Array.isArray(value.savedPromptHistory) &&
      value.savedPromptHistory.every((entry) => typeof entry === "string")
   );
}

function getPromptHistoryState(): PromptHistoryState {
   const existing = Reflect.get(globalThis, PROMPT_HISTORY_STATE_KEY);
   if (isPromptHistoryState(existing)) {
      return existing;
   }

   const state: PromptHistoryState = { savedPromptHistory: [] };
   Reflect.set(globalThis, PROMPT_HISTORY_STATE_KEY, state);
   return state;
}

function readPromptHistory(editor: any): string[] {
   const history = editor?.history;
   if (!Array.isArray(history)) {
      return [];
   }

   const normalized: string[] = [];
   for (const entry of history) {
      if (typeof entry !== "string") {
         continue;
      }
      const trimmed = entry.trim();
      if (!trimmed) {
         continue;
      }
      if (normalized.length > 0 && normalized[normalized.length - 1] === trimmed) {
         continue;
      }
      normalized.push(trimmed);
      if (normalized.length >= PROMPT_HISTORY_LIMIT) {
         break;
      }
   }

   return normalized;
}

function snapshotPromptHistory(editor: any): void {
   const history = readPromptHistory(editor);
   if (history.length > 0) {
      getPromptHistoryState().savedPromptHistory = [...history];
   }
}

function restorePromptHistory(editor: any): void {
   const { savedPromptHistory } = getPromptHistoryState();
   if (!savedPromptHistory.length || typeof editor?.addToHistory !== "function") {
      return;
   }

   for (let i = savedPromptHistory.length - 1; i >= 0; i--) {
      editor.addToHistory(savedPromptHistory[i]);
   }
}

function trackPromptHistory(editor: any): void {
   if (!editor || typeof editor.addToHistory !== "function") {
      return;
   }
   if (editor[PROMPT_HISTORY_TRACKED]) {
      snapshotPromptHistory(editor);
      return;
   }

   const originalAddToHistory = editor.addToHistory.bind(editor);
   editor.addToHistory = (text: string) => {
      originalAddToHistory(text);
      snapshotPromptHistory(editor);
   };
   editor[PROMPT_HISTORY_TRACKED] = true;
   snapshotPromptHistory(editor);
}

function getHomeDir(): string {
   return process.env.HOME || process.env.USERPROFILE || homedir();
}

function getSettingsPath(): string {
   return join(getHomeDir(), ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
   return join(cwd, ".pi", "settings.json");
}

function getGlobalCompactionPolicyPath(): string {
   return join(getHomeDir(), ".pi", "agent", "compaction-policy.json");
}

function getCustomCompactionExtensionPath(): string {
   return join(getHomeDir(), ".pi", "agent", "extensions", "pi-custom-compaction");
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
   const merged: Record<string, unknown> = { ...base };

   for (const [key, overrideValue] of Object.entries(override)) {
      const baseValue = merged[key];
      merged[key] =
         isRecord(baseValue) && isRecord(overrideValue) ? mergeSettings(baseValue, overrideValue) : overrideValue;
   }

   return merged;
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
   try {
      if (!existsSync(settingsPath)) {
         return {};
      }

      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (!isRecord(parsed)) {
         console.debug(`[station-bar] Ignoring non-object settings at ${settingsPath}`);
         return {};
      }

      return parsed;
   } catch (error) {
      // Settings are user-edited input. Log and keep the extension running with defaults
      // Instead of crashing the UI during startup.
      console.debug(`[station-bar] Failed to read settings from ${settingsPath}:`, error);
      return {};
   }
}

function readWritableSettingsFile(settingsPath: string): Record<string, unknown> | null {
   if (!existsSync(settingsPath)) {
      return {};
   }

   try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (!isRecord(parsed)) {
         console.debug(`[station-bar] Refusing to write settings to non-object file at ${settingsPath}`);
         return null;
      }
      return parsed;
   } catch (error) {
      console.debug(`[station-bar] Failed to parse settings at ${settingsPath}:`, error);
      return null;
   }
}

function readCompactionPolicyEnabled(configPath: string): boolean | undefined {
   if (!existsSync(configPath)) {
      return undefined;
   }
   try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") {
         return false;
      }
      return parsed.enabled;
   } catch (error) {
      console.debug(`[station-bar] Failed to read compaction policy from ${configPath}:`, error);
      return false;
   }
}

function detectCustomCompactionEnabled(cwd: string): boolean {
   if (!existsSync(getCustomCompactionExtensionPath())) {
      return false;
   }

   const projectSetting = readCompactionPolicyEnabled(join(cwd, ".pi", "compaction-policy.json"));
   if (projectSetting !== undefined) {
      return projectSetting;
   }

   return readCompactionPolicyEnabled(getGlobalCompactionPolicyPath()) ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSessionsPath(): string {
   return join(getHomeDir(), ".pi", "agent", "sessions");
}

function getProjectSessionsPath(cwd: string): string {
   const projectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");

   return join(getSessionsPath(), `--${projectKey}--`);
}

function getPromptHistoryText(content: unknown): string {
   if (typeof content === "string") {
      return content.replace(/\s+/g, " ").trim();
   }

   if (!Array.isArray(content)) {
      return "";
   }

   const parts: string[] = [];
   for (const block of content) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
         continue;
      }
      parts.push(block.text);
   }

   return parts.join("\n").replace(/\s+/g, " ").trim();
}

function readRecentProjectPrompts(cwd: string, limit: number): string[] {
   const sessionsPath = getProjectSessionsPath(cwd);
   if (!existsSync(sessionsPath)) {
      return [];
   }

   const promptEntries: { text: string; timestamp: number }[] = [];
   const fileNames = readdirSync(sessionsPath).filter((fileName) => fileName.endsWith(".jsonl"));

   for (const fileName of fileNames) {
      const filePath = join(sessionsPath, fileName);
      const lines = readFileSync(filePath, "utf8").split("\n");

      for (let i = lines.length - 1; i >= 0; i--) {
         const line = lines[i];
         if (!line || !line.includes('"type":"message"') || !line.includes('"role":"user"')) {
            continue;
         }

         let entry: unknown;
         try {
            entry = JSON.parse(line);
         } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse session file ${filePath}: ${message}`, { cause: error });
         }

         if (
            !isRecord(entry) ||
            entry.type !== "message" ||
            !isRecord(entry.message) ||
            entry.message.role !== "user"
         ) {
            continue;
         }

         const text = getPromptHistoryText(entry.message.content);
         if (!hasNonWhitespaceText(text)) {
            continue;
         }

         const timestamp =
            typeof entry.message.timestamp === "number"
               ? entry.message.timestamp
               : typeof entry.timestamp === "string"
                 ? Date.parse(entry.timestamp)
                 : 0;

         promptEntries.push({ text, timestamp: Number.isFinite(timestamp) ? timestamp : 0 });
      }
   }

   promptEntries.sort((a, b) => b.timestamp - a.timestamp);

   const prompts: string[] = [];
   const seen = new Set<string>();
   for (const entry of promptEntries) {
      if (seen.has(entry.text)) {
         continue;
      }

      seen.add(entry.text);
      prompts.push(entry.text);
      if (prompts.length >= limit) {
         return prompts;
      }
   }

   return prompts;
}

function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
   return mergeSettings(readSettingsFile(getSettingsPath()), readSettingsFile(getProjectSettingsPath(cwd)));
}

function readCompactionEnabled(): boolean {
   const settings = readSettings();
   const compaction = settings.compaction;
   if (isRecord(compaction) && typeof compaction.enabled === "boolean") {
      return compaction.enabled;
   }
   return true; // default
}

function writeStationSetting(cwd: string, update: (existingStationSetting: unknown) => unknown): boolean {
   const globalSettingsPath = getSettingsPath();
   const projectSettingsPath = getProjectSettingsPath(cwd);
   const globalSettings = readWritableSettingsFile(globalSettingsPath);
   const projectSettings = readWritableSettingsFile(projectSettingsPath);

   if (globalSettings === null || projectSettings === null) {
      return false;
   }

   const writeToProject = Object.hasOwn(projectSettings, "station");
   const settingsPath = writeToProject ? projectSettingsPath : globalSettingsPath;
   const settings = writeToProject ? projectSettings : globalSettings;

   settings["station"] = update(settings["station"]);

   try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      return true;
   } catch (error) {
      console.debug(`[station-bar] Failed to persist station setting to ${settingsPath}:`, error);
      return false;
   }
}

function writeGlobalStationSetting(update: (existingStationSetting: unknown) => unknown): boolean {
   const settingsPath = getSettingsPath();
   const settings = readWritableSettingsFile(settingsPath);
   if (settings === null) {
      return false;
   }

   settings["station"] = update(settings["station"]);

   try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      return true;
   } catch (error) {
      console.debug(`[station-bar] Failed to persist global station setting to ${settingsPath}:`, error);
      return false;
   }
}

function hasNonWhitespaceText(text: string): boolean {
   return text.trim().length > 0;
}

function getCurrentEditorText(ctx: any, editor: any): string {
   return editor?.getExpandedText?.() ?? ctx.ui.getEditorText();
}

const DEFAULT_BASH_MODE_SETTINGS: BashModeSettings = {
   transcriptMaxBytes: 512 * 1024,
   transcriptMaxLines: 2000
};

function parseBashModeSettings(settings: Record<string, unknown>): BashModeSettings {
   const raw = isRecord(settings.bashMode) ? settings.bashMode : {};

   const transcriptMaxLines =
      typeof raw.transcriptMaxLines === "number" && Number.isFinite(raw.transcriptMaxLines)
         ? Math.max(100, Math.floor(raw.transcriptMaxLines))
         : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxLines;
   const transcriptMaxBytes =
      typeof raw.transcriptMaxBytes === "number" && Number.isFinite(raw.transcriptMaxBytes)
         ? Math.max(16 * 1024, Math.floor(raw.transcriptMaxBytes))
         : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxBytes;

   return {
      transcriptMaxBytes,
      transcriptMaxLines
   };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function stationBar(pi: ExtensionAPI) {
   const startupSettings = readSettings();
   config = parseStationConfig(startupSettings["station"]);
   let bashModeSettings = parseBashModeSettings(startupSettings);

   if (config.hashline) {
      registerHashline(pi);
   }

   const state = new StationBarState(config);

   const enabled = true;
   state.sessionStartTime = Date.now();
   let currentCtx: any = null;
   let footerDataRef: ReadonlyFooterDataProvider | null = null;
   let getThinkingLevelFn: (() => string) | null = null;
   let currentThinkingLevel: string | null = null;
   state.liveAssistantUsage = null;
   state.isStreaming = false;
   let tuiRef: any = null;
   let restoreFooterStatusRepaintHook: (() => void) | null = null;
   let fixedEditorCompositor: TerminalSplitCompositor | null = null;
   let fixedStatusContainer: any = null;
   let fixedEditorContainer: any = null;
   let fixedWidgetContainerAbove: any = null;
   let fixedWidgetContainerBelow: any = null;

   let lastUserPrompt = "";
   let showLastPrompt = true;
   let stashedEditorText: string | null = null;
   let stashedPromptHistory: string[] = readPersistedStashHistory();
   let currentEditor: any = null;
   let cachedSkillsLoaded = -1;
   let cachedSkillsInstalled = -1;

   function countSkills(): { loaded: number; installed: number } {
      if (cachedSkillsInstalled >= 0 && cachedSkillsLoaded >= 0) {
         return { installed: cachedSkillsInstalled, loaded: cachedSkillsLoaded };
      }

      // Scan all skill directories (global + packages)
      const searchDirs = [join(getHomeDir(), ".pi", "agent", "skills"), join(getHomeDir(), ".agents", "skills")];
      const pkgDir = join(getHomeDir(), ".pi", "agent", "packages");
      try {
         for (const pkg of readdirSync(pkgDir, { withFileTypes: true })) {
            if (pkg.isDirectory()) {
               searchDirs.push(join(pkgDir, pkg.name, "skills"));
            }
         }
      } catch {}

      const installed = new Set<string>();
      for (const dir of searchDirs) {
         try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
               if (entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))) {
                  installed.add(entry.name);
               }
            }
         } catch {}
      }

      // Read settings to find disabled skills
      const settingsPath = join(getHomeDir(), ".pi", "agent", "settings.json");
      const settings = readSettingsFile(settingsPath);
      const disabledSkillNames = new Set<string>();

      // Top-level skills array
      const skillSettings = Array.isArray(settings.skills) ? settings.skills : [];
      for (const entry of skillSettings) {
         if (typeof entry === "string" && entry.startsWith("-")) {
            const parts = entry.slice(1).replace(/\\/g, "/").split("/");
            if (parts.length >= 2 && parts[0] === "skills") {
               disabledSkillNames.add(parts[1]);
            } else if (parts.length >= 1) {
               disabledSkillNames.add(parts[0]);
            }
         }
      }

      // Package-level skills array
      const packages = Array.isArray(settings.packages) ? settings.packages : [];
      for (const pkg of packages) {
         if (typeof pkg === "object" && pkg && Array.isArray(pkg.skills)) {
            for (const entry of pkg.skills) {
               if (typeof entry === "string" && entry.startsWith("-")) {
                  const parts = entry.slice(1).replace(/\\/g, "/").split("/");
                  if (parts.length >= 2 && parts[0] === "skills") {
                     disabledSkillNames.add(parts[1]);
                  } else if (parts.length >= 1) {
                     disabledSkillNames.add(parts[0]);
                  }
               }
            }
         }
      }

      // Loaded = installed minus disabled
      const loaded = new Set(installed);
      for (const name of disabledSkillNames) {
         loaded.delete(name);
      }

      cachedSkillsInstalled = installed.size;
      cachedSkillsLoaded = loaded.size;
      return { installed: cachedSkillsInstalled, loaded: cachedSkillsLoaded };
   }
   const bashIntegration = new BashModeIntegration(bashModeSettings, {
      getCurrentEditor: () => currentEditor,
      getCwd: () => currentCtx?.cwd,
      requestStatusRender: (delayMs) => requestStatusRender(delayMs)
   });

   // Cache for the top and secondary station bar widgets.
   state.lastLayoutWidth = 0;
   state.lastLayoutResult = null;
   state.lastLayoutTimestamp = 0;
   state.layoutDirty = true;
   state.forceNextLayoutRecompute = false;
   state.lastEditorInputAt = 0;

   const statusRenderScheduler = createRenderScheduler(() => {
      const msSinceInput = Date.now() - state.lastEditorInputAt;
      if (state.layoutDirty && !state.forceNextLayoutRecompute && msSinceInput < EDITOR_STATUS_DEFER_MS) {
         statusRenderScheduler.schedule(Math.max(0, EDITOR_STATUS_DEFER_MS - msSinceInput));
         return;
      }

      tuiRef?.requestRender();
   }, STATUS_RENDER_DEBOUNCE_MS);

   const resetLayoutCache = () => {
      state.lastLayoutResult = null;
      state.layoutDirty = true;
   };

   const requestStatusRender = (delayMs?: number) => {
      state.layoutDirty = true;
      statusRenderScheduler.schedule(delayMs);
   };

   const requestImmediateStatusRender = (options: { deferDuringTyping?: boolean } = {}) => {
      state.layoutDirty = true;
      if (options.deferDuringTyping !== false && Date.now() - state.lastEditorInputAt < EDITOR_STATUS_DEFER_MS) {
         statusRenderScheduler.schedule();
         return;
      }

      state.forceNextLayoutRecompute = true;
      statusRenderScheduler.cancel();
      statusRenderScheduler.schedule(0);
   };

   const installFooterStatusRepaintHook = (footerData: ReadonlyFooterDataProvider) => {
      restoreFooterStatusRepaintHook?.();
      restoreFooterStatusRepaintHook = null;

      const writableFooterData = footerData as ReadonlyFooterDataProvider & {
         setExtensionStatus?: (key: string, text: string | undefined) => void;
         clearExtensionStatuses?: () => void;
      };
      if (typeof writableFooterData.setExtensionStatus !== "function") {
         return;
      }

      const originalSetExtensionStatus = writableFooterData.setExtensionStatus;
      const originalClearExtensionStatuses = writableFooterData.clearExtensionStatuses;
      const setExtensionStatusAndRepaint = function setExtensionStatusAndRepaint(
         this: unknown,
         key: string,
         text: string | undefined
      ) {
         originalSetExtensionStatus.call(this, key, text);
         requestImmediateStatusRender();
      };
      writableFooterData.setExtensionStatus = setExtensionStatusAndRepaint;

      let clearExtensionStatusesAndRepaint: (() => void) | null = null;
      if (typeof originalClearExtensionStatuses === "function") {
         clearExtensionStatusesAndRepaint = function (this: unknown) {
            originalClearExtensionStatuses.call(this);
            requestImmediateStatusRender();
         };
         writableFooterData.clearExtensionStatuses = clearExtensionStatusesAndRepaint;
      }

      restoreFooterStatusRepaintHook = () => {
         if (writableFooterData.setExtensionStatus === setExtensionStatusAndRepaint) {
            writableFooterData.setExtensionStatus = originalSetExtensionStatus;
         }
         if (
            clearExtensionStatusesAndRepaint &&
            writableFooterData.clearExtensionStatuses === clearExtensionStatusesAndRepaint
         ) {
            writableFooterData.clearExtensionStatuses = originalClearExtensionStatuses;
         }
      };
   };

   function overlaySelectListTheme(theme: Theme) {
      return {
         description: (text: string) => theme.fg("muted", text),
         noMatch: (text: string) => theme.fg("warning", text),
         scrollInfo: (text: string) => theme.fg("dim", text),
         selectedPrefix: (text: string) => theme.fg("accent", text),
         selectedText: (text: string) => theme.fg("accent", text)
      };
   }

   async function showSelectOverlay(
      ctx: any,
      title: string,
      hint: string,
      items: SelectItem[],
      maxVisible: number
   ): Promise<SelectItem | null> {
      return (ctx.ui as any).custom(
         (tui: any, theme: Theme, _keybindings: any, done: (result: SelectItem | null) => void) => {
            const selectList = new SelectList(items, maxVisible, overlaySelectListTheme(theme));
            const border = (text: string) => theme.fg("dim", text);
            const wrapRow = (text: string, innerWidth: number): string =>
               `${border("│")}${truncateToWidth(text, innerWidth, "...", true)}${border("│")}`;

            selectList.onSelect = (item) => done(item);
            selectList.onCancel = () => done(null);

            return {
               handleInput: (data: string) => {
                  selectList.handleInput(data);
                  tui.requestRender();
               },
               invalidate: () => selectList.invalidate(),
               render: (width: number) => {
                  const innerWidth = Math.max(1, width - 2);
                  const lines: string[] = [];

                  lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
                  lines.push(wrapRow(theme.fg("accent", theme.bold(title)), innerWidth));
                  lines.push(border(`├${"─".repeat(innerWidth)}┤`));

                  for (const line of selectList.render(innerWidth)) {
                     lines.push(wrapRow(line, innerWidth));
                  }

                  lines.push(border(`├${"─".repeat(innerWidth)}┤`));
                  lines.push(wrapRow(theme.fg("dim", hint), innerWidth));
                  lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

                  return lines;
               }
            };
         },
         {
            overlay: true,
            overlayOptions: () => ({
               horizontalAlign: "center",
               verticalAlign: "center"
            })
         }
      );
   }

   // Track session start
   pi.on("session_start", async (event, ctx) => {
      bashIntegration.session?.dispose();
      bashIntegration.session = null;
      cachedSkillsLoaded = -1;
      cachedSkillsInstalled = -1;

      const settings = readSettings(ctx.cwd);
      config = parseStationConfig(settings["station"]);
      state.config = config;

      customCompactionEnabled = detectCustomCompactionEnabled(ctx.cwd);

      bashModeSettings = parseBashModeSettings(settings);

      state.startSession(ctx, {
         customCompactionEnabled,
         showLastPrompt: settings.showLastPrompt !== false
      });

      ({ currentCtx } = state);
      ({ lastUserPrompt } = state);
      stashedEditorText = null;
      ({ showLastPrompt } = state);
      ({ currentThinkingLevel } = state);
      ({ getThinkingLevelFn } = state);

      ({ stashedPromptHistory } = state);
      bashIntegration.reloadSettings(bashModeSettings);

      if (ctx.hasUI) {
         ctx.ui.setStatus("stash", undefined);
      }

      if (enabled && ctx.hasUI) {
         setupCustomEditor(ctx);
      }
   });

   pi.on("session_shutdown", async () => {
      statusRenderScheduler.cancel();
      restoreFooterStatusRepaintHook?.();
      restoreFooterStatusRepaintHook = null;
      teardownFixedEditorCompositor({ resetExtendedKeyboardModes: true });
      bashIntegration.session?.dispose();
      bashIntegration.session = null;
      bashIntegration.active = false;
      currentCtx = null;
      footerDataRef = null;
      getThinkingLevelFn = null;
      currentThinkingLevel = null;
      state.liveAssistantUsage = null;
      tuiRef = null;
      currentEditor = null;
      resetLayoutCache();
      state.endSession();
   });

   // Check if a bash command might change git branch
   const mightChangeGitBranch = (cmd: string): boolean => {
      const gitBranchPatterns = [
         /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
         /\bgit\s+stash\s+(pop|apply)/
      ];
      return gitBranchPatterns.some((p) => p.test(cmd));
   };

   // Invalidate git status on file changes, trigger re-render on potential branch changes
   pi.on("tool_result", async (event) => {
      if (event.toolName === "write" || event.toolName === "edit") {
         invalidateGitStatus();
      }
      // Check for bash commands that might change git branch
      if (event.toolName === "bash" && typeof event.input?.command === "string") {
         const cmd = event.input.command;
         if (mightChangeGitBranch(cmd)) {
            // Invalidate caches since working tree state changes with branch
            invalidateGitStatus();
            invalidateGitBranch();
            // Small delay to let git update, then re-render
            setTimeout(() => requestStatusRender(), 100);
         }
      }
   });

   // Also catch user escape commands (! prefix)
   // Note: This fires BEFORE execution, so we use a longer delay and multiple re-renders
   // To ensure we catch the update after the command completes.
   pi.on("user_bash", async (event) => {
      if (mightChangeGitBranch(event.command)) {
         // Invalidate immediately so next render fetches fresh data
         invalidateGitStatus();
         invalidateGitBranch();
         // Multiple staggered re-renders to catch fast and slow commands
         setTimeout(() => requestStatusRender(), 100);
         setTimeout(() => requestStatusRender(), 300);
         setTimeout(() => requestStatusRender(), 500);
      }
   });

   pi.on("model_select", async (_event, ctx) => {
      currentCtx = ctx;
      requestStatusRender();
   });

   pi.on("thinking_level_select", async (event, ctx) => {
      currentCtx = ctx;
      currentThinkingLevel = typeof event.level === "string" ? event.level : resolveCurrentThinkingLevel(ctx);
      updateEditorBorderColor(ctx);
      requestImmediateStatusRender({ deferDuringTyping: false });
   });

   pi.on("session_tree", async (_event, ctx) => {
      currentCtx = ctx;
      currentThinkingLevel = (ctx as any).getThinkingLevel?.() ?? null;
      // Also update getThinkingLevelFn to stay in sync with the current session ctx
      getThinkingLevelFn =
         typeof (ctx as any).getThinkingLevel === "function" ? () => (ctx as any).getThinkingLevel() : null;
      state.liveAssistantUsage = null;
      requestImmediateStatusRender({ deferDuringTyping: false });
   });

   pi.on("before_agent_start", async (event, _ctx) => {
      lastUserPrompt = event.prompt;
   });

   pi.on("agent_start", async (_event, ctx) => {
      state.isStreaming = true;
      state.liveAssistantUsage = null;
      currentCtx = ctx;
   });

   pi.on("message_update", async (event, ctx) => {
      if (
         isSessionAssistantMessage(event.message) &&
         event.message.stopReason !== "error" &&
         event.message.stopReason !== "aborted" &&
         getUsageTokenTotal(event.message.usage) > 0
      ) {
         state.liveAssistantUsage = event.message.usage;
         currentCtx = ctx;
         state.layoutDirty = true;
         statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
      }
   });

   pi.on("message_end", async (event, ctx) => {
      currentCtx = ctx;
      if (isSessionAssistantMessage(event.message)) {
         if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
            state.liveAssistantUsage = null;
         } else if (getUsageTokenTotal(event.message.usage) > 0) {
            state.liveAssistantUsage = event.message.usage;
         }
      }
      requestImmediateStatusRender({ deferDuringTyping: false });
   });

   pi.on("turn_end", async (_event, ctx) => {
      currentCtx = ctx;
      requestImmediateStatusRender({ deferDuringTyping: false });
   });

   function addStashHistoryEntry(text: string): void {
      const changed = pushStashHistory(stashedPromptHistory, text);
      if (!changed) {
         return;
      }

      persistStashHistory(stashedPromptHistory);
   }

   async function selectItemFromList(ctx: any, title: string, items: string[]): Promise<string | null> {
      const selectItems: SelectItem[] = items.map((entry, index) => ({
         label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
         value: String(index)
      }));

      const selected = await showSelectOverlay(
         ctx,
         title,
         "↑↓ navigate • enter insert • esc cancel",
         selectItems,
         Math.min(selectItems.length, 10)
      );
      if (!selected) {
         return null;
      }

      return items[Number.parseInt(selected.value, 10)] ?? null;
   }

   async function selectPromptHistorySource(
      ctx: any,
      stashCount: number,
      projectPromptCount: number
   ): Promise<"stash" | "project" | null> {
      const items: SelectItem[] = [];

      if (stashCount > 0) {
         items.push({
            description: `${stashCount} saved`,
            label: "Stashed prompts",
            value: "stash"
         });
      }

      if (projectPromptCount > 0) {
         items.push({
            description: `${projectPromptCount} recent`,
            label: "Recent project prompts",
            value: "project"
         });
      }

      if (items.length === 0) {
         return null;
      }

      if (items.length === 1) {
         return items[0]?.value === "project" ? "project" : "stash";
      }

      const selected = await showSelectOverlay(
         ctx,
         "Prompt history",
         "↑↓ navigate • enter open • esc cancel",
         items,
         items.length
      );
      if (!selected) {
         return null;
      }

      return selected.value === "project" ? "project" : "stash";
   }

   async function insertSelectedPromptHistoryEntry(ctx: any, selected: string): Promise<void> {
      const currentText = getCurrentEditorText(ctx, currentEditor);
      if (!hasNonWhitespaceText(currentText)) {
         ctx.ui.setEditorText(selected);
         ctx.ui.notify("Inserted prompt", "info");
         return;
      }

      const action = await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"]);

      if (action === "Replace") {
         ctx.ui.setEditorText(selected);
         ctx.ui.notify("Replaced editor with prompt", "info");
         return;
      }

      if (action === "Append") {
         const separator = currentText.endsWith("\n") || selected.startsWith("\n") ? "" : "\n";
         ctx.ui.setEditorText(`${currentText}${separator}${selected}`);
         ctx.ui.notify("Appended prompt", "info");
      }
   }

   function stashOrRestoreEditorText(ctx: any): void {
      const rawText = getCurrentEditorText(ctx, currentEditor);
      const hasStash = stashedEditorText !== null;

      if (!hasNonWhitespaceText(rawText)) {
         if (!hasStash) {
            ctx.ui.notify("Nothing to stash", "info");
            return;
         }

         ctx.ui.setEditorText(stashedEditorText);
         stashedEditorText = null;
         ctx.ui.setStatus("stash", undefined);
         ctx.ui.notify("Stash restored", "info");
         return;
      }

      stashedEditorText = rawText;
      addStashHistoryEntry(rawText);
      ctx.ui.setEditorText("");
      ctx.ui.setStatus("stash", "stash");
      ctx.ui.notify(hasStash ? "Stash updated" : "Text stashed", "info");
   }

   async function openStashHistory(ctx: any): Promise<void> {
      let projectPrompts: string[] = [];

      try {
         projectPrompts = readRecentProjectPrompts(ctx.cwd, PROJECT_PROMPT_HISTORY_LIMIT);
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         ctx.ui.notify(`Failed to load project prompts: ${message}`, "warning");
      }

      if (stashedPromptHistory.length === 0 && projectPrompts.length === 0) {
         ctx.ui.notify("No prompt history yet", "info");
         return;
      }

      const source = await selectPromptHistorySource(ctx, stashedPromptHistory.length, projectPrompts.length);
      if (!source) {
         return;
      }

      const selected =
         source === "project"
            ? await selectItemFromList(ctx, "Recent project prompts", projectPrompts)
            : await selectItemFromList(ctx, "Stash history", [...stashedPromptHistory]);
      if (!selected) {
         return;
      }

      await insertSelectedPromptHistoryEntry(ctx, selected);
   }

   pi.on("agent_end", async (_event, ctx) => {
      state.isStreaming = false;
      state.liveAssistantUsage = null;
      currentCtx = ctx;
      if (ctx.hasUI && stashedEditorText !== null) {
         if (ctx.ui.getEditorText().trim() === "") {
            ctx.ui.setEditorText(stashedEditorText);
            stashedEditorText = null;
            ctx.ui.setStatus("stash", undefined);
            ctx.ui.notify("Stash restored", "info");
         } else {
            ctx.ui.notify("Stash preserved. Clear editor then Alt+S to restore", "info");
         }
      }
      requestStatusRender();
   });

   // Command to open station settings
   pi.registerCommand("station", {
      description: "Open station bar settings (fixed editor, scroll bar)",
      handler: async (_args, ctx) => {
         currentCtx = ctx;

         if (!ctx.hasUI) {
            return;
         }

         let needsCustomEditorRefresh = false;
         let needsScrollBarRefresh = false;
         let needsHashlineRefresh = false;
         const valueFor = (value: boolean): string => (value ? "ON" : "OFF");

         await ctx.ui.custom<void>(
            (tui, theme, _keybindings, done) => {
               const list = new SettingsList(
                  [
                     {
                        currentValue: valueFor(config.fixedEditor),
                        description: "Keep chat/feed scrollable above a fixed editor cluster.",
                        id: "fixedEditor",
                        label: "Fixed Editor",
                        values: ["ON", "OFF"]
                     },
                     {
                        currentValue: valueFor(config.scrollBar),
                        description: "Show the scroll position indicator on the chat/feed area.",
                        id: "scrollBar",
                        label: "Scroll Bar",
                        values: ["ON", "OFF"]
                     },
                     {
                        currentValue: valueFor(config.hashline),
                        description: "Hash-anchored read and edit tools. Reload required.",
                        id: "hashline",
                        label: "Hashline",
                        values: ["ON", "OFF"]
                     }
                  ],
                  3,
                  {
                     cursor: "→ ",
                     description: (text: string) => text,
                     hint: (text: string) => text,
                     label: (text: string) => text,
                     value: (text: string) => text
                  },
                  (id, newValue) => {
                     if (id === "fixedEditor") {
                        config.fixedEditor = newValue === "ON";
                        writeStationSetting(ctx.cwd, (existing) =>
                           isRecord(existing)
                              ? { ...existing, fixedEditor: config.fixedEditor }
                              : { fixedEditor: config.fixedEditor }
                        );
                        needsCustomEditorRefresh = true;
                     } else if (id === "scrollBar") {
                        config.scrollBar = newValue === "ON";
                        writeStationSetting(ctx.cwd, (existing) =>
                           isRecord(existing)
                              ? { ...existing, scrollBar: config.scrollBar }
                              : { scrollBar: config.scrollBar }
                        );
                        needsScrollBarRefresh = true;
                     } else if (id === "hashline") {
                        config.hashline = newValue === "ON";
                        const saved = writeGlobalStationSetting((existing) =>
                           isRecord(existing)
                              ? { ...existing, hashline: config.hashline }
                              : { hashline: config.hashline }
                        );
                        needsHashlineRefresh = saved;
                        if (!saved) {
                           ctx.ui.notify("Failed to save Hashline setting", "error");
                        }
                     }
                  },
                  () => done()
               );

               return {
                  handleInput(data: string): void {
                     list.handleInput(data);
                     tui.requestRender();
                  },
                  invalidate(): void {
                     list.invalidate();
                  },
                  render(width: number): string[] {
                     const border = (text: string) => theme.fg("accent", text);
                     const innerWidth = Math.max(1, width - 4);
                     const title = theme.fg("accent", theme.bold("Station Settings"));
                     const top = border(`╭${"─".repeat(Math.max(1, width - 2))}╮`);
                     const divider = border(`├${"─".repeat(Math.max(1, width - 2))}┤`);
                     const bottom = border(`╰${"─".repeat(Math.max(1, width - 2))}╯`);
                     const rows = list.render(innerWidth).map((line) => {
                        const text = truncateToWidth(line, innerWidth, "");
                        return `${border("│")} ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} ${border("│")}`;
                     });
                     const titleRow = `${border("│")} ${title}${" ".repeat(Math.max(0, innerWidth - visibleWidth("Station Settings")))} ${border("│")}`;
                     return [top, titleRow, divider, ...rows, bottom];
                  }
               };
            },
            { overlay: true }
         );

         if (needsCustomEditorRefresh && enabled) {
            setupCustomEditor(ctx);
         } else if (needsScrollBarRefresh && enabled && config.fixedEditor) {
            fixedEditorCompositor?.setScrollBar(config.scrollBar);
         }
         if (needsHashlineRefresh && enabled) {
            ctx.ui.notify(`Hashline saved: ${config.hashline ? "ON" : "OFF"}. Run /reload to apply.`, "info");
         }
      }
   });

   pi.registerCommand("stash-history", {
      description: "Open prompt history picker",
      handler: async (_args, ctx) => {
         if (!ctx.hasUI) {
            return;
         }
         if (!enabled) {
            ctx.ui.notify("Station bar is disabled", "info");
            return;
         }

         await openStashHistory(ctx);
      }
   });

   pi.registerCommand("bash-mode", {
      description: "Enable sticky bash mode",
      handler: async (_args, ctx) => {
         await bashIntegration.setActive(true, ctx as any);
      }
   });

   pi.registerCommand("bash-reset", {
      description: "Reset the managed bash session",
      handler: async (_args, ctx) => {
         bashIntegration.session?.dispose();
         bashIntegration.session = null;
         bashIntegration.transcript.clear();
         if (bashIntegration.active) {
            try {
               await bashIntegration.ensureSession(currentCtx?.cwd);
            } catch (error) {
               bashIntegration.active = false;
               const message = error instanceof Error ? error.message : String(error);
               ctx.ui.notify(`Failed to restart shell session: ${message}`, "error");
               requestStatusRender();
               return;
            }
         }
         requestStatusRender();
         ctx.ui.notify("Bash session reset", "info");
      }
   });

   pi.registerShortcut(config.shortcuts.bashMode as any, {
      description: "Toggle bash mode",
      handler: async (ctx) => {
         if (!enabled || !ctx.hasUI) {
            return;
         }
         await bashIntegration.setActive(!bashIntegration.active, ctx as any);
      }
   });

   pi.registerShortcut(config.shortcuts.stash as any, {
      description: "Stash/restore editor text",
      handler: async (ctx) => {
         if (!enabled || !ctx.hasUI) {
            return;
         }
         stashOrRestoreEditorText(ctx);
      }
   });

   pi.registerShortcut(config.shortcuts.stashHistory as any, {
      description: "Open prompt history picker",
      handler: async (ctx) => {
         if (!enabled || !ctx.hasUI) {
            return;
         }
         await openStashHistory(ctx);
      }
   });

   function buildSegmentContext(ctx: any, theme: Theme): SegmentContext {
      const layoutDef = DEFAULT_LAYOUT;
      const colors: ColorScheme = layoutDef.colors ?? getDefaultColors();

      // Build usage stats and get thinking level from session
      let input = 0,
         output = 0,
         cacheRead = 0,
         cacheWrite = 0,
         cost = 0;
      let lastAssistant: AssistantMessage | undefined;
      let latestCacheHitRate: number | undefined;
      let thinkingLevelFromSession: string | null = null;

      const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
      for (const e of sessionEvents) {
         if (!isRecord(e)) {
            continue;
         }

         // Check for thinking level change entries
         if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
            thinkingLevelFromSession = e.thinkingLevel;
         }

         if (e.type !== "message" || !isSessionAssistantMessage(e.message)) {
            continue;
         }

         const m = e.message;
         if (m.stopReason === "error" || m.stopReason === "aborted") {
            continue;
         }
         input += m.usage.input;
         output += m.usage.output;
         cacheRead += m.usage.cacheRead;
         cacheWrite += m.usage.cacheWrite;
         cost += m.usage.cost.total;
         const latestPromptTokens = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
         latestCacheHitRate = latestPromptTokens > 0 ? (m.usage.cacheRead / latestPromptTokens) * 100 : undefined;
         if (getUsageTokenTotal(m.usage) > 0) {
            lastAssistant = m;
         }
      }

      // Calculate context usage.
      const latestUsage = state.isStreaming ? (state.liveAssistantUsage ?? lastAssistant?.usage) : lastAssistant?.usage;
      const coreContextUsage = state.isStreaming && state.liveAssistantUsage ? null : readCoreContextUsage(ctx);
      const contextTokens = coreContextUsage?.contextTokens ?? (latestUsage ? getUsageTokenTotal(latestUsage) : 0);
      const contextWindow = coreContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const contextPercent =
         coreContextUsage?.contextPercent ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);

      // Get git status (cached)
      const gitBranch = footerDataRef?.getGitBranch() ?? null;
      const gitStatus = getGitStatus(gitBranch);
      const extensionStatuses = footerDataRef?.getExtensionStatuses() ?? new Map();
      const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
      const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

      // Check if using OAuth subscription
      const usingSubscription = ctx.model ? (ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false) : false;

      const thinkingLevel = currentThinkingLevel ?? thinkingLevelFromSession ?? getThinkingLevelFn?.() ?? "off";
      const { loaded: skillsLoaded, installed: skillsInstalled } = countSkills();

      return {
         autoCompactEnabled: readCompactionEnabled(),
         colors,
         contextPercent,
         contextTokens,
         contextWindow,
         customCompactionEnabled: customCompactionEnabled || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
         customItemsById,
         cwd: ctx.cwd,
         extensionStatuses,
         git: gitStatus,
         hiddenExtensionStatusKeys,
         model: ctx.model,
         options: layoutDef.segmentOptions ?? {},
         sessionId: ctx.sessionManager?.getSessionId?.(),
         sessionStartTime: state.sessionStartTime,
         shellCwd: bashIntegration.session?.state.cwd ?? null,
         shellModeActive: bashIntegration.active,
         shellName: bashIntegration.session?.state.shellName ?? null,
         shellRunning: bashIntegration.session?.state.running ?? false,
         skillsInstalled,
         skillsLoaded,
         theme,
         thinkingLevel,
         usageStats: { cacheRead, cacheWrite, cost, input, latestCacheHitRate, output },
         usingSubscription
      };
   }

   // Track previous autoCompactEnabled to detect changes
   let lastAutoCompactEnabled: boolean | null = null;

   /**
    * Get cached responsive layout or compute fresh one.
    * The segment context scans session state, so keep it stable across render bursts.
    */
   function getResponsiveLayout(width: number, theme: Theme) {
      const now = Date.now();
      const cacheTtl = state.isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

      // Detect autoCompactEnabled changes and force re-render
      const currentAutoCompact = currentCtx?.settingsManager?.getCompactionSettings?.()?.enabled ?? true;
      if (lastAutoCompactEnabled !== null && lastAutoCompactEnabled !== currentAutoCompact) {
         state.forceNextLayoutRecompute = true;
      }
      lastAutoCompactEnabled = currentAutoCompact;

      if (state.lastLayoutResult && state.lastLayoutWidth === width) {
         const msSinceInput = now - state.lastEditorInputAt;
         const typingRecently = msSinceInput < EDITOR_STATUS_DEFER_MS;

         if (
            !state.forceNextLayoutRecompute &&
            typingRecently &&
            (state.layoutDirty || now - state.lastLayoutTimestamp >= cacheTtl)
         ) {
            return state.lastLayoutResult;
         }

         if (!state.layoutDirty && now - state.lastLayoutTimestamp < cacheTtl) {
            return state.lastLayoutResult;
         }
      }

      const segmentCtx = buildSegmentContext(currentCtx, theme);

      state.lastLayoutWidth = width;
      state.lastLayoutResult = computeResponsiveLayout(segmentCtx, width, config.customItems);
      state.lastLayoutTimestamp = now;
      state.layoutDirty = false;
      state.forceNextLayoutRecompute = false;

      return state.lastLayoutResult;
   }

   function renderStationStatusLines(width: number): string[] {
      if (!currentCtx || !footerDataRef) {
         return [];
      }

      const statuses = footerDataRef.getExtensionStatuses();
      if (!statuses || statuses.size === 0) {
         return [];
      }
      const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

      const notifications: string[] = [];
      for (const value of getNotificationExtensionStatuses(statuses, hiddenExtensionStatusKeys)) {
         const lineContent = ` ${value}`;
         if (visibleWidth(lineContent) <= width) {
            notifications.push(lineContent);
         }
      }

      return notifications;
   }

   function renderStationLayoutLine(
      width: number,
      theme: Theme,
      field: "topContent" | "secondaryContent" | "tertiaryContent"
   ): string[] {
      if (!currentCtx) {
         return [];
      }
      const content = getResponsiveLayout(width, theme)[field];
      return content ? [content] : [];
   }

   const renderStationTopLines = (width: number, theme: Theme) => renderStationLayoutLine(width, theme, "topContent");
   const renderStationSecondaryLines = (width: number, theme: Theme) =>
      renderStationLayoutLine(width, theme, "secondaryContent");
   const renderStationTertiaryLines = (width: number, theme: Theme) =>
      renderStationLayoutLine(width, theme, "tertiaryContent");

   /** Get current thinking level from ctx, with fallback chain matching buildSegmentContext */
   function resolveCurrentThinkingLevel(ctx: any): string {
      if (currentThinkingLevel) {
         return currentThinkingLevel;
      }

      const fnResult = getThinkingLevelFn?.();
      if (fnResult) {
         return fnResult;
      }

      // Scan session events for the most recent thinking_level_change
      const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
      for (const e of sessionEvents) {
         if (e?.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
            return e.thinkingLevel;
         }
      }

      return "off";
   }

   function updateEditorBorderColor(ctx: any): void {
      if (!currentEditor) {
         return;
      }
      try {
         const level = resolveCurrentThinkingLevel(ctx);
         const theme = ctx.ui?.theme;
         if (theme && typeof theme.getThinkingBorderColor === "function") {
            currentEditor.borderColor = theme.getThinkingBorderColor(level);
            currentEditor.tui?.requestRender();
         }
      } catch {
         // Theme API not available
      }
   }

   function renderLastPromptLines(width: number): string[] {
      if (bashIntegration.active || !showLastPrompt || !lastUserPrompt) {
         return [];
      }

      const prefix = ` ${getFgAnsiCode("sep")}↳${ansi.reset} `;
      const availableWidth = width - visibleWidth(prefix);
      if (availableWidth < 10) {
         return [];
      }

      let promptText = lastUserPrompt.replace(/\s+/g, " ").trim();
      if (!promptText) {
         return [];
      }

      promptText = truncateToWidth(promptText, availableWidth, "...");

      const styledPrompt = `${getFgAnsiCode("sep")}${promptText}${ansi.reset}`;
      const line = `${prefix}${styledPrompt}`;
      return [truncateToWidth(line, width, "...")];
   }

   function teardownFixedEditorCompositor(options?: { resetExtendedKeyboardModes?: boolean }) {
      const hadCompositor = fixedEditorCompositor !== null;
      fixedEditorCompositor?.dispose(options);
      if (!hadCompositor && options?.resetExtendedKeyboardModes) {
         try {
            process.stdout.write(emergencyTerminalModeReset());
         } catch {
            // Shutdown cleanup cannot surface useful terminal write failures.
         }
      }
      fixedEditorCompositor = null;
      fixedStatusContainer = null;
      fixedEditorContainer = null;
      fixedWidgetContainerAbove = null;
      fixedWidgetContainerBelow = null;
   }

   function findContainerWithChild(tui: any, child: any): { container: any; index: number } | null {
      const children = Array.isArray(tui?.children) ? tui.children : [];
      const index = children.findIndex(
         (candidate: any) => Array.isArray(candidate?.children) && candidate.children.includes(child)
      );
      if (index === -1) {
         return null;
      }

      return { container: children[index], index };
   }

   function installFixedEditorCompositor(ctx: any, tui: any) {
      teardownFixedEditorCompositor();

      if (!ctx.hasUI || !config.fixedEditor) {
         return;
      }
      if (!tui?.terminal || typeof tui.terminal.write !== "function") {
         throw new Error("[station-bar] Fixed editor compositor could not find tui.terminal.write()");
      }
      if (!currentEditor) {
         throw new Error("[station-bar] Fixed editor compositor expected the custom editor to be installed first");
      }

      const editorContainerMatch = findContainerWithChild(tui, currentEditor);
      if (!editorContainerMatch) {
         throw new Error("[station-bar] Fixed editor compositor could not find the editor container in TUI children");
      }

      const tuiChildren = Array.isArray(tui.children) ? tui.children : [];
      fixedEditorContainer = editorContainerMatch.container;
      const statusContainerCandidate = tuiChildren[editorContainerMatch.index - 2] ?? null;
      fixedStatusContainer =
         statusContainerCandidate && typeof statusContainerCandidate.render === "function"
            ? statusContainerCandidate
            : null;
      fixedWidgetContainerAbove = tuiChildren[editorContainerMatch.index - 1] ?? null;
      fixedWidgetContainerBelow = tuiChildren[editorContainerMatch.index + 1] ?? null;

      let compositor: TerminalSplitCompositor;
      compositor = new TerminalSplitCompositor({
         accentColor: (text: string) => ctx.ui.theme.fg("accent", text),
         getShowHardwareCursor: () => typeof tui.getShowHardwareCursor === "function" && tui.getShowHardwareCursor(),
         onCopySelection: (text) => copyToClipboard(text),
         renderCluster: (width, terminalRows) => {
            const theme = currentCtx?.ui?.theme ?? ctx.ui.theme;
            const statusContainerLines = fixedStatusContainer
               ? compositor.renderHidden(fixedStatusContainer, width).filter((line) => visibleWidth(line) > 0)
               : [];
            const aboveWidgetLines = fixedWidgetContainerAbove
               ? compositor.renderHidden(fixedWidgetContainerAbove, width)
               : [];
            const belowWidgetLines = fixedWidgetContainerBelow
               ? compositor.renderHidden(fixedWidgetContainerBelow, width)
               : [];
            return renderFixedEditorCluster({
               editorLines: fixedEditorContainer ? compositor.renderHidden(fixedEditorContainer, width) : [],
               lastPromptLines: renderLastPromptLines(width),
               secondaryLines: [...renderStationSecondaryLines(width, theme), ...belowWidgetLines],
               statusLines: [...aboveWidgetLines, ...renderStationStatusLines(width), ...statusContainerLines],
               terminalRows,
               tertiaryLines: renderStationTertiaryLines(width, theme),
               topLines: renderStationTopLines(width, theme),
               transcriptLines: [],
               width
            });
         },
         renderRootOverlay: (width) => {
            const theme = currentCtx?.ui?.theme ?? ctx.ui.theme;
            return bashIntegration.active ? bashIntegration.renderTranscript(width, theme) : null;
         },
         scrollBar: config.scrollBar,
         terminal: tui.terminal,
         tui
      });

      fixedEditorCompositor = compositor;
      if (fixedStatusContainer?.render) {
         compositor.hideRenderable(fixedStatusContainer);
      }
      if (fixedWidgetContainerAbove?.render) {
         compositor.hideRenderable(fixedWidgetContainerAbove);
      }
      compositor.hideRenderable(fixedEditorContainer);
      if (fixedWidgetContainerBelow?.render) {
         compositor.hideRenderable(fixedWidgetContainerBelow);
      }
      compositor.install();
      tui.requestRender(true);
   }

   function followSubmittedEditorToBottom(): void {
      fixedEditorCompositor?.jumpToRootBottom();
   }

   function installStationWidgets(ctx: any) {
      ctx.ui.setWidget(
         "station-status",
         () => ({
            dispose() {},
            invalidate() {
               requestStatusRender();
            },
            render(width: number): string[] {
               return renderStationStatusLines(width);
            }
         }),
         { placement: "aboveEditor" }
      );

      ctx.ui.setWidget(
         "station-top",
         (_tui: any, theme: Theme) => ({
            dispose() {},
            invalidate() {
               resetLayoutCache();
            },
            render(width: number): string[] {
               return renderStationTopLines(width, theme);
            }
         }),
         { placement: "belowEditor" }
      );

      ctx.ui.setWidget(
         "station-secondary",
         (_tui: any, theme: Theme) => ({
            dispose() {},
            invalidate() {
               resetLayoutCache();
            },
            render(width: number): string[] {
               return renderStationSecondaryLines(width, theme);
            }
         }),
         { placement: "belowEditor" }
      );

      ctx.ui.setWidget(
         "station-tertiary",
         (_tui: any, theme: Theme) => ({
            dispose() {},
            invalidate() {
               resetLayoutCache();
            },
            render(width: number): string[] {
               return renderStationTertiaryLines(width, theme);
            }
         }),
         { placement: "belowEditor" }
      );

      ctx.ui.setWidget(
         "station-bash-transcript",
         () => ({
            dispose() {},
            invalidate() {},
            render(): string[] {
               return [];
            }
         }),
         { placement: "belowEditor" }
      );

      ctx.ui.setWidget(
         "station-last-prompt",
         () => ({
            dispose() {},
            invalidate() {},
            render(width: number): string[] {
               return renderLastPromptLines(width);
            }
         }),
         { placement: "belowEditor" }
      );
   }

   function setupCustomEditor(ctx: any) {
      snapshotPromptHistory(currentEditor);
      if (!enabled) {
         return;
      }

      teardownFixedEditorCompositor();
      ctx.ui.setWidget("station-top", undefined);
      ctx.ui.setWidget("station-secondary", undefined);
      ctx.ui.setWidget("station-tertiary", undefined);
      ctx.ui.setWidget("station-bash-transcript", undefined);
      ctx.ui.setWidget("station-status", undefined);
      ctx.ui.setWidget("station-last-prompt", undefined);

      let autocompleteFixed = false;

      const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
         const editor = new BashModeEditor(tui, editorTheme, keybindings, {
            getHistoryEntries: (prefix) => bashIntegration.getHistoryEntries(currentCtx?.cwd, prefix),
            isBashModeActive: () => bashIntegration.active,
            isShellRunning: () => bashIntegration.session?.state.running ?? false,
            keybindings,
            onEditorSubmit: () => followSubmittedEditorToBottom(),
            onExitBashMode: () => {
               void bashIntegration.setActive(false, ctx as any);
            },
            onInterrupt: () => {
               bashIntegration.session?.interrupt();
               ctx.ui.notify("Sent interrupt to shell", "info");
            },
            onNotify: (message, level = "info") => ctx.ui.notify(message, level),
            onSubmitCommand: (command) => void bashIntegration.runCommand(command, ctx),
            resolveGhostSuggestion: async (text, _signal) => {
               const oneOffBash = getOneOffBashCommandContext(text);
               if (oneOffBash) {
                  const ghost = await bashIntegration.completionEngine.getGhostSuggestion(
                     oneOffBash.command,
                     bashIntegration.getShellCwd(),
                     bashIntegration.getShellPath()
                  );
                  return ghost ? { ...ghost, value: `${oneOffBash.prefix}${ghost.value}` } : null;
               }

               return bashIntegration.completionEngine.getGhostSuggestion(
                  text,
                  bashIntegration.getShellCwd(),
                  bashIntegration.getShellPath()
               );
            },
            undoKey: config.shortcuts.undo,
            redoKey: config.shortcuts.redo
         });

         const getInstalledAutocompleteProvider = (): AutocompleteProvider | undefined => {
            const candidate = Reflect.get(editor, "autocompleteProvider");
            if (!candidate || typeof candidate !== "object") {
               return undefined;
            }
            if (typeof Reflect.get(candidate, "getSuggestions") !== "function") {
               return undefined;
            }
            if (typeof Reflect.get(candidate, "applyCompletion") !== "function") {
               return undefined;
            }
            return candidate;
         };

         const attachAutocompleteProvider = (): boolean => {
            if (editor.hasWrappedProvider()) {
               return true;
            }
            const defaultProvider = getInstalledAutocompleteProvider();
            if (!defaultProvider) {
               return false;
            }

            const bashProvider = new BashAutocompleteProvider();
            const oneOffBashProvider = new OneOffBashAutocompleteProvider();
            editor.installAutocompleteProvider(
               new ModeAwareAutocompleteProvider(
                  defaultProvider,
                  bashProvider as any,
                  oneOffBashProvider as any,
                  () => bashIntegration.active
               ) as any
            );
            return true;
         };

         let inheritedOnSubmit: unknown;
         Object.defineProperty(editor, "onSubmit", {
            configurable: true,
            get: () => inheritedOnSubmit,
            set(handler: unknown) {
               inheritedOnSubmit =
                  typeof handler === "function"
                     ? (text: string) => {
                          followSubmittedEditorToBottom();
                          handler(text);
                       }
                     : handler;
            }
         });

         currentEditor = editor;
         // Set thinking-aware border color (pi core defaults to static borderMuted)
         try {
            const level = resolveCurrentThinkingLevel(ctx);
            const themeObj = ctx.ui?.theme;
            if (themeObj && typeof themeObj.getThinkingBorderColor === "function") {
               editor.borderColor = themeObj.getThinkingBorderColor(level);
            }
         } catch {
            // Theme API not available
         }
         trackPromptHistory(editor);
         restorePromptHistory(editor);
         attachAutocompleteProvider();

         const originalHandleInput = editor.handleInput.bind(editor);
         editor.handleInput = (data: string) => {
            state.lastEditorInputAt = Date.now();

            if (!autocompleteFixed && !getInstalledAutocompleteProvider()) {
               autocompleteFixed = true;
               snapshotPromptHistory(editor);
               ctx.ui.setEditorComponent(editorFactory);
               if (config.fixedEditor) {
                  installFixedEditorCompositor(ctx, tui);
               }
               currentEditor?.handleInput(data);
               return;
            }

            attachAutocompleteProvider();
            const followUpText = keybindings.matches(data, "app.message.followUp")
               ? getCurrentEditorText(ctx, editor)
               : "";
            originalHandleInput(data);
            if (hasNonWhitespaceText(followUpText) && !hasNonWhitespaceText(getCurrentEditorText(ctx, editor))) {
               followSubmittedEditorToBottom();
            }
         };

         return editor;
      };

      ctx.ui.setEditorComponent(editorFactory);
      updateEditorBorderColor(ctx);

      ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
         footerDataRef = footerData;
         tuiRef = tui;
         installFooterStatusRepaintHook(footerData);
         const unsub = footerData.onBranchChange(() => requestStatusRender());

         return {
            dispose() {
               unsub();
               restoreFooterStatusRepaintHook?.();
               restoreFooterStatusRepaintHook = null;
            },
            invalidate() {
               requestStatusRender();
            },
            render(): string[] {
               return [];
            }
         };
      });

      if (config.fixedEditor) {
         if (tuiRef) {
            installFixedEditorCompositor(ctx, tuiRef);
         }
      } else {
         installStationWidgets(ctx);
      }
   }
}
