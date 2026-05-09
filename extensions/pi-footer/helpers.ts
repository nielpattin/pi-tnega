import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { CustomStatusItem, PresetDef, SegmentContext, StatusLineSegmentId } from "./types";
import type { PowerlineConfig } from "./powerline-config";
import { mergeSegmentsWithCustomItems, nextPowerlineSettingWithOptions } from "./powerline-config";
import { getSeparator } from "./separators";
import { renderSegment } from "./segments";
import { ansi, getFgAnsiCode } from "./colors";
import type { BashModeSettings } from "./bash-mode/types.ts";
import { getDefaultColors } from "./theme";
import { isSupportedSuperShortcut, shortcutConflictKey, shortcutUsesSuper } from "./shortcuts.ts";

export interface PowerlineShortcuts {
   stashHistory: string;
   copyEditor: string;
   cutEditor: string;
   jumpPreviousUserMessage: string;
   jumpNextUserMessage: string;
   jumpPreviousLlmMessage: string;
   jumpNextLlmMessage: string;
   jumpChatBottom: string;
   scrollChatUp: string;
   scrollChatDown: string;
   editorStart: string;
   editorEnd: string;
}

export type PowerlineShortcutKey = keyof PowerlineShortcuts;
export type ChatJumpShortcutKey = Extract<
   PowerlineShortcutKey,
   | "jumpPreviousUserMessage"
   | "jumpNextUserMessage"
   | "jumpPreviousLlmMessage"
   | "jumpNextLlmMessage"
   | "jumpChatBottom"
>;
export type ChatJumpRole = "user" | "assistant";
export type ChatJumpDirection = "previous" | "next";
export type ChatJumpShortcutAction =
   | { kind: "message"; role: ChatJumpRole; direction: ChatJumpDirection }
   | { kind: "bottom" };
export type PowerlineShortcutAction =
   | { kind: "stashHistory" }
   | { kind: "copyEditor" }
   | { kind: "cutEditor" }
   | { kind: "bashMode" }
   | { kind: "chat"; action: ChatJumpShortcutAction };

