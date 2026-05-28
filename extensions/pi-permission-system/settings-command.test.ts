import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Component } from "@earendil-works/pi-tui";

interface FakePi {
   commands: Record<string, { description?: string; handler: (args: string, ctx: Record<string, unknown>) => unknown | Promise<unknown> }>;
   handlers: Record<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>>;
   on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>): void;
   registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: Record<string, unknown>) => unknown | Promise<unknown> }): void;
}

function createFakePi(): FakePi {
   return {
      commands: {},
      handlers: {},
      on(name, handler) {
         this.handlers[name] = handler;
      },
      registerCommand(name, command) {
         this.commands[name] = command;
      },
   };
}

const promptTheme = {
   bold: (text: string) => text,
   fg: (_name: string, text: string) => text,
   inverse: (text: string) => text,
};

describe("permission settings command", () => {
   const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

   afterEach(() => {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      vi.resetModules();
   });

   it("opens a custom UI and immediately writes yoloMode and debugLog to global permission config", async () => {
      const root = join(tmpdir(), `pi-permission-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
         join(agentDir, "permission.jsonc"),
         JSON.stringify({ permission: { bash: { "git *": "ask" } } }, null, 3),
         "utf8"
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;

      try {
         const { default: permissionSystem } = await import("./index.ts");
         const pi = createFakePi();
         permissionSystem(pi as never);

         const configPath = join(agentDir, "permission.jsonc");
         let firstRender = "";
         let secondRender = "";
         const ctx = {
            cwd,
            ui: {
               custom: async (factory: (tui: { requestRender(): void }, theme: typeof promptTheme, keybindings: unknown, done: () => void) => Component) => {
                  const component = factory({ requestRender() {} }, promptTheme, {}, () => {});
                  firstRender = component.render(120).join("\n");
                  component.handleInput?.("\r");
                  component.handleInput?.("\u001b[B");
                  component.handleInput?.("\r");
                  secondRender = component.render(120).join("\n");
               },
               notify: vi.fn(),
            },
            sessionManager: { getSessionId: () => "session-1" },
         };

         await pi.commands.permission.handler("", ctx);

         expect(firstRender).toContain("Permission Settings");
         expect(firstRender).toContain(configPath.replaceAll("\\", "/"));
         expect(secondRender).toContain("YOLO mode: on");
         expect(secondRender).toContain("Debug log: on");
         expect(existsSync(configPath)).toBe(true);
         expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
            yoloMode: true,
            debugLog: true,
            permission: { bash: { "git *": "ask" } },
         });
      } finally {
         rmSync(root, { recursive: true, force: true });
      }
   });
});
