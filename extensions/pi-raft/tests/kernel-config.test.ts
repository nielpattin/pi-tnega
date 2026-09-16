import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RAFT_CONFIG,
  MAX_EXECUTOR_MEMORY_LIMIT_BYTES,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  loadRaftConfigForScope,
  maxExecutorMemoryLimitBytes,
  normalizeRaftConfig,
  saveRaftConfig,
} from "../src/config.js";
import type { RaftKernel } from "../src/runtime/kernel.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const configLocation = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "raft-kernel-config-"));
  directories.push(directory);
  return {
    cwd: path.join(directory, "project"),
    agentDir: path.join(directory, "agent"),
    projectTrusted: true,
  };
};

describe("executor kernel configuration", () => {
  it("defaults to TypeScript/QuickJS with an inert CPython binary setting", () => {
    const config = normalizeRaftConfig({});
    expect(config.execution.executor).toMatchObject({
      kernel: "typescript",
      runtime: "quickjs",
      cpython: { binary: "python3" },
    });
    expect(config.execution.executor).toEqual(DEFAULT_RAFT_CONFIG.execution.executor);
    expect(
      normalizeRaftConfig({ execution: { executor: { cpython: { binary: "/opt/bin/python3" } } } })
        .execution.executor.kernel,
    ).toBe("typescript");
  });

  it.each<RaftKernel>(["typescript", "python"])("accepts the canonical %s kernel", (kernel) => {
    const config = normalizeRaftConfig({ execution: { executor: { kernel } } });
    expect(config.execution.executor.kernel).toBe(kernel);
    expect(config.execution.executor.cpython).toEqual({ binary: "python3" });
    expect(config.execution.executor.cpython).not.toHaveProperty("enabled");
    expect(normalizeRaftConfig(config as unknown as Record<string, unknown>)).toEqual(config);
  });

  it.each([undefined, null, "", "javascript", "PYTHON", false, 1, {}, []])(
    "falls back to TypeScript for invalid kernel %j",
    (kernel) => {
      expect(
        normalizeRaftConfig({ execution: { executor: { kernel } } }).execution.executor.kernel,
      ).toBe("typescript");
    },
  );

  it("normalizes the binary as a trimmed nonempty executable string", () => {
    const config = normalizeRaftConfig({
      execution: {
        executor: { kernel: "python", cpython: { binary: "  /opt/Python 3/bin/python3  " } },
      },
    });
    expect(config.execution.executor.cpython.binary).toBe("/opt/Python 3/bin/python3");
  });

  it.each([undefined, null, "", "  ", 123, true, [], {}])(
    "defaults invalid CPython binary %j without disabling Python",
    (binary) => {
      const config = normalizeRaftConfig({
        execution: { executor: { kernel: "python", cpython: { binary } } },
      });
      expect(config.execution.executor.kernel).toBe("python");
      expect(config.execution.executor.cpython.binary).toBe("python3");
    },
  );

  it.each([null, "python3", [], true])("defaults malformed CPython section %j", (cpython) => {
    expect(
      normalizeRaftConfig({ execution: { executor: { kernel: "python", cpython } } }).execution
        .executor.cpython,
    ).toEqual({ binary: "python3" });
  });

  it("uses the native Python memory ceiling even with a dormant QuickJS setting", () => {
    const config = normalizeRaftConfig({
      execution: {
        executor: {
          kernel: "python",
          runtime: "quickjs",
          memoryLimitBytes: Number.MAX_SAFE_INTEGER,
        },
      },
    });
    expect(config.execution.executor.memoryLimitBytes).toBe(MAX_EXECUTOR_MEMORY_LIMIT_BYTES);
    expect(maxExecutorMemoryLimitBytes("quickjs", "python")).toBe(MAX_EXECUTOR_MEMORY_LIMIT_BYTES);
    expect(maxExecutorMemoryLimitBytes("quickjs")).toBe(
      Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES),
    );
    expect(
      normalizeRaftConfig({ execution: { executor: { kernel: "python", memoryLimitBytes: 1 } } })
        .execution.executor.memoryLimitBytes,
    ).toBe(8 * 1024 * 1024);
  });

  it("persists exclusive selection and merges binary overrides through generic config scopes", () => {
    const location = configLocation();
    saveRaftConfig(
      { ...location, scope: "global" },
      {
        execution: {
          executor: { kernel: "python", cpython: { binary: "python3.12" }, runtime: "bun-process" },
        },
      },
    );
    saveRaftConfig(
      { ...location, scope: "project" },
      { execution: { executor: { cpython: { binary: "/opt/bin/python3" } } } },
    );
    expect(loadRaftConfigForScope(location, "global").execution.executor).toMatchObject({
      kernel: "python",
      cpython: { binary: "python3.12" },
      runtime: "bun-process",
    });
    expect(loadRaftConfigForScope(location, "project").execution.executor).toMatchObject({
      kernel: "python",
      cpython: { binary: "/opt/bin/python3" },
      runtime: "bun-process",
    });

    saveRaftConfig(
      { ...location, scope: "project" },
      { execution: { executor: { kernel: "typescript" } } },
    );
    expect(loadRaftConfigForScope(location, "project").execution.executor).toMatchObject({
      kernel: "typescript",
      cpython: { binary: "/opt/bin/python3" },
      runtime: "bun-process",
    });
    expect(
      loadRaftConfigForScope({ ...location, projectTrusted: false }, "global").execution.executor
        .kernel,
    ).toBe("python");
    expect(() => loadRaftConfigForScope({ ...location, projectTrusted: false }, "project")).toThrow(
      "untrusted",
    );
  });
});
