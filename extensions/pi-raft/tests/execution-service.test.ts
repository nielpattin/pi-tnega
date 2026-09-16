import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { RaftAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import { RaftActivityStore } from "../src/activity/store.js";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { RaftExecutionService } from "../src/execution-service.js";
import type { RaftActionDescriptor, RaftProvider } from "../src/protocol.js";

describe("RaftExecutionService", () => {
  it("runs a program that returns nothing as an empty success", async () => {
    const registry = new ActionRegistry();
    const service = new RaftExecutionService(registry, structuredClone(DEFAULT_RAFT_CONFIG));
    const result = await service.execute({
      code: "const touched = 1; return undefined;",
      signal: undefined,
      parentToolCallId: "empty-return",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("uses the configured disposable Node process executor", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.execution.executor.runtime = "node-process";
    config.execution.executor.memoryLimitBytes = 128 * 1024 * 1024;
    const service = new RaftExecutionService(new ActionRegistry(), config);
    const result = await service.execute({
      code: 'print("native"); return { answer: 42 };',
      signal: undefined,
      parentToolCallId: "native-test",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(result.logs).toEqual(["native"]);
    expect(result.value).toEqual({ answer: 42 });
  });

  it("coalesces all parallel nested calls through one global debounce and flushes on settle", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "ping",
      description: "emit rapid progress",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "debounce fixture",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "ping" ? descriptor : undefined;
      },
      async invoke(_name, args, invocation) {
        invocation.update(`starting ${String(args.id)}`);
        invocation.update(`finishing ${String(args.id)}`);
        return args.id;
      },
    });
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const code = `return Promise.all([
      tools.call({ ref: "demo.ping", args: { id: 1 } }),
      tools.call({ ref: "demo.ping", args: { id: 2 } }),
      tools.call({ ref: "demo.ping", args: { id: 3 } }),
    ]);`;

    const debouncedConfig = structuredClone(DEFAULT_RAFT_CONFIG);
    debouncedConfig.safety.approvals.read = "allow";
    debouncedConfig.appearance.ui.updateDebounceMs = 10_000;
    const debouncedPartials: Array<{ audits: unknown[] }> = [];
    const debounced = await new RaftExecutionService(registry, debouncedConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "global-debounce",
      context,
      onPartial(snapshot) {
        debouncedPartials.push(snapshot);
      },
    });
    expect(debounced.success).toBe(true);
    expect(debouncedPartials).toHaveLength(1);
    expect(debouncedPartials[0]?.audits).toHaveLength(3);

    const immediateConfig = structuredClone(debouncedConfig);
    immediateConfig.appearance.ui.updateDebounceMs = 0;
    const immediatePartials: unknown[] = [];
    await new RaftExecutionService(registry, immediateConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "no-debounce",
      context,
      onPartial(snapshot) {
        immediatePartials.push(snapshot);
      },
    });
    expect(immediatePartials.length).toBeGreaterThan(1);
  });

  it("ignores late nested updates after activity resets during execution", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "stream",
      description: "emit progress on demand",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    let emitUpdate!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register({
      name: "demo",
      description: "stream fixture",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "stream" ? descriptor : undefined;
      },
      async invoke(_name, _args, invocation) {
        emitUpdate = () => invocation.update("late output");
        markStarted();
        await released;
        return true;
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.read = "allow";
    const activity = new RaftActivityStore();
    const execution = new RaftExecutionService(registry, config, activity).execute({
      code: 'return tools.call({ ref: "demo.stream" });',
      signal: undefined,
      parentToolCallId: "reset-during-stream",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    await started;
    expect(activity.get("reset-during-stream")?.status).toBe("running");
    activity.reset();
    expect(() => emitUpdate()).not.toThrow();
    release();

    await expect(execution).resolves.toMatchObject({ success: true, value: true });
    expect(activity.get("reset-during-stream")).toBeUndefined();
  });

  it("throttles continuous nested progress without starving intermediate snapshots", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "stream",
      description: "emit sustained progress",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "stream fixture",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "stream" ? descriptor : undefined;
      },
      async invoke(_name, _args, invocation) {
        for (let index = 0; index < 8; index++) {
          invocation.update(`tick ${index}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return true;
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.read = "allow";
    config.appearance.ui.updateDebounceMs = 50;
    const partials: Array<{ progress?: string | undefined; audits: Array<{ success?: boolean }> }> =
      [];

    const result = await new RaftExecutionService(registry, config).execute({
      code: 'return tools.call({ ref: "demo.stream" });',
      signal: undefined,
      parentToolCallId: "continuous-progress",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial(snapshot) {
        partials.push(structuredClone(snapshot));
      },
    });

    expect(result.success).toBe(true);
    expect(partials.some((snapshot) => snapshot.audits[0]?.success === undefined)).toBe(true);
    expect(
      partials.some(
        (snapshot) => snapshot.progress?.startsWith("tick ") && snapshot.progress !== "tick 7",
      ),
    ).toBe(true);
    expect(partials.length).toBeLessThan(8);
  });

  it("enforces the per-execution agent budget", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args) {
        return { status: "completed", text: String(args.task), usage: { input: 1, output: 1 } };
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.agent = "allow";
    const service = new RaftExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
await Promise.all([
  agents.run({ task: "one" }),
  agents.run({ task: "two" }),
]);
return "unreachable";
`,
      signal: undefined,
      parentToolCallId: "budget-test",
      context,
      maxAgentCalls: 1,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent budget exhausted (1 per execution)");
  });

  it("raises the executor deadline to the agent deadline for orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            clearTimeout(timer);
            resolve({ status: "completed", text: "ok", usage: { input: 0, output: 0 } });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.agent = "allow";
    config.execution.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new RaftExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'await agents.run({ task: "slow" }); return "ok";',
      signal: undefined,
      parentToolCallId: "orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
  });

  it("permits a slow generic tool call beyond executor.timeoutMs via per-invocation timeoutMs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "slowext",
      description: "generic tool stub",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: true,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "extensions",
      description: "fake extensions",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "slowext" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true }), 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.read = "allow";
    config.execution.executor.timeoutMs = 100;
    const service = new RaftExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    // Without a raised deadline the 250ms call fails at the 100ms default.
    const timedOut = await service.execute({
      code: 'await tools.call({ ref: "extensions.slowext", args: { url: "x" } }); return "ok";',
      signal: undefined,
      parentToolCallId: "default-timeout",
      context,
      onPartial() {},
    });
    expect(timedOut.success).toBe(false);
    expect(timedOut.error).toContain("timed out");

    // The per-invocation request raises the whole-program deadline.
    const raised = await service.execute({
      code: 'await tools.call({ ref: "extensions.slowext", args: { url: "x" } }); return "ok";',
      requestedTimeoutMs: 30_000,
      signal: undefined,
      parentToolCallId: "raised-timeout",
      context,
      onPartial() {},
    });
    expect(raised.success).toBe(true);
    expect(raised.value).toBe("ok");

    // The request cannot exceed the configured policy maximum.
    const capped = await service.execute({
      code: 'await tools.call({ ref: "extensions.slowext", args: { url: "x" } }); return "ok";',
      requestedTimeoutMs: 3_600_000,
      signal: undefined,
      parentToolCallId: "capped-timeout",
      context,
      onPartial() {},
    });
    expect(capped.success).toBe(true);
  });

  it("raises the deadline for a configured exact host-call ref", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "subagent",
      description: "generic tool stub",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "read" as const,
    };
    registry.register({
      name: "extensions",
      description: "fake extensions",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "subagent" || name === "unfloored" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true }), 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.read = "allow";
    config.execution.executor.timeoutMs = 100;
    config.execution.executor.hostCallTimeouts = { "extensions.subagent": 30_000 };
    const service = new RaftExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    const result = await service.execute({
      code: 'await tools.call({ ref: "extensions.subagent", args: {} }); return "ok";',
      signal: undefined,
      parentToolCallId: "ref-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");

    // A ref without a configured floor still runs at the default deadline.
    const other = await service.execute({
      code: 'await tools.call({ ref: "extensions.unfloored", args: {} }); return "ok";',
      signal: undefined,
      parentToolCallId: "ref-floor-other",
      context,
      onPartial() {},
    });
    expect(other.success).toBe(false);
    expect(other.error).toContain("timed out");
  });

  it("raises the deadline for literal and computed generic agent refs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({
              status: "completed",
              text: String(args.task),
              usage: { input: 0, output: 0 },
            });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.agent = "allow";
    config.execution.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new RaftExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
