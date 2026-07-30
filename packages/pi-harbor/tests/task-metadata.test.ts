import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { registerHarborExtension } from "../src/extension.js";
import { AgentsStore } from "../src/services/AgentsStore.js";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";

describe("task tool dynamic agent metadata", () => {
   function createMockPi() {
      const registeredTools: Array<{
         name: string;
         description?: string;
         promptSnippet?: string;
         promptGuidelines?: string[];
         parameters?: unknown;
         execute?: Function;
      }> = [];
      const eventHandlers = new Map<string, Function[]>();

      const pi = {
         getAllTools: () =>
            registeredTools.map((t) => ({
               name: t.name,
               description: t.description ?? t.name,
               promptSnippet: t.promptSnippet,
               promptGuidelines: t.promptGuidelines,
               parameters: t.parameters ?? {},
               sourceInfo: { path: "packages/pi-harbor/index.ts" }
            })),
         getActiveTools: () => registeredTools.map((t) => t.name),
         setActiveTools: vi.fn(),
         registerTool: vi.fn((def: any) => {
            const idx = registeredTools.findIndex((t) => t.name === def.name);
            if (idx >= 0) registeredTools[idx] = def;
            else registeredTools.push(def);
         }),
         on: (event: string, handler: Function) => {
            const handlers = eventHandlers.get(event) ?? [];
            handlers.push(handler);
            eventHandlers.set(event, handlers);
         },
         getCommands: () => [],
         appendEntry: vi.fn(),
         registerEntryRenderer: vi.fn(),
         registerMessageRenderer: vi.fn(),
         registerCommand: vi.fn(),
         sendMessage: vi.fn()
      };

      return {
         pi: pi as any,
         registeredTools,
         emit: async (event: string, payload: unknown, ctx: unknown) => {
            for (const handler of eventHandlers.get(event) ?? []) {
               await handler(payload, ctx);
            }
         }
      };
   }

   function fakeAgentsStore() {
      return Layer.succeed(
         AgentsStore,
         AgentsStore.of({
            getAgent: () => Effect.die("unused"),
            listAgents: (_cwd?: string) =>
               Effect.succeed([
                  {
                     name: "scout",
                     description: "Read-only codebase research agent",
                     tools: ["read", "grep"],
                     harness: "pi" as const,
                     enabled: true,
                     source: "builtin" as const,
                     kind: "agent" as const,
                     body: "SCOUT BODY - must not appear in metadata"
                  },
                  {
                     name: "disabled-agent",
                     description: "Should be hidden",
                     tools: ["read"],
                     harness: "pi" as const,
                     enabled: false,
                     source: "project" as const,
                     kind: "agent" as const,
                     body: "DISABLED BODY"
                  },
                  {
                     name: "custom-coder",
                     description: "Custom implementation agent",
                     tools: ["read", "write", "edit"],
                     harness: "pi" as const,
                     enabled: true,
                     source: "project" as const,
                     kind: "agent" as const,
                     body: "CUSTOM BODY"
                  }
               ]),
            getVibeProfiles: () => Effect.die("unused"),
            updateAgent: () => Effect.die("unused"),
            deleteAgent: () => Effect.die("unused"),
            updateVibeProfile: () => Effect.die("unused")
         })
      );
   }

   it("starts with base task metadata when no cwd is known", async () => {
      const settings: string[] = [];
      const mock = createMockPi();
      const runtime = makeFakeHarborRuntime(undefined, undefined, fakeAgentsStore());
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      const taskTool = mock.registeredTools.find((t) => t.name === "task");
      expect(taskTool).toBeDefined();
      expect(taskTool?.description).toContain('{ task: "prompt"');
      expect(taskTool?.description).toContain('{ tasks: [{ task: "prompt"');
      expect(taskTool?.description).toContain("agent field selects");
      expect(taskTool?.description).not.toContain("Enabled agent profiles");
      expect(taskTool?.description).not.toContain("custom-coder");
      expect(taskTool?.promptGuidelines?.some((g) => g.includes('Use task agent: "high-task"'))).toBe(true);
      expect(taskTool?.promptGuidelines?.some((g) => g.includes("custom-coder"))).toBe(false);

      await runtime.dispose();
   });

   it("augments task metadata with enabled agents for the current cwd at session_start", async () => {
      const settings: string[] = [];
      const mock = createMockPi();
      const runtime = makeFakeHarborRuntime(undefined, undefined, fakeAgentsStore());
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      await mock.emit("session_start", {}, {
         mode: "tui",
         hasUI: true,
         ui: { notify: vi.fn() },
         sessionManager: { getEntries: () => [], getSessionId: () => "s" },
         cwd: "/fake/project"
      });

      const taskTool = mock.registeredTools.find((t) => t.name === "task");
      expect(taskTool).toBeDefined();

      // Enabled agents with descriptions are present.
      expect(taskTool?.description).toContain("Enabled agent profiles for the current workspace:");
      expect(taskTool?.description).toContain("custom-coder");
      expect(taskTool?.description).toContain("Custom implementation agent");
      expect(taskTool?.description).toContain("scout");
      expect(taskTool?.description).toContain("Read-only codebase research agent");

      // Disabled agents are excluded.
      expect(taskTool?.description).not.toContain("disabled-agent");
      expect(taskTool?.description).not.toContain("Should be hidden");

      // Agent bodies are never exposed.
      expect(taskTool?.description).not.toContain("SCOUT BODY");
      expect(taskTool?.description).not.toContain("CUSTOM BODY");
      expect(taskTool?.description).not.toContain("DISABLED BODY");

      // Base metadata is preserved.
      expect(taskTool?.description).toContain('{ task: "prompt"');
      expect(taskTool?.description).toContain("agent field selects");

      // Guideline bullets are added for enabled agents.
      expect(
         taskTool?.promptGuidelines?.some((g) => g.includes('Use task agent: "custom-coder"'))
      ).toBe(true);
      expect(
         taskTool?.promptGuidelines?.some((g) => g.includes('Use task agent: "scout"'))
      ).toBe(true);
      expect(
         taskTool?.promptGuidelines?.some((g) => g.includes('Use task agent: "disabled-agent"'))
      ).toBe(false);

      // Base guideline preserved.
      expect(
         taskTool?.promptGuidelines?.some((g) => g.includes('Use task agent: "high-task"'))
      ).toBe(true);

      await runtime.dispose();
   });

   it("caps dynamic metadata size when many agents or long descriptions exist", async () => {
      const settings: string[] = [];
      const mock = createMockPi();
      const longDescription = "x".repeat(1000);
      const manyAgents = Array.from({ length: 20 }, (_, i) => ({
         name: `agent-${i + 1}`,
         description: `${longDescription}-${i + 1}`,
         tools: ["read"],
         harness: "pi" as const,
         enabled: true,
         source: "project" as const,
         kind: "agent" as const,
         body: "BODY"
      }));
      const disabledAgent = {
         name: "disabled-agent",
         description: longDescription,
         tools: ["read"],
         harness: "pi" as const,
         enabled: false,
         source: "project" as const,
         kind: "agent" as const,
         body: "BODY"
      };
      const store = Layer.succeed(
         AgentsStore,
         AgentsStore.of({
            getAgent: () => Effect.die("unused"),
            listAgents: () => Effect.succeed([...manyAgents, disabledAgent]),
            getVibeProfiles: () => Effect.die("unused"),
            updateAgent: () => Effect.die("unused"),
            deleteAgent: () => Effect.die("unused"),
            updateVibeProfile: () => Effect.die("unused")
         })
      );
      const runtime = makeFakeHarborRuntime(undefined, undefined, store);
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      await mock.emit("session_start", {}, {
         mode: "tui",
         hasUI: true,
         ui: { notify: vi.fn() },
         sessionManager: { getEntries: () => [], getSessionId: () => "s" },
         cwd: "/fake/project"
      });

      const taskTool = mock.registeredTools.find((t) => t.name === "task");
      expect(taskTool).toBeDefined();

      // Base metadata preserved.
      expect(taskTool?.description).toContain('{ task: "prompt"');
      expect(taskTool?.description).toContain("Enabled agent profiles");

      // Only a bounded number of agents are advertised.
      const advertisedCount = (taskTool?.description ?? "")
         .split("\n")
         .filter((line) => /^  - agent-\d+(?::|$)/.test(line)).length;
      expect(advertisedCount).toBe(16);

      // Long descriptions are truncated for the provider-facing description.
      expect(taskTool?.description?.length).toBeLessThan(5000);
      expect(taskTool?.description).not.toContain(`${longDescription}-1`);
      expect(taskTool?.description).toContain("agent-1: xxxxx");

      // Disabled agents still excluded.
      expect(taskTool?.description).not.toContain("disabled-agent");

      // Guidelines are bounded by the same agent limit; base guidelines are preserved.
      expect(taskTool?.promptGuidelines?.length).toBe(6 + 16);

      await runtime.dispose();
   });

   it("leaves base metadata when the agents store is empty", async () => {
      const settings: string[] = [];
      const mock = createMockPi();
      const emptyStore = Layer.succeed(
         AgentsStore,
         AgentsStore.of({
            getAgent: () => Effect.die("unused"),
            listAgents: () => Effect.succeed([]),
            getVibeProfiles: () => Effect.die("unused"),
            updateAgent: () => Effect.die("unused"),
            deleteAgent: () => Effect.die("unused"),
            updateVibeProfile: () => Effect.die("unused")
         })
      );
      const runtime = makeFakeHarborRuntime(undefined, undefined, emptyStore);
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      await mock.emit("session_start", {}, {
         mode: "tui",
         hasUI: true,
         ui: { notify: vi.fn() },
         sessionManager: { getEntries: () => [], getSessionId: () => "s" },
         cwd: "/fake/project"
      });

      const taskTool = mock.registeredTools.find((t) => t.name === "task");
      expect(taskTool?.description).not.toContain("Enabled agent profiles");
      expect(taskTool?.promptGuidelines?.length).toBe(6);

      await runtime.dispose();
   });
});
