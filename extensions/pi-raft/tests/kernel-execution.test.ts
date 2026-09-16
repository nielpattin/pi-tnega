import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { availablePythonBackends, pythonBackends } from "./fixtures/python-backends.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";
import { normalizeRaftConfig, type RaftPythonRuntime } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { RaftExecutionService } from "../src/execution-service.js";
import type { RaftActionDescriptor } from "../src/protocol.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const registries: ActionRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const root of roots.splice(0)) rmTempSync(root);
});

const fixture = (pythonRuntime: RaftPythonRuntime) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "raft-python-service-"));
  roots.push(cwd);
  const registry = new ActionRegistry();
  registries.push(registry);
  const config = normalizeRaftConfig({
    execution: {
      executor: {
        kernel: "python",
        ...(pythonRuntime === "cpython"
          ? { pythonRuntime }
          : { cpython: { binary: "/nonexistent/python3" } }),
        memoryLimitBytes: 256 * 1024 * 1024,
      },
    },
  });
  const service = new RaftExecutionService(registry, config);
  let sequence = 0;
  const run = (code: string, strings?: Record<string, string>) =>
    service.execute({
      code,
      ...(strings ? { strings } : {}),
      signal: undefined,
      parentToolCallId: `python-${++sequence}`,
      context: {
        cwd,
        hasUI: false,
        sessionManager: {
          getSessionId: () => "python-kernel-test",
          getSessionFile: () => undefined,
        },
      } as unknown as ExtensionContext,
      onPartial() {},
    });
  return { cwd, registry, config, service, run };
};

const registerProviderAction = (
  registry: ActionRegistry,
  providerName: string,
  actionName: string,
  risk: "read" | "execute" | "agent" = "read",
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) => {
  const descriptor: RaftActionDescriptor = {
    name: actionName,
    description: "Fixture action",
    risk,
    inputSchema: {
      type: "object",
      properties:
        providerName === "mcp" && actionName === "demo.run"
          ? { command: { type: "string" }, settle: { type: "boolean" } }
          : { value: { type: "string" } },
      required:
        providerName === "mcp" && actionName === "demo.echo"
          ? ["value"]
          : actionName === "demo.run"
            ? ["command"]
            : [],
      additionalProperties: false,
    },
    ...(providerName === "mcp" ? { namespace: actionName.split(".")[0] } : {}),
  };
  registry.register({
    name: providerName,
    description: "Fixture provider",
    async list() {
      return [descriptor];
    },
    async describe(name) {
      return name === actionName ? descriptor : undefined;
    },
    invoke,
  });
  return invoke;
};

const registerEcho = (
  registry: ActionRegistry,
  name = "demo",
  action = "echo",
  risk: "read" | "agent" = "read",
) => {
  const invoke = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    value: args.value,
  }));
  registerProviderAction(registry, "mcp", `${name}.${action}`, risk, invoke);
  return invoke;
};

const registerCommand = (registry: ActionRegistry, cwd: string) =>
  registerProviderAction(registry, "mcp", "demo.run", "execute", async (_name, args) => {
    try {
      const result = (await execFileAsync("sh", ["-c", String(args.command)], {
        cwd,
        encoding: "utf8",
      })) as { stdout: string; stderr: string };
      return { ok: true, output: result.stdout, details: null };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const exitCode = typeof failure.code === "number" ? failure.code : 1;
      if (args.settle === true) {
        return {
          ok: false,
          output: failure.stdout ?? failure.stderr ?? "",
          details: null,
          exitCode,
          error: failure.message,
        };
      }
      throw error;
    }
  });