export const STASH_HISTORY_LIMIT = 12;
export const PROJECT_PROMPT_HISTORY_LIMIT = 50;
export const STASH_PREVIEW_WIDTH = 72;
export const DEFAULT_SHORTCUTS: PowerlineShortcuts = {
   stashHistory: "ctrl+alt+h",
   copyEditor: "ctrl+alt+c",
   cutEditor: "ctrl+alt+x",
   jumpPreviousUserMessage: "ctrl+shift+u",
   jumpNextUserMessage: "ctrl+shift+i",
   jumpPreviousLlmMessage: "ctrl+alt+,",
   jumpNextLlmMessage: "ctrl+alt+.",
   jumpChatBottom: "ctrl+shift+g",
   scrollChatUp: "super+up",
   scrollChatDown: "super+down",
   editorStart: "super+shift+up",
   editorEnd: "super+shift+down",
};
export const DEFAULT_BASH_MODE_SETTINGS: BashModeSettings = {
   toggleShortcut: "ctrl+shift+b",
   transcriptMaxLines: 2000,
   transcriptMaxBytes: 512 * 1024,
};
export const CHAT_JUMP_SHORTCUTS: Array<{
   shortcutKey: ChatJumpShortcutKey;
   description: string;
   action: ChatJumpShortcutAction;
}> = [
   {
      shortcutKey: "jumpPreviousUserMessage",
      description: "Jump to previous user message",
      action: { kind: "message", role: "user", direction: "previous" },
   },
   {
      shortcutKey: "jumpNextUserMessage",
      description: "Jump to next user message",
      action: { kind: "message", role: "user", direction: "next" },
   },
   {
      shortcutKey: "jumpPreviousLlmMessage",
      description: "Jump to previous LLM message",
      action: { kind: "message", role: "assistant", direction: "previous" },
   },
   {
      shortcutKey: "jumpNextLlmMessage",
      description: "Jump to next LLM message",
      action: { kind: "message", role: "assistant", direction: "next" },
   },
   {
      shortcutKey: "jumpChatBottom",
      description: "Jump chat to bottom",
      action: { kind: "bottom" },
   },
];
export const SHORTCUT_KEYS: PowerlineShortcutKey[] = [
   "stashHistory",
   "copyEditor",
   "cutEditor",
   "jumpPreviousUserMessage",
   "jumpNextUserMessage",
   "jumpPreviousLlmMessage",
   "jumpNextLlmMessage",
   "jumpChatBottom",
   "scrollChatUp",
   "scrollChatDown",
   "editorStart",
   "editorEnd",
];
export const APP_RESERVED_SHORTCUTS = [
   "escape",
   "ctrl+c",
   "ctrl+d",
   "ctrl+z",
   "shift+tab",
   "ctrl+p",
   "shift+ctrl+p",
   "ctrl+l",
   "ctrl+o",
   "shift+ctrl+o",
   "ctrl+t",
   "ctrl+n",
   "ctrl+g",
   "alt+enter",
   "alt+up",
   "alt+down",
   "ctrl+v",
   "alt+v",
   "shift+l",
   "shift+t",
   "ctrl+s",
   "ctrl+r",
   "ctrl+backspace",
   "ctrl+a",
   "ctrl+x",
   "ctrl+u",
] as const;
export const EXTRA_RESERVED_SHORTCUTS = ["alt+s"] as const;
export const SHORTCUT_MODIFIER_ORDER = ["ctrl", "alt", "super", "shift"] as const;
export const SHORTCUT_MODIFIERS = new Set(SHORTCUT_MODIFIER_ORDER);
export const SHORTCUT_NAMED_KEYS = new Set([
   "escape",
   "esc",
   "enter",
   "return",
   "tab",
   "space",
   "backspace",
   "delete",
   "insert",
   "clear",
   "home",
   "end",
   "pageup",
   "pagedown",
   "up",
   "down",
   "left",
   "right",
]);
export const SHORTCUT_SYMBOL_KEYS = new Set([
   "`",
   "-",
   "=",
   "[",
   "]",
   "\\",
   ";",
   "'",
   ",",
   ".",
   "/",
   "!",
   "@",
   "#",
   "$",
   "%",
   "^",
   "&",
   "*",
   "(",
   ")",
   "_",
   "|",
   "~",
   "{",
   "}",
   ":",
   "<",
   ">",
   "?",
]);
export const PROMPT_HISTORY_LIMIT = 100;
export const LAYOUT_CACHE_TTL_MS = 250;
export const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
export const STATUS_RENDER_DEBOUNCE_MS = 33;
export const CONTEXT_STATUS_RENDER_MS = 250;
export const EDITOR_STATUS_DEFER_MS = 150;
export const PROMPT_HISTORY_TRACKED = Symbol.for("powerlinePromptHistoryTracked");
export const PROMPT_HISTORY_STATE_KEY = Symbol.for("powerlinePromptHistoryState");
export const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";

export type PromptHistoryState = { savedPromptHistory: string[] };
export type SessionAssistantUsage = AssistantMessage["usage"];

