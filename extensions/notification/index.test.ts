import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface FakePi {
   execCalls: Array<{ command: string; args: string[] }>;
   handlers: Record<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>>;
   exec(command: string, args: string[]): Promise<unknown>;
   on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>): void;
}

function createFakePi(): FakePi {
   return {
      execCalls: [],
      handlers: {},
      exec(command, args) {
         this.execCalls.push({ command, args });
         return Promise.resolve(undefined);
      },
      on(name, handler) {
         this.handlers[name] = handler;
      },
   };
}

function withTempDirs(fn: (agentDir: string, cwd: string) => Promise<void>): Promise<void> {
   const root = join(tmpdir(), `pi-notification-${Date.now()}-${Math.random().toString(16).slice(2)}`);
   const agentDir = join(root, "agent");
   const cwd = join(root, "project");
   mkdirSync(agentDir, { recursive: true });
   mkdirSync(join(cwd, ".pi"), { recursive: true });
   return fn(agentDir, cwd).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("notification extension", () => {
   const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

   afterEach(() => {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      vi.resetModules();
   });

   it("plays the configured done sound from settings.json at volume 100", async () => {
      await withTempDirs(async (agentDir, cwd) => {
         process.env.PI_CODING_AGENT_DIR = agentDir;
         writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify(
               {
                  notification: {
                     sound: "assets/custom-done.mp3",
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
              "sounds": {
                "done": "assets/wrong-file.mp3",
                "volume": 1,
              }
            }`,
            "utf8",
         );

         const { default: notificationExtension } = await import("./index.ts");
         const pi = createFakePi();
         notificationExtension(pi as never);

         await pi.handlers.agent_end?.({}, { hasUI: true, cwd });

         expect(pi.execCalls).toEqual([
            {
               command: "ffplay",
               args: [
                  "-nodisp",
                  "-autoexit",
                  "-loglevel",
                  "error",
                  "-volume",
                  "100",
                  join(agentDir, "assets", "custom-done.mp3"),
               ],
            },
         ]);
      });
   });
});
