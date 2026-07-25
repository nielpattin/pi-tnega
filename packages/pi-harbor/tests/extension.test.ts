import { describe, expect, it, vi } from "vitest";
import { registerHarborExtension } from "../src/extension.js";

describe("Harbor Extension Registration & Cutover Gate", () => {
   function createMockPi(opts?: {
      hasUI?: boolean;
      isPrintMode?: boolean;
      tools?: Array<{ name: string; sourceInfo?: { path?: string } }>;
      commands?: Array<{ name: string; sourceInfo?: { path?: string } }>;
      settingsExtensions?: string[];
   }) {
      const tools: string[] = [];
      const commands: string[] = [];
      const renderers: string[] = [];
      const errors: string[] = [];

      const registeredToolsList = opts?.tools ?? [];
      const registeredCmdsList = opts?.commands ?? [];
      const settingsExtensions = opts?.settingsExtensions ?? [];

      return {
         pi: {
            hasUI: () => opts?.hasUI ?? true,
            isPrintMode: () => opts?.isPrintMode ?? false,
            getTools: () => registeredToolsList,
            getCommands: () => registeredCmdsList,
            getSettings: () => ({ extensions: settingsExtensions }),
            registerTool: vi.fn((def: any) => {
               tools.push(def.name);
            }),
            registerCommand: vi.fn((name: string) => {
               commands.push(name);
            }),
            registerEntryRenderer: vi.fn((type: string) => {
               renderers.push(type);
            }),
            logError: vi.fn((err: string) => {
               errors.push(err);
            })
         },
         tools,
         commands,
         renderers,
         errors
      };
   }

   it("worker mode (no UI or print mode) registers only worker surfaces", () => {
      const mock = createMockPi({ hasUI: false });
      const res = registerHarborExtension(mock.pi);

      expect(res.ok).toBe(true);
      if (res.ok) {
         expect(res.registered).toBe("worker-only");
      }
      expect(mock.tools).toContain("submit");
      expect(mock.commands).not.toContain("/tasks");
      expect(mock.commands).not.toContain("/vibe");
   });

   it("full mode fails cutover if legacy tasks extension is active without force-exclude", () => {
      const mock = createMockPi({
         hasUI: true,
         tools: [{ name: "task", sourceInfo: { path: "extensions/tasks/index.ts" } }],
         settingsExtensions: []
      });

      const res = registerHarborExtension(mock.pi);

      expect(res.ok).toBe(false);
      if (!res.ok) {
         expect(res.error).toContain("extensions/tasks");
      }
      expect(mock.commands).toHaveLength(0); // refused parent command registration
   });

   it("full mode registers parent tools, commands, and renderers when cutover passes", () => {
      const mock = createMockPi({
         hasUI: true,
         settingsExtensions: ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"]
      });

      const res = registerHarborExtension(mock.pi);

      expect(res.ok).toBe(true);
      if (res.ok) {
         expect(res.registered).toBe("full");
      }
      expect(mock.tools).toEqual(expect.arrayContaining(["task", "hub", "submit"]));
      expect(mock.commands).toEqual(expect.arrayContaining(["/tasks", "/agents", "/vibe", "/btw"]));
      expect(mock.renderers).toEqual(expect.arrayContaining(["harbor-result", "btw-result"]));
   });
});