export function getUsageTokenTotal(usage: SessionAssistantUsage): number {
   const totalTokens = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
   return totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function hasSessionAssistantUsage(value: unknown): value is SessionAssistantUsage {
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

export function isSessionAssistantMessage(value: unknown): value is AssistantMessage {
   return (
      isRecord(value) &&
      value.role === "assistant" &&
      hasSessionAssistantUsage(value.usage) &&
      (value.stopReason === undefined || typeof value.stopReason === "string")
   );
}

export function isPromptHistoryState(value: unknown): value is PromptHistoryState {
   return (
      isRecord(value) &&
      Array.isArray(value.savedPromptHistory) &&
      value.savedPromptHistory.every((entry) => typeof entry === "string")
   );
}

export function getPromptHistoryState(): PromptHistoryState {
   const existing = Reflect.get(globalThis, PROMPT_HISTORY_STATE_KEY);
   if (isPromptHistoryState(existing)) {
      return existing;
   }

   const state: PromptHistoryState = { savedPromptHistory: [] };
   Reflect.set(globalThis, PROMPT_HISTORY_STATE_KEY, state);
   return state;
}

export function readPromptHistory(editor: any): string[] {
   const history = editor?.history;
   if (!Array.isArray(history)) return [];

   const normalized: string[] = [];
   for (const entry of history) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (normalized.length > 0 && normalized[normalized.length - 1] === trimmed) continue;
      normalized.push(trimmed);
      if (normalized.length >= PROMPT_HISTORY_LIMIT) break;
   }

   return normalized;
}

export function snapshotPromptHistory(editor: any): void {
   const history = readPromptHistory(editor);
   if (history.length > 0) {
      getPromptHistoryState().savedPromptHistory = [...history];
   }
}

export function restorePromptHistory(editor: any): void {
   const { savedPromptHistory } = getPromptHistoryState();
   if (!savedPromptHistory.length || typeof editor?.addToHistory !== "function") return;

   for (let i = savedPromptHistory.length - 1; i >= 0; i--) {
      editor.addToHistory(savedPromptHistory[i]);
   }
}

export function trackPromptHistory(editor: any): void {
   if (!editor || typeof editor.addToHistory !== "function") return;
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

export function getSettingsPath(): string {
   const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
   return join(homeDir, ".pi", "agent", "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
   return join(cwd, ".pi", "settings.json");
}

export function getGlobalCompactionPolicyPath(): string {
   const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
   return join(homeDir, ".pi", "agent", "compaction-policy.json");
}

export function getCustomCompactionExtensionPath(): string {
   const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
   return join(homeDir, ".pi", "agent", "extensions", "pi-custom-compaction");
}

export function mergeSettings(
   base: Record<string, unknown>,
   override: Record<string, unknown>,
): Record<string, unknown> {
   const merged: Record<string, unknown> = { ...base };

   for (const [key, overrideValue] of Object.entries(override)) {
      const baseValue = merged[key];
      merged[key] =
         isRecord(baseValue) && isRecord(overrideValue) ? mergeSettings(baseValue, overrideValue) : overrideValue;
   }

   return merged;
}

export function readSettingsFile(settingsPath: string): Record<string, unknown> {
   try {
      if (!existsSync(settingsPath)) {
         return {};
      }

      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!isRecord(parsed)) {
         console.debug(`[powerline-footer] Ignoring non-object settings at ${settingsPath}`);
         return {};
      }

      return parsed;
   } catch (error) {
      // Settings are user-edited input. Log and keep the extension running with defaults
      // instead of crashing the UI during startup.
      console.debug(`[powerline-footer] Failed to read settings from ${settingsPath}:`, error);
      return {};
   }
}

export function readWritableSettingsFile(settingsPath: string): Record<string, unknown> | null {
   if (!existsSync(settingsPath)) {
      return {};
   }

   try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!isRecord(parsed)) {
         console.debug(`[powerline-footer] Refusing to write settings to non-object file at ${settingsPath}`);
         return null;
      }

      return parsed;
   } catch (error) {
      // Do not overwrite malformed user settings with partial data. Surface the failure
      // through the command handler so the user can fix the file intentionally.
      console.debug(`[powerline-footer] Failed to parse settings at ${settingsPath}:`, error);
      return null;
   }
}

export function readCompactionPolicyEnabled(configPath: string): boolean | undefined {
   if (!existsSync(configPath)) return undefined;
   try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return false;
      return parsed.enabled;
   } catch (error) {
      console.debug(`[powerline-footer] Failed to read compaction policy from ${configPath}:`, error);
      return false;
   }
}

