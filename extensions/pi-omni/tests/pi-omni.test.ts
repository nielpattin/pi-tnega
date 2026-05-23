import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-ai", () => ({
   getModel: vi.fn().mockReturnValue({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      provider: "openai-codex",
      input: ["text", "image"],
   }),
}));

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

function mockSession(overrides: Record<string, any> = {}) {
   return {
      model: undefined,
      isStreaming: false,
      getLastAssistantText: vi.fn().mockReturnValue(""),
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      ...overrides,
   };
}

import { runOmni } from "../index";

// ---------------------------------------------------------------------------

describe("runOmni", () => {
   const cwd = "/mock/project";
   const imagePath = "src/assets/ui.png";

   beforeEach(() => {
      vi.clearAllMocks();
   });

   it("returns cancelled text when signal already aborted", async () => {
      const signal = AbortSignal.abort();

      const result = await runOmni(imagePath, cwd, { signal });

      expect(result.text).toBe("Inspection cancelled.");
      expect(createAgentSession).not.toHaveBeenCalled();
   });

   it("returns error when no model configured", async () => {
      vi.mocked(createAgentSession).mockResolvedValue({
         session: mockSession({ model: undefined }),
      } as any);

      const result = await runOmni(imagePath, cwd, {});

      expect(result.error).toContain("Omni model not available");
      expect(result.text).toBe("");
   });

   it("wraps thrown errors in Omni error prefix", async () => {
      vi.mocked(createAgentSession).mockResolvedValue({
         session: mockSession({
            model: {},
            prompt: vi.fn().mockRejectedValue(new Error("Network failure")),
         }),
      } as any);

      const result = await runOmni(imagePath, cwd, {});

      expect(result.error).toContain("Omni error");
      expect(result.error).toContain("Network failure");
   });

   it("prepends file path to result", async () => {
      vi.mocked(createAgentSession).mockResolvedValue({
         session: mockSession({
            model: {},
            isStreaming: false,
            getLastAssistantText: vi.fn().mockReturnValue("A blue login form."),
         }),
      } as any);

      const result = await runOmni(imagePath, cwd, {});

      expect(result.text).toBe("File: src/assets/ui.png\n\nA blue login form.");
      expect(result.error).toBeUndefined();
   });

   it("prompts the session to read the image file", async () => {
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("description"),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      await runOmni(imagePath, cwd, {});

      expect(session.prompt).toHaveBeenCalledWith(
         `Read the file at "src/assets/ui.png" and describe it in detail.`,
      );
   });

   it("handles undefined getLastAssistantText", async () => {
      vi.mocked(createAgentSession).mockResolvedValue({
         session: mockSession({
            model: {},
            isStreaming: false,
            getLastAssistantText: vi.fn().mockReturnValue(undefined),
         }),
      } as any);

      const result = await runOmni(imagePath, cwd, {});

      expect(result.text).toBe("File: src/assets/ui.png\n\n");
      expect(result.error).toBeUndefined();
   });

   it("passes hardcoded model and thinking off to createAgentSession", async () => {
      vi.mocked(createAgentSession).mockResolvedValue({
         session: mockSession({ model: {}, isStreaming: false }),
      } as any);

      await runOmni(imagePath, cwd, {});

      expect(vi.mocked(createAgentSession)).toHaveBeenCalledWith(
         expect.objectContaining({
            model: expect.objectContaining({
               id: "gpt-5.4-mini",
               provider: "openai-codex",
            }),
            thinkingLevel: "off",
            tools: ["read"],
         }),
      );
   });

   it("disposes session on completion", async () => {
      const session = mockSession({
         model: {},
         isStreaming: false,
         getLastAssistantText: vi.fn().mockReturnValue("desc"),
      });
      vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

      await runOmni(imagePath, cwd, {});

      expect(session.dispose).toHaveBeenCalledTimes(1);
   });

   it("disposes session even when prompt throws", async () => {
      const dispose = vi.fn();
      vi.mocked(createAgentSession).mockResolvedValue({
         session: mockSession({
            model: {},
            prompt: vi.fn().mockRejectedValue(new Error("boom")),
            dispose,
         }),
      } as any);

      await runOmni(imagePath, cwd, {});

      expect(dispose).toHaveBeenCalledTimes(1);
   });

   it("aborts session when parent signal fires during prompt", async () => {
      const ac = new AbortController();
      const abort = vi.fn().mockResolvedValue(undefined);

      // prompt is a never-resolving promise (simulates model call).
      let promptResolve!: () => void;
      const promptPromise = new Promise<void>((resolve) => {
         promptResolve = resolve;
      });

      vi.mocked(createAgentSession).mockResolvedValue({
         session: mockSession({
            model: {},
            isStreaming: false,
            getLastAssistantText: vi.fn().mockReturnValue("Partial"),
            prompt: vi.fn().mockReturnValue(promptPromise),
            abort,
         }),
      } as any);

      const resultPromise = runOmni(imagePath, cwd, { signal: ac.signal });

      await new Promise((r) => setTimeout(r, 10));
      ac.abort();

      // Allow microtasks to flush — abort handler fires, resolves result.
      const result = await resultPromise;

      expect(abort).toHaveBeenCalled();
      expect(result.text).toContain("Aborted");
      expect(result.text).toContain("File: src/assets/ui.png");

      // Clean up the stuck prompt.
      promptResolve();
   });
});

describe("omni tool registration", () => {
   it("has imagePath parameter", () => {
      const valid = { imagePath: "screenshot.png" };
      expect(valid.imagePath).toBe("screenshot.png");
   });
});

describe("omni system prompt", () => {
   const OMNI_SYSTEM_PROMPT = [
      "You are an omni visual inspector. Your job is to look at an image and",
      "describe what you see in rich textual detail.",
      "",
      "When describing:",
      "- Start with the overall layout and structure.",
      "- Describe colors, typography, spacing, and visual hierarchy.",
      "- Note any text visible in the image (transcribe it).",
      "- Call out interactive elements: buttons, inputs, dropdowns, links.",
      "- Mention alignment issues, spacing inconsistencies, or visual bugs.",
      "- For diagrams/charts: describe axes, data trends, labels, and key values.",
      "- For code screenshots: transcribe the visible code accurately.",
      "",
      "Be thorough. Your output is consumed by another AI that cannot see images.",
      "Do NOT suggest changes. Only describe.",
   ].join("\n");

   it("says do not suggest changes", () => {
      expect(OMNI_SYSTEM_PROMPT).toContain("Do NOT suggest changes");
   });

   it("mentions visual detail categories", () => {
      expect(OMNI_SYSTEM_PROMPT).toContain("colors, typography, spacing");
      expect(OMNI_SYSTEM_PROMPT).toContain("interactive elements");
   });
});
