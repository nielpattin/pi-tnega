import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRaftConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { RaftExecutionService } from "../src/execution-service.js";
import { CPythonRuntime } from "../src/runtime/cpython-runtime.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";

afterEach(() => vi.restoreAllMocks());

describe.each(["monty", "cpython"] as const)("%s host-call deadline floors", (pythonRuntime) => {
  it("resolves configured ref floors and blocking orchestration floors", async () => {
    const config = normalizeRaftConfig({
      execution: {
        executor: {
          kernel: "python",
          pythonRuntime,
          timeoutMs: 1000,
          hostCallTimeouts: { "mcp.demo.echo": 60_000 },
        },
      },
      agents: { timeoutMs: 2000 },
    });
    const prototype = pythonRuntime === "monty" ? MontyRuntime.prototype : CPythonRuntime.prototype;
    vi.spyOn(prototype, "execute").mockImplementation(async (_code, _host, options) => ({
      terminationReason: "completed",
      logs: [],
      value: [
        // An explicit agents.run request raises the floor above agents.timeoutMs.
        options.minimumTimeoutMsForHostCall!("agents.run", { timeoutMs: 5000 }),
        // A request below agents.timeoutMs never lowers it.
        options.minimumTimeoutMsForHostCall!("agents.run", { timeoutMs: 100 }),
        // Non-numeric requests fall back to agents.timeoutMs.
        options.minimumTimeoutMsForHostCall!("agents.run", { timeoutMs: "5000" }),
        options.minimumTimeoutMsForHostCall!("agents.wait", {}),
        // A configured exact-ref floor applies to the direct ref...
        options.minimumTimeoutMsForHostCall!("mcp.demo.echo", {}),
        // ...including when the ref arrives through the generic call bridge.
        options.minimumTimeoutMsForHostCall!("raft.$call", { ref: "mcp.demo.echo", args: {} }),
        // Unconfigured, non-blocking refs get no floor at all.
        options.minimumTimeoutMsForHostCall!("mcp.other", {}),
      ],
    }));
    const registry = new ActionRegistry();
    try {
      const result = await new RaftExecutionService(registry, config).execute({
        code: "return 1",
        signal: undefined,
        parentToolCallId: "deadline",
        context: { cwd: process.cwd() } as ExtensionContext,
        onPartial() {},
      });
      expect(result).toMatchObject({
        success: true,
        value: [5000, 2000, 2000, 2000, 60000, 60000, undefined],
      });
    } finally {
      await registry.close();
    }
  });
});
