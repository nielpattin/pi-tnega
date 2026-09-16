import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AgentRunResult } from "../src/agents/types.js";
import {
  collectAgentToolPreviewNodes,
  waitWithProgress,
} from "../src/providers/agents-progress.js";
import {
  collectAgentToolPreviewNodes as publicPreview,
  type AgentToolPreviewTreeOptions,
} from "../src/providers/agents-provider.js";

const record = (id = "run"): AgentRunResult => ({
  id,
  name: id,
  task: "task",
  status: "completed",
  runner: "pi",
  transport: "process",
  cwd: "/project",
  startedAt: 1,
  updatedAt: 2,
  turns: 1,
  toolCalls: 2,
  text: "done",
  usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0 },
});

afterEach(() => vi.useRealTimers());

describe("agents provider progress service boundaries", () => {
  it("preserves the public preview export identity", () => {
    expect(publicPreview).toBe(collectAgentToolPreviewNodes);
    expectTypeOf<AgentToolPreviewTreeOptions>().toEqualTypeOf<
      Parameters<typeof collectAgentToolPreviewNodes>[1]
    >();
  });

  it("attaches final metrics and preview even before the first poll", async () => {
    vi.useFakeTimers();
    const result = record();
    const sink = { update: vi.fn(), activity: vi.fn(), attachPreview: vi.fn() };
    await expect(
      waitWithProgress(
        { wait: async () => result, status: () => result },
        { read: vi.fn() },
        "run",
        sink,
        () => true,
      ),
    ).resolves.toBe(result);
    expect(sink.activity).toHaveBeenCalledWith({
      type: "metrics",
      tokens: 7,
      toolCalls: 2,
      cost: 0,
    });
    expect(sink.attachPreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run", status: "completed" }),
    );
    expect(sink.update).toHaveBeenCalledWith("Agent run: completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the poll and preserves rejection when cancellation removes the run", async () => {
    vi.useFakeTimers();
    const failure = new Error("cancelled");
    await expect(
      waitWithProgress(
        {
          wait: () => Promise.reject(failure),
          status: () => {
            throw new Error("Unknown Raft agent");
          },
        },
        { read: vi.fn() },
        "run",
        { update: vi.fn() },
        () => true,
      ),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects polling errors and stops polling even if the worker is still pending", async () => {
    vi.useFakeTimers();
    const failure = new Error("status unavailable");
    const result = waitWithProgress(
      {
        wait: () => new Promise<AgentRunResult>(() => {}),
        status: () => {
          throw failure;
        },
      },
      { read: vi.fn() },
      "run",
      { update: vi.fn() },
      () => true,
    );
    const assertion = expect(result).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
