/**
 * Permission System Extension
 *
 * Config resolution mirrors pi settings:
 * 1. Global: ~/.pi/agent/permission.jsonc
 * 2. Project override: <cwd>/.pi/permission.jsonc
 *
 * Project config overrides global config. Nested permission objects merge.
 * JSONC comments and trailing commas are supported.
 *
 * Logs:
 * ~/.pi/agent/pi-permission-system/<session-id>.jsonl
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative } from "path";
import { evaluatePatterns } from "./evaluator.ts";
import { mergeAllRulesets, normalizeConfig } from "./merge.ts";
import { bashAdapter, editAdapter, readAdapter } from "./adapters.ts";
import type { PermissionConfig, Rule } from "./types.ts";

interface RawConfig {
   debugLog?: boolean;
   permissionReviewLog?: boolean;
   yoloMode?: boolean;
   permission?: PermissionConfig;
}

interface PiPermissionSystemSettings {
   sound?: unknown;
   volume?: unknown;
}

interface PermissionSoundSettings {
   sound: string;
   volume: number;
}

interface LoadedConfig {
   paths: string[];
   rules: Rule[];
   debugLog: boolean;
   permissionReviewLog: boolean;
   yoloMode: boolean;
}

type PermissionDecision = "once" | "always" | "reject";
type PermissionPromptResult = { decision: PermissionDecision; message?: string };
type PermissionSettingKey = "yoloMode" | "debugLog";

interface PermissionSettings {
   yoloMode: boolean;
   debugLog: boolean;
}

type PermissionTheme = {
   bold(text: string): string;
   fg(name: "accent" | "muted" | "warning" | "error" | "success", text: string): string;
   inverse?(text: string): string;
};

interface PermissionContext {
   cwd: string;
   hasUI?: boolean;
   ui: {
      custom<T>(
         factory: (
            tui: { requestRender(): void },
            theme: PermissionTheme,
            keybindings: unknown,
            done: (value: T) => void
         ) => Component,
         options?: unknown
      ): Promise<T>;
   };
   sessionManager?: {
      getSessionId?: () => string;
   };
}

function agentDir(override?: string): string {
   return override ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function globalConfigPath(agentDirOverride?: string): string {
   return join(agentDir(agentDirOverride), "permission.jsonc");
}

function projectConfigPath(cwd: string): string {
   return join(cwd, ".pi", "permission.jsonc");
}

function settingsPath(agentDirOverride?: string): string {
   return join(agentDir(agentDirOverride), "settings.json");
}

function logPath(sessionId: string): string {
   return join(agentDir(), "pi-permission-system", `${sessionId}.jsonl`);
}

function stripJsonc(input: string): string {
   let withoutComments = "";
   let inString = false;
   let escape = false;

   for (let i = 0; i < input.length; i++) {
      const char = input[i];
      const next = input[i + 1];

      if (inString) {
         withoutComments += char;
         if (escape) {
            escape = false;
         } else if (char === "\\") {
            escape = true;
         } else if (char === '"') {
            inString = false;
         }
         continue;
      }

      if (char === '"') {
         inString = true;
         withoutComments += char;
         continue;
      }

      if (char === "/" && next === "/") {
         while (i < input.length && input[i] !== "\n") i++;
         withoutComments += "\n";
         continue;
      }

      if (char === "/" && next === "*") {
         i += 2;
         while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
         i++;
         continue;
      }

      withoutComments += char;
   }

   let output = "";
   inString = false;
   escape = false;
   for (let i = 0; i < withoutComments.length; i++) {
      const char = withoutComments[i];
      if (inString) {
         output += char;
         if (escape) {
            escape = false;
         } else if (char === "\\") {
            escape = true;
         } else if (char === '"') {
            inString = false;
         }
         continue;
      }

      if (char === '"') {
         inString = true;
         output += char;
         continue;
      }

      if (char === ",") {
         let j = i + 1;
         while (j < withoutComments.length && /\s/.test(withoutComments[j] ?? "")) j++;
         if (withoutComments[j] === "}" || withoutComments[j] === "]") continue;
      }

      output += char;
   }

   return output;
}

function parseJsonc(text: string): unknown {
   return JSON.parse(stripJsonc(text));
}

function mergeRawConfig(base: RawConfig, override: RawConfig): RawConfig {
   return {
      ...base,
      ...override,
      permission: mergePermissionConfig(base.permission, override.permission)
   };
}

function mergePermissionConfig(
   base: PermissionConfig | undefined,
   override: PermissionConfig | undefined
): PermissionConfig | undefined {
   if (!base) return override;
   if (!override) return base;

   const merged: PermissionConfig = { ...base };
   for (const [key, value] of Object.entries(override)) {
      const existing = merged[key];
      if (
         existing &&
         typeof existing === "object" &&
         !Array.isArray(existing) &&
         typeof value === "object" &&
         !Array.isArray(value)
      ) {
         merged[key] = { ...existing, ...value };
      } else {
         merged[key] = value;
      }
   }
   return merged;
}

function readRawConfig(path: string): RawConfig | undefined {
   if (!existsSync(path)) return undefined;
   return parseJsonc(readFileSync(path, "utf8")) as RawConfig;
}

function globalPermissionSettings(agentDirOverride?: string): PermissionSettings {
   const config = readRawConfig(globalConfigPath(agentDirOverride)) ?? {};
   return {
      yoloMode: config.yoloMode === true,
      debugLog: config.debugLog === true
   };
}

function updateGlobalPermissionSettings(
   settings: Partial<PermissionSettings>,
   agentDirOverride?: string
): PermissionSettings {
   const path = globalConfigPath(agentDirOverride);
   const config = readRawConfig(path) ?? {};
   const next: RawConfig = { ...config, ...settings };
   mkdirSync(dirname(path), { recursive: true });
   writeFileSync(path, `${JSON.stringify(next, null, 3)}\n`, "utf8");
   return globalPermissionSettings(agentDirOverride);
}

function loadPermissionConfig(cwd: string, agentDirOverride?: string): LoadedConfig {
   const paths = [globalConfigPath(agentDirOverride), projectConfigPath(cwd)];
   let merged: RawConfig = {};
   const loadedPaths: string[] = [];

   for (const path of paths) {
      try {
         const config = readRawConfig(path);
         if (!config) continue;
         merged = mergeRawConfig(merged, config);
         loadedPaths.push(path);
      } catch {
         loadedPaths.push(path);
         merged = mergeRawConfig(merged, { debugLog: true, permissionReviewLog: true, yoloMode: false });
      }
   }

   return {
      paths: loadedPaths,
      rules: merged.permission ? normalizeConfig(merged.permission) : [],
      debugLog: merged.debugLog === true,
      permissionReviewLog: merged.permissionReviewLog === true,
      yoloMode: merged.yoloMode === true
   };
}

export function loadPermissionConfigForTest(cwd: string, agentDirOverride: string): LoadedConfig {
   return loadPermissionConfig(cwd, agentDirOverride);
}

function defaultPermissionSoundSettings(agentDirOverride?: string): PermissionSoundSettings {
   return {
      sound: join(agentDir(agentDirOverride), "assets", "permission-request.mp3"),
      volume: 100
   };
}

function clampVolume(value: number): number {
   return Math.min(100, Math.max(0, Math.round(value)));
}

function expandHome(path: string): string {
   if (path === "~") return homedir();
   if (path.startsWith("~/")) return join(homedir(), path.slice(2));
   if (path === "$HOME") return homedir();
   if (path.startsWith("$HOME/")) return join(homedir(), path.slice(6));
   return path;
}

function resolveSoundPath(value: unknown, configDir: string): string | undefined {
   if (typeof value !== "string") return undefined;
   const trimmed = value.trim();
   if (!trimmed) return undefined;
   const expanded = expandHome(trimmed);
   if (isAbsolute(expanded)) return expanded;
   return join(configDir, expanded);
}

function loadPermissionSoundSettings(agentDirOverride?: string): PermissionSoundSettings {
   const path = settingsPath(agentDirOverride);
   const defaults = defaultPermissionSoundSettings(agentDirOverride);

   try {
      const parsed = parseJsonc(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
      const section = (parsed as { piPermissionSystem?: unknown }).piPermissionSystem;
      if (!section || typeof section !== "object" || Array.isArray(section)) return defaults;
      const config = section as PiPermissionSystemSettings;
      return {
         sound: resolveSoundPath(config.sound, dirname(path)) ?? defaults.sound,
         volume: typeof config.volume === "number" ? clampVolume(config.volume) : defaults.volume
      };
   } catch {
      return defaults;
   }
}

function sessionId(ctx: PermissionContext): string {
   return ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
}

function logEvent(ctx: PermissionContext, enabled: boolean, event: Record<string, unknown>): void {
   if (!enabled) return;
   const file = logPath(sessionId(ctx));
   mkdirSync(dirname(file), { recursive: true });
   appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, "utf8");
}

function playPermissionSound(pi: ExtensionAPI, ctx: PermissionContext): void {
   if (ctx.hasUI === false) return;
   const sounds = loadPermissionSoundSettings();

   try {
      void pi
         .exec("ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", "-volume", String(sounds.volume), sounds.sound])
         .catch((error) => {
            console.warn("[pi-permission-system] failed to play permission sound:", error);
         });
   } catch (error) {
      console.warn("[pi-permission-system] failed to play permission sound:", error);
   }
}

const TOOL_PERMISSION_MAP: Record<
   string,
   (input: Record<string, unknown>) => { permission: string; patterns: string[] }
> = {
   bash: (input) => {
      const command = input.command as string;
      if (!command) return { permission: "bash", patterns: ["*"] };
      const req = bashAdapter(command);
      return { permission: req.permission, patterns: req.patterns };
   },
   edit: (input) => {
      const path = input.path as string;
      const oldText = (input.oldText as string) ?? "";
      const newText = (input.newText as string) ?? "";
      if (!path) return { permission: "edit", patterns: ["*"] };
      const req = editAdapter(path, oldText, newText);
      return { permission: req.permission, patterns: req.patterns };
   },
   read: (input) => {
      const path = input.path as string;
      if (!path) return { permission: "read", patterns: ["*"] };
      const req = readAdapter(path);
      return { permission: req.permission, patterns: req.patterns };
   },
   task: () => ({ permission: "task", patterns: ["*"] })
};

export default function permissionSystem(pi: ExtensionAPI): void {
   let loaded: LoadedConfig = {
      paths: [],
      rules: [],
      debugLog: false,
      permissionReviewLog: false,
      yoloMode: false
   };
   let approvedRules: Rule[] = [];

   pi.registerCommand("permission", {
      description: "Configure permission system settings",
      handler: async (_args, ctx) => {
         const permissionCtx = ctx as PermissionContext;
         await showPermissionSettings(permissionCtx, globalPermissionSettings(), (key, value) => {
            const next = updateGlobalPermissionSettings({ [key]: value });
            loaded = loadPermissionConfig(permissionCtx.cwd);
            return next;
         });
      }
   });

   pi.on("session_start", (_event, ctx) => {
      const permissionCtx = ctx as PermissionContext;
      loaded = loadPermissionConfig(permissionCtx.cwd);
      approvedRules = [];
      logEvent(permissionCtx, loaded.debugLog, {
         type: "config_loaded",
         configPaths: loaded.paths,
         rules: loaded.rules.length,
         approvedRules: approvedRules.length,
         cwd: permissionCtx.cwd
      });
   });

   pi.on("tool_call", async (event, ctx) => {
      const permissionCtx = ctx as PermissionContext;
      const adapter = TOOL_PERMISSION_MAP[event.toolName];
      if (!adapter) return undefined;

      if (loaded.yoloMode) {
         logEvent(permissionCtx, loaded.permissionReviewLog, { type: "allow", reason: "yolo", tool: event.toolName });
         return undefined;
      }

      const input = event.input as Record<string, unknown>;
      const { permission, patterns } = adapter(input);
      const ruleset = mergeAllRulesets(loaded.rules, [], approvedRules);

      logEvent(permissionCtx, loaded.permissionReviewLog, {
         type: "review",
         tool: event.toolName,
         permission,
         patterns,
         rules: loaded.rules.length,
         approvedRules: approvedRules.length
      });

      const action = evaluatePatterns(ruleset, permission, patterns);
      const approvalPattern = patterns[0] ?? "*";
      logEvent(permissionCtx, loaded.permissionReviewLog, {
         type: "evaluate",
         tool: event.toolName,
         permission,
         patterns,
         action
      });

      if (action === "deny") {
         return {
            block: true,
            reason: `Permission denied for ${event.toolName} (${permission}: ${approvalPattern}).`
         };
      }

      if (action === "ask") {
         playPermissionSound(pi, permissionCtx);
         const reply = normalizePermissionPromptResult(
            await showPermissionPrompt(permissionCtx, {
               toolName: event.toolName,
               permission,
               pattern: approvalPattern,
               input
            })
         );

         if (reply.decision === "reject") {
            logEvent(permissionCtx, loaded.permissionReviewLog, {
               type: "reject",
               tool: event.toolName,
               permission,
               pattern: approvalPattern,
               message: reply.message
            });
            const message = reply.message ? ` ${reply.message}` : "";
            return {
               block: true,
               reason: `Permission rejected by user for ${event.toolName} (${permission}: ${approvalPattern}).${message}`
            };
         }

         if (reply.decision === "always") {
            const newRule: Rule = { permission, pattern: approvalPattern, action: "allow" };
            approvedRules.push(newRule);
         }

         logEvent(permissionCtx, loaded.permissionReviewLog, {
            type: "approve",
            tool: event.toolName,
            permission,
            pattern: approvalPattern,
            decision: reply.decision
         });
         return undefined;
      }

      logEvent(permissionCtx, loaded.permissionReviewLog, { type: "allow", tool: event.toolName, permission });
      return undefined;
   });
}

interface PermissionPromptRequest {
   toolName: string;
   permission: string;
   pattern: string;
   input: Record<string, unknown>;
}

function showPermissionPrompt(
   ctx: PermissionContext,
   request: PermissionPromptRequest
): Promise<PermissionPromptResult> {
   return ctx.ui.custom<PermissionPromptResult>((tui, theme, _keybindings, done) => {
      return new PermissionPromptComponent(ctx.cwd, request, theme, done, () => tui.requestRender());
   });
}

function normalizePermissionPromptResult(value: unknown): PermissionPromptResult {
   if (value === "once" || value === "always" || value === "reject") return { decision: value };
   if (value && typeof value === "object" && "decision" in value) return value as PermissionPromptResult;
   return { decision: "reject" };
}

function showPermissionSettings(
   ctx: PermissionContext,
   settings: PermissionSettings,
   onChange: (key: PermissionSettingKey, value: boolean) => PermissionSettings
): Promise<void> {
   return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      return new PermissionSettingsComponent(globalConfigPath(), settings, theme, done, onChange, () =>
         tui.requestRender()
      );
   });
}

class PermissionSettingsComponent implements Component {
   private selected = 0;
   private settings: PermissionSettings;
   private error = "";
   private readonly items: Array<{ key: PermissionSettingKey; label: string }> = [
      { key: "yoloMode", label: "YOLO mode" },
      { key: "debugLog", label: "Debug log" }
   ];

   constructor(
      private readonly path: string,
      settings: PermissionSettings,
      private readonly theme: PermissionTheme,
      private readonly done: () => void,
      private readonly onChange: (key: PermissionSettingKey, value: boolean) => PermissionSettings,
      private readonly requestRender: () => void
   ) {
      this.settings = settings;
   }

   render(width: number): string[] {
      const path = this.path.replaceAll("\\", "/");
      const lines = [
         "",
         `  ${this.theme.bold("Permission Settings")}`,
         `  ${this.theme.fg("muted", path)}`,
         "",
         ...this.items.map((item, index) => this.renderItem(item, index)),
         "",
         `  ${this.theme.fg("muted", "↑/↓ select   enter/space toggle   esc/q close")}`,
         ...(this.error ? [`  ${this.theme.fg("error", this.error)}`] : []),
         ""
      ];
      return lines.map((line) => truncateToWidth(line, width));
   }

   handleInput(data: string): void {
      if (matchesKey(data, Key.up) || data === "k") {
         this.selected = (this.selected + this.items.length - 1) % this.items.length;
         this.requestRender();
         return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
         this.selected = (this.selected + 1) % this.items.length;
         this.requestRender();
         return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
         this.done();
         return;
      }
      if (
         matchesKey(data, Key.enter) ||
         matchesKey(data, Key.space) ||
         data === "\r" ||
         data === "\n" ||
         data === " "
      ) {
         this.toggleSelected();
      }
   }

   invalidate(): void {}

   private renderItem(item: { key: PermissionSettingKey; label: string }, index: number): string {
      const selected = index === this.selected;
      const value = this.settings[item.key] ? "on" : "off";
      const marker = selected ? "›" : " ";
      const text = `${marker} ${item.label}: ${value}`;
      if (selected) return `  ${this.theme.fg("accent", text)}`;
      return `  ${this.theme.fg("muted", text)}`;
   }

   private toggleSelected(): void {
      const item = this.items[this.selected];
      if (!item) return;
      const previous = this.settings;
      const value = !this.settings[item.key];
      this.error = "";
      try {
         this.settings = this.onChange(item.key, value);
      } catch (error) {
         this.settings = previous;
         this.error = error instanceof Error ? error.message : String(error);
      }
      this.requestRender();
   }
}

class PermissionPromptComponent implements Component {
   private selected = 1;
   private stage: "permission" | "reject" = "permission";
   private rejectionMessage = "";
   private readonly options: PermissionDecision[] = ["once", "always", "reject"];

   constructor(
      private readonly cwd: string,
      private readonly request: PermissionPromptRequest,
      private readonly theme: PermissionTheme,
      private readonly done: (result: PermissionPromptResult) => void,
      private readonly requestRender: () => void
   ) {}

   render(width: number): string[] {
      const innerWidth = Math.max(32, width - 6);
      const info = permissionInfo(this.cwd, this.request);
      const rail = this.theme.fg("accent", "│");
      const lines: string[] = [];

      lines.push("");
      lines.push(
         this.fit(
            `  ${this.theme.fg("warning", "△")} ${this.theme.bold(this.stage === "reject" ? "Reject permission" : "Permission required")}`,
            width
         )
      );
      lines.push(this.fit(`  ${rail}`, width));
      lines.push(...this.renderWrappedLine(`  ${rail}  `, info.title, width));

      if (info.lines.length > 0) {
         lines.push(this.fit(`  ${rail}`, width));
         for (const line of info.lines) {
            lines.push(...this.renderWrappedLine(`  ${rail}  `, this.theme.fg("muted", line), width));
         }
      }

      lines.push(this.fit(`  ${rail}`, width));
      if (this.stage === "reject") {
         lines.push(
            ...this.renderWrappedLine(`  ${rail}  `, this.theme.fg("muted", "Tell pi what to do differently"), width)
         );
         lines.push(
            this.fit(`  ${rail}  > ${this.rejectionMessage || this.theme.fg("muted", "type a reason")}`, width)
         );
         lines.push(this.fit(`  ${rail}`, width));
         lines.push(this.fit(`  ${rail}  ${this.theme.fg("muted", "enter reject   esc cancel")}`, width));
      } else {
         lines.push(this.fit(`  ${rail}  ${this.renderButtons()}`, width));
         lines.push(this.fit(`  ${rail}`, width));
         lines.push(this.fit(`  ${rail}  ${this.theme.fg("muted", "←/→ select   enter confirm   esc reject")}`, width));
      }
      lines.push("");

      return lines.map((line) => truncateToWidth(line, innerWidth + 6));
   }

   handleInput(data: string): void {
      if (this.stage === "reject") {
         this.handleRejectInput(data);
         return;
      }
      if (matchesKey(data, Key.left) || data === "h" || data === "\t") {
         this.selected = (this.selected + this.options.length - 1) % this.options.length;
         this.requestRender();
         return;
      }
      if (matchesKey(data, Key.right) || data === "l") {
         this.selected = (this.selected + 1) % this.options.length;
         this.requestRender();
         return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
         this.openRejectStage();
         return;
      }
      if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
         const decision = this.options[this.selected] ?? "reject";
         if (decision === "reject") {
            this.openRejectStage();
            return;
         }
         this.done({ decision });
      }
   }

   invalidate(): void {}

   private handleRejectInput(data: string): void {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
         this.stage = "permission";
         this.selected = this.options.indexOf("reject");
         this.requestRender();
         return;
      }
      if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
         const message = this.rejectionMessage.trim();
         this.done({ decision: "reject", ...(message ? { message } : {}) });
         return;
      }
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
         this.rejectionMessage = this.rejectionMessage.slice(0, -1);
         this.requestRender();
         return;
      }
      if (data.length === 1 && data >= " ") {
         this.rejectionMessage += data;
         this.requestRender();
      }
   }

   private openRejectStage(): void {
      this.stage = "reject";
      this.requestRender();
   }

   private renderButtons(): string {
      return this.options.map((option, index) => this.renderButton(option, index === this.selected)).join("   ");
   }

   private renderButton(option: PermissionDecision, selected: boolean): string {
      const label = option === "once" ? "Allow once" : option === "always" ? "Allow always" : "Reject";
      const text = ` ${label} `;
      if (selected) {
         return this.theme.inverse ? this.theme.inverse(text) : this.theme.fg("warning", `[ ${label} ]`);
      }
      if (option === "reject") return this.theme.fg("error", `[ ${label} ]`);
      return this.theme.fg("muted", `[ ${label} ]`);
   }

   private fit(line: string, width: number): string {
      return truncateToWidth(line, Math.max(1, width));
   }

   private renderWrappedLine(prefix: string, text: string, width: number): string[] {
      const contentWidth = Math.max(1, width - 5);
      const wrapped = wrapTextWithAnsi(text, contentWidth);
      return (wrapped.length > 0 ? wrapped : [""]).map((line) => this.fit(`${prefix}${line}`, width));
   }
}

function permissionInfo(cwd: string, request: PermissionPromptRequest): { title: string; lines: string[] } {
   switch (request.toolName) {
      case "bash": {
         const command = String(request.input.command ?? "").trim();
         const description = String(request.input.description ?? "").trim();
         return { title: description || describeBashCommand(command), lines: [] };
      }
      case "read": {
         const path = displayPath(cwd, request.input.path);
         return { title: `Read ${path}`, lines: [`Path: ${path}`] };
      }
      case "edit": {
         const path = displayPath(cwd, request.input.path);
         return { title: `Edit ${path}`, lines: editLines(path, request.input) };
      }
      case "task":
         return { title: "Start subagent task", lines: [`Task: ${String(request.input.description ?? "unknown")}`] };
      default:
         return { title: `${request.toolName} request`, lines: [`Pattern: ${request.pattern}`] };
   }
}

function describeBashCommand(command: string): string {
   const parts = shellWords(command);
   const tool = (parts[0] ?? "").toLowerCase();
   const args = parts.slice(1);
   const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";

   if ((tool === "bash" || tool === "sh") && args.some((arg) => arg === "-c" || arg === "-lc")) {
      const script = args[args.findIndex((arg) => arg === "-c" || arg === "-lc") + 1] ?? "";
      return `${describeBashCommand(script)} through ${tool}`;
   }
   if (tool === "git") return describeGitCommand(subcommand);
   if (tool === "pnpm") return describePnpmCommand(args);
   if (tool === "mkdir") return describeTargetAction("Create", "directory", args);
   if (tool === "touch") return describeTargetAction("Create or update", "file", args);
   if (tool === "rm") return describeTargetAction("Remove", "path", args);
   if (tool === "cp") return describeCopyMoveCommand("Copy", args);
   if (tool === "mv") return describeCopyMoveCommand("Move", args);
   if (tool === "cat") return describeTargetAction("Print", "file", args);
   if (tool === "ls") return `List files in ${firstCommandTarget(args, ".")}`;
   if (tool === "find") return `Find files under ${firstCommandTarget(args, ".")}`;
   if (tool === "rg") return describeSearchCommand(args);
   if (tool) return `Run ${tool} command`;
   return "Run shell command";
}

function shellWords(command: string): string[] {
   const words: string[] = [];
   let current = "";
   let quote = "";
   let escape = false;

   for (const char of command) {
      if (escape) {
         current += char;
         escape = false;
         continue;
      }
      if (char === "\\") {
         escape = true;
         continue;
      }
      if (quote) {
         if (char === quote) {
            quote = "";
         } else {
            current += char;
         }
         continue;
      }
      if (char === "'" || char === '"') {
         quote = char;
         continue;
      }
      if (/\s/.test(char)) {
         if (current) {
            words.push(current);
            current = "";
         }
         continue;
      }
      current += char;
   }

   if (current) words.push(current);
   return words;
}

function describeGitCommand(subcommand: string): string {
   if (subcommand === "status") return "Show git working tree status";
   if (subcommand === "diff") return "Show git changes";
   if (subcommand === "log") return "Show git commit history";
   if (subcommand === "show") return "Show git object details";
   if (subcommand === "add") return "Stage git changes";
   if (subcommand === "commit") return "Create git commit";
   if (subcommand === "push") return "Push git commits";
   if (subcommand === "pull") return "Pull git updates";
   if (subcommand === "checkout" || subcommand === "switch") return "Switch git branch";
   if (subcommand) return `Run git ${subcommand}`;
   return "Run git command";
}

function describePnpmCommand(args: string[]): string {
   const script = args[0] === "run" ? args[1] : args[0];
   const rest = args[0] === "run" ? args.slice(2) : args.slice(1);
   const target = rest.find((arg) => !arg.startsWith("-"));
   if (script === "test") return target ? `Run tests for ${target}` : "Run project tests";
   if (script === "check") return "Run project checks";
   if (script === "lint") return "Run lint checks";
   if (script === "install") return "Install package dependencies";
   if (script) return `Run pnpm ${script}`;
   return "Run pnpm command";
}

function describeTargetAction(action: string, noun: string, args: string[]): string {
   const targets = args.filter((arg) => !arg.startsWith("-"));
   if (targets.length === 0) return `${action} ${noun}`;
   if (targets.length === 1) return `${action} ${noun} ${targets[0]}`;
   return `${action} ${noun}s ${targets.slice(0, 3).join(", ")}${targets.length > 3 ? ", ..." : ""}`;
}

function describeCopyMoveCommand(action: "Copy" | "Move", args: string[]): string {
   const targets = args.filter((arg) => !arg.startsWith("-"));
   if (targets.length >= 2) return `${action} ${targets[0]} to ${targets[targets.length - 1]}`;
   if (targets.length === 1) return `${action} ${targets[0]}`;
   return `${action} files`;
}

function describeSearchCommand(args: string[]): string {
   const pattern = args.find((arg) => !arg.startsWith("-"));
   if (!pattern) return "Search project text";
   return `Search text for ${pattern}`;
}

function firstCommandTarget(args: string[], fallback: string): string {
   return args.find((arg) => !arg.startsWith("-")) ?? fallback;
}

function displayPath(cwd: string, value: unknown): string {
   if (typeof value !== "string" || value.trim() === "") return "unknown";
   const normalized = value.replaceAll("\\", "/");
   const normalizedCwd = cwd.replaceAll("\\", "/");
   if (!isAbsolute(value)) return normalized;
   const rel = relative(normalizedCwd, normalized).replaceAll("\\", "/");
   if (!rel.startsWith("..") && rel !== "") return rel;
   return normalized;
}

function editLines(path: string, input: Record<string, unknown>): string[] {
   const edits = input.edits;
   if (Array.isArray(edits)) {
      return [`File: ${path}`, `Changes: ${edits.length}`];
   }
   return [`File: ${path}`];
}
