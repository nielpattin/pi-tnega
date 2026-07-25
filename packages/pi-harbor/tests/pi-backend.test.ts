import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  PI_BACKEND_CAPABILITIES,
  routeControl,
  cancelSession,
  createChildInitOptions,
  configureChildTools,
  PiSessionRunner,
  type ControlMode
} from "../src/backends/pi.js";
import { ControlError, CancelError } from "../src/domain.js";

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
      if (result._tag === "Failure") {
        const err = result.cause;
        expect(String(err)).toContain("steer failed");
      }
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

  describe("PiSessionRunner lifecycle vs settlement", () => {
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
      expect(mockSession.prompt).toHaveBeenCalledWith("Please call the submit tool to submit your final result or error.");

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
});