const computedRef = ["agents", "run"].join(".");
return Promise.all([
  tools.call({ ref: "agents.run", args: { task: "literal" } }),
  tools.call({ ref: computedRef, args: { task: "computed" } }),
]);
`,
      signal: undefined,
      parentToolCallId: "generic-orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toEqual([
      { status: "completed", text: "literal", usage: { input: 0, output: 0 } },
      { status: "completed", text: "computed", usage: { input: 0, output: 0 } },
    ]);
  });

  it("audits auto approvals and accounts for classifier usage", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "mutate",
      description: "mutate one value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "write" as const,
    };
    const invoke = vi.fn(async (_name, args) => args);
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "mutate" ? descriptor : undefined;
      },
      invoke,
    });
    const usage = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    };
    const classify = vi.fn(async () => ({
      decision: "allow" as const,
      reason: "Bounded task-aligned mutation",
      model: "anthropic/classifier",
      usage,
    }));
    const classifier = { classify } as unknown as RaftAutoApprovalClassifier;
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.write = "auto";
    const service = new RaftExecutionService(registry, config, undefined, undefined, classifier);

    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.mutate", args: { value: "next" } });',
      signal: undefined,
      parentToolCallId: "auto-approval",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "demo.mutate", risk: "write" }),
      { value: "next" },
      expect.anything(),
      undefined,
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.usage).toEqual(usage);
    expect(result.trace.operations).toContainEqual(
      expect.objectContaining({
        ref: "raft.approval.auto",
        result: expect.objectContaining({ decision: "allow", model: "anthropic/classifier" }),
      }),
    );
  });

  it("keeps the short executor deadline for non-orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "slow",
      description: "slow call",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "slow" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.read = "allow";
    config.execution.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new RaftExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.slow", args: {} });',
      signal: undefined,
      parentToolCallId: "no-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});

describe("RaftExecutionService dynamic guest typing", () => {
  const mcpDescriptor: RaftActionDescriptor = {
    name: "github.get_repo",
    description: "Get a GitHub repository",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
    risk: "network",
    namespace: "github",
  };
  const mcpProvider = (
    cacheWarm: boolean,
  ): RaftProvider & { sliceDescriptors?: () => RaftActionDescriptor[] } => ({
    name: "mcp",
    description: "Mock MCP provider",
    async list() {
      return [mcpDescriptor];
    },
    async describe(name) {
      return name === mcpDescriptor.name ? mcpDescriptor : undefined;
    },
    async invoke(_name, args) {
      return { mirrored: args };
    },
    ...(cacheWarm ? { sliceDescriptors: () => [mcpDescriptor] } : {}),
  });
  const setup = (providers: RaftProvider[]) => {
    const registry = new ActionRegistry();
    for (const provider of providers) registry.register(provider);
    const service = new RaftExecutionService(registry, structuredClone(DEFAULT_RAFT_CONFIG));
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const run = (code: string, parentToolCallId: string) =>
      service.execute({ code, signal: undefined, parentToolCallId, context, onPartial() {} });
    return { service, context, run };
  };

  it("rejects argument-shape mistakes on mcp tools before executing", async () => {
    const { run } = setup([mcpProvider(true)]);
    const result = await run(
      'return mcp.github.get_repo({ owner: "octo", repo: "hello", branchs: "main" });',
      "dyn-mcp-typo",
    );
    expect(result.success).toBe(false);
    expect(result.audits).toEqual([]);
    expect(result.trace.outcome).toBe("failed");
    expect(result.trace.operations).toEqual([]);
    expect(result.typeErrors?.map((error) => error.message).join(" ")).toMatch(
      /branchs|known properties/,
    );
  });

  it("executes well-shaped calls against typed mcp surfaces", async () => {
    const { run } = setup([mcpProvider(true)]);
    const result = await run(
      'return mcp.github.get_repo({ owner: "octo", repo: "hello" });',
      "dyn-mcp-valid",
    );
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.audits[0]?.ref).toBe("mcp.github.get_repo");
    expect(result.value).toEqual({ mirrored: { owner: "octo", repo: "hello" } });
  });

  it("routes suppressed-property omissions to registry validation", async () => {
    const { run } = setup([mcpProvider(true)]);
    // Missing a required property is TS2345 (suppressed by design) and never
    // reaches the mcp.invoke path — the registry's validate stage rejects it.
    const result = await run('return mcp.github.get_repo({ owner: "octo" });', "dyn-mcp-missing");
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid arguments for mcp.github.get_repo");
    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "validate",
    });
  });

  it("fails unknown mcp servers at resolve even with a typed surface", async () => {
    const { run } = setup([mcpProvider(true)]);
    const result = await run("return mcp.new_server.tool({ anything: true });", "dyn-mcp-unknown");
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown Raft action: mcp.new_server.tool");
  });

  it("keeps cold-cache mcp surfaces loose and validated at dispatch", async () => {
    const { run } = setup([mcpProvider(false)]);
    const result = await run(
      'return mcp.github.get_repo({ owner: "octo", branchs: "main" });',
      "dyn-mcp-cold",
    );
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid arguments for mcp.github.get_repo");
    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "validate",
    });
  });
});
