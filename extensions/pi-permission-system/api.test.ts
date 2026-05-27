import { describe, it, expect, vi } from "vitest";
import { PermissionService, PermissionRejectedError } from "./service.ts";
import {
   createPermissionAPI,
   subscribeToPermissionEvents,
   formatPermissionPrompt,
} from "./api.ts";
import type { PermissionEvent, Rule, Ruleset } from "./types.ts";

// ── End-to-end ask → reply flows ────────────────────────────────────

describe("end-to-end permission flows", () => {
   function setup(configRules: Ruleset = []) {
      const service = new PermissionService({ configRules });
      const api = createPermissionAPI(service);
      const events: PermissionEvent[] = [];
      const unsubscribe = subscribeToPermissionEvents(service, (e) => events.push(e));
      return { service, api, events, unsubscribe };
   }

   describe("ask → reply once", () => {
      it("completes full flow: ask → pending → reply once → resolved", async () => {
         const { service, api, events } = setup([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);

         // Start ask
         const promise = service.ask("bash", ["git push"], { command: "git push" }, "session-1");

         // Verify pending state
         expect(api.pendingCount()).toBe(1);
         const pending = api.listPending();
         expect(pending).toHaveLength(1);
         expect(pending[0].permission).toBe("bash");
         expect(api.isPending(pending[0].id)).toBe(true);

         // Verify event was emitted
         expect(events).toHaveLength(1);
         expect(events[0].type).toBe("permission-requested");

         // Reply once
         const replied = api.reply({ requestId: pending[0].id, decision: "once" });
         expect(replied).toBe(true);

         // Verify resolution
         const result = await promise;
         expect(result).toBe("allow");
         expect(api.pendingCount()).toBe(0);

         // Verify resolved event
         expect(events).toHaveLength(2);
         expect(events[1].type).toBe("permission-resolved");
         expect(events[1].action).toBe("allow");

         // No rules should be persisted
         expect(service.getApprovedRules()).toHaveLength(0);
      });
   });

   describe("ask → reply always", () => {
      it("persists approval rules and allows future matching requests", async () => {
         const { service, api, events } = setup([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);

         // First request
         const promise1 = service.ask("bash", ["git push"], { command: "git push" }, "session-1");
         const pending1 = api.listPending();
         api.reply({ requestId: pending1[0].id, decision: "always" });
         const result1 = await promise1;
         expect(result1).toBe("allow");

         // Verify rules were persisted
         const approved = service.getApprovedRules();
         expect(approved).toHaveLength(1);
         expect(approved[0]).toEqual({
            permission: "bash",
            pattern: "git push",
            action: "allow",
         });

         // Second request with same command should be auto-allowed
         const result2 = await service.ask("bash", ["git push"], { command: "git push" }, "session-1");
         expect(result2).toBe("allow");
         expect(api.pendingCount()).toBe(0); // No new pending request
      });
   });

   describe("ask → reply reject", () => {
      it("rejects request with feedback and emits events", async () => {
         const { service, api, events } = setup([
            { permission: "bash", pattern: "git *", action: "ask" },
         ]);

         const promise = service.ask("bash", ["git push"], { command: "git push" }, "session-1");
         const pending = api.listPending();

         api.reply({
            requestId: pending[0].id,
            decision: "reject",
            message: "Pushing is not allowed in this branch",
         });

         await expect(promise).rejects.toThrow(PermissionRejectedError);
         await expect(promise).rejects.toThrow("Pushing is not allowed in this branch");

         // Verify events
         expect(events).toHaveLength(2);
         expect(events[0].type).toBe("permission-requested");
         expect(events[1].type).toBe("permission-resolved");
         expect(events[1].action).toBe("deny");
      });

      it("reject fans out to same-session pending requests", async () => {
         const { service, api } = setup([
            { permission: "bash", pattern: "*", action: "ask" },
            { permission: "edit", pattern: "*", action: "ask" },
         ]);

         const promise1 = service.ask("bash", ["cmd1"], {}, "session-1");
         const promise2 = service.ask("edit", ["file.ts"], {}, "session-1");
         const promise3 = service.ask("bash", ["cmd3"], {}, "session-2");

         expect(api.pendingCount()).toBe(3);

         const pending = api.listPendingForSession("session-1");
         expect(pending).toHaveLength(2);

         // Reject one
         api.reply({ requestId: pending[0].id, decision: "reject" });

         // Both session-1 requests should be rejected
         await expect(promise1).rejects.toThrow(PermissionRejectedError);
         await expect(promise2).rejects.toThrow(PermissionRejectedError);

         // Session-2 request should still be pending
         expect(api.pendingCount()).toBe(1);
         expect(api.isPending(api.listPending()[0].id)).toBe(true);

         // Clean up (catch expected rejection)
         promise3.catch(() => {});
         service.cleanupSession("session-2");
      });
   });

   describe("deny fast path", () => {
      it("returns deny immediately without creating pending request", async () => {
         const { service, api, events } = setup([
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
         ]);

         const result = await service.ask("bash", ["rm -rf /"], {}, "session-1");
         expect(result).toBe("deny");
         expect(api.pendingCount()).toBe(0);
         expect(events).toHaveLength(0); // No events for deny fast path
      });
   });

   describe("allow fast path", () => {
      it("returns allow immediately without creating pending request", async () => {
         const { service, api, events } = setup([
            { permission: "*", pattern: "*", action: "allow" },
         ]);

         const result = await service.ask("bash", ["git status"], {}, "session-1");
         expect(result).toBe("allow");
         expect(api.pendingCount()).toBe(0);
         expect(events).toHaveLength(0);
      });
   });
});

// ── Prompt formatting ───────────────────────────────────────────────

describe("formatPermissionPrompt", () => {
   it("formats bash command prompt", () => {
      const prompt = formatPermissionPrompt({
         id: "test-1",
         sessionId: "s1",
         permission: "bash",
         patterns: ["git push"],
         metadata: { command: "git push origin main", commandName: "git", args: ["push", "origin", "main"] },
         createdAt: Date.now(),
      });

      expect(prompt.title).toBe("Bash Command Execution");
      expect(prompt.domain).toBe("bash");
      expect(prompt.primaryValue).toBe("git push origin main");
      expect(prompt.risk).toBe("low");
   });

   it("formats edit prompt with diff", () => {
      const prompt = formatPermissionPrompt({
         id: "test-2",
         sessionId: "s1",
         permission: "edit",
         patterns: ["/src/index.ts"],
         metadata: {
            filePath: "/src/index.ts",
            extension: ".ts",
            diff: "--- a/src/index.ts\n+++ b/src/index.ts\n-old\n+new",
         },
         createdAt: Date.now(),
      });

      expect(prompt.title).toBe("File Edit");
      expect(prompt.domain).toBe("edit");
      expect(prompt.risk).toBe("medium");
      expect(prompt.contextLines.some((l) => l.includes("old"))).toBe(true);
   });

   it("formats external directory prompt with high risk", () => {
      const prompt = formatPermissionPrompt({
         id: "test-3",
         sessionId: "s1",
         permission: "external_directory",
         patterns: ["/home/user/other/**"],
         metadata: { directory: "/home/user/other", parentDirectory: "/home/user" },
         createdAt: Date.now(),
      });

      expect(prompt.title).toBe("External Directory Access");
      expect(prompt.risk).toBe("high");
      expect(prompt.contextLines.some((l) => l.includes("outside"))).toBe(true);
   });

   it("formats destructive bash command with high risk", () => {
      const prompt = formatPermissionPrompt({
         id: "test-4",
         sessionId: "s1",
         permission: "bash",
         patterns: ["rm *"],
         metadata: { command: "rm -rf /tmp/old", commandName: "rm", args: ["-rf", "/tmp/old"] },
         createdAt: Date.now(),
      });

      expect(prompt.risk).toBe("high");
      expect(prompt.contextLines.some((l) => l.includes("Destructive"))).toBe(true);
   });
});
