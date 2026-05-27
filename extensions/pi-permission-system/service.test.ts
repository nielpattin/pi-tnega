import { describe, it, expect, vi } from "vitest";
import { PermissionService, PermissionRejectedError } from "./service.ts";
import type { Rule, Ruleset, PermissionEvent } from "./types.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function createService(configRules: Ruleset = []) {
   return new PermissionService({ configRules });
}

// ── Pending queue behavior ──────────────────────────────────────────

describe("PermissionService", () => {
   describe("ask flow", () => {
      it("returns 'allow' immediately when all patterns match allow rules", async () => {
         const service = createService([
            { permission: "*", pattern: "*", action: "allow" },
         ]);

         const result = await service.ask("bash", ["git status"], {}, "session-1");
         expect(result).toBe("allow");
         expect(service.pendingCount).toBe(0);
      });

      it("returns 'deny' immediately when any pattern matches deny rule", async () => {
         const service = createService([
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
         ]);

         const result = await service.ask("bash", ["rm -rf /"], {}, "session-1");
         expect(result).toBe("deny");
         expect(service.pendingCount).toBe(0);
      });

      it("queues pending request when pattern resolves to 'ask'", async () => {
         const service = createService([
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);

         const promise = service.ask("bash", ["git push"], {}, "session-1");
         expect(service.pendingCount).toBe(1);

         const pending = service.listPending();
         expect(pending).toHaveLength(1);
         expect(pending[0].permission).toBe("bash");
         expect(pending[0].patterns).toEqual(["git push"]);
      });

      it("emits permission-requested event on ask", async () => {
         const service = createService([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);
         const events: PermissionEvent[] = [];
         service.on("permission-requested", (e: PermissionEvent) => events.push(e));

         service.ask("bash", ["git push"], {}, "session-1");

         expect(events).toHaveLength(1);
         expect(events[0].type).toBe("permission-requested");
         expect(events[0].request.permission).toBe("bash");
      });

      it("uses default 'ask' when no rules match", async () => {
         const service = createService([]);

         const promise = service.ask("bash", ["git status"], {}, "session-1");
         expect(service.pendingCount).toBe(1);
      });
   });

   describe("reply flow", () => {
      it("resolves pending request with 'once' reply", async () => {
         const service = createService([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);

         const promise = service.ask("bash", ["git push"], {}, "session-1");
         const pending = service.listPending();
         expect(pending).toHaveLength(1);

         service.reply({ requestId: pending[0].id, decision: "once" });

         const result = await promise;
         expect(result).toBe("allow");
         expect(service.pendingCount).toBe(0);
         expect(service.getApprovedRules()).toHaveLength(0); // no persistence
      });

      it("resolves pending request with 'always' reply and persists rules", async () => {
         const service = createService([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);

         const promise = service.ask("bash", ["git push"], {}, "session-1");
         const pending = service.listPending();

         service.reply({ requestId: pending[0].id, decision: "always" });

         const result = await promise;
         expect(result).toBe("allow");

         // Verify rules were persisted
         const approved = service.getApprovedRules();
         expect(approved).toHaveLength(1);
         expect(approved[0]).toEqual({
            permission: "bash",
            pattern: "git push",
            action: "allow",
         });

         // Future matching requests should now be allowed
         const result2 = await service.ask("bash", ["git push"], {}, "session-1");
         expect(result2).toBe("allow");
      });

      it("rejects pending request with 'reject' reply", async () => {
         const service = createService([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);

         const promise = service.ask("bash", ["git push"], {}, "session-1");
         const pending = service.listPending();

         service.reply({
            requestId: pending[0].id,
            decision: "reject",
            message: "Not allowed",
         });

         await expect(promise).rejects.toThrow(PermissionRejectedError);
         await expect(promise).rejects.toThrow("Not allowed");
         expect(service.pendingCount).toBe(0);
      });

      it("returns false when replying to non-existent request", () => {
         const service = createService([]);
         const result = service.reply({ requestId: "non-existent", decision: "once" });
         expect(result).toBe(false);
      });

      it("emits permission-resolved event on reply", async () => {
         const service = createService([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);
         const events: PermissionEvent[] = [];
         service.on("permission-resolved", (e: PermissionEvent) => events.push(e));

         const promise = service.ask("bash", ["git push"], {}, "session-1");
         const pending = service.listPending();

         service.reply({ requestId: pending[0].id, decision: "once" });
         await promise;

         expect(events).toHaveLength(1);
         expect(events[0].type).toBe("permission-resolved");
         expect(events[0].action).toBe("allow");
      });
   });

   describe("reject fanout", () => {
      it("rejects all pending requests in the same session on reject", async () => {
         const service = createService([
            { permission: "bash", pattern: "git *", action: "ask" },
            { permission: "edit", pattern: "*", action: "ask" },
         ]);

         const promise1 = service.ask("bash", ["git push"], {}, "session-1");
         const promise2 = service.ask("edit", ["file.ts"], {}, "session-1");
         const promise3 = service.ask("bash", ["git pull"], {}, "session-2"); // different session

         expect(service.pendingCount).toBe(3);

         const pending = service.listPendingForSession("session-1");
         expect(pending).toHaveLength(2);

         // Reject one request in session-1
         service.reply({ requestId: pending[0].id, decision: "reject" });

         // Both session-1 requests should be rejected
         await expect(promise1).rejects.toThrow(PermissionRejectedError);
         await expect(promise2).rejects.toThrow(PermissionRejectedError);

         // Session-2 request should still be pending
         expect(service.pendingCount).toBe(1);
         expect(service.isPending(service.listPending()[0].id)).toBe(true);
      });

      it("emits events for each fanout rejection", async () => {
         const service = createService([
            { permission: "bash", pattern: "git *", action: "ask" },
            { permission: "edit", pattern: "*", action: "ask" },
         ]);
         const events: PermissionEvent[] = [];
         service.on("permission-resolved", (e: PermissionEvent) => events.push(e));

         const promise1 = service.ask("bash", ["git push"], {}, "session-1");
         const promise2 = service.ask("edit", ["file.ts"], {}, "session-1");

         const pending = service.listPending();
         service.reply({ requestId: pending[0].id, decision: "reject" });

         // Wait for rejections to propagate
         await Promise.allSettled([promise1, promise2]);

         // Should have 2 events: the explicit reject + 1 fanout rejection
         // (the explicitly rejected request is removed from pending before fanout)
         expect(events).toHaveLength(2);
      });
   });

   describe("session cleanup", () => {
      it("cleans up all pending requests for a session", async () => {
         const service = createService([
            { permission: "bash", pattern: "*", action: "ask" },
         ]);

         const promise1 = service.ask("bash", ["cmd1"], {}, "session-1");
         const promise2 = service.ask("bash", ["cmd2"], {}, "session-1");
         const promise3 = service.ask("bash", ["cmd3"], {}, "session-2");

         expect(service.pendingCount).toBe(3);

         service.cleanupSession("session-1", "Agent aborted");

         await expect(promise1).rejects.toThrow("Agent aborted");
         await expect(promise2).rejects.toThrow("Agent aborted");
         expect(service.pendingCount).toBe(1);

         // Clean up remaining (catch expected rejection)
         promise3.catch(() => {});
         service.cleanupSession("session-2");
      });
   });

   describe("rule management", () => {
      it("supports updating session overrides", async () => {
         const service = createService([
            { permission: "bash", pattern: "*", action: "deny" },
         ]);

         // Initially denied
         const result1 = await service.ask("bash", ["git status"], {}, "session-1");
         expect(result1).toBe("deny");

         // Add override
         service.setSessionOverrides([
            { permission: "bash", pattern: "git *", action: "allow" },
         ]);

         // Now allowed
         const result2 = await service.ask("bash", ["git status"], {}, "session-1");
         expect(result2).toBe("allow");
      });

      it("supports updating config rules", async () => {
         const service = createService([
            { permission: "bash", pattern: "*", action: "allow" },
         ]);

         const result1 = await service.ask("bash", ["git status"], {}, "session-1");
         expect(result1).toBe("allow");

         service.setConfigRules([
            { permission: "bash", pattern: "*", action: "deny" },
         ]);

         const result2 = await service.ask("bash", ["git status"], {}, "session-1");
         expect(result2).toBe("deny");
      });
   });
});
