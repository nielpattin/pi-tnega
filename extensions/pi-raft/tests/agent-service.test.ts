import fs from "node:fs";
import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentService,
  createAgentServiceClient,
  createAgentServiceHandler,
  createAgentsProvider,
  type AgentExecutionPort,
  type AgentExecutionRequest,
  type AgentExecutionResponse,
  type AgentServiceEvent,
} from "../src/agents.js";
import type { RaftInvocationContext } from "../src/protocol.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 };
const context = { signal: undefined } as RaftInvocationContext;
const services: AgentService[] = [];
const service = (
  port: AgentExecutionPort,
  options: Partial<ConstructorParameters<typeof AgentService>[0]> = {},
) => {
  const instance = new AgentService({ rootId: "root", port, ...options });
  services.push(instance);
  return instance;
};
const hanging = () => {
  const requests = new Map<string, AgentExecutionRequest>();
  const results = new Map<string, ReturnType<typeof deferred<AgentExecutionResponse>>>();
  const execute = vi.fn(async (request: AgentExecutionRequest) => {
    requests.set(request.id, request);
    const result = deferred<AgentExecutionResponse>();
    results.set(request.id, result);
    const stop = () => result.resolve({ status: "stopped" });
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted) stop();
    return result.promise;
  });
  const cleanup = vi.fn(async () => {});
  return { port: { execute, cleanup }, requests, results };
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(services.splice(0).map((entry) => entry.close()));
});

