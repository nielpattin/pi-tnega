import { describe, expect, it } from "vitest";

interface FakeEntry {
   type: string;
   customType?: string;
   data?: unknown;
}

interface FakeTool {
   name: string;
   description: string;
   parameters: Record<string, unknown>;
   sourceInfo: Record<string, unknown>;
   promptGuidelines?: string[];
}

interface FakePi {
   handlers: Record<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>>;
   activeTools: string[];
   setActiveToolsCalls: string[][];
   on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>): void;
   registerCommand(name: string, options: Record<string, unknown>): void;
   getAllTools(): FakeTool[];
   getActiveTools(): string[];
   setActiveTools(toolNames: string[]): void;
   appendEntry(): void;
}

function builtInTool(name: string): FakeTool {
   return {
      name,
      description: `${name} description`,
      parameters: {},
      sourceInfo: { source: "builtin" },
   };
}

function extensionTool(name: string, promptGuidelines?: string[]): FakeTool {
   return {
      name,
      description: `${name} description`,
      parameters: {},
      promptGuidelines,
      sourceInfo: { source: "extension" },
   };
}

function createFakePi(activeTools: string[]): FakePi {
   const allTools = [
      builtInTool("read"),
      builtInTool("bash"),
      builtInTool("edit"),
      builtInTool("write"),
      builtInTool("grep"),
      extensionTool("agent"),
      extensionTool("monitor_list"),
   ];

   return {
      handlers: {},
      activeTools,
      setActiveToolsCalls: [],
      on(name, handler) {
         this.handlers[name] = handler;
      },
      registerCommand() {},
      getAllTools() {
         return allTools;
      },
      getActiveTools() {
         return this.activeTools;
      },
      setActiveTools(toolNames) {
         this.setActiveToolsCalls.push(toolNames);
         this.activeTools = toolNames;
      },
      appendEntry() {},
   };
}

function createCtx(branch: FakeEntry[] = []) {
   return {
      sessionManager: {
         getBranch() {
            return branch;
         },
      },
   };
}

describe("tool selector extension", () => {
   it("keeps active extension tools but excludes default-disabled built-ins on first session start", async () => {
      const { default: toolSelectorExtension } = await import("./index.ts");
      const pi = createFakePi(["read", "bash", "edit", "write", "grep", "agent"]);

      toolSelectorExtension(pi as never);

      await pi.handlers.session_start?.({ type: "session_start", reason: "startup" }, createCtx() as never);

      expect(pi.setActiveToolsCalls).toEqual([["read", "bash", "edit", "write", "agent"]]);
   });

   it("removes auto-active extension tools that have no prompt snippet before the agent starts", async () => {
      const { default: toolSelectorExtension } = await import("./index.ts");
      const pi = createFakePi(["read", "bash", "edit", "write", "agent", "monitor_list"]);

      toolSelectorExtension(pi as never);

      await pi.handlers.session_start?.({ type: "session_start", reason: "startup" }, createCtx() as never);
      await pi.handlers.before_agent_start?.(
         {
            type: "before_agent_start",
            systemPromptOptions: {
               toolSnippets: {
                  agent: "Launch a specialized agent for complex tasks.",
               },
            },
         },
         createCtx() as never
      );

      expect(pi.setActiveToolsCalls).toEqual([
         ["read", "bash", "edit", "write", "agent", "monitor_list"],
         ["read", "bash", "edit", "write", "agent"],
      ]);
   });
});
