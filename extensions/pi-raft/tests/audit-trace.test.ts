import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  RAFT_EXECUTION_DETAILS_MAX_BYTES,
  createRaftPersistedExecutionDetails,
  readRaftExecutionRenderDetails,
} from "../src/audit/details.js";
import {
  RAFT_EXECUTION_TRACE_MAX_BYTES,
  RaftExecutionTraceRecorder,
  RaftTraceSafeError,
  executionOutcomeFromError,
  isRaftExecutionTraceV1,
  readRaftExecutionTraceV1,
  type RaftExecutionFailureStageV1,
} from "../src/audit/trace.js";
import { RaftActivityStore } from "../src/activity/store.js";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { RaftExecutionService } from "../src/execution-service.js";
import type { RaftProvider } from "../src/protocol.js";

const descriptor = {
  name: "echo",
  description: "Echo a value",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" }, delay: { type: "number" } },
    required: ["value"],
    additionalProperties: true,
  },
  risk: "read" as const,
};

const demoProvider = (overrides: Partial<RaftProvider> = {}): RaftProvider => ({
  name: "demo",
  description: "Demo",
  async list() {
    return [descriptor];
  },
  async describe(name) {
    return name === "echo" ? descriptor : undefined;
  },
  async invoke(_name, args) {
    const delay = typeof args.delay === "number" ? args.delay : 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return { value: args.value };
  },
  ...overrides,
});

const serviceFor = (
  provider: RaftProvider = demoProvider(),
): { service: RaftExecutionService; context: ExtensionContext } => {
  const registry = new ActionRegistry();
  registry.register(provider);
  const config = structuredClone(DEFAULT_RAFT_CONFIG);
  config.safety.approvals.read = "allow";
  return {
    service: new RaftExecutionService(registry, config),
    context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
  };
};

const serviceForRegistry = (
  registry: ActionRegistry,
  context: ExtensionContext = { cwd: process.cwd(), hasUI: false } as ExtensionContext,
): { service: RaftExecutionService; context: ExtensionContext } => {
  const config = structuredClone(DEFAULT_RAFT_CONFIG);
  config.safety.approvals.read = "allow";
  return { service: new RaftExecutionService(registry, config), context };
};

const execute = (
  service: RaftExecutionService,
  context: ExtensionContext,
  code: string,
  signal?: AbortSignal,
) => service.execute({ code, signal, parentToolCallId: "trace-test", context, onPartial() {} });