describe("hosted Raft agent service", () => {
  it("shares native normalization/schema results, stable prepare identity, usage and private checkpoints", async () => {
    const events: AgentServiceEvent[] = [];
    const prepare = vi.fn(async (request) => ({ authorizedId: request.id }));
    const instance = service(
      {
        prepare,
        execute: async (request) => {
          expect(request.binding).toEqual({ authorizedId: request.id });
          expect(request.generation).toBe(prepare.mock.calls[0]![0].generation);
          await request.emit({ type: "progress", turns: 1, toolCalls: 2, usage });
          await request.emit({ type: "checkpoint", checkpoint: { secret: "opaque" } });
          return { status: "completed", text: 'Answer:\n```json\n{"ok":true}\n```' };
        },
      },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    const client = createAgentServiceClient(createAgentServiceHandler(instance, "root"));
    const provider = createAgentsProvider(client);
    const result = await provider.invoke(
      "run",
      {
        prompt: "  task  ",
        thinking: "LOW",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
      context,
    );
    expect(result).toMatchObject({
      status: "completed",
      task: "  task  ",
      thinking: "low",
      turns: 1,
      toolCalls: 2,
      usage,
      value: { ok: true },
      depth: 1,
      parentId: "root",
    });
    expect(JSON.stringify(result)).not.toContain("opaque");
    const [record] = await client.list();
    expect(record).not.toHaveProperty("checkpoint");
    expect(await client.status(record!.id)).not.toHaveProperty("checkpoint");
    expect(await client.wait(record!.id)).not.toHaveProperty("checkpoint");
    expect(instance.snapshot().records[0]!.record.checkpoint).toEqual({ secret: "opaque" });
    expect(events.map((event) => event.type)).toEqual([
      "admitted",
      "running",
      "progress",
      "checkpoint",
      "settled",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.at(-1)!.record.checkpoint).toEqual({ secret: "opaque" });
  });

  it("consumes admitted failed starts, not denied asynchronous preparation", async () => {
    const cleanup = vi.fn(async () => {});
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("placement denied"))
      .mockResolvedValue(undefined);
    const execute = vi.fn(async () => {
      throw new Error("start failed");
    });
    const instance = service({ prepare, execute, cleanup });
    await expect(instance.run("root", { task: "denied" })).rejects.toThrow("placement denied");
    expect(instance.snapshot().starts).toBe(0);
    expect(await instance.run("root", { task: "admitted" })).toMatchObject({
      status: "failed",
      error: "start failed",
    });
    expect(instance.snapshot().starts).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("validates structured output using the native worker failure contract", async () => {
    const instance = service({
      execute: async () => ({ status: "completed", text: '{"ok":"wrong"}' }),
    });
    const result = await instance.run("root", {
      task: "structured",
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^Structured agent output was invalid:/);
    expect(result.error).toContain('output: {"ok":"wrong"}');
    expect(result.finishedAt).toBeTypeOf("number");
  });

  it("admits exactly eight attempts atomically after nine concurrent preparations", async () => {
    const gate = deferred<void>();
    const prepare = vi.fn(async () => gate.promise);
    const instance = service(
      { prepare, execute: async () => ({ status: "completed" }) },
      { maxConcurrent: 9 },
    );
    const operations = Array.from({ length: 9 }, (_, index) =>
      instance.run("root", { task: String(index) }),
    );
    const all = Promise.allSettled(operations);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(9));
    expect(instance.snapshot().starts).toBe(0);
    gate.resolve();
    const results = await all;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(instance.snapshot().starts).toBe(8);
  });

  it("uses per-parent concurrency without recursive semaphore deadlock and checks depth", async () => {
    let instance: AgentService;
    instance = service(
      {
        execute: async (request) => {
          if (request.depth === 3) {
            await expect(instance.run(request.id, { task: "too deep" })).rejects.toThrow(
              "depth limit",
            );
            return { status: "completed", text: "leaf" };
          }
          const child = await instance.run(request.id, { task: "nested" });
          return { status: "completed", text: child.text };
        },
      },
      { maxConcurrent: 1 },
    );
    expect(await instance.run("root", { task: "parent" })).toMatchObject({
      status: "completed",
      text: "leaf",
    });
    expect(instance.snapshot().starts).toBe(3);
    const child = instance.snapshot().records.find(({ record }) => record.depth === 2)!.record;
    await expect(instance.status("root", child.id)).rejects.toThrow("direct child");
    await expect(instance.stop("foreign", child.id)).rejects.toThrow("Unknown agent caller");
  });

  it("rechecks authority after prepare and refuses stale admissions without charging", async () => {
    let authorized = true;
    const execute = vi.fn();
    const instance = service(
      {
        prepare: async () => {
          authorized = false;
        },
        execute,
      },
      {
        assertAuthority: () => {
          if (!authorized) throw new Error("lease revoked");
        },
      },
    );
    await expect(instance.spawn("root", { task: "stale" })).rejects.toThrow("lease revoked");
    expect(instance.snapshot().starts).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts only a waiter and leaves the admitted child running", async () => {
    const host = hanging();
    const instance = service(host.port);
    const handle = await instance.spawn("root", { task: "background" });
    await vi.waitFor(() => expect(host.requests.has(handle.id)).toBe(true));
    const controller = new AbortController();
    const waiter = instance.wait("root", handle.id, controller.signal);
    controller.abort();
    await expect(waiter).rejects.toThrow("aborted");
    expect(host.requests.get(handle.id)!.signal.aborted).toBe(false);
    host.results.get(handle.id)!.resolve({ status: "completed", text: "still alive" });
    expect(await instance.wait("root", handle.id)).toMatchObject({
      status: "completed",
      text: "still alive",
    });
  });

  it("stops descendants and waits for control acknowledgment before cleanup and waiter completion", async () => {
    const host = hanging();
    const stopAck = deferred<void>();
    const stop = vi.fn(async () => stopAck.promise);
    const instance = service({ ...host.port, stop });
    const parent = await instance.spawn("root", { task: "parent" });
    await vi.waitFor(() => expect(host.requests.has(parent.id)).toBe(true));
    const child = await instance.spawn(parent.id, { task: "child" });
    await vi.waitFor(() => expect(host.requests.has(child.id)).toBe(true));
    const stopped = instance.stop("root", parent.id);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    expect(host.port.cleanup).not.toHaveBeenCalled();
    stopAck.resolve();
    expect(await stopped).toMatchObject({ status: "stopped" });
    expect(await instance.wait(parent.id, child.id)).toMatchObject({ status: "stopped" });
    expect(host.port.cleanup).toHaveBeenCalledTimes(2);
    await instance.close();
    expect(host.port.cleanup).toHaveBeenCalledTimes(2);
  });

  it("fences execution after asynchronous running publication and drains cleanup even when stop acknowledgment fails", async () => {
    let authorized = true;
    const execute = vi.fn();
    const cleanup = vi.fn(async () => {});
    const fenced = service(
      { execute, cleanup },
      {
        assertAuthority: () => {
          if (!authorized) throw new Error("revoked");
        },
        onEvent: async (event) => {
          if (event.type === "running") authorized = false;
        },
      },
    );
    const handle = await fenced.spawn("root", { task: "fenced start" });
    await fenced.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fenced.snapshot().records[0]!.record).toMatchObject({ id: handle.id, status: "failed" });
    const host = hanging();
    const instance = service({
      ...host.port,
      stop: async () => {
        throw new Error("stop ack failed");
      },
    });
    const child = await instance.spawn("root", { task: "stop failure" });
    await vi.waitFor(() => expect(host.requests.has(child.id)).toBe(true));
    await expect(instance.stop("root", child.id)).rejects.toThrow("Agent stop failed");
    expect(host.port.cleanup).toHaveBeenCalledOnce();
    expect(await instance.wait("root", child.id)).toMatchObject({ status: "stopped" });
  });

  it("drains background descendants admitted by live parents during natural completion", async () => {
    const gate = deferred<void>();
    const leaf = deferred<void>();
    let instance: AgentService;
    instance = service(
      {
        execute: async (request) => {
          if (request.depth === 1) {
            await gate.promise;
            await instance.spawn(request.id, { task: "background child" });
            return { status: "completed", text: "parent done" };
          }
          await leaf.promise;
          return { status: "completed", text: "child done" };
        },
      },
      { maxConcurrent: 1 },
    );
    await instance.spawn("root", { task: "parent" });
    let drained = false;
    const drain = instance.drain().then(() => {
      drained = true;
    });
    gate.resolve();
    await vi.waitFor(() => expect(instance.snapshot().records).toHaveLength(2));
    expect(drained).toBe(false);
    expect(instance.snapshot().records[0]!.record.status).toBe("completed");
    leaf.resolve();
    await drain;
    expect(instance.snapshot().records.map(({ record }) => record.status)).toEqual([
      "completed",
      "completed",
    ]);
    await instance.close();
    expect(instance.snapshot().records.map(({ record }) => record.status)).toEqual([
      "completed",
      "completed",
    ]);
  });
});
