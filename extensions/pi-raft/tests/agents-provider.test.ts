import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agents/manager.js";
import type { AgentHandleInfo, AgentRunResult } from "../src/agents/types.js";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";
import type { RaftInvocationContext } from "../src/protocol.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";

const handle: AgentHandleInfo = {
  id: "run-1",
  name: "test agent",
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
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
};

const setup = () => {
  const manager = {
    config: DEFAULT_RAFT_CONFIG.agents,
    spawn: vi.fn(async () => handle),
    wait: vi.fn(async () => result),
    status: vi.fn(() => result),
    list: vi.fn(() => [result]),
    stop: vi.fn(async () => ({ ...result, status: "stopped" as const })),
    readLog: vi.fn(() => ({ id: "run-1", events: [] })),
    detachSignal: vi.fn(),
    resolveKernel: vi.fn(() => undefined),
    resolvePythonRuntime: vi.fn(() => undefined),
  } as unknown as AgentManager;
  const context = {
    cwd: "/work",
    signal: undefined,
    parentToolCallId: "parent",
    nestedToolCallId: "nested",
    update: vi.fn(),
    activity: vi.fn(),
    extensionContext: {},
  } as unknown as RaftInvocationContext;
  return { manager, provider: new AgentsProvider(manager, () => false), context };
};

describe("AgentsProvider local one-shot actions", () => {
  it("exposes only the surviving local action surface", async () => {
    const { provider, context } = setup();
    expect((await provider.list({}, context)).map(({ name }) => name)).toEqual([
      "run",
      "spawn",
      "wait",
      "status",
      "list",
      "stop",
      "log",
    ]);
  });

  it("states each action's result contract so callers learn the handle shape from describe", () => {
    const byName = new Map(AGENTS_ACTION_DESCRIPTORS.map((action) => [action.name, action]));
    for (const name of ["run", "spawn", "wait", "status", "list", "stop", "log"]) {
      expect(byName.get(name)?.outputSchema).toBeDefined();
    }

    // spawn is the action whose result the caller must reuse; its contract names the
    // field that agents.wait takes, which is what a guessed `handle` argument missed.
    const spawn = byName.get("spawn")!.outputSchema as {
      required: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(spawn.required).toContain("awaitWith");
    expect(spawn.properties.id?.description).toMatch(/agents\.wait/);
    expect(spawn.properties.awaitWith?.description).toMatch(/agents\.wait/);
    expect(byName.get("wait")?.description).toMatch(/id.*agents\.spawn/s);
  });

  it("validates strict run arguments and rejects removed action arguments", () => {
    const run = AGENTS_ACTION_DESCRIPTORS.find(({ name }) => name === "run")!;
    expect(Value.Check(run.inputSchema, { task: "task" })).toBe(true);
    expect(Value.Check(run.inputSchema, { task: "task", kernel: "python" })).toBe(true);
    expect(Value.Check(run.inputSchema, { task: "task", modelDiscovery: true })).toBe(false);
    expect(Value.Check(run.inputSchema, { task: "task", unknown: true })).toBe(false);
  });

  it("dispatches run, spawn, wait, status, list, stop, and paged log locally", async () => {
    const { manager, provider, context } = setup();
    await expect(provider.invoke("run", { task: "task" }, context)).resolves.toEqual(result);
    await expect(provider.invoke("spawn", { task: "task" }, context)).resolves.toMatchObject({
      id: "run-1",
      awaitWith: 'agents.wait({ id: "run-1" })',
    });
    await expect(provider.invoke("wait", { id: "run-1" }, context)).resolves.toEqual(result);
    await expect(provider.invoke("status", { id: "run-1" }, context)).resolves.toEqual(result);
    await expect(provider.invoke("list", {}, context)).resolves.toEqual([result]);
    await expect(provider.invoke("stop", { id: "run-1" }, context)).resolves.toMatchObject({
      status: "stopped",
    });
    await expect(
      provider.invoke("log", { id: "run-1", lines: 12, before: 8 }, context),
    ).resolves.toEqual({ id: "run-1", events: [] });
    expect((manager as unknown as { spawn: ReturnType<typeof vi.fn> }).spawn).toHaveBeenCalledTimes(
      2,
    );
    expect((manager as unknown as { wait: ReturnType<typeof vi.fn> }).wait).toHaveBeenCalledTimes(
      2,
    );
    expect(
      (manager as unknown as { status: ReturnType<typeof vi.fn> }).status,
    ).toHaveBeenCalledWith("run-1");
    expect((manager as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith(
      "run-1",
    );
    expect(
      (manager as unknown as { readLog: ReturnType<typeof vi.fn> }).readLog,
    ).toHaveBeenCalledWith("run-1", { lines: 12, before: 8 });
  });
});