describe("Raft execution trace V1", () => {
  it("records successful calls with the stable V1 envelope and preserves legacy audits", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "demo.echo", args: { value: "ok" } });',
    );

    expect(result.trace).toEqual({
      kind: "pi-raft.execution",
      version: 1,
      outcome: "succeeded",
      phases: [],
      operations: [
        {
          type: "call",
          sequence: 0,
          ref: "demo.echo",
          provider: "demo",
          action: "echo",
          args: {},
          outcome: "succeeded",
        },
      ],
      counts: { droppedValues: 2, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
    });
    expect(result.audits).toMatchObject([
      { ref: "demo.echo", provider: "demo", tool: "echo", success: true },
    ]);
    expect(isRaftExecutionTraceV1(result.trace)).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it.each<{
    name: string;
    provider: RaftProvider;
    code: string;
    stage: RaftExecutionFailureStageV1;
    expectedError?: string;
  }>([
    {
      name: "unknown action",
      provider: demoProvider(),
      code: 'return tools.call({ ref: "demo.missing", args: {} });',
      stage: "resolve",
      // Resolve-stage failures are registry-generated and carry no argument
      // payloads, so the cause is surfaced in the rendered failure line.
      expectedError: "Call failed during resolve: Unknown Raft action: demo.missing",
    },
    {
      name: "argument preparation",
      provider: demoProvider({
        async prepareArguments() {
          throw new Error("prepare exploded");
        },
      }),
      code: 'return tools.call({ ref: "demo.echo", args: { value: "x" } });',
      stage: "prepare",
    },
    {
      name: "schema validation",
      provider: demoProvider(),
      code: 'return tools.call({ ref: "demo.echo", args: { value: 42 } });',
      stage: "validate",
      // TypeBox messages describe only schema expectations and never echo
      // argument values, so they are safe to surface.
      expectedError: "Call failed during validate: Invalid arguments for demo.echo: must be string",
    },
    {
      name: "provider invocation",
      provider: demoProvider({
        async invoke() {
          throw new Error("provider exploded");
        },
      }),
      code: 'return tools.call({ ref: "demo.echo", args: { value: "x" } });',
      stage: "invoke",
    },
  ])(
    "captures $name failures before legacy audits necessarily begin",
    async ({ provider, code, stage, expectedError }) => {
      const { service, context } = serviceFor(provider);
      const result = await execute(service, context, code);

      expect(result.success).toBe(false);
      expect(result.trace.outcome).toBe("failed");
      expect(result.trace.operations).toHaveLength(1);
      expect(result.trace.operations[0]).toMatchObject({
        sequence: 0,
        outcome: "failed",
        failureStage: stage,
        error: expectedError ?? `Call failed during ${stage}`,
        args: {},
      });
      expect(JSON.stringify(createRaftPersistedExecutionDetails(result).trace)).not.toContain(
        "exploded",
      );
    },
  );

  it("records approval denial at the approval stage", async () => {
    const provider = demoProvider({
      async list() {
        return [{ ...descriptor, risk: "execute" }];
      },
      async describe(name) {
        return name === "echo" ? { ...descriptor, risk: "execute" } : undefined;
      },
    });
    const { service, context } = serviceFor(provider);
    service.config.safety.approvals.execute = "deny";
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "demo.echo", args: { value: "x" } });',
    );

    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "approve",
      error: "Call failed during approve: demo.echo is denied by the Raft execute policy",
      args: {},
    });
    expect(result.audits).toEqual([]);
  });

  it("preserves approve-stage causes without interactive UI", async () => {
    const provider = demoProvider({
      async list() {
        return [{ ...descriptor, risk: "write" }];
      },
      async describe(name) {
        return name === "echo" ? { ...descriptor, risk: "write" } : undefined;
      },
    });
    const { service, context } = serviceFor(provider);
    service.config.safety.approvals.write = "ask";
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "demo.echo", args: { value: "x" } });',
    );

    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "approve",
      error:
        "Call failed during approve: demo.echo requires approval, but no interactive UI is available",
    });
  });

  it("keeps issue order when parallel calls complete out of order", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      `return Promise.all([
        tools.call({ ref: "demo.echo", args: { value: "first", delay: 80 } }),
        tools.call({ ref: "demo.echo", args: { value: "second", delay: 5 } }),
      ]);`,
    );

    expect(
      result.trace.operations.map((operation) => ({
        sequence: operation.sequence,
        ref: operation.ref,
        args: operation.args,
        result: operation.result,
      })),
    ).toEqual([
      { sequence: 0, ref: "demo.echo", args: {}, result: undefined },
      { sequence: 1, ref: "demo.echo", args: {}, result: undefined },
    ]);
  });

  it("seals unfinished calls as timed out and cancelled", async () => {
    const waitingProvider = demoProvider({
      async invoke() {
        return new Promise(() => undefined);
      },
    });

    const timed = serviceFor(waitingProvider);
    timed.service.config.execution.executor.timeoutMs = 50;
    const timedResult = await execute(
      timed.service,
      timed.context,
      'return tools.call({ ref: "demo.echo", args: { value: "slow" } });',
    );
    expect(timedResult.trace.outcome).toBe("timed_out");
    expect(timedResult.trace.operations[0]).toMatchObject({ outcome: "timed_out" });

    const cancelled = serviceFor(waitingProvider);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop requested")), 30);
    const cancelledResult = await execute(
      cancelled.service,
      cancelled.context,
      'return tools.call({ ref: "demo.echo", args: { value: "slow" } });',
      controller.signal,
    );
    expect(cancelledResult.trace.outcome).toBe("aborted");
    expect(cancelledResult.trace.operations[0]).toMatchObject({ outcome: "aborted" });
  });

  it("returns a failed zero-call trace for type-check failure without source text", async () => {
    const { service, context } = serviceFor();
    const result = await execute(service, context, "return rawCodeSecretIdentifier;");
    const details = createRaftPersistedExecutionDetails(result);

    expect(result.typeErrors?.length).toBeGreaterThan(0);
    expect(result.trace).toMatchObject({ outcome: "failed", operations: [], phases: [] });
    // Counts surface the failure class, but source-derived diagnostic text
    // must stay out of the durable trace.
    expect(result.trace.error).toMatch(/^Type checking failed \(\d+ errors?\)$/);
    expect(JSON.stringify(details)).not.toContain("rawCodeSecretIdentifier");
  });

  it("fails closed when a TypeBox validator throws", async () => {
    const provider = demoProvider({
      async describe(name) {
        return name === "echo"
          ? {
              ...descriptor,
              inputSchema: {
                type: "object",
                properties: { value: { type: "string", pattern: "[" } },
              },
            }
          : undefined;
      },
    });
    const { service, context } = serviceFor(provider);
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "demo.echo", args: { value: "validator-arg-secret" } });',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Schema validator failed");
    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "validate",
      error:
        "Call failed during validate: Invalid arguments for demo.echo: Schema validator failed",
      args: {},
    });
    expect(JSON.stringify(createRaftPersistedExecutionDetails(result))).not.toContain("secret");
  });

  it("preserves validate-stage schema details without echoing argument values", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "demo.echo", args: { delay: "arg-value-secret" } });',
    );

    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "validate",
    });
    const error = result.trace.operations[0]?.error ?? "";
    expect(error).toContain("Invalid arguments for demo.echo:");
    expect(error).not.toContain("arg-value-secret");
    expect(JSON.stringify(createRaftPersistedExecutionDetails(result))).not.toContain(
      "arg-value-secret",
    );
  });

  it("does not infer timeout or abort outcomes from error prose", async () => {
    expect(executionOutcomeFromError(new Error("ordinary timeout wording"))).toBe("failed");
    expect(executionOutcomeFromError(new Error("ordinary aborted wording"))).toBe("failed");
    const controller = new AbortController();
    controller.abort(new Error("unclassified reason"));
    expect(executionOutcomeFromError(new Error("ordinary failure"), controller.signal)).toBe(
      "aborted",
    );

    const { service, context } = serviceFor();
    for (const message of ["runtime timeout false positive", "runtime aborted false positive"]) {
      const result = await execute(
        service,
        context,
        `throw new Error(${JSON.stringify(message)});`,
      );
      expect(result.trace.outcome).toBe("failed");
      expect(result.trace.error).toBe("Execution failed");
      expect(JSON.stringify(createRaftPersistedExecutionDetails(result).trace)).not.toContain(
        message,
      );
    }
  });

  it("reconstructs current render audits from trace and preserves legacy audit rendering", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const operation = recorder.issueCall("pi.read", { path: "src/index.ts", offset: 4, limit: 8 });
    operation.succeed("omitted content");
    const trace = recorder.seal("succeeded", ["Inspect"]);

    expect(readRaftExecutionRenderDetails({ success: true, trace })).toMatchObject({
      phases: ["Inspect"],
      audits: [
        {
          ref: "pi.read",
          provider: "pi",
          tool: "read",
          success: true,
          args: { path: "src/index.ts", offset: 4, limit: 8 },
        },
      ],
    });
    const legacy = {
      success: true,
      phases: ["Legacy"],
      audits: [
        {
          ref: "pi.read",
          tool: "read",
          args: { path: "old.txt" },
          result: "old body",
          preview: { details: { truncation: { truncated: false } } },
          startedAt: 10,
          endedAt: 20,
        },
      ],
    };
    expect(readRaftExecutionRenderDetails(legacy)).toMatchObject(legacy);
  });

  it("retains bash commands in the trace while omitting arbitrary argument and result content", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const bash = recorder.issueCall("pi.bash", {
      command: "pnpm vitest run tests/audit-trace.test.ts",
      authorizationValue: "authorization-secret",
    });
    bash.succeed({ secretValue: "result-secret" });
    const write = recorder.issueCall("pi.write", {
      path: "/tmp/safe.txt",
      content: "write-content-secret",
    });
    write.succeed({ created: true, details: { secretValue: "write-result-secret" } });
    const external = recorder.issueCall("extensions.lookup", {
      query: "query-token-secret",
      url: "https://user:url-password@example.test/path?token=url-query-secret",
      arbitrary: { secretValue: "nested-secret" },
    });
    external.succeed({ authorizationValue: "external-result-secret" });
    const unsafePath = recorder.issueCall("pi.read", {
      path: "https://user:path-password@example.test/file?token=path-query-secret",
      offset: 2,
      limit: 4,
    });
    unsafePath.succeed("read-content-secret");
    recorder
      .issueCall("memory.recall", { query: "memory-query-secret" })
      .succeed({ text: "memory-result-secret" });
    recorder
      .issueCall("raft.approval.auto", {
        action: "pi.bash",
        risk: "execute",
        rawArguments: "classifier-argument-secret",
      })
      .succeed({
        action: "pi.bash",
        risk: "execute",
        decision: "escalate",
        model: "anthropic/classifier",
        reason: "classifier-reason-secret",
        error: "classifier-error-secret",
        at: 123,
      });

    const trace = recorder.seal("succeeded", []);
    const details = createRaftPersistedExecutionDetails({ success: true, trace });
    const serialized = JSON.stringify(details);

    expect(trace.operations.map((operation) => operation.args)).toEqual([
      { command: "pnpm vitest run tests/audit-trace.test.ts" },
      { path: "/tmp/safe.txt" },
      {},
      { limit: 4, offset: 2 },
      {},
      { action: "pi.bash", risk: "execute" },
    ]);
    expect(trace.operations.map((operation) => operation.result)).toEqual([
      undefined,
      { created: true },
      undefined,
      undefined,
      undefined,
      {
        action: "pi.bash",
        risk: "execute",
        decision: "escalate",
        model: "anthropic/classifier",
        at: 123,
      },
    ]);
    for (const secret of [
      "authorization-secret",
      "result-secret",
      "write-content-secret",
      "write-result-secret",
      "query-token-secret",
      "url-password",
      "url-query-secret",
      "nested-secret",
      "external-result-secret",
      "path-password",
      "path-query-secret",
      "read-content-secret",
      "classifier-argument-secret",
      "classifier-reason-secret",
      "classifier-error-secret",
      "memory-query-secret",
      "memory-result-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(details.audits).toEqual([]);
  });

  it("persists rich render audits verbatim alongside the projected trace", () => {
    const recorder = new RaftExecutionTraceRecorder();
    recorder
      .issueCall("pi.write", { path: "/tmp/safe.txt", content: "write-content-secret" })
      .succeed({ created: true, details: { secretValue: "write-result-secret" } });
    const trace = recorder.seal("succeeded", ["Ship"]);
    const audits = [
      {
        ref: "pi.write",
        tool: "write",
        provider: "pi",
        success: true,
        args: { path: "/tmp/safe.txt", content: "verbatim-argument" },
        result: {
          details: { codePreviewAfterWrite: { kind: "content", content: "verbatim-result" } },
        },
        preview: {
          details: { codePreviewBeforeWrite: { kind: "content", content: "verbatim-preview" } },
        },
        startedAt: 1,
        endedAt: 2,
        // In-memory image payloads and correlation ids never cross into the record.
        media: [{ type: "image", data: "image-bytes-not-persisted" }],
        mediaNote: "Read image file",
        nestedToolCallId: "nested-correlation-id",
      } as never,
    ];
    const details = createRaftPersistedExecutionDetails({
      success: true,
      trace,
      audits,
      phases: ["Ship"],
    });
    const serialized = JSON.stringify(details);

    expect(JSON.stringify(details.trace)).not.toContain("write-content-secret");
    for (const retained of ["verbatim-argument", "verbatim-result", "verbatim-preview"]) {
      expect(serialized).toContain(retained);
    }
    for (const volatile of [
      "image-bytes-not-persisted",
      "Read image file",
      "nested-correlation-id",
    ]) {
      expect(serialized).not.toContain(volatile);
    }

    const parsed = readRaftExecutionRenderDetails(JSON.parse(serialized));
    expect(parsed.phases).toEqual(["Ship"]);
    expect(parsed.audits).toHaveLength(1);
    expect(parsed.audits[0]).toMatchObject({
      ref: "pi.write",
      tool: "write",
      result: { details: { codePreviewAfterWrite: { content: "verbatim-result" } } },
    });
    expect(parsed.audits[0]).not.toHaveProperty("fromTrace");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      RAFT_EXECUTION_DETAILS_MAX_BYTES,
    );
    expect(trace.counts.droppedValues).toBeGreaterThan(0);
  });

  it("persists bounded mixed-output highlighting metadata", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const details = createRaftPersistedExecutionDetails({
      success: true,
      trace: recorder.seal("succeeded", []),
      outputFormat: "yaml",
      outputFormatStartLine: 3.9,
      outputFormatLines: 17.9,
    });

    expect(details.outputFormatStartLine).toBe(3);
    expect(details.outputFormatLines).toBe(17);
    expect(readRaftExecutionRenderDetails(details)).toMatchObject({
      outputFormatStartLine: 3,
      outputFormatLines: 17,
    });
  });

  it("retains a bounded underlying cause for classified invocation failures", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const invocation = recorder.issueCall("agents.run", { task: "exit 7" });
    invocation.fail(
      "invoke",
      new RaftTraceSafeError(`${"x".repeat(20_000)}\n\nInvocation failed with code 7`),
    );

    const operation = recorder.seal("failed", []).operations[0];
    expect(operation).toMatchObject({
      ref: "agents.run",
      outcome: "failed",
      failureStage: "invoke",
    });
    expect(operation?.error).toContain("Call failed during invoke: ");
    expect(operation?.error).toContain("Invocation failed with code 7");
    expect(Buffer.byteLength(operation?.error ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("bounds large call traces while preserving operation order", () => {
    const recorder = new RaftExecutionTraceRecorder();
    for (let index = 0; index < 500; index++) {
      recorder
        .issueCall("pi.bash", { command: `${index}:${"x".repeat(16_000)}` })
        .succeed(undefined);
    }

    const trace = recorder.seal("succeeded", []);
    expect(trace.operations).toHaveLength(500);
    expect(trace.operations.map((operation) => operation.sequence)).toEqual(
      Array.from({ length: 500 }, (_, index) => index),
    );
    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeLessThanOrEqual(
      RAFT_EXECUTION_TRACE_MAX_BYTES,
    );
    expect(trace.counts.droppedValues).toBeGreaterThan(0);
  });

  it("enforces the total UTF-8 envelope bound with explicit drops", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const phases = Array.from(
      { length: 512 },
      (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(1_100)}`,
    );
    const trace = recorder.seal("succeeded", phases);

    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeLessThanOrEqual(
      RAFT_EXECUTION_TRACE_MAX_BYTES,
    );
    const details = createRaftPersistedExecutionDetails({ success: true, trace });
    expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(
      RAFT_EXECUTION_DETAILS_MAX_BYTES,
    );
    expect(trace.counts.droppedValues + trace.counts.droppedOperations).toBeGreaterThan(0);
    expect(isRaftExecutionTraceV1(trace)).toBe(true);
  });

  it("is byte-stable when legacy random IDs and timings differ", async () => {
    const first = serviceFor();
    const second = serviceFor();
    const code = 'return tools.call({ ref: "demo.echo", args: { value: "stable" } });';
    const firstResult = await execute(first.service, first.context, code);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondResult = await execute(second.service, second.context, code);

    expect(firstResult.audits[0]?.nestedToolCallId).not.toBe(
      secondResult.audits[0]?.nestedToolCallId,
    );
    expect(firstResult.audits[0]?.startedAt).not.toBe(secondResult.audits[0]?.startedAt);
    expect(JSON.stringify(firstResult.trace)).toBe(JSON.stringify(secondResult.trace));
  });

  it("strictly ignores malformed and unknown trace versions", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const trace = recorder.seal("succeeded", []);

    expect(readRaftExecutionTraceV1(trace)).toBe(trace);
    expect(readRaftExecutionTraceV1({ ...trace, version: 2 })).toBeUndefined();
    expect(readRaftExecutionTraceV1({ ...trace, unexpected: true })).toBeUndefined();
    expect(readRaftExecutionTraceV1({ kind: "pi-raft.execution", version: 1 })).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(readRaftExecutionTraceV1(circular)).toBeUndefined();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile input");
        },
      },
    );
    expect(readRaftExecutionTraceV1(hostile)).toBeUndefined();
  });
});

describe("result truncation persistence", () => {
  it("stamps resultTruncated into trace operations and reconstructed audits", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const operation = recorder.issueCall("pi.bash", { cmd: "yes | head -c 200000" });
    operation.succeed({ ok: true, output: "tail slice" }, { resultTruncated: true });
    const trace = recorder.seal("succeeded", []);

    expect(trace.operations[0]?.resultTruncated).toBe(true);
    expect(
      readRaftExecutionRenderDetails({ success: true, trace }).audits[0]?.resultTruncated,
    ).toBe(true);
    expect(readRaftExecutionTraceV1(trace)?.operations[0]?.resultTruncated).toBe(true);
  });

  it("stamps resultTruncated on failed invocations carrying a truncated result", () => {
    const recorder = new RaftExecutionTraceRecorder();
    const operation = recorder.issueCall("pi.bash", { cmd: "big && false" });
    operation.fail(
      "invoke",
      new Error("exit 1"),
      "failed",
      { ok: false, output: "tail" },
      { resultTruncated: true },
    );
    const trace = recorder.seal("failed", []);

    expect(trace.operations[0]?.resultTruncated).toBe(true);
  });

  it("omits the flag for untruncated results", () => {
    const recorder = new RaftExecutionTraceRecorder();
    recorder.issueCall("pi.read", { path: "x" }).succeed("small body");
    const trace = recorder.seal("succeeded", []);

    expect(trace.operations[0]?.resultTruncated).toBeUndefined();
    expect(
      readRaftExecutionRenderDetails({ success: true, trace }).audits[0]?.resultTruncated,
    ).toBeUndefined();
  });
});