describe.each(pythonBackends)("%s Python kernel host integration", (pythonRuntime) => {
  const runTest = it.skipIf(!availablePythonBackends[pythonRuntime]);

  it.skipIf(!availablePythonBackends[pythonRuntime] || pythonRuntime !== "cpython")(
    "runs CPython stdlib and payloads without consuming TypeScript declarations",
    async () => {
      const { registry, run } = fixture(pythonRuntime);
      const declarations = vi.spyOn(registry, "guestTypeSources");
      const result = await run(
        'import json\nreturn {"sum": sum(json.loads(π.numbers)), "same": payloads["numbers"] == π.numbers}',
        { numbers: "[1,2,3]" },
      );
      expect(result).toMatchObject({ success: true, value: { sum: 6, same: true }, audits: [] });
      expect(declarations).not.toHaveBeenCalled();
    },
  );

  runTest("uses the configured Python backend with native payload dictionaries", async () => {
    const { registry, config, run } = fixture(pythonRuntime);
    const declarations = vi.spyOn(registry, "guestTypeSources");
    expect(config.execution.executor.pythonRuntime).toBe(pythonRuntime);
    const result = await run(
      'return {"sum": sum([1, 2, 3]), "same": payloads["numbers"] == π.numbers}',
      { numbers: "[1,2,3]" },
    );
    expect(result).toMatchObject({ success: true, value: { sum: 6, same: true }, audits: [] });
    expect(declarations).not.toHaveBeenCalled();
  });

  runTest(
    "supports discovery and parallel MCP calls while retaining schema validation",
    async () => {
      const { registry, run } = fixture(pythonRuntime);
      const invoke = registerEcho(registry);
      const success = await run(
        'import asyncio\ndescriptor = await tools.describe(ref="mcp.demo.echo")\nvalues = await asyncio.gather(tools.call(ref="mcp.demo.echo", args={"value":"a"}), tools.call(ref="mcp.demo.echo", args={"value":"b"}))\nreturn {"ref": descriptor["ref"], "values": values}',
      );
      expect(success.success, success.error).toBe(true);
      expect(success.value).toEqual({
        ref: "mcp.demo.echo",
        values: [{ value: "a" }, { value: "b" }],
      });
      const failed = await run('return await tools.call(ref="mcp.demo.echo", args={"value": 123})');
      expect(failed.success).toBe(false);
      expect(failed.error).toContain("Invalid arguments");
      expect(failed.trace.operations[0]).toMatchObject({
        ref: "mcp.demo.echo",
        failureStage: "validate",
      });
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );

  runTest("enforces MCP approvals at the host boundary", async () => {
    const { registry, config, run } = fixture(pythonRuntime);
    const invoke = registerEcho(registry);
    config.safety.approvals.read = "deny";
    const blocked = await run(
      'return await tools.call(ref="mcp.demo.echo", args={"value":"blocked"})',
    );
    expect(blocked.success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(blocked.trace.operations[0]).toMatchObject({
      ref: "mcp.demo.echo",
      failureStage: "approve",
    });
    config.safety.approvals.read = "allow";
    const direct = await run('return await mcp.demo.echo(value="allowed")');
    expect(direct).toMatchObject({ success: true, value: { value: "allowed" } });
  });

  runTest("preserves native command results and settle exit contracts through MCP", async () => {
    const { registry, cwd, run } = fixture(pythonRuntime);
    registerCommand(registry, cwd);
    const result = await run(
      'ok = await mcp.demo.run(command="printf bridge")\nfailed = await mcp.demo.run(command="printf failed; exit 3", settle=True)\nreturn {"output": ok["output"], "failed": failed["ok"], "exitCode": failed["exitCode"]}',
    );
    expect(result.success, result.error).toBe(true);
    expect(result.value).toEqual({ output: "bridge", failed: false, exitCode: 3 });
  });

  runTest(
    "enforces agent call budgets and refreshes kernels after configuration changes",
    async () => {
      const { registry, config, run } = fixture(pythonRuntime);
      const invoke = registerProviderAction(
        registry,
        "agents",
        "run",
        "agent",
        vi.fn(async (_name, args) => ({ value: args.value })),
      );
      config.agents.maxPerExecution = 1;
      const result = await run(
        'await agents.run(value="first")\nreturn await agents.run(value="second")',
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("agent budget exhausted");
      expect(invoke).toHaveBeenCalledOnce();
      config.execution.executor.kernel = "typescript";
      expect(await run("const n: number = 7; return n;")).toMatchObject({
        success: true,
        value: 7,
      });
      config.execution.executor.kernel = "python";
      expect(await run("return [n * n for n in range(3)]")).toMatchObject({
        success: true,
        value: [0, 1, 4],
      });
      expect((await run("const n = 7; return n;")).success).toBe(false);
    },
  );
});