export function detectCustomCompactionEnabled(cwd: string): boolean {
   if (!existsSync(getCustomCompactionExtensionPath())) return false;

   const projectSetting = readCompactionPolicyEnabled(join(cwd, ".pi", "compaction-policy.json"));
   if (projectSetting !== undefined) return projectSetting;

   return readCompactionPolicyEnabled(getGlobalCompactionPolicyPath()) ?? false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getStashHistoryPath(): string {
   const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
   return join(homeDir, ".pi", "agent", "pi-footer-hist", "stash-history.json");
}

export function getSessionsPath(): string {
   const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
   return join(homeDir, ".pi", "agent", "sessions");
}

export function getProjectSessionsPath(cwd: string): string {
   const projectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");

   return join(getSessionsPath(), `--${projectKey}--`);
}

export function getPromptHistoryText(content: unknown): string {
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

export function readRecentProjectPrompts(cwd: string, limit: number): string[] {
   const sessionsPath = getProjectSessionsPath(cwd);
   if (!existsSync(sessionsPath)) {
      return [];
   }

   const promptEntries: { text: string; timestamp: number }[] = [];
   const fileNames = readdirSync(sessionsPath).filter((fileName) => fileName.endsWith(".jsonl"));

   for (const fileName of fileNames) {
      const filePath = join(sessionsPath, fileName);
      const lines = readFileSync(filePath, "utf-8").split("\n");

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

export function normalizeStashHistoryEntries(value: unknown): string[] {
   if (!Array.isArray(value)) {
      return [];
   }

   const history: string[] = [];
   for (const entry of value) {
      if (typeof entry !== "string") {
         continue;
      }

      if (!hasNonWhitespaceText(entry)) {
         continue;
      }

      if (history[history.length - 1] === entry) {
         continue;
      }

      history.push(entry);
      if (history.length >= STASH_HISTORY_LIMIT) {
         break;
      }
   }

   return history;
}

export function readPersistedStashHistory(): string[] {
   const stashHistoryPath = getStashHistoryPath();

   try {
      if (!existsSync(stashHistoryPath)) {
         return [];
      }

      const parsed = JSON.parse(readFileSync(stashHistoryPath, "utf-8"));
      if (!isRecord(parsed)) {
         console.debug(`[powerline-footer] Ignoring invalid stash history at ${stashHistoryPath}`);
         return [];
      }

      return normalizeStashHistoryEntries(parsed.history);
   } catch (error) {
      console.debug(`[powerline-footer] Failed to read stash history from ${stashHistoryPath}:`, error);
      return [];
   }
}

export function persistStashHistory(history: string[]): void {
   const stashHistoryPath = getStashHistoryPath();
   const payload = {
      version: 1,
      history: history.slice(0, STASH_HISTORY_LIMIT),
   };

   try {
      mkdirSync(dirname(stashHistoryPath), { recursive: true });
      writeFileSync(stashHistoryPath, JSON.stringify(payload, null, 2) + "\n");
   } catch (error) {
      console.debug(`[powerline-footer] Failed to persist stash history to ${stashHistoryPath}:`, error);
   }
}

export function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
   return mergeSettings(readSettingsFile(getSettingsPath()), readSettingsFile(getProjectSettingsPath(cwd)));
}

export function writePowerlineSetting(cwd: string, update: (existingPowerlineSetting: unknown) => unknown): boolean {
   const globalSettingsPath = getSettingsPath();
   const projectSettingsPath = getProjectSettingsPath(cwd);
   const globalSettings = readWritableSettingsFile(globalSettingsPath);
   const projectSettings = readWritableSettingsFile(projectSettingsPath);

   if (globalSettings === null || projectSettings === null) {
      return false;
   }

   const writeToProject = Object.prototype.hasOwnProperty.call(projectSettings, "powerline");
   const settingsPath = writeToProject ? projectSettingsPath : globalSettingsPath;
   const settings = writeToProject ? projectSettings : globalSettings;

   settings.powerline = update(settings.powerline);

   try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      return true;
   } catch (error) {
      console.debug(`[powerline-footer] Failed to persist powerline setting to ${settingsPath}:`, error);
      return false;
   }
}

export function writePowerlineOptionSetting(
   cwd: string,
   updates: Partial<Pick<PowerlineConfig, "mouseScroll" | "fixedEditor">>,
): boolean {
   return writePowerlineSetting(cwd, (existingPowerlineSetting) =>
      nextPowerlineSettingWithOptions(existingPowerlineSetting, updates),
   );
}

export const DEFAULT_POWERLINE_LAYOUT: PresetDef = {
   leftSegments: ["model", "thinking", "shell_mode", "path", "git", "context_pct", "cache_read", "cost"],
   rightSegments: [],
   secondarySegments: ["extension_statuses"],
   separator: "powerline-thin",
   colors: getDefaultColors(),
   segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 40 },
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
   },
};

export function hasNonWhitespaceText(text: string): boolean {
   return text.trim().length > 0;
}

export function getCurrentEditorText(ctx: any, editor: any): string {
   return editor?.getExpandedText?.() ?? ctx.ui.getEditorText();
}

