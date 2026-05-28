import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Component } from "@earendil-works/pi-tui";

interface FakePi {
   commands: Record<string, { description?: string; handler: (args: string, ctx: Record<string, unknown>) => unknown | Promise<unknown> }>;
   execCalls: Array<{ command: string; args: string[] }>;
   handlers: Record<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>>;
   exec(command: string, args: string[]): Promise<unknown>;
   on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>): void;
   registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: Record<string, unknown>) => unknown | Promise<unknown> }): void;
}

function createFakePi(): FakePi {
   return {
      commands: {},
      execCalls: [],
      handlers: {},
      exec(command, args) {
         this.execCalls.push({ command, args });
         return Promise.resolve(undefined);
      },
      on(name, handler) {
         this.handlers[name] = handler;
      },
      registerCommand(name, command) {
         this.commands[name] = command;
      },
   };
}

function makeAskConfig(root: string): { agentDir: string; cwd: string } {
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
   return { agentDir, cwd };
}

const promptTheme = {
   bold: (text: string) => text,
   fg: (_name: string, text: string) => text,
   inverse: (text: string) => text,
};

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
      const { agentDir, cwd } = makeAskConfig(root);
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

   it("plays the configured permission sound before opening the prompt", async () => {
      const root = join(tmpdir(), `pi-permission-sound-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const { agentDir, cwd } = makeAskConfig(root);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      writeFileSync(
         join(agentDir, "settings.json"),
         JSON.stringify(
            {
               piPermissionSystem: {
                  sound: "assets/custom-permission.mp3",
                  volume: 100,
               },
            },
            null,
            2,
         ),
         "utf8",
      );
      writeFileSync(
         join(agentDir, "permission.jsonc"),
         `{
            "permission": {
               "*": "ask"
            },
            "sounds": {
               "permissionRequired": "assets/wrong-permission.mp3",
               "volume": 1
            }
         }`,
         "utf8",
      );

      try {
         const { default: permissionSystem } = await import("./index.ts");
         const pi = createFakePi();
         const order: string[] = [];
         pi.exec = async (command, args) => {
            order.push("sound");
            pi.execCalls.push({ command, args });
         };
         permissionSystem(pi as never);

         const ctx = {
            cwd,
            ui: {
               custom: async () => {
                  order.push("prompt");
                  return "once";
               },
            },
            sessionManager: { getSessionId: () => "session-1" },
         };

         await pi.handlers.session_start({}, ctx);
         await pi.handlers.tool_call({ toolName: "bash", input: { command: "git status --short" } }, ctx);

         expect(order).toEqual(["sound", "prompt"]);
         expect(pi.execCalls).toHaveLength(1);
         expect(pi.execCalls[0]).toMatchObject({ command: "ffplay" });
         expect(pi.execCalls[0]?.args).toEqual(
            expect.arrayContaining(["-nodisp", "-autoexit", "-loglevel", "error", "-volume", "100"])
         );
         expect(pi.execCalls[0]?.args.at(-1)).toBe(join(agentDir, "assets", "custom-permission.mp3"));
      } finally {
         rmSync(root, { recursive: true, force: true });
      }
   });

   it("lets the user enter a rejection message", async () => {
      const root = join(tmpdir(), `pi-permission-reject-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const { agentDir, cwd } = makeAskConfig(root);
      process.env.PI_CODING_AGENT_DIR = agentDir;

      try {
         const { default: permissionSystem } = await import("./index.ts");
         const pi = createFakePi();
         permissionSystem(pi as never);

         let rejectRender = "";
         const ctx = {
            cwd,
            ui: {
               custom: async (factory: (tui: { requestRender(): void }, theme: typeof promptTheme, keybindings: unknown, done: (decision: unknown) => void) => Component) => {
                  let result: unknown = "";
                  const component = factory({ requestRender() {} }, promptTheme, {}, (value) => {
                     result = value;
                  });
                  component.handleInput?.("l");
                  component.handleInput?.("\r");
                  rejectRender = component.render(120).join("\n");
                  for (const char of "Use the read tool instead") component.handleInput?.(char);
                  component.handleInput?.("\r");
                  return result;
               },
            },
            sessionManager: { getSessionId: () => "session-1" },
         };

         await pi.handlers.session_start({}, ctx);
         const result = await pi.handlers.tool_call({ toolName: "bash", input: { command: "cat package.json" } }, ctx);

         expect(rejectRender).toContain("Reject permission");
         expect(rejectRender).toContain("Tell pi what to do differently");
         expect(result).toMatchObject({
            block: true,
            reason: expect.stringContaining("Use the read tool instead"),
         });
      } finally {
         rmSync(root, { recursive: true, force: true });
      }
   });

   it("renders bash prompt with an action label and no command echo", async () => {
      const root = join(tmpdir(), `pi-permission-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const { agentDir, cwd } = makeAskConfig(root);
      process.env.PI_CODING_AGENT_DIR = agentDir;

      try {
         const { default: permissionSystem } = await import("./index.ts");
         const pi = createFakePi();
         permissionSystem(pi as never);

         const rendered: string[] = [];
         const ctx = {
            cwd,
            ui: {
               custom: async (factory: (tui: { requestRender(): void }, theme: typeof promptTheme, keybindings: unknown, done: (decision: string) => void) => Component) => {
                  const component = factory({ requestRender() {} }, promptTheme, {}, () => {});
                  rendered.push(component.render(120).join("\n"));
                  return "once";
               },
            },
            sessionManager: { getSessionId: () => "session-1" },
         };

         await pi.handlers.session_start({}, ctx);
         const cases = [
            ["git status --short", "Show git working tree status", 120],
            ["mkdir -p tmp/cache", "Create directory tmp/cache", 120],
            [
               "find extensions/pi-permission-system/subdir -maxdepth 2 -type f",
               "Find files under extensions/pi-permission-system/subdir",
               50,
            ],
            ['bash -lc "pnpm test extensions/pi-permission-system"', "Run tests for extensions/pi-permission-system through bash", 120],
         ] as const;

         for (const [command, _label, width] of cases) {
            ctx.ui.custom = async (factory) => {
               const component = factory({ requestRender() {} }, promptTheme, {}, () => {});
               rendered.push(component.render(width).join("\n"));
               return "once";
            };
            await pi.handlers.tool_call({ toolName: "bash", input: { command } }, ctx);
         }

         for (const [index, [command, label]] of cases.entries()) {
            if (index !== 2) expect(rendered[index]).toContain(label);
            expect(rendered[index]).not.toContain(command);
            expect(rendered[index]).not.toContain(`$ ${command}`);
            expect(rendered[index]).not.toContain(`Command: ${command}`);
         }
         expect(rendered[2]).toContain("Find files under");
         expect(rendered[2]).toContain("extensions/pi-permission-system/subdir");
         expect(rendered[2]).not.toContain("...");
      } finally {
         rmSync(root, { recursive: true, force: true });
      }
   });
});
