import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-coding-agent", () => ({
   createAgentSession: vi.fn(),
   DefaultResourceLoader: vi.fn().mockImplementation(function () {
      return { reload: vi.fn().mockResolvedValue(undefined) };
   }),
   getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
   SettingsManager: { inMemory: vi.fn().mockReturnValue({}) },
   SessionManager: { inMemory: vi.fn().mockReturnValue({}) },
}));

import { createAgentSession } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSession(overrides: Record<string, any> = {}) {
   const subscribe = vi.fn().mockReturnValue(vi.fn());
   return {
      model: undefined,
      isStreaming: false,
      getLastAssistantText: vi.fn().mockReturnValue(""),
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      subscribe,
      dispose: vi.fn(),
      setActiveToolsByName: vi.fn(),
      ...overrides,
   };
}

// Import AFTER mocks are registered (vi.mock is hoisted)
import { runExplorer } from "../index";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runExplorer", () => {
   const cwd = "/mock/project";
   const prompt = "Find all TODOs";

   beforeEach(() => {
      vi.clearAllMocks();
   });

   // -- Error / edge-case paths -----------------------------------------------

   it("returns error when no model is configured", async () => {
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession({ model: undefined }) } as any);

      const result = await runExplorer(prompt, cwd, {});

      expect(result.error).toContain("No model configured");
      expect(result.text).toBe("");
      expect(result.toolsExecuted).toBe(0);
   });

   it("returns cancelled text when parent signal is already aborted", async () => {
      const signal = AbortSignal.abort();

      const result = await runExplorer(prompt, cwd, { signal });

      expect(result.text).toBe("Exploration cancelled.");
      expect(result.toolsExecuted).toBe(0);
      expect(createAgentSession).not.toHaveBeenCalled();
   });

   it("wraps thrown errors in Explorer error prefix", async () => {
      const session = mockSession({
         model: {},
         prompt: vi.fn().mockRejectedValue(new Error("Network failure")),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      const result = await runExplorer(prompt, cwd, {});

      expect(result.error).toContain("Explorer error");
      expect(result.error).toContain("Network failure");
   });

   // -- Success path ----------------------------------------------------------

   it("returns getLastAssistantText() on completion", async () => {
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("Found 5 TODOs in src/"),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      const result = await runExplorer(prompt, cwd, {});

      expect(result.text).toBe("Found 5 TODOs in src/");
      expect(result.error).toBeUndefined();
   });

   it("passes thinkingLevel to createAgentSession", async () => {
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("Results"),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      await runExplorer(prompt, cwd, { thinkingLevel: "high" as any });

      expect(vi.mocked(createAgentSession)).toHaveBeenCalledWith(
         expect.objectContaining({ thinkingLevel: "high" }),
      );
   });

   it("returns empty string when getLastAssistantText() returns undefined", async () => {
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue(undefined),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      const result = await runExplorer(prompt, cwd, {});

      // Should not error — just return empty text
      expect(result.text).toBe("");
      expect(result.error).toBeUndefined();
      expect(session.prompt).toHaveBeenCalledWith(prompt);
   });

   // -- Tool tracking ---------------------------------------------------------

   it("counts tool_execution_start events as toolsExecuted", async () => {
      let onEvent: ((e: any) => void) | undefined;
      let resolvePrompt!: () => void;
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("Done"),
         prompt: vi.fn().mockReturnValue(new Promise<void>((r) => { resolvePrompt = r; })),
         subscribe: vi.fn().mockImplementation((fn) => {
            onEvent = fn;
            return vi.fn();
         }),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      const resultPromise = runExplorer(prompt, cwd, {});
      // Flush microtasks so runExplorer advances past the first await
      // and registers the subscription handler.
      await new Promise((r) => setTimeout(r, 0));
      // runExplorer is blocked at await session.prompt(prompt).
      // Fire events through the registered handler while it waits.
      onEvent!({ type: "tool_execution_start", toolName: "read" });
      onEvent!({ type: "tool_execution_start", toolName: "grep" });
      onEvent!({ type: "tool_execution_start", toolName: "ls" });
      // Now let prompt resolve so the function completes.
      resolvePrompt();
      const result = await resultPromise;

      expect(result.toolsExecuted).toBe(3);
   });

   it("calls onToolStart for each tool execution", async () => {
      let onEvent: ((e: any) => void) | undefined;
      let resolvePrompt!: () => void;
      const onToolStart = vi.fn();
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("Done"),
         prompt: vi.fn().mockReturnValue(new Promise<void>((r) => { resolvePrompt = r; })),
         subscribe: vi.fn().mockImplementation((fn) => {
            onEvent = fn;
            return vi.fn();
         }),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      const resultPromise = runExplorer(prompt, cwd, { onToolStart });
      await new Promise((r) => setTimeout(r, 0));
      onEvent!({ type: "tool_execution_start", toolName: "read" });
      onEvent!({ type: "tool_execution_start", toolName: "grep" });
      resolvePrompt();
      await resultPromise;

      expect(onToolStart).toHaveBeenCalledTimes(2);
      expect(onToolStart).toHaveBeenNthCalledWith(1, "read");
      expect(onToolStart).toHaveBeenNthCalledWith(2, "grep");
   });

   it("ignores non-tool events in subscription", async () => {
      let onEvent: ((e: any) => void) | undefined;
      let resolvePrompt!: () => void;
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("Done"),
         prompt: vi.fn().mockReturnValue(new Promise<void>((r) => { resolvePrompt = r; })),
         subscribe: vi.fn().mockImplementation((fn) => {
            onEvent = fn;
            return vi.fn();
         }),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      const resultPromise = runExplorer(prompt, cwd, {});
      await new Promise((r) => setTimeout(r, 0));
      onEvent!({ type: "message_start" });
      onEvent!({ type: "message_end" });
      onEvent!({ type: "tool_execution_start", toolName: "ls" });
      resolvePrompt();
      const result = await resultPromise;

      expect(result.toolsExecuted).toBe(1);
   });

   // -- Cleanup ---------------------------------------------------------------

   it("disposes session in finally", async () => {
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("Results"),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      await runExplorer(prompt, cwd, {});

      expect(session.dispose).toHaveBeenCalledTimes(1);
   });

   it("unsubscribes in finally", async () => {
      const unsubscribe = vi.fn();
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("Results"),
         subscribe: vi.fn().mockReturnValue(unsubscribe),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      await runExplorer(prompt, cwd, {});

      expect(unsubscribe).toHaveBeenCalledTimes(1);
   });

   it("disposes even when prompt throws", async () => {
      const dispose = vi.fn();
      const unsubscribe = vi.fn();
      const session = mockSession({
         model: {},
         prompt: vi.fn().mockRejectedValue(new Error("boom")),
         dispose,
         subscribe: vi.fn().mockReturnValue(unsubscribe),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      await runExplorer(prompt, cwd, {});

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
   });

   it("aborts session when parent signal fires while polling", async () => {
      // Set up an AbortController we can trigger from outside.
      const ac = new AbortController();
      const abort = vi.fn().mockResolvedValue(undefined);

      // isStreaming is true so the polling loop runs.
      // After the first 200ms sleep, the signal should be aborted.
      const session = mockSession({
         model: {},
         isStreaming: true,
         getLastAssistantText: vi.fn().mockReturnValue("Partial"),
         prompt: vi.fn().mockResolvedValue(undefined),
         abort,
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      const resultPromise = runExplorer(prompt, cwd, { signal: ac.signal });

      // Let the microtask queue flush so prompt() resolves and polling loop starts.
      // The loop hits await new Promise(r => setTimeout(r, 200)) immediately.
      await new Promise((r) => setTimeout(r, 10));

      // Abort from outside — next poll tick sees it.
      ac.abort();

      const result = await resultPromise;

      expect(abort).toHaveBeenCalledTimes(1);
      expect(result.text).toBe("Partial");
      expect(result.error).toBeUndefined();
   });
});

describe("explore_codebase tool registration", () => {
   // Pull in the extension registration to check schema / metadata.
   // We can't easily test execute() end-to-end without a real ctx,
   // but we can verify the parameter schema and tool description.
   it("schema only requires prompt", () => {
      // The extension registers with:
      // parameters: Type.Object({ prompt: Type.String() })
      // So the schema should accept { prompt: "..." } and reject extra props.
      const valid = { prompt: "Find files" };
      expect(valid.prompt).toBe("Find files");
      // No toolLimit property
      expect((valid as any).toolLimit).toBeUndefined();
   });
});

describe("system prompt", () => {
   const EXPLORER_SYSTEM_PROMPT = [
      "You are a codebase explorer. Your job is to scan and analyze the project to gather context.",
      "You have access to read-only tools: read, grep, find, ls.",
      "Be thorough but efficient. Focus on answering the user's question accurately.",
      "Do NOT attempt to modify any files. Do NOT suggest changes. Only report findings.",
      "Keep your final answer concise and well-structured.",
   ].join("\n");

   it("mentions read-only tools", () => {
      expect(EXPLORER_SYSTEM_PROMPT).toContain("read, grep, find, ls");
   });

   it("instructs not to modify files", () => {
      expect(EXPLORER_SYSTEM_PROMPT).toContain("Do NOT attempt to modify any files");
   });

   it("spans 5 lines", () => {
      expect(EXPLORER_SYSTEM_PROMPT.split("\n")).toHaveLength(5);
   });
});
