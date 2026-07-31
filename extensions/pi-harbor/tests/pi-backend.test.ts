import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  PI_BACKEND_CAPABILITIES,
  routeControl,
  cancelSession,
  createChildInitOptions,
  configureChildTools,
  createWorkerSubmitTool,
  PiSessionRunner,
  spawnPiSession,
  type ControlMode
} from "../src/backends/pi.js";
import { ControlError, CancelError } from "../src/domain.js";
import { JobRegistry } from "../src/services/JobRegistry.js";

describe("Pi Backend Adapter", () => {
  it("exposes capabilities with all features true", () => {
    expect(PI_BACKEND_CAPABILITIES).toEqual({
      steering: true,
      followUp: true,
      midTurnTools: true,
      modelSelection: true,
      reasoningEffort: true
    });
  });

  it("validates worker submit without settling before the Pi runner captures the final turn", async () => {
    const runtime = ManagedRuntime.make(JobRegistry.layer);
    const job = await runtime.runPromise(
      JobRegistry.use((registry) =>
        registry.register({
          id: "task-submit-boundary",
          ownerSessionId: "parent",
          name: "submit-boundary",
          kind: "agent",
          promptOrCommand: "Return details",
          async: false
        })
      )
    );
    await runtime.runPromise(JobRegistry.use((registry) => registry.updateStatus(job.id, "running")));
    const tool = createWorkerSubmitTool((effect) => runtime.runPromise(effect), job.id);

    const result = await tool.execute("submit-call", { result: { data: "Complete result" } });
    const stored = await runtime.runPromise(JobRegistry.use((registry) => registry.get(job.id)));

    expect(result.terminate).toBe(true);
    expect(stored?.status).toBe("running");
    await runtime.dispose();
  });

  describe("control routing", () => {
    it("routes control(text, 'steer') to session.steer when streaming", async () => {
      const steerFn = vi.fn();
      const followUpFn = vi.fn();
      const promptFn = vi.fn();

      const fakeSession = {
        isStreaming: true,
        steer: steerFn,
        followUp: followUpFn,
        prompt: promptFn
      };

      await Effect.runPromise(routeControl(fakeSession, "steer message", "steer"));
      expect(steerFn).toHaveBeenCalledWith("steer message");
      expect(followUpFn).not.toHaveBeenCalled();
      expect(promptFn).not.toHaveBeenCalled();
    });

    it("routes control(text, 'followUp') to session.followUp when streaming", async () => {
      const steerFn = vi.fn();
      const followUpFn = vi.fn();
      const promptFn = vi.fn();

      const fakeSession = {
        isStreaming: true,
        steer: steerFn,
        followUp: followUpFn,
        prompt: promptFn
      };

      await Effect.runPromise(routeControl(fakeSession, "follow up message", "followUp"));
      expect(followUpFn).toHaveBeenCalledWith("follow up message");
      expect(steerFn).not.toHaveBeenCalled();
      expect(promptFn).not.toHaveBeenCalled();
    });

    it("routes control(text, mode) to session.prompt when idle for both steer and followUp", async () => {
      const steerFn = vi.fn();
      const followUpFn = vi.fn();
      const promptFn = vi.fn();

      const fakeSession = {
        isStreaming: false,
        steer: steerFn,
        followUp: followUpFn,
        prompt: promptFn
      };

      await Effect.runPromise(routeControl(fakeSession, "idle prompt 1", "steer"));
      await Effect.runPromise(routeControl(fakeSession, "idle prompt 2", "followUp"));

      expect(promptFn).toHaveBeenNthCalledWith(1, "idle prompt 1");
      expect(promptFn).toHaveBeenNthCalledWith(2, "idle prompt 2");
      expect(steerFn).not.toHaveBeenCalled();
      expect(followUpFn).not.toHaveBeenCalled();
    });

    it("wraps control errors in ControlError", async () => {
      const fakeSession = {
        isStreaming: true,
        steer: () => {
          throw new Error("steer failed");
        },
        followUp: vi.fn(),
        prompt: vi.fn()
      };

      const result = await Effect.runPromiseExit(routeControl(fakeSession, "msg", "steer"));
      expect(result._tag).toBe("Failure");
      const _tagNarrowed = result as Extract<typeof result, { _tag: "Failure" }>;
     const err = _tagNarrowed.cause;
     expect(String(err)).toContain("steer failed");
    });
  });

  describe("cancellation logic", () => {
    it("calls clearQueue then abort", async () => {
      const clearQueueFn = vi.fn();
      const abortFn = vi.fn().mockResolvedValue(undefined);

      const fakeSession = {
        clearQueue: clearQueueFn,
        abort: abortFn
      };

      await Effect.runPromise(cancelSession(fakeSession, 1000));
      expect(clearQueueFn).toHaveBeenCalled();
      expect(abortFn).toHaveBeenCalled();
    });

    it("handles cancel failure by wrapping in CancelError", async () => {
      const fakeSession = {
        clearQueue: vi.fn(),
        abort: () => Promise.reject(new Error("abort crashed"))
      };

      const result = await Effect.runPromiseExit(cancelSession(fakeSession, 1000));
      expect(result._tag).toBe("Failure");
    });
  });

  describe("child initialization path pure helpers", () => {
    it("builds loader options with systemPrompt via DefaultResourceLoader options", () => {
      const initOpts = createChildInitOptions({
        cwd: "/test/cwd",
        agentDir: "/test/agentDir",
        settingsManager: { fake: true },
        agentDef: { body: "You are a test agent.", tools: ["read", "write"] }
      });

      expect(initOpts.loaderOptions).toEqual({
        cwd: "/test/cwd",
        agentDir: "/test/agentDir",
        settingsManager: { fake: true },
        systemPrompt: "You are a test agent."
      });
      // createAgentSession options must NOT include customPrompt or modelRegistry
      expect(initOpts.createSessionOptions).not.toHaveProperty("customPrompt");
      expect(initOpts.createSessionOptions).not.toHaveProperty("modelRegistry");
    });

    it("intersects tools with getAllTools and calls setActiveToolsByName", () => {
      const getAllToolsFn = vi.fn().mockReturnValue([
        { name: "read" },
        { name: "write" },
        { name: "submit" },
        { name: "bash" }
      ]);
      const setActiveToolsByNameFn = vi.fn();

      const mockSession = {
        getAllTools: getAllToolsFn,
        setActiveToolsByName: setActiveToolsByNameFn
      };

      configureChildTools(mockSession as any, ["read", "submit", "unknownTool"]);
      expect(setActiveToolsByNameFn).toHaveBeenCalledWith(["read", "submit"]);
    });
  });

  describe("worker submit tool", () => {
    it("terminates a successful turn and preserves the submitted structured payload", async () => {
      const tool = createWorkerSubmitTool(async () => ({ ok: true, status: "completed" }) as any, "task-1");

      const result = await tool.execute("call-submit", { result: { data: { summary: "done" } } });

      expect(tool.promptSnippet).toContain("final action");
      expect(tool.promptGuidelines.every((guideline) => guideline.includes("submit"))).toBe(true);
      expect(result.terminate).toBe(true);
      expect(result.details).toMatchObject({
        ok: true,
        status: "completed",
        result: { data: { summary: "done" } }
      });
    });

    it("does not terminate when schema validation fails and reports actionable errors", async () => {
      const tool = createWorkerSubmitTool(
        async () => ({ ok: false, error: "Schema validation failed: expected number, got string" }) as any,
        "task-1"
      );

      const result = await tool.execute("call-submit", { result: { data: "invalid" } });

      expect(result.terminate).toBeUndefined();
      expect(result.details).toMatchObject({
        ok: false,
        error: expect.stringContaining("Schema validation failed")
      });
    });
  });

  describe("PiSessionRunner lifecycle vs settlement", () => {
    it("settles as cancelled when a worker turn aborts", () => {
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { prompt: vi.fn(), followUp: vi.fn(), abort: vi.fn() } as any,
        onSettle
      });

      runner.handleEvent({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "aborted",
            errorMessage: "The operation was aborted",
            timestamp: Date.now()
          }
        ],
        willRetry: false
      });

      expect(onSettle).toHaveBeenCalledWith("cancelled", undefined, undefined);
    });

    it("settles as failed with the real message on a terminal provider error", () => {
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { prompt: vi.fn(), followUp: vi.fn(), abort: vi.fn() } as any,
        onSettle
      });

      runner.handleEvent({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error",
            errorMessage: "Provider returned 529: overloaded",
            timestamp: Date.now()
          }
        ],
        willRetry: false
      });

      expect(onSettle).toHaveBeenCalledWith("failed", undefined, "Provider returned 529: overloaded");
    });

    it("preserves submit reminders after a genuinely successful agent_end without submit", () => {
      const followUpFn = vi.fn();
      const runner = new PiSessionRunner({
        session: { followUp: followUpFn, prompt: vi.fn(), abort: vi.fn() } as any,
        onSettle: vi.fn()
      });

      runner.handleEvent({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "I did something." }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now()
          }
        ],
        willRetry: false
      });

      expect(followUpFn).toHaveBeenCalledWith(
        "Your previous response did not complete the task. Do not explain or summarize. Call submit now."
      );
    });

    it("does not settle job on agent_end, only settles on submit or max reminders", async () => {
      const listeners: Record<string, Function[]> = {};
      const mockSession = {
        isStreaming: false,
        subscribe: (fn: Function) => {
          listeners.event = listeners.event || [];
          listeners.event.push(fn);
          return () => {};
        },
        prompt: vi.fn(),
        followUp: vi.fn(),
        clearQueue: vi.fn(),
        abort: vi.fn()
      };

      let settledStatus: string | undefined;
      let settledData: unknown;
      let settledError: string | undefined;

      const runner = new PiSessionRunner({
        session: mockSession as any,
        onSettle: (status, data, errorText) => {
          settledStatus = status;
          settledData = data;
          settledError = errorText;
        }
      });

      // Emit agent_end event (1st time)
      runner.handleEvent({ type: "agent_end" });
      expect(settledStatus).toBeUndefined();
      expect(mockSession.prompt).not.toHaveBeenCalled();
      expect(mockSession.followUp).toHaveBeenCalledWith(
        "Your previous response did not complete the task. Do not explain or summarize. Call submit now."
      );

      // Emit agent_end (2nd time)
      runner.handleEvent({ type: "agent_end" });
      expect(settledStatus).toBeUndefined();

      // Emit agent_end (3rd time)
      runner.handleEvent({ type: "agent_end" });
      expect(settledStatus).toBeUndefined();

      // Emit agent_end (4th time -> exceeds 3 reminders -> fail)
      runner.handleEvent({ type: "agent_end" });
      expect(settledStatus).toBe("failed");
      expect(settledError).toContain("missing submit");
    });

    it("settles as completed when submit tool is executed with success data", () => {
      let settledStatus: string | undefined;
      let settledData: unknown;

      const mockSession = {
        subscribe: () => () => {},
        prompt: vi.fn(),
        clearQueue: vi.fn(),
        abort: vi.fn()
      };

      const runner = new PiSessionRunner({
        session: mockSession as any,
        onSettle: (status, data) => {
          settledStatus = status;
          settledData = data;
        }
      });

      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        args: { result: { data: { message: "all done" } } }
      });

      expect(settledStatus).toBe("completed");
      expect(settledData).toEqual({ message: "all done" });
    });

    it("settles from the structured result carried by a real tool end event", () => {
      let settledData: unknown;
      const runner = new PiSessionRunner({
        session: { prompt: vi.fn(), abort: vi.fn() } as any,
        onSettle: (_status, data) => {
          settledData = data;
        }
      });

      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        result: {
          content: [{ type: "text", text: "Task submitted." }],
          details: {
            ok: true,
            status: "completed",
            result: { data: { summary: "structured completion" } }
          },
          terminate: true
        }
      });

      expect(settledData).toEqual({ summary: "structured completion" });
    });

    it("does not settle when schema validation reports an actionable error", () => {
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { prompt: vi.fn(), abort: vi.fn() } as any,
        onSettle
      });

      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        args: { result: { data: "still invalid" } },
        result: {
          details: {
            ok: false,
            error: "Schema validation failed: expected number, got string"
          }
        }
      });

      expect(onSettle).not.toHaveBeenCalled();
    });

    it("allows unlimited schema-rejected submits without reminders before a valid submit", () => {
      const followUp = vi.fn();
      const prompt = vi.fn();
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { followUp, prompt, abort: vi.fn() } as any,
        onSettle
      });

      for (let attempt = 0; attempt < 4; attempt++) {
        runner.handleEvent({
          type: "tool_execution_end",
          toolName: "submit",
          args: { result: { data: `invalid-${attempt}` } },
          result: {
            details: {
              ok: false,
              error: "Schema validation failed: expected number, got string"
            }
          }
        });
        runner.handleEvent({ type: "agent_end" });
      }

      expect(followUp).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(onSettle).not.toHaveBeenCalled();

      const validData = { summary: "valid completion" };
      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        args: { result: { data: validData } }
      });

      expect(onSettle).toHaveBeenCalledTimes(1);
      expect(onSettle).toHaveBeenCalledWith("completed", validData, undefined);
    });

    it("does not settle when submit execution returns an unsuccessful tool result", () => {
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { prompt: vi.fn(), abort: vi.fn() } as any,
        onSettle
      });

      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        result: {
          content: [{ type: "text", text: "Service not found: harbor/JobRegistry" }],
          details: { ok: false, error: "Service not found: harbor/JobRegistry" }
        }
      });

      expect(onSettle).not.toHaveBeenCalled();
    });

    it("keeps a live child session open across rejected submits and settles once on a valid resubmission", async () => {
      let subscriber: ((event: any) => void) | undefined;
      const followUp = vi.fn();
      const prompt = vi.fn().mockResolvedValue(undefined);
      const onSettled = vi.fn();
      const responses = [
        { ok: false, error: "Schema validation failed: expected number, got string" },
        { ok: true, status: "completed" }
      ];
      const mockSession = {
        getAllTools: () => [{ name: "submit" }, { name: "hub" }],
        setActiveToolsByName: vi.fn(),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn((fn: (event: any) => void) => {
          subscriber = fn;
          return () => {};
        }),
        prompt,
        followUp,
        clearQueue: vi.fn(),
        abort: vi.fn().mockResolvedValue(undefined),
        model: { provider: "proxy", id: "live-test" },
        thinkingLevel: "medium",
        isStreaming: true
      };
      let createOptions: any;
      const createSessionFn = vi.fn().mockImplementation(async (options: any) => {
        createOptions = options;
        return { session: mockSession };
      });

      await spawnPiSession({
        jobId: "live-submit-retry",
        prompt: "start",
        runEffect: async () => responses.shift() as any,
        createSessionFn: createSessionFn as any,
        onSettled
      });

      const submitTool = createOptions.customTools.find((tool: any) => tool.name === "submit");
      const invalidArgs = { result: { data: "invalid" } };
      const invalidResult = await submitTool.execute("invalid-call", invalidArgs);
      expect(invalidResult.terminate).toBeUndefined();
      expect(invalidResult.details).toEqual({
        ok: false,
        error: "Schema validation failed: expected number, got string",
        result: invalidArgs.result
      });
      subscriber!({ type: "tool_execution_end", toolName: "submit", args: invalidArgs, result: invalidResult });
      subscriber!({ type: "agent_end", messages: [], willRetry: false });

      expect(mockSession.isStreaming).toBe(true);
      expect(followUp).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledWith("start");
      expect(onSettled).not.toHaveBeenCalled();

      const validArgs = { result: { data: { answer: 42 } } };
      const validResult = await submitTool.execute("valid-call", validArgs);
      expect(validResult.terminate).toBe(true);
      subscriber!({ type: "tool_execution_end", toolName: "submit", args: validArgs, result: validResult });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith("completed", { answer: 42 }, undefined);
    });

    it("preserves terminal lifecycle settlement after a schema rejection and ignores later events", () => {
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { prompt: vi.fn(), followUp: vi.fn(), abort: vi.fn() } as any,
        onSettle
      });

      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        result: {
          details: {
            ok: false,
            error: "Failed to convert JSON schema: unexpected token"
          }
        }
      });
      runner.handleEvent({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: "The operation was aborted"
          }
        ],
        willRetry: false
      });
      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        args: { result: { data: { late: true } } }
      });
      runner.handleEvent({ type: "agent_end", messages: [], willRetry: false });

      expect(onSettle).toHaveBeenCalledTimes(1);
      expect(onSettle).toHaveBeenCalledWith("cancelled", undefined, undefined);
    });

    it("settles as failed when submit tool is executed with error string", () => {
      let settledStatus: string | undefined;
      let settledError: string | undefined;

      const mockSession = {
        subscribe: () => () => {},
        prompt: vi.fn(),
        clearQueue: vi.fn(),
        abort: vi.fn()
      };

      const runner = new PiSessionRunner({
        session: mockSession as any,
        onSettle: (status, _data, errorText) => {
          settledStatus = status;
          settledError = errorText;
        }
      });

      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        args: { result: { error: "something failed in task" } }
      });

      expect(settledStatus).toBe("failed");
      expect(settledError).toBe("something failed in task");
    });
  });

  describe("spawnPiSession orchestration", () => {
    it("emits assistant, tool-call, and actual tool-result transcript entries without synthetic tool text", async () => {
      let subscriber: ((event: any) => void) | undefined;
      const transcripts: any[][] = [];
      const rawOutputs: string[] = [];
      const readyMetadata: any[] = [];
      const mockSession = {
        getAllTools: () => [{ name: "read" }],
        setActiveToolsByName: vi.fn(),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn((fn: (event: any) => void) => {
          subscriber = fn;
          return () => {};
        }),
        prompt: vi.fn().mockResolvedValue(undefined),
        clearQueue: vi.fn(),
        abort: vi.fn().mockResolvedValue(undefined),
        setSessionName: vi.fn(),
        model: { provider: "proxy", id: "test-model" },
        thinkingLevel: "high",
        isStreaming: false
      };

      const handle = await spawnPiSession({
        jobId: "task-transcript",
        sessionName: "task: investigate-copy-all task-transcript",
        prompt: "Inspect the file",
        specTools: ["read"],
        runEffect: (eff) => Effect.runPromise(eff as any),
        createSessionFn: vi.fn().mockResolvedValue({ session: mockSession }) as any,
        onOutput: (text) => rawOutputs.push(text),
        onTranscript: (entries) => transcripts.push([...entries]),
        onSessionReady: (metadata) => {
          readyMetadata.push(metadata);
        }
      });

      subscriber?.({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "I should inspect the requested directory." }
      });
      subscriber?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Checking." }
      });
      subscriber?.({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "src/main.ts" }
      });
      subscriber?.({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: {
          content: [
            { type: "text", text: "export const value = 1;" },
            { type: "image", data: "ignored-binary", mimeType: "image/png" }
          ]
        },
        isError: false
      });
      await Effect.runPromise(handle.control("Continue please", "followUp"));
      subscriber?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: " More." }
      });

      expect(mockSession.setSessionName).toHaveBeenCalledWith("task: investigate-copy-all task-transcript");
      expect(readyMetadata).toEqual([
        expect.objectContaining({ model: "proxy/test-model", thinking: "high", cwd: process.cwd() })
      ]);
      expect(transcripts.at(-1)).toEqual([
        { type: "thinking", text: "I should inspect the requested directory." },
        { type: "assistant", text: "Checking." },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read",
          arguments: { path: "src/main.ts" },
          raw: {
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "read",
            args: { path: "src/main.ts" }
          }
        },
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read",
          content: [
            { type: "text", text: "export const value = 1;" },
            { type: "image", mimeType: "image/png" }
          ],
          isError: false,
          raw: {
            type: "tool_execution_end",
            toolCallId: "call-1",
            toolName: "read",
            result: {
              content: [
                { type: "text", text: "export const value = 1;" },
                { type: "image", data: "ignored-binary", mimeType: "image/png" }
              ]
            },
            isError: false
          }
        },
        { type: "user", text: "Continue please" },
        { type: "assistant", text: " More." }
      ]);
      expect(rawOutputs.at(-1)).toBe("Checking. More.");
      expect(rawOutputs.join("\n")).not.toContain("[tool]");
    });

    it("creates child session via SDK with customTools, excludeTools, systemPrompt, bindExtensions, and wires control/abort", async () => {
      let createdOptions: any = null;
      const mockSession = {
        getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "submit" }, { name: "hub" }, { name: "bash" }],
        setActiveToolsByName: vi.fn(),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        prompt: vi.fn().mockResolvedValue(undefined),
        clearQueue: vi.fn(),
        abort: vi.fn().mockResolvedValue(undefined),
        isStreaming: false
      };

      const mockCreateSession = vi.fn().mockImplementation(async (opts: any) => {
        createdOptions = opts;
        return { session: mockSession };
      });

      const selectedModel = { provider: "proxy", id: "cfai/@cf/moonshotai/kimi-k2.7-code" };
      const modelRegistry = {
        find: vi.fn((provider: string, id: string) =>
          provider === selectedModel.provider && id === selectedModel.id ? selectedModel : undefined
        ),
        getAll: vi.fn(() => [selectedModel])
      };
      const handle = await spawnPiSession({
        jobId: "task-100",
        prompt: "Fix the bug in src/main.ts",
        agentDef: {
          body: "You are a specialized worker agent.",
          tools: ["read", "write"],
          model: "proxy/cfai/@cf/moonshotai/kimi-k2.7-code",
          thinking: "high"
        },
        specTools: ["read", "write"],
        modelRegistry,
        runEffect: (eff) => Effect.runPromise(eff as any),
        createSessionFn: mockCreateSession as any
      });

      // 1. Verify createAgentSession options
      expect(mockCreateSession).toHaveBeenCalled();
      expect(createdOptions).not.toHaveProperty("customPrompt");
      expect(createdOptions).not.toHaveProperty("modelRegistry");
      expect(createdOptions.excludeTools).toEqual(["task", "bash"]);
      expect(createdOptions.customTools).toHaveLength(2);
      expect(createdOptions.customTools.map((t: any) => t.name)).toEqual(["submit", "hub"]);
      expect(createdOptions.model).toBe(selectedModel);
      expect(createdOptions.thinkingLevel).toBe("high");

      // 2. Verify DefaultResourceLoader received systemPrompt via loader options
      expect(createdOptions.resourceLoader.systemPrompt).toContain("You are a specialized worker agent.");
      expect(createdOptions.resourceLoader.systemPrompt).toContain(
        "MANDATORY: You must end every task by calling submit. Never finish with a normal assistant response."
      );
      expect(createdOptions.resourceLoader.systemPrompt).toContain(
        "Submit a complete, self-contained result with every detail the parent needs"
      );
      expect(createdOptions.resourceLoader.systemPrompt).toContain(
        "Never refer to text above, previous prose, or the worker transcript"
      );
      expect(createdOptions.resourceLoader.systemPrompt).toContain(
        'Use the built-in find tool with { "path": "extensions/copy-all", "pattern": "*" }'
      );
      expect(createdOptions.resourceLoader.systemPrompt).toContain("Do not put directory paths inside find.pattern");

      // 3. Verify bindExtensions & active tools configuration
      expect(mockSession.bindExtensions).toHaveBeenCalledWith({ mode: "print" });
      expect(mockSession.setActiveToolsByName).toHaveBeenCalledWith(["read", "write", "submit", "hub"]);

      // 4. Verify initial prompt called
      expect(mockSession.prompt).toHaveBeenCalledWith("Fix the bug in src/main.ts");

      // 5. Verify abort() calls clearQueue & abort via cancelSession
      await Effect.runPromise(handle.abort());
      expect(mockSession.clearQueue).toHaveBeenCalled();
      expect(mockSession.abort).toHaveBeenCalled();

      // 6. Verify control() routes to session.prompt when idle
      await Effect.runPromise(handle.control("additional instruction", "followUp"));
      expect(mockSession.prompt).toHaveBeenLastCalledWith("additional instruction");
    });

    it("routes the child SessionManager into a sibling directory derived from the parent session file", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-child-session-"));

      try {
        const parentFile = path.join(tmpBase, "2026-01-15T123456Z_parent-session-id.jsonl");
        const expectedDir = path.join(tmpBase, "2026-01-15T123456Z_parent-session-id");

        let capturedSessionManager: SessionManager | undefined;
        const mockSession = {
          getAllTools: () => [{ name: "submit" }, { name: "hub" }],
          setActiveToolsByName: vi.fn(),
          bindExtensions: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn().mockReturnValue(() => {}),
          prompt: vi.fn().mockResolvedValue(undefined),
          clearQueue: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
          setSessionName: vi.fn(),
          isStreaming: false
        };

        const mockCreateSession = vi.fn().mockImplementation(async (opts: any) => {
          capturedSessionManager = opts.sessionManager;
          return { session: mockSession };
        });

        await spawnPiSession({
          jobId: "task-child-dir",
          sessionName: "task: child directory task-child-dir",
          prompt: "Testing derived child session directory",
          parentSessionFile: parentFile,
          runEffect: (eff) => Effect.runPromise(eff as any),
          createSessionFn: mockCreateSession as any
        });

        expect(capturedSessionManager).toBeDefined();
        expect(capturedSessionManager!.getSessionDir()).toBe(expectedDir);
        expect(fs.existsSync(expectedDir)).toBe(true);
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("passes the exact lazy child SessionManager to createAgentSession and reports undefined sessionFile initially", async () => {
      const readyMetadata: any[] = [];
      const fakeManager = {
        getCwd: () => process.cwd(),
        getSessionDir: () => path.join(process.cwd(), "child-sessions"),
        getSessionId: vi.fn().mockReturnValue("lazy-session-id"),
        getSessionFile: vi.fn().mockReturnValue(undefined)
      };
      const createSpy = vi.spyOn(SessionManager, "create").mockReturnValue(fakeManager as any);
      const createOpts: any[] = [];
      const mockSession = {
        getAllTools: () => [{ name: "submit" }, { name: "hub" }],
        setActiveToolsByName: vi.fn(),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        prompt: vi.fn().mockResolvedValue(undefined),
        clearQueue: vi.fn(),
        abort: vi.fn().mockResolvedValue(undefined),
        setSessionName: vi.fn(),
        model: { provider: "proxy", id: "lazy-model" },
        thinkingLevel: "medium",
        isStreaming: false
      };
      const mockCreateSession = vi.fn().mockImplementation(async (opts: any) => {
        createOpts.push(opts);
        return { session: mockSession };
      });

      try {
        await spawnPiSession({
          jobId: "lazy-init",
          prompt: "be lazy",
          runEffect: (eff) => Effect.runPromise(eff as any),
          createSessionFn: mockCreateSession as any,
          onSessionReady: (metadata) => { readyMetadata.push(metadata); }
        });

        expect(createOpts[0].sessionManager).toBe(fakeManager);
        expect(readyMetadata).toHaveLength(1);
        expect(readyMetadata[0]).toEqual({
          model: "proxy/lazy-model",
          thinking: "medium",
          cwd: process.cwd(),
          sessionFile: undefined,
          sessionId: "lazy-session-id"
        });
      } finally {
        createSpy.mockRestore();
      }
    });

    it("captures the child session file on the first event after lazy JSONL creation", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-lazy-event-"));
      const parentFile = path.join(tmpBase, "2026-01-15T123456Z_parent.jsonl");
      const expectedDir = path.join(tmpBase, "2026-01-15T123456Z_parent");
      const childFile = path.join(expectedDir, "event-created.jsonl");
      let currentFile: string | undefined = undefined;
      const fakeManager = {
        getCwd: () => process.cwd(),
        getSessionDir: () => expectedDir,
        getSessionId: vi.fn().mockReturnValue("event-session-id"),
        getSessionFile: vi.fn(() => currentFile)
      };
      const createSpy = vi.spyOn(SessionManager, "create").mockReturnValue(fakeManager as any);
      let subscriber: ((event: any) => void) | undefined;

      try {
        const mockSession = {
          getAllTools: () => [{ name: "submit" }, { name: "hub" }],
          setActiveToolsByName: vi.fn(),
          bindExtensions: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn((fn: (event: any) => void) => {
            subscriber = fn;
            return () => {};
          }),
          prompt: vi.fn().mockResolvedValue(undefined),
          clearQueue: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
          setSessionName: vi.fn(),
          model: { provider: "proxy", id: "lazy-model" },
          thinkingLevel: "medium",
          isStreaming: false
        };
        const mockCreateSession = vi.fn().mockResolvedValue({ session: mockSession });
        const readyMetadata: any[] = [];

        await spawnPiSession({
          jobId: "lazy-event",
          prompt: "be lazy",
          parentSessionFile: parentFile,
          runEffect: (eff) => Effect.runPromise(eff as any),
          createSessionFn: mockCreateSession as any,
          onSessionReady: (metadata) => { readyMetadata.push(metadata); }
        });

        expect(readyMetadata).toHaveLength(1);
        expect(readyMetadata[0].sessionFile).toBeUndefined();

        currentFile = childFile;
        subscriber!({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hello" }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(readyMetadata).toHaveLength(2);
        expect(readyMetadata[1]).toEqual({
          model: "proxy/lazy-model",
          thinking: "medium",
          cwd: process.cwd(),
          sessionFile: childFile,
          sessionId: "event-session-id"
        });
        expect(path.dirname(readyMetadata[1].sessionFile!)).toBe(expectedDir);
      } finally {
        createSpy.mockRestore();
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("deduplicates onSessionReady calls when successive child events carry unchanged metadata", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-lazy-dedup-"));
      const parentFile = path.join(tmpBase, "2026-01-15T123456Z_parent.jsonl");
      const expectedDir = path.join(tmpBase, "2026-01-15T123456Z_parent");
      const childFile = path.join(expectedDir, "dedup.jsonl");
      let currentFile: string | undefined = undefined;
      const fakeManager = {
        getCwd: () => process.cwd(),
        getSessionDir: () => expectedDir,
        getSessionId: vi.fn().mockReturnValue("dedup-session-id"),
        getSessionFile: vi.fn(() => currentFile)
      };
      const createSpy = vi.spyOn(SessionManager, "create").mockReturnValue(fakeManager as any);
      let subscriber: ((event: any) => void) | undefined;

      try {
        const mockSession = {
          getAllTools: () => [{ name: "submit" }, { name: "hub" }],
          setActiveToolsByName: vi.fn(),
          bindExtensions: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn((fn: (event: any) => void) => {
            subscriber = fn;
            return () => {};
          }),
          prompt: vi.fn().mockResolvedValue(undefined),
          clearQueue: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
          setSessionName: vi.fn(),
          model: { provider: "proxy", id: "lazy-model" },
          thinkingLevel: "medium",
          isStreaming: false
        };
        const mockCreateSession = vi.fn().mockResolvedValue({ session: mockSession });
        const readyMetadata: any[] = [];

        await spawnPiSession({
          jobId: "lazy-dedup",
          prompt: "be lazy",
          parentSessionFile: parentFile,
          runEffect: (eff) => Effect.runPromise(eff as any),
          createSessionFn: mockCreateSession as any,
          onSessionReady: (metadata) => { readyMetadata.push(metadata); }
        });

        currentFile = childFile;
        subscriber!({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "a" }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        subscriber!({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "b" }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        subscriber!({
          type: "tool_execution_start",
          toolCallId: "c",
          toolName: "read",
          args: {}
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(readyMetadata).toHaveLength(2);
        expect(readyMetadata[1].sessionFile).toBe(childFile);
      } finally {
        createSpy.mockRestore();
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("falls back to reading the child session file at terminal settlement", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-lazy-settle-"));
      const parentFile = path.join(tmpBase, "2026-01-15T123456Z_parent.jsonl");
      const expectedDir = path.join(tmpBase, "2026-01-15T123456Z_parent");
      const childFile = path.join(expectedDir, "settle-created.jsonl");
      let currentFile: string | undefined = undefined;
      const fakeManager = {
        getCwd: () => process.cwd(),
        getSessionDir: () => expectedDir,
        getSessionId: vi.fn().mockReturnValue("settle-session-id"),
        getSessionFile: vi.fn(() => currentFile)
      };
      const createSpy = vi.spyOn(SessionManager, "create").mockReturnValue(fakeManager as any);
      let subscriber: ((event: any) => void) | undefined;

      try {
        const mockSession = {
          getAllTools: () => [{ name: "submit" }, { name: "hub" }],
          setActiveToolsByName: vi.fn(),
          bindExtensions: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn((fn: (event: any) => void) => {
            subscriber = fn;
            return () => {};
          }),
          prompt: vi.fn().mockResolvedValue(undefined),
          clearQueue: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
          setSessionName: vi.fn(),
          model: { provider: "proxy", id: "lazy-model" },
          thinkingLevel: "medium",
          isStreaming: false
        };
        const mockCreateSession = vi.fn().mockResolvedValue({ session: mockSession });
        const readyMetadata: any[] = [];
        let settled = false;

        await spawnPiSession({
          jobId: "lazy-settle",
          prompt: "be lazy",
          parentSessionFile: parentFile,
          runEffect: (eff) => Effect.runPromise(eff as any),
          createSessionFn: mockCreateSession as any,
          onSessionReady: (metadata) => { readyMetadata.push(metadata); },
          onSettled: () => {
            settled = true;
          }
        });

        expect(readyMetadata).toHaveLength(1);
        expect(readyMetadata[0].sessionFile).toBeUndefined();

        currentFile = childFile;
        subscriber!({
          type: "tool_execution_end",
          toolName: "submit",
          args: { result: { data: "done" } }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(settled).toBe(true);
        expect(readyMetadata).toHaveLength(2);
        expect(readyMetadata[1]).toMatchObject({
          model: "proxy/lazy-model",
          thinking: "medium",
          cwd: process.cwd(),
          sessionFile: childFile,
          sessionId: "settle-session-id"
        });
      } finally {
        createSpy.mockRestore();
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("child session compaction configuration", () => {
    it("propagates automatic compaction as enabled when Pi has no explicit disable", async () => {
      const createSpy = vi
        .spyOn(SettingsManager, "create")
        .mockImplementation((_cwd: any, _agentDir: any, options: any) => SettingsManager.inMemory({}, options));

      try {
        const captured: any[] = [];
        const mockSession = {
          getAllTools: () => [{ name: "read" }, { name: "submit" }, { name: "hub" }],
          setActiveToolsByName: vi.fn(),
          bindExtensions: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn().mockReturnValue(() => {}),
          prompt: vi.fn().mockResolvedValue(undefined),
          clearQueue: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
          isStreaming: false
        };
        const mockCreateSession = vi.fn().mockImplementation(async (opts: any) => {
          captured.push(opts);
          return { session: mockSession };
        });

        await spawnPiSession({
          jobId: "compact-default",
          prompt: "do work",
          runEffect: (eff) => Effect.runPromise(eff as any),
          createSessionFn: mockCreateSession as any
        });

        expect(captured[0].settingsManager.getCompactionEnabled()).toBe(true);
        expect(captured[0].settingsManager.getCompactionReserveTokens()).toBe(16384);
      } finally {
        createSpy.mockRestore();
      }
    });

    it("respects an explicit user/project compaction disable", async () => {
      const createSpy = vi
        .spyOn(SettingsManager, "create")
        .mockImplementation((_cwd: any, _agentDir: any, options: any) =>
          SettingsManager.inMemory({ compaction: { enabled: false } }, options)
        );

      try {
        const captured: any[] = [];
        const mockSession = {
          getAllTools: () => [{ name: "submit" }, { name: "hub" }],
          setActiveToolsByName: vi.fn(),
          bindExtensions: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn().mockReturnValue(() => {}),
          prompt: vi.fn().mockResolvedValue(undefined),
          clearQueue: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
          isStreaming: false
        };
        const mockCreateSession = vi.fn().mockImplementation(async (opts: any) => {
          captured.push(opts);
          return { session: mockSession };
        });

        await spawnPiSession({
          jobId: "compact-disabled",
          prompt: "do work",
          runEffect: (eff) => Effect.runPromise(eff as any),
          createSessionFn: mockCreateSession as any
        });

        expect(captured[0].settingsManager.getCompactionEnabled()).toBe(false);
      } finally {
        createSpy.mockRestore();
      }
    });
  });

  describe("PiSessionRunner compaction lifecycle", () => {
    const overflowMessage = (text: string): any => ({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      usage: { input: 150, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0 } },
      stopReason: "error",
      errorMessage: text,
      timestamp: Date.now()
    });

    const stopMessage = (text: string): any => ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
      stopReason: "stop",
      timestamp: Date.now()
    });

    it("does not settle or remind while compaction/retry events are in flight", () => {
      const followUp = vi.fn();
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { followUp, prompt: vi.fn(), abort: vi.fn() } as any,
        onSettle,
        modelContextWindow: 100
      });

      runner.handleEvent({
        type: "agent_end",
        messages: [overflowMessage("prompt is too long: 150 tokens > 100 maximum")],
        willRetry: false
      });
      expect(onSettle).not.toHaveBeenCalled();
      expect(followUp).not.toHaveBeenCalled();

      runner.handleEvent({ type: "compaction_start" });
      runner.handleEvent({
        type: "agent_end",
        messages: [stopMessage("I have compacted.")],
        willRetry: false
      });
      expect(followUp).not.toHaveBeenCalled();

      runner.handleEvent({
        type: "compaction_end",
        aborted: false,
        willRetry: true,
        result: { summary: "summary", firstKeptEntryId: "e1", tokensBefore: 150 }
      });
      expect(followUp).not.toHaveBeenCalled();
      expect(onSettle).not.toHaveBeenCalled();

      runner.handleEvent({
        type: "agent_end",
        messages: [stopMessage("Still need to submit.")],
        willRetry: false
      });
      expect(followUp).toHaveBeenCalledTimes(1);
      expect(onSettle).not.toHaveBeenCalled();
    });

    it("recovers from context overflow through auto-compaction and accepts a later submit", () => {
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { prompt: vi.fn(), abort: vi.fn() } as any,
        onSettle,
        modelContextWindow: 100
      });

      runner.handleEvent({
        type: "agent_end",
        messages: [overflowMessage("prompt is too long: 150 tokens > 100 maximum")],
        willRetry: false
      });
      runner.handleEvent({ type: "compaction_start" });
      runner.handleEvent({
        type: "compaction_end",
        aborted: false,
        willRetry: true,
        result: { summary: "summary", firstKeptEntryId: "e1", tokensBefore: 150 }
      });
      runner.handleEvent({
        type: "tool_execution_end",
        toolName: "submit",
        args: { result: { data: { recovered: true } } }
      });

      expect(onSettle).toHaveBeenCalledWith("completed", { recovered: true }, undefined);
    });

    it("uses the provided context window to confirm overflow when the provider silently exceeds the window", () => {
      const prompt = vi.fn();
      const followUp = vi.fn();
      const onSettle = vi.fn();
      const runner = new PiSessionRunner({
        session: { prompt, followUp, abort: vi.fn() } as any,
        onSettle,
        modelContextWindow: 100
      });

      // Silent overflow: stopReason "stop" but input exceeds the context window.
      runner.handleEvent({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 150, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0 } },
            stopReason: "stop",
            timestamp: Date.now()
          }
        ],
        willRetry: false
      });
      expect(onSettle).not.toHaveBeenCalled();
      expect(followUp).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe("spawnPiSession tool availability after compaction", () => {
    it("keeps submit and hub active after a compaction event", async () => {
      const activeNames: string[] = [];
      let subscriber: ((event: any) => void) | undefined;
      const mockSession = {
        getAllTools: () => [{ name: "read" }, { name: "submit" }, { name: "hub" }],
        setActiveToolsByName: vi.fn((names: string[]) => {
          activeNames.push(...names);
        }),
        bindExtensions: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn((fn: (event: any) => void) => {
          subscriber = fn;
          return () => {};
        }),
        prompt: vi.fn().mockResolvedValue(undefined),
        clearQueue: vi.fn(),
        abort: vi.fn().mockResolvedValue(undefined),
        model: { provider: "proxy", id: "test-model", contextWindow: 200000 },
        thinkingLevel: "medium",
        isStreaming: false
      };
      const mockCreateSession = vi.fn().mockResolvedValue({ session: mockSession });

      await spawnPiSession({
        jobId: "compact-tools",
        prompt: "do work",
        specTools: ["read"],
        runEffect: (eff) => Effect.runPromise(eff as any),
        createSessionFn: mockCreateSession as any
      });

      expect(activeNames).toEqual(["read", "submit", "hub"]);
      subscriber?.({
        type: "compaction_end",
        aborted: false,
        willRetry: false,
        result: { summary: "summary", firstKeptEntryId: "e1", tokensBefore: 1000 }
      });
      expect(mockSession.setActiveToolsByName).toHaveBeenCalledTimes(1);
    });
  });
});