export function buildStashPreview(text: string, maxWidth: number): string {
   const compact = text.replace(/\s+/g, " ").trim();
   if (!compact) return "(empty)";
   return truncateToWidth(compact, maxWidth, "…");
}

export function pushStashHistory(history: string[], text: string): boolean {
   if (!hasNonWhitespaceText(text)) return false;
   if (history[0] === text) return false;

   history.unshift(text);
   if (history.length > STASH_HISTORY_LIMIT) {
      history.length = STASH_HISTORY_LIMIT;
   }

   return true;
}

export function normalizeShortcut(value: string): string {
   const parts = value.trim().toLowerCase().split("+");
   if (parts.length <= 1) return parts[0] ?? "";

   const modifierRank = new Map<string, number>(SHORTCUT_MODIFIER_ORDER.map((modifier, index) => [modifier, index]));
   const modifiers = parts.slice(0, -1).sort((a, b) => (modifierRank.get(a) ?? 99) - (modifierRank.get(b) ?? 99));
   return [...modifiers, parts[parts.length - 1]].join("+");
}

export function reservedShortcuts(): Set<string> {
   const shortcuts = new Set<string>([...EXTRA_RESERVED_SHORTCUTS, ...APP_RESERVED_SHORTCUTS].map(normalizeShortcut));

   for (const definition of Object.values(TUI_KEYBINDINGS)) {
      const defaultKeys = definition.defaultKeys;
      const keys = defaultKeys === undefined ? [] : Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys];
      for (const key of keys) {
         shortcuts.add(normalizeShortcut(key));
      }
   }

   return shortcuts;
}

export function isValidShortcutKeyPart(keyPart: string): boolean {
   const lowerKeyPart = keyPart.toLowerCase();

   if (/^[a-z0-9]$/i.test(keyPart)) return true;
   if (/^f([1-9]|1[0-2])$/i.test(keyPart)) return true;
   if (SHORTCUT_NAMED_KEYS.has(lowerKeyPart)) return true;

   return SHORTCUT_SYMBOL_KEYS.has(keyPart);
}

export function parseShortcutOverride(value: unknown): string | null {
   if (typeof value !== "string") {
      return null;
   }

   const trimmed = value.trim();
   if (!trimmed || /\s/.test(trimmed)) {
      return null;
   }

   const parts = trimmed.split("+");
   if (parts.some((part) => part.length === 0)) {
      return null;
   }

   const modifierParts = parts.slice(0, -1).map((part) => {
      const modifier = part.toLowerCase();
      return modifier === "cmd" || modifier === "command" ? "super" : modifier;
   });
   if (new Set(modifierParts).size !== modifierParts.length) {
      return null;
   }

   for (const modifier of modifierParts) {
      if (!(SHORTCUT_MODIFIERS as ReadonlySet<string>).has(modifier)) {
         return null;
      }
   }

   const keyPart = parts[parts.length - 1];
   if (!isValidShortcutKeyPart(keyPart)) {
      return null;
   }

   const normalizedKey = SHORTCUT_SYMBOL_KEYS.has(keyPart) ? keyPart : keyPart.toLowerCase();
   const normalizedShortcut = normalizeShortcut([...modifierParts, normalizedKey].join("+"));
   if (shortcutUsesSuper(normalizedShortcut) && !isSupportedSuperShortcut(normalizedShortcut)) {
      return null;
   }

   return normalizedShortcut;
}

export function shortcutUsageKey(shortcut: string): string {
   return shortcutConflictKey(normalizeShortcut(shortcut));
}

export function findShortcutReplacement(key: PowerlineShortcutKey, used: Set<string>): string | null {
   const preferred = DEFAULT_SHORTCUTS[key];
   if (!used.has(shortcutUsageKey(preferred))) {
      return preferred;
   }

   for (const shortcutKey of SHORTCUT_KEYS) {
      const candidate = DEFAULT_SHORTCUTS[shortcutKey];
      if (!used.has(shortcutUsageKey(candidate))) {
         return candidate;
      }
   }

   return null;
}

