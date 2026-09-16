import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunRequest, AgentRunResult } from "../src/agents/types.js";
import { ProcessTransport } from "../src/agents/transports/process-transport.js";
import { DEFAULT_RAFT_CONFIG, type RaftPythonRuntime } from "../src/config.js";
import type { RaftKernel } from "../src/runtime/kernel.js";
import { parseWorkerOptions } from "../src/worker/options.js";
import { createRunningRecord, writeCrashRunRecord } from "../src/worker/run-record.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
const temp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-agent-kernel-"));
  roots.push(root);
  return root;
};
const createManager = (
  options: ConstructorParameters<typeof AgentManager>[2] = {},
  config = DEFAULT_RAFT_CONFIG.agents,
) => {
  const manager = new AgentManager(process.cwd(), config, {
    runRoot: temp(),
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    ...options,
  });
  managers.push(manager);
  return manager;
};

beforeEach(() => {
  for (const key of [
    "PI_RAFT_DEPTH",
    "PI_RAFT_BUDGET",
    "PI_RAFT_BUDGET_FILE",
    "PI_RAFT_BUDGET_ID",
    "PI_RAFT_KERNEL",
    "PI_RAFT_PYTHON_RUNTIME",
  ]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const argv = (overrides: Record<string, string> = {}) => [
  "node",
  "worker.js",
  ...Object.entries({
    id: "kernel-probe",
    name: "probe",
    runner: "pi",
    "task-file": "task.txt",
    "status-file": "status.json",
    "lifecycle-file": "lifecycle.jsonl",
    "log-file": "events.jsonl",
    cwd: process.cwd(),
    "pi-binary": "pi",
    "claude-binary": "claude",
    "timeout-ms": "5000",
    depth: "1",
    extensions: "true",
    tools: "[]",
    "granted-risks": "[]",
    transport: "process",
    ...overrides,
  }).flatMap(([key, value]) => [`--${key}`, value]),
];

describe("agent kernel resolution", () => {
  it("defaults to TypeScript independently of ambient child environment", () => {
    vi.stubEnv("PI_RAFT_KERNEL", "python");
    vi.stubEnv("PI_RAFT_PYTHON_RUNTIME", "monty");
    const manager = createManager();
    expect(manager.resolveKernel({})).toBe("typescript");
    expect(manager.resolveKernel({ kernel: "inherit" })).toBe("typescript");
    expect(manager.resolvePythonRuntime()).toBe("monty");
  });

  it("inherits live caller configuration and permits an explicit language override", () => {
    let language: RaftKernel = "python";
    const manager = createManager({ kernel: () => language });
    expect(manager.resolveKernel({})).toBe("python");
    expect(manager.resolveKernel({ kernel: "inherit" })).toBe("python");
    expect(manager.resolveKernel({ kernel: "typescript" })).toBe("typescript");
    language = "typescript";
    expect(manager.resolveKernel({})).toBe("typescript");
    expect(manager.resolveKernel({ kernel: "python" })).toBe("python");
  });

  it.each(["ruby", "PYTHON", "", null, false, 4, {}, []])(
    "rejects invalid runtime request %j before launch",
    async (kernel) => {
      const preparePiModel = vi.fn(async () => {});
      const manager = createManager({ preparePiModel });
      await expect(manager.spawn({ task: "invalid", kernel } as AgentRunRequest)).rejects.toThrow(
        "Invalid Raft agent kernel",
      );
      expect(preparePiModel).not.toHaveBeenCalled();
      expect(manager.list()).toEqual([]);
    },
  );

  it.each([{ runner: "claude" as const }, { extensions: false }])(
    "does not assign a Raft kernel to incompatible runner %j",
    async (request) => {
      const manager = createManager({ kernel: () => "python" });
      expect(manager.resolveKernel(request)).toBeUndefined();
      expect(manager.resolveKernel({ ...request, kernel: "inherit" })).toBeUndefined();
      for (const kernel of ["typescript", "python"] as const) {
        await expect(manager.spawn({ task: "invalid", ...request, kernel })).rejects.toThrow(
          "Pi runner with Raft extensions",
        );
      }
    },
  );

  it("uses configured runner/extensions defaults and rejects broken callback values", () => {
    const manager = createManager({}, { ...DEFAULT_RAFT_CONFIG.agents, runner: "claude" });
    expect(manager.resolveKernel({})).toBeUndefined();
    expect(manager.resolveKernel({ runner: "pi", kernel: "python" })).toBe("python");
    const disabled = createManager({}, { ...DEFAULT_RAFT_CONFIG.agents, extensions: false });
    expect(disabled.resolveKernel({})).toBeUndefined();
    expect(() => disabled.resolveKernel({ kernel: "python" })).toThrow("Raft extensions");
    expect(disabled.resolveKernel({ extensions: true, kernel: "python" })).toBe("python");
    const broken = createManager({
      kernel: () => "auto" as RaftKernel,
      pythonRuntime: () => "auto" as RaftPythonRuntime,
    });
    expect(() => broken.resolveKernel({})).toThrow("Invalid inherited");
    expect(() => broken.resolvePythonRuntime()).toThrow("Invalid inherited");
  });

  it("freezes language and backend before async preparation and reports it through status", async () => {
    let language: RaftKernel = "python";
    let backend: RaftPythonRuntime = "monty";
    const launch = vi.spyOn(ProcessTransport.prototype, "launch");
    const manager = createManager({
      kernel: () => language,
      pythonRuntime: () => backend,
      preparePiModel: async () => {
        language = "typescript";
        backend = "cpython";
      },
    });
    const handle = await manager.spawn({ task: "freeze", transport: "process", kernel: "inherit" });
    expect(handle.kernel).toBe("python");
    const options = parseWorkerOptions([
      "node",
      "worker.js",
      ...launch.mock.calls[0]![0].workerArguments,
    ]);
    expect(options).toMatchObject({ kernel: "python", pythonRuntime: "monty" });
    const result = await manager.wait(handle.id);
    expect(result).toMatchObject({ status: "completed", kernel: "python" });
    expect(manager.status(handle.id).kernel).toBe("python");
  });

  it("recursive children inherit Python even when ordinary extensions default off", async () => {
    const manager = createManager(
      { kernel: () => "python" },
      { ...DEFAULT_RAFT_CONFIG.agents, extensions: false },
    );
    const result = await manager.run({ task: "recursive", recursive: true, transport: "process" });
    expect(result.kernel).toBe("python");
    await expect(
      manager.spawn({
        task: "contradictory",
        recursive: true,
        extensions: false,
        kernel: "python",
      }),
    ).rejects.toThrow("Recursive Raft requires extensions");
  });

  it.each(["typescript", "python"] as const)(
    "explicit %s loads Raft for the selected kernel",
    async (kernel) => {
      const launch = vi.spyOn(ProcessTransport.prototype, "launch");
      const manager = createManager();
      const result = await manager.run({ task: "language", transport: "process", kernel });
      expect(result.kernel).toBe(kernel);
      const options = parseWorkerOptions([
        "node",
        "worker.js",
        ...launch.mock.calls[0]![0].workerArguments,
      ]);
      expect(options.raftExtensionPath).toContain("index");
      expect(options.tools).toContain("raft_exec");
    },
  );
});

describe("worker kernel contract", () => {
  it("defaults old worker argv to TypeScript/Monty, not ambient selectors", () => {
    vi.stubEnv("PI_RAFT_KERNEL", "python");
    vi.stubEnv("PI_RAFT_PYTHON_RUNTIME", "monty");
    expect(parseWorkerOptions(argv())).toMatchObject({
      kernel: "typescript",
      pythonRuntime: "monty",
    });
    expect(parseWorkerOptions(argv({ "python-runtime": "cpython" })).pythonRuntime).toBe("cpython");
  });

  it.each(["inherit", "Python", "ruby", ""])(
    "rejects unresolved or invalid worker kernel %j",
    (kernel) => {
      expect(() => parseWorkerOptions(argv({ kernel }))).toThrow("Invalid worker kernel");
    },
  );

  it.each(["inherit", "CPython", "native", ""])("rejects invalid Python backend %j", (runtime) => {
    expect(() => parseWorkerOptions(argv({ "python-runtime": runtime }))).toThrow(
      "Invalid worker Python runtime",
    );
  });

  it.each([{ runner: "claude" }, { extensions: "false" }])(
    "rejects explicit worker kernel for %j",
    (request) => {
      expect(parseWorkerOptions(argv(request)).kernel).toBeUndefined();
      expect(() => parseWorkerOptions(argv({ ...request, kernel: "python" }))).toThrow(
        "Raft extensions",
      );
    },
  );

  it("persists the resolved language in running and crash status files", () => {
    const options = parseWorkerOptions(argv({ kernel: "python", "python-runtime": "monty" }));
    const record = createRunningRecord(options, "task", undefined, 123);
    expect(record.kernel).toBe("python");
    const file = path.join(temp(), "status.json");
    writeCrashRunRecord(file, record, new Error("probe"));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      kernel: "python",
      status: "failed",
    });
  });

  it.each([
    { kernel: "inherit" as const, recursive: true, alternateCwd: true },
    { kernel: "typescript" as const, alternateCwd: true },
    { kernel: "python" as const, session: true },
    { extensions: false, alternateCwd: true },
  ])(
    "runs the source worker with resolved child env and copied session paths: %j",
    async (request) => {
      const root = temp();
      const report = path.join(root, "env.json");
      const shim = path.join(root, "probe.mjs");
      fs.writeFileSync(
        shim,
        [
          "#!/usr/bin/env node",
          'import fs from "node:fs";',
          `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ kernel: process.env.PI_RAFT_KERNEL, pythonRuntime: process.env.PI_RAFT_PYTHON_RUNTIME, cwd: process.cwd(), argv: process.argv.slice(2) }));`,
          `await import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-pi-launch-probe.mjs")).href)});`,
        ].join("\n"),
        { mode: 0o755 },
      );
      vi.stubEnv("PI_RAFT_KERNEL", "typescript");
      vi.stubEnv("PI_RAFT_PYTHON_RUNTIME", "cpython");
      const manager = createManager({
        workerPath: path.resolve("src/worker.ts"),
        piBinary: shim,
        kernel: () => "python",
        pythonRuntime: () => "monty",
      });
      const sessionFile = path.join(root, "session.jsonl");
      const result: AgentRunResult = await manager.run({
        task: "probe",
        transport: "process",
        ...(request.kernel ? { kernel: request.kernel } : {}),
        ...(request.recursive ? { recursive: true } : {}),
        ...(request.extensions === false ? { extensions: false } : {}),
        ...(request.alternateCwd ? { cwd: root } : {}),
        ...(request.session ? { sessionFile } : {}),
      });
      expect(result.status, result.error).toBe("completed");
      const surface = JSON.parse(fs.readFileSync(report, "utf8"));
      const expectedKernel =
        request.extensions === false
          ? undefined
          : request.kernel === "typescript"
            ? "typescript"
            : "python";
      expect(surface.kernel).toBe(expectedKernel);
      expect(surface.pythonRuntime).toBe(expectedKernel ? "monty" : undefined);
      expect(result.kernel).toBe(expectedKernel);
      if (request.alternateCwd) expect(surface.cwd).toBe(fs.realpathSync(root));
      if (request.session) expect(surface.argv).toContain(sessionFile);
      expect(process.env.PI_RAFT_KERNEL).toBe("typescript");
      expect(process.env.PI_RAFT_PYTHON_RUNTIME).toBe("cpython");
    },
  );
});
