import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CPYTHON_CHILD_SOURCE } from "../src/runtime/cpython-child-source.js";
import { CPythonRuntime } from "../src/runtime/cpython-runtime.js";
import type { RaftHostCall, RaftSandboxOptions } from "../src/runtime/kernel.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access) };
});

const python = childProcess.spawnSync("python3", [
  "-I",
  "-B",
  "-c",
  "import sys; print(sys.executable)",
]);
const hasPython = python.status === 0;
const binary = hasPython ? python.stdout.toString().trim() : "python3";
const options: RaftSandboxOptions = { timeoutMs: 5_000, memoryLimitBytes: 256 * 1024 * 1024 };
const roots: string[] = [];
const temp = (): string => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cpython-runtime-"));
  roots.push(cwd);
  return cwd;
};
const echo: RaftHostCall = async (ref, args) => ({ ref, args });
const run = (
  code: string,
  call: RaftHostCall = echo,
  overrides: Partial<RaftSandboxOptions> = {},
) => new CPythonRuntime(binary).execute(code, call, { ...options, ...overrides });

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsPromises.access).mockReset();
  vi.mocked(childProcess.spawn).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasPython)("CPythonRuntime", () => {
  it("preserves multiline literals and exact shared payload keys", async () => {
    const result = await run(
      'text = """first\n  second\nthird"""\nreturn [text, π.body, payloads["body"], π is payloads, payloads["not-an-id"]]',
      echo,
      { strings: { body: 'quoted "Unicode π"\nline', "not-an-id": "yes" } },
    );
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual([
      "first\n  second\nthird",
      'quoted "Unicode π"\nline',
      'quoted "Unicode π"\nline',
      true,
      "yes",
    ]);
  });

  it.each(["π.missing", 'payloads["missing"]'])(
    "preflights missing %s before host effects",
    async (accessor) => {
      const host = vi.fn(echo);
      const result = await run(
        `await tools.call(ref="demo.wait", args={})\nreturn ${accessor}`,
        host,
      );
      expect(result.error).toContain("Pre-execution check: missing payloads missing");
      expect(host).not.toHaveBeenCalled();
    },
  );

  it("does not preflight examples inside comments and strings", async () => {
    expect(await run("# π.missing\nreturn \"payloads['missing']\"")).toMatchObject({
      terminationReason: "completed",
      value: "payloads['missing']",
    });
  });

  it("routes discovery, generic, MCP and core positional/keyword calls", async () => {
    const result = await run(
      'return await asyncio.gather(tools.search("example"), tools.call(ref="demo.echo", args={"n": 1}), mcp.server.tool(n=2), pi.read("a", offset=2), pi.grep("needle", "src", 3), pi.read("a", {"limit": 4}))',
    );
    expect(result.value).toEqual([
      { ref: "raft.$search", args: { query: "example" } },
      { ref: "raft.$call", args: { ref: "demo.echo", args: { n: 1 } } },
      { ref: "mcp.server.tool", args: { n: 2 } },
      { ref: "pi.read", args: { path: "a", offset: 2 } },
      { ref: "pi.grep", args: { pattern: "needle", path: "src", limit: 3 } },
      { ref: "pi.read", args: { path: "a", limit: 4 } },
    ]);
  });

  it.each([
    'pi.edit("a", "old", "new")',
    'pi.edit(path="a", oldText="old", newText="new")',
    'pi.edit({"path": "a", "oldText": "old", "newText": "new"})',
  ])("canonicalizes edit shorthand: %s", async (call) => {
    expect((await run(`return await ${call}`)).value).toEqual({
      ref: "pi.edit",
      args: { path: "a", edits: [{ oldText: "old", newText: "new" }] },
    });
  });

  it("supports underscore-prefixed sanitized MCP names", async () => {
    expect((await run("return await mcp._123._tool()")).value).toEqual({
      ref: "mcp._123._tool",
      args: {},
    });
  });

  it.each([
    'return b"bytes"',
    'return float("nan")',
    "return 9007199254740992",
    'return {1: "integer key"}',
  ])("rejects lossy/non-JSON values: %s", async (code) => {
    expect((await run(code)).terminationReason).toBe("runtime_error");
  });

  it("reports guest syntax and traceback source lines", async () => {
    const syntax = await run("return (");
    expect(syntax.error).toContain("SyntaxError");
    const exception = await run('n = 1\nraise ValueError("source failure")');
    expect(exception.error).toContain('File "raft-exec.py", line 2');
    expect(exception.error).toContain("source failure");
  });

  it("serializes host bridge errors without crashing on Python 3.14", async () => {
    const result = await run(
      'return await tools.call(ref="demo.echo", args={"count": "bad"})',
      async () => {
        throw new Error("Invalid arguments for demo.echo: /count: expected number");
      },
    );
    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("Invalid arguments for demo.echo");
    expect(result.error).not.toContain("property 'exc_type'");
  });

  it("extends active deadlines at the host-call boundary", async () => {
    const result = await run(
      'return await tools.call(ref="slow.wait", args={})',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return "done";
      },
      { timeoutMs: 1000, minimumTimeoutMsForHostCall: () => 2000 },
    );
    expect(result).toMatchObject({ terminationReason: "completed", value: "done" });
  });

  it("kills synchronous infinite loops and preserves pre-timeout logs", async () => {
    // The wall deadline includes interpreter startup. Leave room for a cold
    // process on busy CI before checking log preservation during termination.
    const result = await run('print("started", flush=True)\nwhile True:\n    pass', echo, {
      timeoutMs: 1500,
    });
    expect(result.terminationReason).toBe("timed_out");
    expect(result.logs).toContain("started");
  });

  it("aborts outstanding host calls and rejects pre-aborted invocations without spawn", async () => {
    const controller = new AbortController();
    let hostSignal: AbortSignal | undefined;
    const result = await run(
      'return await tools.call(ref="demo.wait", args={})',
      async (_ref, _args, signal) => {
        hostSignal = signal;
        controller.abort();
        return new Promise(() => undefined);
      },
      { signal: controller.signal },
    );
    expect(result.terminationReason).toBe("aborted");
    expect(hostSignal?.aborted).toBe(true);
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    expect((await run("return 1", echo, { signal: controller.signal })).terminationReason).toBe(
      "aborted",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn after cancellation during interpreter resolution", async () => {
    const controller = new AbortController();
    const { access } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.access).mockImplementationOnce(async (file, mode) => {
      await access(file, mode);
      controller.abort();
    });
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    expect((await run("return 1", echo, { signal: controller.signal })).terminationReason).toBe(
      "aborted",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "kills same-group subprocesses when cancelled",
    async () => {
      const controller = new AbortController();
      let pid: number | undefined;
      try {
        const result = await run(
          'import subprocess, sys\nchild = subprocess.Popen([sys.executable, "-I", "-B", "-c", "import time; time.sleep(30)"])\nawait tools.call(ref="demo.pid", args={"pid": child.pid})',
          async (_ref, args) => {
            pid = Number((args as { args?: { pid?: number } }).args?.pid);
            controller.abort();
          },
          { signal: controller.signal },
        );
        expect(result.terminationReason).toBe("aborted");
        expect(Number.isSafeInteger(pid)).toBe(true);
        await expect
          .poll(
            () => {
              const status = childProcess.spawnSync("ps", ["-o", "stat=", "-p", String(pid)]);
              return status.stdout?.toString().trim() ?? "";
            },
            { timeout: 2000 },
          )
          .toMatch(/^(?:Z.*)?$/);
      } finally {
        if (pid && Number.isSafeInteger(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
      }
    },
  );

  it("settles issued background host calls before completing", async () => {
    let completed = false;
    const result = await run(
      'task = asyncio.create_task(tools.call(ref="demo.wait", args={}))\nawait asyncio.sleep(0.03)\nreturn 1',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        completed = true;
      },
    );
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toBe(1);
    expect(completed).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not write late host replies after a terminal guest frame",
    async () => {
      const writes: string[] = [];
      const channel = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          const message = JSON.parse(chunk.toString());
          writes.push(message.type);
          if (message.type === "response") {
            callback(new Error("EPIPE: guest already exited"));
            return;
          }
          callback();
          queueMicrotask(() =>
            channel.push(
              [
                JSON.stringify({ type: "call", id: 1, ref: "demo.get", args: {} }),
                JSON.stringify({
                  type: "result",
                  result: { terminationReason: "completed", value: 1 },
                }),
                "",
              ].join("\n"),
            ),
          );
        },
      });
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdio: [null, null, null, channel],
        kill: vi.fn(),
      });
      vi.mocked(childProcess.spawn).mockReturnValue(
        child as unknown as ReturnType<typeof childProcess.spawn>,
      );
      let completed = false;
      const result = await run("return 1", async () => {
        await new Promise((resolve) => setImmediate(resolve));
        completed = true;
        return "late result";
      });
      expect(result).toMatchObject({ terminationReason: "completed", value: 1 });
      expect(completed).toBe(true);
      expect(writes).toEqual(["execute"]);
    },
  );

  it("bounds non-cooperative host calls after guest failure", async () => {
    const started = Date.now();
    const result = await run(
      'await asyncio.gather(tools.call(ref="demo.wait", args={}), tools.call(ref="demo.fail", args={}))',
      async (_ref, args) => {
        const requested = (args as { ref?: string }).ref;
        if (requested === "demo.wait") return new Promise(() => undefined);
        throw new Error("sibling failed");
      },
    );
    expect(result.error).toContain("sibling failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects malformed/oversized IPC before calling the host", async () => {
    const host = vi.fn(echo);
    if (process.platform !== "win32") {
      // Windows carries IPC over loopback TCP, so there is no writable fd 3.
      const malformed = await run(
        "import os\nos.write(3, bytes([123, 10]))\nawait asyncio.sleep(1)",
        host,
      );
      expect(malformed.error).toContain("Invalid CPython IPC");
    }
    const oversized = await run('return "x" * (17 * 1024 * 1024)', host);
    expect(oversized.error).toContain("16 MiB");
    expect(host).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "resolves relative PATH entries against invocation cwd",
    async () => {
      const cwd = temp();
      fs.mkdirSync(path.join(cwd, "bin"));
      fs.symlinkSync(binary, path.join(cwd, "bin", "python-fixture"));
      vi.stubEnv("PATH", "bin");
      try {
        const result = await new CPythonRuntime("python-fixture").execute(
          "import os\nreturn os.getcwd()",
          echo,
          { ...options, cwd },
        );
        expect(result.terminationReason, result.error).toBe("completed");
        expect(result.value).toBe(fs.realpathSync(cwd));
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("reports missing configured interpreters without any fallback", async () => {
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    const result = await new CPythonRuntime(path.join(temp(), "missing-python")).execute(
      "return 1",
      echo,
      options,
    );
    expect(result.error).toContain("executor.cpython.binary");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["sys.version_info = (3, 9, 0)", 'sys.implementation.name = "pypy"'])(
    "rejects unsupported interpreter identity before imports/RPC: %s",
    (override) => {
      const result = childProcess.spawnSync(binary, [
        "-I",
        "-B",
        "-c",
        `import sys\n${override}\nexec(${JSON.stringify(CPYTHON_CHILD_SOURCE)})`,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toContain("CPython 3.10 or newer");
    },
  );
});
