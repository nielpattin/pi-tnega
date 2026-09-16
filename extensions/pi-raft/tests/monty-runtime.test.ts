import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EXECUTOR_TIMEOUT_MS } from "../src/config.js";
import type { RaftHostCall, RaftSandboxOptions } from "../src/runtime/kernel.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";

const require = createRequire(import.meta.url);
let missing: string | undefined;
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
  missing = `optional @pydantic/monty native dependency missing: ${(error as Error).message}`;
}
if (missing) console.warn("Skipping native Monty tests: " + missing);
const options: RaftSandboxOptions = { timeoutMs: 5000, memoryLimitBytes: 64 * 1024 * 1024 };
const echo: RaftHostCall = async (ref, args) => ({ ref, args });
const run = (code: string, host: RaftHostCall = echo, extra: Partial<RaftSandboxOptions> = {}) =>
  new MontyRuntime().execute(code, host, { ...options, ...extra });
afterEach(() => vi.restoreAllMocks());

describe.skipIf(Boolean(missing))(
  `MontyRuntime native 0.0.23${missing ? " (" + missing + ")" : ""}`,
  () => {
    it("preserves multiline, raw, escaped and formatted literals without rewriting payload attributes", async () => {
      const code =
        'text = """first\n  second\nthird"""\nraw = r"""a\\b\nπ.missing\nend"""\ncontinued = "one\\\ntwo"\nreturn [text, raw, continued, f"payload={π.body}", π.body, payloads["body"], payloads["not-an-id"]]';
      const result = await run(code, echo, {
        strings: { body: 'quoted "Unicode π"\nline', "not-an-id": "yes" },
      });
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toEqual([
        "first\n  second\nthird",
        "a\\b\nπ.missing\nend",
        "onetwo",
        'payload=quoted "Unicode π"\nline',
        'quoted "Unicode π"\nline',
        'quoted "Unicode π"\nline',
        "yes",
      ]);
    });

    it.each(["π.missing", 'payloads["missing"]'])(
      "preflights missing %s before host effects",
      async (accessor) => {
        const host = vi.fn(echo);
        const result = await run(
          `await tools.call(ref="demo.get", args={})\nreturn ${accessor}`,
          host,
        );
        expect(result.error).toContain("Pre-execution check: missing payloads missing");
        expect(host).not.toHaveBeenCalled();
      },
    );

    it("ignores payload examples in strings/comments and reports dynamic missing keys", async () => {
      expect(await run("# π.missing\nreturn \"payloads['missing']\"")).toMatchObject({
        terminationReason: "completed",
        value: "payloads['missing']",
      });
      expect(await run('key = "missing"\nreturn payloads[key]')).toMatchObject({
        terminationReason: "runtime_error",
        error: expect.stringContaining("KeyError"),
      });
      expect(await run('return f"{π.missing}"')).toMatchObject({
        terminationReason: "runtime_error",
        error: expect.stringContaining("missing"),
      });
    });

    it("routes underscore-prefixed MCP names through generic calls (native class attributes exclude them)", async () => {
      const host = vi.fn(echo);
      expect(await run("return await mcp._123._tool()", host)).toMatchObject({
        terminationReason: "runtime_error",
        error: expect.stringContaining("AttributeError"),
      });
      expect(host).not.toHaveBeenCalled();
      expect(
        await run('return await tools.call(ref="mcp._123._tool", args={"n": 2})'),
      ).toMatchObject({
        terminationReason: "completed",
        value: { ref: "raft.$call", args: { ref: "mcp._123._tool", args: { n: 2 } } },
      });
    });

    it("runs actual host calls concurrently via asyncio.gather", async () => {
      const calls: string[] = [];
      let release!: () => void;
      const both = new Promise<void>((resolve) => {
        release = resolve;
      });
      const result = await run(
        'return await asyncio.gather(pi.read("a"), pi.read("b"))',
        async (_ref, args) => {
          calls.push(String(args.path));
          if (calls.length === 2) release();
          await both;
          return args.path;
        },
      );
      expect(result).toMatchObject({ terminationReason: "completed", value: ["a", "b"] });
    });

    it.each([
      'pi.edit("a", "old", "new")',
      'pi.edit(path="a", oldText="old", newText="new")',
      'pi.edit({"path": "a", "oldText": "old", "newText": "new"})',
    ])("normalizes edit shorthand: %s", async (call) => {
      expect(await run("return await " + call)).toMatchObject({
        value: { ref: "pi.edit", args: { path: "a", edits: [{ oldText: "old", newText: "new" }] } },
      });
    });

    it.each([
      'pi.read({"path": "a"}, path="b")',
      "agents()",
      "tools.constructor()",
      "tools.__proto__()",
      'mcp.server.__getattribute__("x")',
    ])("rejects malformed or forbidden calls before host dispatch: %s", async (call) => {
      const host = vi.fn(echo);
      expect((await run("return await " + call, host)).terminationReason).toBe("runtime_error");
      expect(host).not.toHaveBeenCalled();
    });

    it.each([
      'return b"bytes"',
      'return float("nan")',
      'return float("inf")',
      "return 9007199254740992",
      'return {1: "key"}',
      "return {1, 2}",
      "value = []\nvalue.append(value)\nreturn value",
      "return schema",
    ])("rejects non-JSON guest values: %s", async (code) => {
      expect((await run(code)).terminationReason).toBe("runtime_error");
    });

    it("rejects non-JSON host returns without leaking capabilities", async () => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      for (const value of [
        1n,
        Infinity,
        Buffer.from("data"),
        new Set([1]),
        cycle,
        { fn: () => 1 },
        { nested: undefined },
      ]) {
        expect(
          (await run('return await tools.call(ref="demo", args={})', async () => value))
            .terminationReason,
        ).toBe("runtime_error");
      }
    });

    it("reports syntax and nested traceback lines against the unwrapped user source", async () => {
      const syntax = await run("n = 1\nreturn (");
      expect(syntax.error).toContain("SyntaxError");
      expect(syntax.error).toContain('File "raft-exec.py", line 2');
      const error = await run('def fail():\n    raise ValueError("source failure")\nfail()');
      expect(error.error).toContain('File "raft-exec.py", line 2');
      expect(error.error).toContain('File "raft-exec.py", line 3');
      expect(error.error).not.toContain("<python-input");
    });

    it("sets an explicit long native request watchdog when host floors are enabled", async () => {
      const native = await import("@pydantic/monty/node");
      const create = native.Monty.create.bind(native.Monty);
      const checkouts: unknown[] = [];
      const createSpy = vi.spyOn(native.Monty, "create").mockImplementation(async (opts) => {
        const pool = await create(opts);
        const checkout = pool.checkout.bind(pool);
        vi.spyOn(pool, "checkout").mockImplementation(async (opts) => {
          checkouts.push(opts);
          return checkout(opts);
        });
        return pool;
      });
      expect(
        await run("return 1", echo, { timeoutMs: 100, minimumTimeoutMsForHostCall: () => 1000 }),
      ).toMatchObject({ value: 1, terminationReason: "completed" });
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestTimeout: MAX_EXECUTOR_TIMEOUT_MS / 1000 + 1,
          durationLimitGrace: null,
        }),
      );
      expect(checkouts[0]).toMatchObject({ limits: { maxMemory: options.memoryLimitBytes } });
      expect((checkouts[0] as { limits: object }).limits).not.toHaveProperty("maxDurationSecs");
    });

    it("hard-interrupts synchronous loops with and without extendable deadlines", async () => {
      for (const extra of [{}, { minimumTimeoutMsForHostCall: () => 500 }]) {
        const started = Date.now();
        const result = await run('print("started")\nwhile True:\n    pass', echo, {
          ...extra,
          timeoutMs: 150,
        });
        expect(result.terminationReason).toBe("timed_out");
        expect(result.logs).toContain("started");
        expect(Date.now() - started).toBeLessThan(2000);
      }
    });

    it("bounds guest memory independently of the wall deadline", async () => {
      const result = await run('return "x" * 10000000', echo, { memoryLimitBytes: 1024 * 1024 });
      expect(result.terminationReason).toBe("runtime_error");
      expect(result.error).toMatch(/memory|Memory/);
    });

    it("exposes no filesystem, environment or network capability by default", async () => {
      for (const code of [
        'from pathlib import Path\nreturn Path("package.json").read_text()',
        'return open("package.json").read()',
        "import socket\nreturn socket.socket()",
      ]) {
        const host = vi.fn(echo);
        expect((await run(code, host)).terminationReason).toBe("runtime_error");
        expect(host).not.toHaveBeenCalled();
      }
      const env = await run('import os\nreturn os.getenv("HOME")');
      expect(env.terminationReason === "runtime_error" || env.value === null).toBe(true);
    });

    it("does not consult MONTY_BIN to select a different interpreter", async () => {
      vi.stubEnv("MONTY_BIN", "/does/not/exist/monty");
      try {
        expect(await run("return 2 + 2")).toMatchObject({
          terminationReason: "completed",
          value: 4,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  },
);

describe("MontyRuntime availability and option validation", () => {
  it("fails clearly when the optional native package cannot load", async () => {
    vi.doMock("@pydantic/monty/node", () => {
      throw new Error("Cannot find optional native dependency");
    });
    try {
      const result = await run("return 1");
      expect(result.terminationReason).toBe("runtime_error");
      expect(result.error).toContain("optional native package is unavailable or incompatible");
      expect(result.error).toContain("@pydantic/monty@0.0.23");
      expect(result.error).toContain("cpython");
    } finally {
      vi.doUnmock("@pydantic/monty/node");
    }
  });
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: NaN },
    { memoryLimitBytes: -1 },
    { memoryLimitBytes: Infinity },
    { maxLogChars: -1 },
  ])("rejects invalid limits before native startup: %j", async (extra) => {
    expect((await run("return 1", echo, extra)).terminationReason).toBe("runtime_error");
  });
});
