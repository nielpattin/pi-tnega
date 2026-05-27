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
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
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

interface LoadedConfig {
   paths: string[];
   rules: Rule[];
   debugLog: boolean;
   permissionReviewLog: boolean;
   yoloMode: boolean;
}

type PermissionDecision = "once" | "always" | "reject";

type PermissionTheme = {
   bold(text: string): string;
   fg(name: "accent" | "muted" | "warning" | "error" | "success", text: string): string;
   inverse?(text: string): string;
};

interface PermissionContext {
   cwd: string;
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

function sessionId(ctx: PermissionContext): string {
   return ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
}

function logEvent(ctx: PermissionContext, enabled: boolean, event: Record<string, unknown>): void {
   if (!enabled) return;
   const file = logPath(sessionId(ctx));
   mkdirSync(dirname(file), { recursive: true });
   appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, "utf8");
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
         const decision = await showPermissionPrompt(permissionCtx, {
            toolName: event.toolName,
            permission,
            pattern: approvalPattern,
            input
         });

         if (decision === "reject") {
            logEvent(permissionCtx, loaded.permissionReviewLog, {
               type: "reject",
               tool: event.toolName,
               permission,
               pattern: approvalPattern
            });
            return {
               block: true,
               reason: `Permission rejected by user for ${event.toolName} (${permission}: ${approvalPattern}).`
            };
         }

         if (decision === "always") {
            const newRule: Rule = { permission, pattern: approvalPattern, action: "allow" };
            approvedRules.push(newRule);
         }

         logEvent(permissionCtx, loaded.permissionReviewLog, {
            type: "approve",
            tool: event.toolName,
            permission,
            pattern: approvalPattern,
            decision
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

function showPermissionPrompt(ctx: PermissionContext, request: PermissionPromptRequest): Promise<PermissionDecision> {
   return ctx.ui.custom<PermissionDecision>((tui, theme, _keybindings, done) => {
      return new PermissionPromptComponent(ctx.cwd, request, theme, done, () => tui.requestRender());
   });
}

class PermissionPromptComponent implements Component {
   private selected = 1;
   private readonly options: PermissionDecision[] = ["once", "always", "reject"];

   constructor(
      private readonly cwd: string,
      private readonly request: PermissionPromptRequest,
      private readonly theme: PermissionTheme,
      private readonly done: (decision: PermissionDecision) => void,
      private readonly requestRender: () => void
   ) {}

   render(width: number): string[] {
      const innerWidth = Math.max(32, width - 6);
      const info = permissionInfo(this.cwd, this.request);
      const rail = this.theme.fg("accent", "│");
      const lines: string[] = [];

      lines.push("");
      lines.push(this.fit(`  ${this.theme.fg("warning", "△")} ${this.theme.bold("Permission required")}`, width));
      lines.push(this.fit(`  ${rail}`, width));
      lines.push(this.fit(`  ${rail}  ${info.title}`, width));

      if (info.lines.length > 0) {
         lines.push(this.fit(`  ${rail}`, width));
         for (const line of info.lines) {
            lines.push(this.fit(`  ${rail}  ${this.theme.fg("muted", line)}`, width));
         }
      }

      lines.push(this.fit(`  ${rail}`, width));
      lines.push(this.fit(`  ${rail}  ${this.renderButtons()}`, width));
      lines.push(this.fit(`  ${rail}`, width));
      lines.push(this.fit(`  ${rail}  ${this.theme.fg("muted", "←/→ select   enter confirm   esc reject")}`, width));
      lines.push("");

      return lines.map((line) => truncateToWidth(line, innerWidth + 6));
   }

   handleInput(data: string): void {
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
         this.done("reject");
         return;
      }
      if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
         this.done(this.options[this.selected] ?? "reject");
      }
   }

   invalidate(): void {}

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
}

function permissionInfo(cwd: string, request: PermissionPromptRequest): { title: string; lines: string[] } {
   switch (request.toolName) {
      case "bash": {
         const command = String(request.input.command ?? "unknown");
         return { title: `Run ${command}`, lines: [`Command: ${command}`] };
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
