/**
 * Runtime permission service.
 *
 * Manages the permission request lifecycle:
 * - Pending request queue with deferred resolution
 * - Approved-rule cache for "always" decisions
 * - Ask/reply flow with event emission
 * - Session-level reject fanout
 */

import { EventEmitter } from "events";
import { evaluatePatterns } from "./evaluator.ts";
import { mergeAllRulesets } from "./merge.ts";
import type { Action, Rule, Ruleset, PermissionRequest, PermissionReply, PermissionEvent } from "./types.ts";
import { generateRequestId } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

interface PendingEntry {
   request: PermissionRequest;
   resolve: (action: Action) => void;
   reject: (error: Error) => void;
}

export interface PermissionServiceOptions {
   /** Base ruleset from normalized config. */
   configRules: Ruleset;
   /** Session/agent override rules. */
   sessionOverrides?: Ruleset;
   /** Persisted approval rules (loaded from storage). */
   persistedApprovals?: Ruleset;
}

// ── Service ─────────────────────────────────────────────────────────

export class PermissionService extends EventEmitter {
   private pending = new Map<string, PendingEntry>();
   private approvedRules: Rule[] = [];
   private configRules: Ruleset;
   private sessionOverrides: Ruleset;

   constructor(options: PermissionServiceOptions) {
      super();
      this.configRules = options.configRules;
      this.sessionOverrides = options.sessionOverrides ?? [];
      this.approvedRules = options.persistedApprovals ?? [];
   }

   // ── Rule management ───────────────────────────────────────────

   /** Get the current merged ruleset for evaluation. */
   private getMergedRuleset(): Ruleset {
      return mergeAllRulesets(this.configRules, this.sessionOverrides, this.approvedRules);
   }

   /** Add approved rules (from "always" replies). */
   addApprovedRules(rules: Rule[]): void {
      this.approvedRules.push(...rules);
   }

   /** Get all currently approved rules. */
   getApprovedRules(): Ruleset {
      return [...this.approvedRules];
   }

   /** Update session/agent override rules. */
   setSessionOverrides(overrides: Ruleset): void {
      this.sessionOverrides = overrides;
   }

   /** Update config rules (e.g. on config reload). */
   setConfigRules(rules: Ruleset): void {
      this.configRules = rules;
   }

   // ── Ask flow ──────────────────────────────────────────────────

   /**
    * Request permission for an operation.
    *
    * Evaluates request pattern alternatives against the merged ruleset.
    * Last matching rule wins across all alternatives. "ask" queues a
    * pending request that resolves when a reply is received.
    *
    * @param permission - Permission domain (e.g. "bash", "edit").
    * @param patterns - Patterns to evaluate.
    * @param metadata - Tool-specific metadata for the request.
    * @param sessionId - Session that owns this request.
    * @returns Promise resolving to the final action.
    */
   async ask(
      permission: string,
      patterns: string[],
      metadata: Record<string, unknown>,
      sessionId: string
   ): Promise<Action> {
      const ruleset = this.getMergedRuleset();

      const action = evaluatePatterns(ruleset, permission, patterns);

      if (action === "deny") return "deny";
      if (action === "allow") return "allow";

      // Queue pending request
      const request: PermissionRequest = {
         id: generateRequestId(),
         sessionId,
         permission,
         patterns,
         metadata,
         createdAt: Date.now()
      };

      return new Promise<Action>((resolve, reject) => {
         this.pending.set(request.id, { request, resolve, reject });

         // Emit event for UI/automation consumers
         const event: PermissionEvent = {
            type: "permission-requested",
            request
         };
         this.emit("permission-requested", event);
      });
   }

   // ── Reply flow ────────────────────────────────────────────────

   /**
    * Reply to a pending permission request.
    *
    * @param reply - The reply payload.
    * @returns True if the request was found and resolved, false otherwise.
    */
   reply(reply: PermissionReply): boolean {
      const entry = this.pending.get(reply.requestId);
      if (!entry) return false;

      // Remove from pending
      this.pending.delete(reply.requestId);

      switch (reply.decision) {
         case "once": {
            // Approve for this request only
            entry.resolve("allow");
            this.emitResolved(entry.request, "allow", reply);
            break;
         }

         case "always": {
            // Persist approval rules and approve
            const approvalRules = this.deriveApprovalRules(entry.request);
            this.addApprovedRules(approvalRules);
            entry.resolve("allow");
            this.emitResolved(entry.request, "allow", reply);
            break;
         }

         case "reject": {
            // Reject with feedback
            const error = new PermissionRejectedError(reply.message ?? "Permission denied by operator", reply.message);
            entry.reject(error);

            // Fanout: reject all other pending requests in the same session
            this.rejectSessionPending(entry.request.sessionId, reply);

            this.emitResolved(entry.request, "deny", reply);
            break;
         }
      }

      return true;
   }

   // ── List flow ─────────────────────────────────────────────────

   /**
    * List all pending permission requests.
    */
   listPending(): PermissionRequest[] {
      return Array.from(this.pending.values()).map((e) => e.request);
   }

   /**
    * List pending requests for a specific session.
    */
   listPendingForSession(sessionId: string): PermissionRequest[] {
      return this.listPending().filter((r) => r.sessionId === sessionId);
   }

   // ── Lifecycle cleanup ─────────────────────────────────────────

   /**
    * Clean up pending requests for a session (e.g. on session interrupt/abort).
    *
    * @param sessionId - Session to clean up.
    * @param reason - Reason for cleanup.
    */
   cleanupSession(sessionId: string, reason = "Session interrupted"): void {
      const entries = Array.from(this.pending.entries()).filter(([, e]) => e.request.sessionId === sessionId);

      for (const [id, entry] of entries) {
         this.pending.delete(id);
         entry.reject(new Error(reason));
      }
   }

   /**
    * Get the count of pending requests.
    */
   get pendingCount(): number {
      return this.pending.size;
   }

   /**
    * Check if a specific request is still pending.
    */
   isPending(requestId: string): boolean {
      return this.pending.has(requestId);
   }

   // ── Internal helpers ──────────────────────────────────────────

   /**
    * Derive approval rule from the request's most specific pattern.
    */
   private deriveApprovalRules(request: PermissionRequest): Rule[] {
      return [
         {
            permission: request.permission,
            pattern: request.patterns[0] ?? "*",
            action: "allow" as const
         }
      ];
   }

   /**
    * Reject all pending requests in a session (reject fanout).
    */
   private rejectSessionPending(sessionId: string, reply: PermissionReply): void {
      const entries = Array.from(this.pending.entries()).filter(([, e]) => e.request.sessionId === sessionId);

      for (const [id, entry] of entries) {
         this.pending.delete(id);
         const error = new PermissionRejectedError("Rejected by operator (session fanout)", reply.message);
         entry.reject(error);
         this.emitResolved(entry.request, "deny", {
            ...reply,
            requestId: id
         });
      }
   }

   /**
    * Emit a permission-resolved event.
    */
   private emitResolved(request: PermissionRequest, action: Action, reply: PermissionReply): void {
      const event: PermissionEvent = {
         type: "permission-resolved",
         request,
         action,
         reply
      };
      this.emit("permission-resolved", event);
   }
}

// ── Error class ─────────────────────────────────────────────────────

export class PermissionRejectedError extends Error {
   constructor(
      message: string,
      public readonly feedback?: string
   ) {
      super(message);
      this.name = "PermissionRejectedError";
   }
}