export function resolveShortcutConfig(settings: Record<string, unknown>): PowerlineShortcuts {
   const resolved: PowerlineShortcuts = { ...DEFAULT_SHORTCUTS };
   const shortcutSettings = settings.powerlineShortcuts;

   if (isRecord(shortcutSettings)) {
      for (const key of SHORTCUT_KEYS) {
         const override = parseShortcutOverride(shortcutSettings[key]);
         if (override) {
            resolved[key] = override;
         }
      }
   }

   const used = new Set(Array.from(reservedShortcuts(), shortcutUsageKey));

   for (const key of SHORTCUT_KEYS) {
      const configured = resolved[key];
      const configuredUsageKey = shortcutUsageKey(configured);

      if (!used.has(configuredUsageKey)) {
         used.add(configuredUsageKey);
         continue;
      }

      const replacement = findShortcutReplacement(key, used);
      if (!replacement) {
         console.debug(`[powerline-footer] Shortcut conflict for ${key}: "${configured}" is already in use`);
         continue;
      }

      console.debug(`[powerline-footer] Shortcut conflict for ${key}: "${configured}" replaced with "${replacement}"`);

      resolved[key] = replacement;
      used.add(shortcutUsageKey(replacement));
   }

   return resolved;
}

export function parseBashModeSettings(settings: Record<string, unknown>): BashModeSettings {
   const raw = isRecord(settings.bashMode) ? settings.bashMode : {};

   const configuredToggleShortcut = parseShortcutOverride(raw.toggleShortcut);
   const toggleShortcut =
      configuredToggleShortcut && !reservedShortcuts().has(shortcutUsageKey(configuredToggleShortcut))
         ? configuredToggleShortcut
         : DEFAULT_BASH_MODE_SETTINGS.toggleShortcut;

   if (configuredToggleShortcut && toggleShortcut !== configuredToggleShortcut) {
      console.debug(
         `[powerline-footer] Bash mode shortcut conflict: "${configuredToggleShortcut}" replaced with "${toggleShortcut}"`,
      );
   }
   const transcriptMaxLines =
      typeof raw.transcriptMaxLines === "number" && Number.isFinite(raw.transcriptMaxLines)
         ? Math.max(100, Math.floor(raw.transcriptMaxLines))
         : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxLines;
   const transcriptMaxBytes =
      typeof raw.transcriptMaxBytes === "number" && Number.isFinite(raw.transcriptMaxBytes)
         ? Math.max(16 * 1024, Math.floor(raw.transcriptMaxBytes))
         : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxBytes;

   return {
      toggleShortcut,
      transcriptMaxLines,
      transcriptMaxBytes,
   };
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
export function renderSegmentWithWidth(
   segId: StatusLineSegmentId,
   ctx: SegmentContext,
): { content: string; width: number; visible: boolean } {
   const rendered = renderSegment(segId, ctx);
   if (!rendered.visible || !rendered.content) {
      return { content: "", width: 0, visible: false };
   }
   return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Build content string from pre-rendered parts */
export function buildContentFromParts(parts: string[], layoutDef: PresetDef): string {
   if (parts.length === 0) return "";
   const separatorDef = getSeparator(layoutDef.separator);
   const sepAnsi = getFgAnsiCode("sep");
   const sep = separatorDef.left;
   return parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset;
}

/**
 * Responsive segment layout - fits segments into top bar, overflows to secondary row.
 * When terminal is wide enough, secondary segments move up to top bar.
 * When narrow, top bar segments overflow down to secondary row.
 */
export function computeResponsiveLayout(
   ctx: SegmentContext,
   layoutDef: PresetDef,
   availableWidth: number,
   customItems: CustomStatusItem[] = [],
): { pathContent: string; topContent: string; extensionContent: string; secondaryContent: string } {
   const separatorDef = getSeparator(layoutDef.separator);
   const sepWidth = visibleWidth(separatorDef.left) + 2; // separator + spaces around it

   // Get all segments: primary first, then secondary
   const mergedSegments = mergeSegmentsWithCustomItems(layoutDef, customItems);
   const primaryIds = [...mergedSegments.leftSegments, ...mergedSegments.rightSegments];
   const secondaryIds = mergedSegments.secondarySegments;
   const allSegmentIds = [...primaryIds, ...secondaryIds];

   const pathRowSegmentIds: StatusLineSegmentId[] = ["path", "git"];
   const pathRowSegments: string[] = [];
   for (const segId of pathRowSegmentIds) {
      if (!allSegmentIds.includes(segId)) continue;
      const { content, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) pathRowSegments.push(content);
   }
   const pathRowRightSegments: string[] = [];
   for (const segId of ["skills", "mcp"] satisfies StatusLineSegmentId[]) {
      const { content, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) pathRowRightSegments.push(content);
   }
   const pathRowRightContent = buildContentFromParts(pathRowRightSegments, layoutDef);
   const pathRowLeftContent = buildContentFromParts(pathRowSegments, layoutDef);
   const pathRowLeftWidth = visibleWidth(pathRowLeftContent);
   const pathRowRightWidth = visibleWidth(pathRowRightContent);
   const pathRowGap =
      pathRowRightContent && pathRowLeftWidth + pathRowRightWidth < availableWidth
         ? " ".repeat(availableWidth - pathRowLeftWidth - pathRowRightWidth)
         : pathRowRightContent && !pathRowLeftContent
           ? " ".repeat(Math.max(0, availableWidth - pathRowRightWidth))
           : "";
   const pathContent = pathRowRightContent
      ? `${pathRowLeftContent}${pathRowGap}${pathRowRightContent}`
      : pathRowLeftContent;

   const extensionSegment = allSegmentIds.includes("extension_statuses")
      ? renderSegmentWithWidth("extension_statuses", ctx)
      : null;
   const extensionContent = extensionSegment?.visible
      ? buildContentFromParts([extensionSegment.content], layoutDef)
      : "";

   const rightAlignedMainSegmentIds: StatusLineSegmentId[] = ["model", "thinking"];
   const leftMainSegmentIds = allSegmentIds.filter(
      (segId) =>
         !pathRowSegmentIds.includes(segId) &&
         segId !== "extension_statuses" &&
         !rightAlignedMainSegmentIds.includes(segId),
   );
   const rightMainSegmentIds = rightAlignedMainSegmentIds.filter((segId) => allSegmentIds.includes(segId));

   // Render all segments and get their widths
   const renderedSegments: { content: string; width: number }[] = [];
   for (const segId of leftMainSegmentIds) {
      const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
         renderedSegments.push({ content, width });
      }
   }
   const rightSegments: string[] = [];
   for (const segId of rightMainSegmentIds) {
      const { content, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) rightSegments.push(content);
   }
   const rightContent = buildContentFromParts(rightSegments, layoutDef);

   if (renderedSegments.length === 0) {
      return { pathContent, topContent: "", extensionContent, secondaryContent: "" };
   }

   // Calculate how many segments fit in top bar
   // Account for: leading space (1) + trailing space (1) = 2 chars overhead
   const baseOverhead = 2;
   let currentWidth = baseOverhead;
   let topSegments: string[] = [];
   let overflowSegments: { content: string; width: number }[] = [];
   let overflow = false;

   for (const seg of renderedSegments) {
      const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);

      if (!overflow && currentWidth + neededWidth <= availableWidth) {
         topSegments.push(seg.content);
         currentWidth += neededWidth;
      } else {
         overflow = true;
         overflowSegments.push(seg);
      }
   }

   // Fit overflow segments into secondary row (same width constraint)
   // Stop at first non-fitting segment to preserve ordering
   let secondaryWidth = baseOverhead;
   let secondarySegments: string[] = [];

   for (const seg of overflowSegments) {
      const neededWidth = seg.width + (secondarySegments.length > 0 ? sepWidth : 0);
      if (secondaryWidth + neededWidth <= availableWidth) {
         secondarySegments.push(seg.content);
         secondaryWidth += neededWidth;
      } else {
         break;
      }
   }

   const leftContent = buildContentFromParts(topSegments, layoutDef);
   const leftWidth = visibleWidth(leftContent);
   const rightWidth = visibleWidth(rightContent);
   const gap =
      rightContent && leftWidth + rightWidth < availableWidth
         ? " ".repeat(availableWidth - leftWidth - rightWidth)
         : rightContent && !leftContent
           ? " ".repeat(Math.max(0, availableWidth - rightWidth))
           : "";

   return {
      pathContent,
      topContent: rightContent ? `${leftContent}${gap}${rightContent}` : leftContent,
      extensionContent,
      secondaryContent: buildContentFromParts(secondarySegments, layoutDef),
   };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════
