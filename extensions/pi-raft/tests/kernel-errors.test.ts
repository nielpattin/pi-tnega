import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { CPythonRuntime } from "../src/runtime/cpython-runtime.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";
import { pythonErrorRecoveryHint } from "../src/runtime/python-error-guidance.js";
import type { RaftHostCall, RaftSandboxOptions } from "../src/runtime/kernel.js";

const require = createRequire(import.meta.url);
let montyAvailable = true;
try {
  const nativeRequire = createRequire(require.resolve("@pydantic/monty/node"));
  const triple =
    process.platform === "darwin"
      ? `darwin-${process.arch}`
      : process.platform === "linux"
        ? `linux-${process.arch}-gnu`
        : "win32-x64-msvc";
  nativeRequire.resolve(
    `@pydantic/monty-${triple}/${process.platform === "win32" ? "monty.exe" : "monty"}`,
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  montyAvailable = false;
}
const python = spawnSync("python3", [
  "-I",
  "-B",
  "-c",
  "import sys; assert sys.implementation.name == 'cpython' and sys.version_info >= (3, 10); print(sys.executable)",
]);
if (python.error && (python.error as NodeJS.ErrnoException).code !== "ENOENT") throw python.error;
if (!python.error && python.status !== 0)
  throw new Error(`CPython probe failed: ${python.stderr.toString()}`);
const cpythonAvailable = !python.error;
const options: RaftSandboxOptions = { timeoutMs: 5000, memoryLimitBytes: 256 * 1024 * 1024 };
const echo: RaftHostCall = async () => ({ output: "ok" });

for (const backend of ["monty", "cpython"] as const) {
  const available = backend === "monty" ? montyAvailable : cpythonAvailable;
  if (!available) console.warn(`Skipping ${backend} diagnostics: backend dependency absent`);
  const run = (code: string, host: RaftHostCall = echo, extra: Partial<RaftSandboxOptions> = {}) =>
    (backend === "monty"
      ? new MontyRuntime()
      : new CPythonRuntime(python.stdout.toString().trim())
    ).execute(code, host, { ...options, ...extra });
  describe.skipIf(!available)(`${backend} real kernel diagnostics`, () => {
    it("preserves nested user frames and source, without bootstrap noise", async () => {
      const result = await run('def fail():\n    raise ValueError("user failure")\nfail()');
      expect(result.terminationReason).toBe("runtime_error");
      expect(result.error).toContain('File "raft-exec.py", line 2, in fail');
      expect(result.error).toContain('File "raft-exec.py", line 3, in <raft_exec>');
      expect(result.error).toContain('raise ValueError("user failure")');
      expect(result.error).not.toMatch(/<string>|<python-input|__raft_program|in _main|in _call/);
    });
    it("reports SyntaxError against the exact unwrapped line", async () => {
      const result = await run("value = 1\nreturn (");
      expect(result.error).toContain("SyntaxError");
      expect(result.error).toContain('File "raft-exec.py", line 2');
      expect(result.error).not.toMatch(/<string>|<python-input|in _main/);
      expect(pythonErrorRecoveryHint("value = 1\nreturn (", result.error!, backend)).toContain(
        "Python syntax",
      );
    });
    it.each(["π.missing", 'payloads["missing"]'])(
      "rejects missing %s before host effects",
      async (accessor) => {
        const host = vi.fn(echo);
        const code = `await tools.call(ref="demo.wait", args={})\nreturn ${accessor}`;
        const result = await run(code, host);
        expect(result.error).toContain("Pre-execution check: missing payloads missing");
        expect(host).not.toHaveBeenCalled();
        expect(pythonErrorRecoveryHint(code, result.error!, backend)).toContain(
          "raft_exec.payloads",
        );
      },
    );
    it("retains host schema ref/property and gives Python repair advice", async () => {
      const code = 'return await tools.call(ref="demo.echo", args={"count": "bad"})';
      const result = await run(code, async () => {
        throw new Error("Invalid arguments for demo.echo: /count: expected number");
      });
      expect(result.error).toContain("Invalid arguments for demo.echo: /count: expected number");
      expect(result.error).not.toMatch(/<string>|_HostError|in _call|in __call__/);
      expect(pythonErrorRecoveryHint(code, result.error!, backend)).toContain("Python dictionary");
    });
    it("bounds large exception output while preserving its type", async () => {
      const result = await run('raise ValueError("x" * 30000)');
      expect(result.error!.length).toBeLessThanOrEqual(16000);
      expect(result.error).toContain("ValueError");
    });
    if (backend === "monty")
      it("explains unsupported imports without enabling native execution", async () => {
        const code = "import socket\nreturn socket.socket()";
        const result = await run(code);
        expect(result.terminationReason).toBe("runtime_error");
        expect(pythonErrorRecoveryHint(code, result.error!, backend)).toContain(
          "explicit trusted CPython",
        );
      });
    if (backend === "cpython") {
      it("preserves exception causes and implicit context", async () => {
        for (const suffix of [" from cause", ""]) {
          const result = await run(
            'try:\n    raise ValueError("first cause")\nexcept ValueError as cause:\n    raise RuntimeError("second failure")' +
              suffix,
          );
          expect(result.error).toContain("ValueError: first cause");
          expect(result.error).toContain("RuntimeError: second failure");
          expect(result.error).toContain(suffix ? "direct cause" : "During handling");
          expect(result.error).not.toContain("<string>");
        }
      });
      it("preserves real dynamically compiled user frames", async () => {
        const result = await run('exec("raise ValueError(123)")');
        expect(result.error).toContain('File "<string>", line 1, in <module>');
        expect(result.error).toContain('File "raft-exec.py", line 1');
        expect(result.error).not.toContain("in _main");
      });
    }
  });
}

describe("pure Python recovery hints", () => {
  it.each([
    ["const x = 1", "SyntaxError: invalid syntax", "monty", "Python assignments"],
    ["", "Monty optional native package is unavailable or incompatible", "monty", "trust approval"],
    ["", "Set executor.cpython.binary", "cpython", "CPython 3.10+"],
    ["", "AttributeError: unknown attribute _tool", "monty", "tools.call"],
    ["", "NameError: name 'true' is not defined", "cpython", "True/False/None"],
    [
      "",
      "AttributeError: 'RaftPayloads' object has no attribute 'missing'",
      "monty",
      "runtime lookups may follow earlier effects",
    ],
  ] as const)("classifies %s / %s", (code, error, backend, expected) => {
    const hint = pythonErrorRecoveryHint(code, error, backend);
    expect(hint).toContain(expected);
    expect(hint!.length).toBeLessThanOrEqual(900);
  });
  it.each([
    "ValueError: user failure",
    "Execution cancelled",
    "TimeoutError: time limit exceeded",
    "Approval denied",
    "MemoryError: allocation failed",
  ])("does not invent syntax repairs for %s", (error) => {
    expect(pythonErrorRecoveryHint("const bad = 1", error, "monty")).toBeUndefined();
  });
  it("handles oversized errors without echoing them or changing inputs", () => {
    const error = "x".repeat(100000) + "\nAttributeError: 'dict' object has no attribute 'output'";
    expect(pythonErrorRecoveryHint("return result.output", error, "cpython")).toContain(
      'result["output"]',
    );
    expect(error.length).toBeGreaterThan(100000);
  });
});
