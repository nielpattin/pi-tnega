import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface FakePi {
   handlers: Record<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>>;
   on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>): void;
}

function createFakePi(): FakePi {
   return {
      handlers: {},
      on(name, handler) {
         this.handlers[name] = handler;
      },
   };
}

describe("session approvals", () => {
   const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

   afterEach(() => {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      vi.resetModules();
      vi.restoreAllMocks();
   });

   it("keeps Allow always in memory only and asks again after session restart", async () => {
      let storedApprovals: unknown[] = [];
      vi.doMock("./persistence.ts", () => ({
         loadApprovedRules: () => storedApprovals,
         appendApprovedRules: (rules: unknown[]) => {
            storedApprovals = [...storedApprovals, ...rules];
         },
      }));

      const root = join(tmpdir(), `pi-permission-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
         join(agentDir, "permission.jsonc"),
         `{
            "permission": {
               "*": "ask"
            }
         }`,
         "utf8",
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;

      try {
         const { default: permissionSystem } = await import("./index.ts");
         const pi = createFakePi();
         permissionSystem(pi as never);

         let prompts = 0;
         const ctx = {
            cwd,
            ui: {
               custom: async () => {
                  prompts += 1;
                  return "always";
               },
            },
            sessionManager: { getSessionId: () => "session-1" },
         };

         await pi.handlers.session_start({}, ctx);
         await pi.handlers.tool_call({ toolName: "read", input: { path: "README.md" } }, ctx);
         await pi.handlers.tool_call({ toolName: "read", input: { path: "README.md" } }, ctx);
         expect(prompts).toBe(1);

         await pi.handlers.session_start({}, ctx);
         await pi.handlers.tool_call({ toolName: "read", input: { path: "README.md" } }, ctx);
         expect(prompts).toBe(2);
      } finally {
         rmSync(root, { recursive: true, force: true });
      }
   });
});
