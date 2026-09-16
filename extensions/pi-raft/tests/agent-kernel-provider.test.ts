import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agents/manager.js";
import type { AgentHandleInfo, AgentRunResult } from "../src/agents/types.js";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";
import type { RaftInvocationContext } from "../src/protocol.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";

const handle: AgentHandleInfo = {
  id: "kernel-run",
  name: "kernel test",
  status: "running",
  runner: "pi",
  transport: "process",
  cwd: "/work",
};
const result: AgentRunResult = {
  ...handle,
  status: "completed",
  task: "task",
  text: "done",
  turns: 1,
  toolCalls: 0,
  startedAt: 1,
  updatedAt: 2,
  finishedAt: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
};

const setup = () => {
  const manager = {
    config: DEFAULT_RAFT_CONFIG.agents,
    spawn: vi.fn(async () => handle),
    wait: vi.fn(async () => result),
    status: vi.fn(() => result),
    resolveKernel: vi.fn((request: { kernel?: string }) => request.kernel),
    resolvePythonRuntime: vi.fn(() => undefined),
  } as unknown as AgentManager;
  const context = {
    cwd: "/work",
    signal: undefined,
    update: vi.fn(),
    activity: vi.fn(),
    extensionContext: {},
  } as unknown as RaftInvocationContext;
  return { manager, provider: new AgentsProvider(manager, () => false), context };
};

describe("agent kernel public contracts", () => {
  it("accepts only the supported kernel selectors on local actions", () => {
    for (const name of ["run", "spawn"] as const) {
      const schema = AGENTS_ACTION_DESCRIPTORS.find((action) => action.name === name)!.inputSchema;
      for (const kernel of [undefined, "inherit", "typescript", "python"]) {
        expect(Value.Check(schema, { task: "task", ...(kernel ? { kernel } : {}) })).toBe(true);
      }
      for (const kernel of [null, "", "PYTHON", "ruby", false, 1, {}, []]) {
        expect(Value.Check(schema, { task: "task", kernel })).toBe(false);
      }
      expect(Value.Check(schema, { task: "task", kernel: "python", pythonRuntime: "monty" })).toBe(
        false,
      );
      expect(Value.Check(schema, { task: "task", unknown: true })).toBe(false);
    }
  });

  it("forwards concrete kernels to local run requests", async () => {
    const { manager, provider, context } = setup();
    await provider.invoke("run", { task: "task", kernel: "python" }, context);
    expect((manager as unknown as { spawn: ReturnType<typeof vi.fn> }).spawn).toHaveBeenCalledWith(
      expect.objectContaining({ kernel: "python" }),
      undefined,
    );
  });
});
