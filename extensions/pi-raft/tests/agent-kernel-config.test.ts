import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRaftConfig,
  loadRaftConfigForScope,
  normalizeRaftConfig,
  saveRaftConfig,
} from "../src/config.js";

const roots: string[] = [];
const location = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-agent-kernel-config-"));
  roots.push(root);
  return {
    cwd: path.join(root, "project"),
    agentDir: path.join(root, "agent"),
    projectTrusted: true,
  };
};
beforeEach(() => {
  vi.stubEnv("PI_RAFT_KERNEL", undefined);
  vi.stubEnv("PI_RAFT_PYTHON_RUNTIME", undefined);
  vi.stubEnv("PI_RAFT_COMPACTION_ENGINE", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("inherited agent kernel config", () => {
  it.each(["typescript", "python"] as const)(
    "applies inherited %s after disk merge without overwriting saved scopes",
    (kernel) => {
      const options = location();
      const diskKernel = kernel === "python" ? "typescript" : "python";
      saveRaftConfig(
        { ...options, scope: "global" },
        {
          execution: {
            executor: {
              kernel: diskKernel,
              pythonRuntime: "cpython",
              cpython: { binary: "python3.12" },
            },
          },
        },
      );
      saveRaftConfig(
        { ...options, scope: "project" },
        {
          execution: {
            executor: {
              kernel: diskKernel,
              pythonRuntime: "cpython",
              cpython: { binary: "/opt/python3" },
            },
          },
        },
      );
      vi.stubEnv("PI_RAFT_KERNEL", kernel);
      vi.stubEnv("PI_RAFT_PYTHON_RUNTIME", "monty");
      expect(loadRaftConfig(options).execution.executor).toMatchObject({
        kernel,
        pythonRuntime: "monty",
        cpython: { binary: "/opt/python3" },
      });
      for (const scope of ["global", "project"] as const) {
        expect(loadRaftConfigForScope(options, scope).execution.executor).toMatchObject({
          kernel: diskKernel,
          pythonRuntime: "cpython",
        });
      }
      const alternate = {
        ...options,
        cwd: path.join(options.cwd, "alternate"),
        projectTrusted: false,
      };
      expect(loadRaftConfig(alternate).execution.executor).toMatchObject({
        kernel,
        pythonRuntime: "monty",
        cpython: { binary: "python3.12" },
      });
    },
  );

  it("uses disk defaults when no inherited selector is present", () => {
    const options = location();
    saveRaftConfig(
      { ...options, scope: "global" },
      { execution: { executor: { kernel: "python", pythonRuntime: "monty" } } },
    );
    expect(loadRaftConfig(options).execution.executor).toMatchObject({
      kernel: "python",
      pythonRuntime: "monty",
    });
    vi.stubEnv("PI_RAFT_KERNEL", "typescript");
    vi.stubEnv("PI_RAFT_PYTHON_RUNTIME", "cpython");
    expect(loadRaftConfig(options).execution.executor).toMatchObject({
      kernel: "typescript",
      pythonRuntime: "cpython",
    });
  });

  it.each(["inherit", "", "Python", "javascript", "python3", " python", "python; echo unsafe"])(
    "fails closed on invalid inherited language %j",
    (kernel) => {
      const options = location();
      vi.stubEnv("PI_RAFT_KERNEL", kernel);
      expect(() => loadRaftConfig(options)).toThrow("Invalid PI_RAFT_KERNEL");
      expect(loadRaftConfigForScope(options, "global").execution.executor.kernel).toBe(
        "typescript",
      );
    },
  );

  it.each(["inherit", "", "CPython", "native", " monty"])(
    "fails closed on invalid inherited backend %j",
    (runtime) => {
      const options = location();
      vi.stubEnv("PI_RAFT_PYTHON_RUNTIME", runtime);
      expect(() => loadRaftConfig(options)).toThrow("Invalid PI_RAFT_PYTHON_RUNTIME");
      expect(loadRaftConfigForScope(options, "global").execution.executor.pythonRuntime).toBe(
        "monty",
      );
    },
  );

  it.each([undefined, null, "", "native", "MONTY", false, 1, {}, []])(
    "defaults malformed disk Python backend %j to Monty",
    (pythonRuntime) => {
      expect(
        normalizeRaftConfig({ execution: { executor: { pythonRuntime } } }).execution.executor
          .pythonRuntime,
      ).toBe("monty");
    },
  );

  it.each(["cpython", "monty"] as const)(
    "round-trips configured %s without selecting a different language",
    (pythonRuntime) => {
      expect(
        normalizeRaftConfig({ execution: { executor: { pythonRuntime } } }).execution.executor,
      ).toMatchObject({ kernel: "typescript", pythonRuntime });
      const options = location();
      saveRaftConfig(options, { execution: { executor: { kernel: "python", pythonRuntime } } });
      expect(loadRaftConfig(options).execution.executor).toMatchObject({
        kernel: "python",
        pythonRuntime,
      });
    },
  );
});
