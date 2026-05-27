/**
 * Hook System Extension (Pre/Post Tool Middleware)
 *
 * Adds a middleware chain around tool calls with three hooks:
 * - PreToolUse: runs before tool executes — can block, modify input, or
 *   inject additional context into the AI request.
 * - PostToolUse: runs after tool result — can augment output or capture
 *   side effects.
 * - Stop: runs on agent stop — can intercept completion, trigger retry,
 *   or log session outcome.
 *
 * Includes a TrustManager that validates hook scripts by fingerprint
 * and an AuditLogger that records all decisions to .pi/audit/.
 * Permission levels: standard (ask), bypass (auto-allow), auto-accept (silent).
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionMode = "standard" | "bypass" | "auto-accept";

export interface HookContext {
   toolName: string;
   toolCallId: string;
   input: Record<string, unknown>;
   additionalContext?: string;
}

export interface HookResult {
   block?: boolean;
   reason?: string;
   additionalContext?: string;
}

export interface StopHookResult {
   retry?: boolean;
   retryFeedback?: string;
   stopSession?: boolean;
   stopReason?: string;
}

export interface HookEntry {
   name: string;
   event: "PreToolUse" | "PostToolUse" | "Stop";
   fingerprint: string;
   source: "builtin" | "extension" | "user";
   handler: (ctx: HookContext) => HookResult | Promise<HookResult>;
   description?: string;
}

export interface AuditRecord {
   timestamp: number;
   event: string;
   toolName: string;
   toolCallId: string;
   hookName: string;
   outcome: "allowed" | "blocked" | "augmented" | "error";
   reason?: string;
}

// ---------------------------------------------------------------------------
// Trust Manager
// ---------------------------------------------------------------------------

class TrustManager {
   private trusted: Set<string> = new Set();
   private initialized = false;

   async load(trustFilePath: string): Promise<void> {
      if (this.initialized) return;
      try {
         if (existsSync(trustFilePath)) {
            const data = JSON.parse(readFileSync(trustFilePath, "utf-8")) as string[];
            data.forEach((fp) => this.trusted.add(fp));
         }
      } catch {
         // no trust file yet
      }
      this.initialized = true;
   }

   computeFingerprint(source: string): string {
      return createHash("sha256").update(source).digest("hex").slice(0, 16);
   }

   isTrusted(fingerprint: string): boolean {
      return this.trusted.has(fingerprint);
   }

   trust(fingerprint: string): void {
      this.trusted.add(fingerprint);
   }

   revoke(fingerprint: string): void {
      this.trusted.delete(fingerprint);
   }

   save(trustFilePath: string): void {
      try {
         const dir = join(trustFilePath, "..");
         if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
         writeFileSync(trustFilePath, JSON.stringify([...this.trusted], null, 2), "utf-8");
      } catch {
         // best-effort
      }
   }
}

// ---------------------------------------------------------------------------
// Audit Logger
// ---------------------------------------------------------------------------

class AuditLogger {
   private logPath: string;

   constructor(logPath: string) {
      this.logPath = logPath;
   }

   log(record: AuditRecord): void {
      try {
         const dir = join(this.logPath, "..");
         if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
         appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf-8");
      } catch {
         // best-effort
      }
   }

   query(toolName?: string, limit = 50): AuditRecord[] {
      try {
         if (!existsSync(this.logPath)) return [];
         const raw = readFileSync(this.logPath, "utf-8");
         const lines = raw.trim().split("\n").filter(Boolean);
         const records: AuditRecord[] = [];
         for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
            try {
               const rec = JSON.parse(lines[i]) as AuditRecord;
               if (!toolName || rec.toolName === toolName) records.push(rec);
            } catch {
               // skip malformed
            }
         }
         return records;
      } catch {
         return [];
      }
   }
}

// ---------------------------------------------------------------------------
// Hook Registry
// ---------------------------------------------------------------------------

class HookRegistry {
   private hooks: HookEntry[] = [];

   register(entry: HookEntry): void {
      this.hooks.push(entry);
   }

   unregister(name: string): void {
      this.hooks = this.hooks.filter((h) => h.name !== name);
   }

   getForEvent(event: "PreToolUse" | "PostToolUse" | "Stop"): HookEntry[] {
      return this.hooks.filter((h) => h.event === event);
   }

   getAll(): HookEntry[] {
      return [...this.hooks];
   }

   clear(): void {
      this.hooks = [];
   }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
   const baseDir = join(process.cwd(), ".pi");
   const auditDir = join(baseDir, "audit");
   const trustFile = join(baseDir, "hook-trust.json");
   const auditFile = join(auditDir, "hook-audit.ndjson");

   if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });

   const trustManager = new TrustManager();
   const auditLogger = new AuditLogger(auditFile);
   const registry = new HookRegistry();

   let permissionMode: PermissionMode = "standard";

   // Load trust on start
   trustManager.load(trustFile).catch(() => {});

   // ------------------------------------------------------------------
   // Built-in hooks
   // ------------------------------------------------------------------

   // PreToolUse: null check guard — blocks tool calls with empty required fields
   registry.register({
      name: "null-check-guard",
      event: "PreToolUse",
      fingerprint: trustManager.computeFingerprint("builtin:null-check-guard"),
      source: "builtin",
      description: "Blocks tool calls with missing required string inputs",
      handler: (ctx: HookContext): HookResult => {
         for (const [key, value] of Object.entries(ctx.input)) {
            if (typeof value === "string" && !value.trim()) {
               return { block: true, reason: `Field '${key}' is empty` };
            }
         }
         return {};
      }
   });

   // PreToolUse: path safety — blocks writes to sensitive paths
   registry.register({
      name: "path-safety",
      event: "PreToolUse",
      fingerprint: trustManager.computeFingerprint("builtin:path-safety"),
      source: "builtin",
      description: "Blocks writes to .env, .git",
      handler: (ctx: HookContext): HookResult => {
         const path = ctx.input.path as string | undefined;
         if (!path) return {};

         const sensitive = [".env", ".git/"];
         const matched = sensitive.find((s) => path.includes(s));
         if (matched) {
            return { block: true, reason: `Path contains sensitive directory: ${matched}` };
         }
         return {};
      }
   });

   // PostToolUse: captures side effects from write/edit
   registry.register({
      name: "file-change-capture",
      event: "PostToolUse",
      fingerprint: trustManager.computeFingerprint("builtin:file-change-capture"),
      source: "builtin",
      description: "Captures file write paths for context injection",
      handler: (ctx: HookContext): HookResult => {
         if (ctx.toolName === "write" || ctx.toolName === "edit") {
            const path = ctx.input.path as string | undefined;
            if (path) {
               return {
                  additionalContext: `[File modified: ${path}]`
               };
            }
         }
         return {};
      }
   });

   // ------------------------------------------------------------------
   // Event handlers
   // ------------------------------------------------------------------

   // PreToolUse: run registered hooks before tool execution
   pi.on("tool_call", async (event, ctx) => {
      const hooks = registry.getForEvent("PreToolUse");
      if (hooks.length === 0) return undefined;

      const hookCtx: HookContext = {
         toolName: event.toolName,
         toolCallId: event.toolCallId,
         input: event.input as Record<string, unknown>
      };

      for (const hook of hooks) {
         // Skip untrusted hooks in standard mode
         if (permissionMode === "standard" && hook.source !== "builtin" && !trustManager.isTrusted(hook.fingerprint)) {
            continue;
         }

         try {
            const result = await hook.handler(hookCtx);

            auditLogger.log({
               timestamp: Date.now(),
               event: "PreToolUse",
               toolName: event.toolName,
               toolCallId: event.toolCallId,
               hookName: hook.name,
               outcome: result.block ? "blocked" : "allowed",
               reason: result.reason
            });

            if (result.block) {
               if (ctx.hasUI) {
                  ctx.ui.notify(
                     `Hook "${hook.name}" blocked ${event.toolName}: ${result.reason ?? "no reason"}`,
                     "warning"
                  );
               }
               return { block: true, reason: result.reason ?? `Blocked by hook: ${hook.name}` };
            }

            // Collect additional context from hooks
            if (result.additionalContext) {
               hookCtx.additionalContext = hookCtx.additionalContext
                  ? `${hookCtx.additionalContext}\n${result.additionalContext}`
                  : result.additionalContext;
            }
         } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            auditLogger.log({
               timestamp: Date.now(),
               event: "PreToolUse",
               toolName: event.toolName,
               toolCallId: event.toolCallId,
               hookName: hook.name,
               outcome: "error",
               reason: msg
            });
         }
      }

      // If hooks collected additional context, inject it into the input
      if (hookCtx.additionalContext) {
         (event.input as Record<string, unknown>)._hookContext = hookCtx.additionalContext;
      }

      return undefined;
   });

   // PostToolUse: run registered hooks after tool result
   pi.on("tool_result", async (event) => {
      const hooks = registry.getForEvent("PostToolUse");
      if (hooks.length === 0) return undefined;

      const hookCtx: HookContext = {
         toolName: event.toolName,
         toolCallId: event.toolCallId,
         input: event.input as Record<string, unknown>
      };

      let additionalContext = "";

      for (const hook of hooks) {
         if (permissionMode === "standard" && hook.source !== "builtin" && !trustManager.isTrusted(hook.fingerprint)) {
            continue;
         }

         try {
            const result = await hook.handler(hookCtx);

            auditLogger.log({
               timestamp: Date.now(),
               event: "PostToolUse",
               toolName: event.toolName,
               toolCallId: event.toolCallId,
               hookName: hook.name,
               outcome: result.additionalContext ? "augmented" : "allowed"
            });

            if (result.additionalContext) {
               additionalContext += `\n${result.additionalContext}`;
            }
         } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            auditLogger.log({
               timestamp: Date.now(),
               event: "PostToolUse",
               toolName: event.toolName,
               toolCallId: event.toolCallId,
               hookName: hook.name,
               outcome: "error",
               reason: msg
            });
         }
      }

      if (additionalContext) {
         return {
            ...(event as unknown as Record<string, unknown>),
            details: {
               ...(event.details as unknown as Record<string, unknown>),
               _hookAdditionalContext: additionalContext.trim()
            }
         } as typeof event;
      }

      return undefined;
   });

   // ------------------------------------------------------------------
   // Commands
   // ------------------------------------------------------------------

   pi.registerCommand("hook-list", {
      description: "List all registered hooks",
      handler: async (_args, ctx) => {
         const all = registry.getAll();
         if (all.length === 0) {
            ctx.ui.notify("No hooks registered.", "info");
            return;
         }
         const lines = all.map((h) => `  [${h.event}] ${h.name} (${h.source}) — ${h.description ?? "no description"}`);
         ctx.ui.notify(`Registered hooks (${all.length}):\n${lines.join("\n")}`, "info");
      }
   });

   pi.registerCommand("hook-trust", {
      description: "Manage hook trust: /hook-trust <fingerprint>",
      handler: async (args, ctx) => {
         const fp = args?.trim();
         if (!fp) {
            ctx.ui.notify("Usage: /hook-trust <fingerprint>", "info");
            return;
         }
         if (trustManager.isTrusted(fp)) {
            ctx.ui.notify(`Fingerprint already trusted: ${fp}`, "info");
            return;
         }
         trustManager.trust(fp);
         trustManager.save(trustFile);
         ctx.ui.notify(`Trusted fingerprint: ${fp}`, "info");
      }
   });

   pi.registerCommand("hook-permission", {
      description: "Set permission mode: /hook-permission <standard|bypass|auto-accept>",
      handler: async (args, ctx) => {
         const mode = args?.trim().toLowerCase() as PermissionMode;
         if (!["standard", "bypass", "auto-accept"].includes(mode)) {
            ctx.ui.notify("Usage: /hook-permission <standard|bypass|auto-accept>", "warning");
            return;
         }
         permissionMode = mode;
         ctx.ui.notify(`Hook permission mode set to: ${mode}`, "info");
      }
   });

   pi.registerCommand("hook-audit", {
      description: "Show recent audit log entries: /hook-audit [toolName]",
      handler: async (args, ctx) => {
         const toolName = args?.trim() || undefined;
         const records = auditLogger.query(toolName, 20);
         if (records.length === 0) {
            ctx.ui.notify("No audit records found.", "info");
            return;
         }
         const lines = records.map(
            (r) =>
               `  [${new Date(r.timestamp).toISOString().slice(11, 19)}] ${r.event} → ${r.toolName}: ${r.outcome}${r.reason ? " (" + r.reason + ")" : ""}`
         );
         ctx.ui.notify(`Recent audit (${records.length}):\n${lines.join("\n")}`, "info");
      }
   });
}
