import { describe, expect, it, vi } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { transpileRaftCodeWithSourceMap } from "../src/runtime/type-checker.js";

const options = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };

describe("QuickJsRuntime", () => {
  it("rejects memory limits that overflow the WASM32 size_t", async () => {
    const result = await new QuickJsRuntime().execute("return 1;", async () => undefined, {
      ...options,
      memoryLimitBytes: 4 * 1024 ** 3,
    });

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("WASM32 maximum");
  });

  it("runs parallel host calls and returns structured data", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => ({
      ref,
      value: args.value,
    }));
    const result = await new QuickJsRuntime().execute(
      `
const values = await Promise.all([
  tools.call({ ref: "demo.echo", args: { value: 1 } }),
  tools.call({ ref: "demo.echo", args: { value: 2 } }),
]);
print("calls", values.length);
return values;
`,
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(["calls 2"]);
    expect(result.value).toEqual([
      { ref: "raft.$call", value: undefined },
      { ref: "raft.$call", value: undefined },
    ]);
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ ref: "demo.echo", args: { value: 1 } });
    expect(hostCall).toHaveBeenCalledTimes(2);
  });

  it("normalizes the string shorthand for tools.search", async () => {
    const result = await new QuickJsRuntime().execute(
      'return tools.search("fovea");',
      async (ref, args) => {
        expect(ref).toBe("raft.$search");
        expect(args).toEqual({ query: "fovea" });
        return [{ ref: "extensions.fovea_focus" }];
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([{ ref: "extensions.fovea_focus" }]);
  });

  it("routes JavaScript-safe MCP aliases through the direct MCP proxy", async () => {
    const result = await new QuickJsRuntime().execute(
      'return mcp.fal_ai.get_model_schema({ endpoint_id: "openai/gpt-image-2" });',
      async (ref, args) => ({ ref, args }),
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      ref: "mcp.fal_ai.get_model_schema",
      args: { endpoint_id: "openai/gpt-image-2" },
    });
  });

  it("does not expose Node globals", async () => {
    const result = await new QuickJsRuntime().execute(
      "return { process: typeof process, require: typeof require };",
      async () => undefined,
      options,
    );
    expect(result.value).toEqual({ process: "undefined", require: "undefined" });
  });

  it("waits for host calls without spinning the Node event loop", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    try {
      const result = await new QuickJsRuntime().execute(
        'return tools.call({ ref: "demo.wait" });',
        async () => new Promise((resolve) => setTimeout(() => resolve("done"), 40)),
        options,
      );
      expect(result.value).toBe("done");
      expect(immediate).not.toHaveBeenCalled();
    } finally {
      immediate.mockRestore();
    }
  });

  it("times out unresolved guest promises", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      "await new Promise(() => {});",
      async () => undefined,
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toContain("timed out");
    expect(result.terminationReason).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("classifies timeout and abort words in thrown runtime errors as runtime failures", async () => {
    for (const message of ["business timeout was rejected", "operation was aborted upstream"]) {
      const result = await new QuickJsRuntime().execute(
        `throw new Error(${JSON.stringify(message)});`,
        async () => undefined,
        options,
      );
      expect(result.error).toContain(message);
      expect(result.terminationReason).toBe("runtime_error");
    }
  });

  it("returns a typed aborted termination for an external signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const result = await new QuickJsRuntime().execute("return 1;", async () => undefined, {
      ...options,
      signal: controller.signal,
    });
    expect(result.terminationReason).toBe("aborted");
  });

  it("extends the active deadline before a blocking host call runs", async () => {
    const result = await new QuickJsRuntime().execute(
      `
const ref = ["agents", "run"].join(".");
return tools.call({ ref, args: { task: "slow" } });
`,
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed", text: "ok" }), 150);
        }),
      {
        ...options,
        timeoutMs: 50,
        minimumTimeoutMsForHostCall(ref, args) {
          return ref === "raft.$call" && args.ref === "agents.run" ? 1_000 : undefined;
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ status: "completed", text: "ok" });
  });

  it("extends a late blocking host call from the call start", async () => {
    const result = await new QuickJsRuntime().execute(
      `
await tools.call({ ref: "demo.delay" });
return tools.call({ ref: "agents.run", args: { task: "late" } });
`,
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed" }), 70);
        }),
      {
        ...options,
        timeoutMs: 100,
        minimumTimeoutMsForHostCall(ref) {
          return ref === "raft.$call" ? 100 : undefined;
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ status: "completed" });
  });

  it("aborts sibling host calls when guest workflow code fails", async () => {
    let hostCallAborted = false;
    const result = await new QuickJsRuntime().execute(
      `
await Promise.all([
  tools.call({ ref: "demo.wait" }),
  Promise.reject(new Error("branch failed")),
]);
`,
      async (_ref, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              hostCallAborted = true;
              reject(new Error("host call aborted"));
            },
            { once: true },
          );
        }),
      options,
    );
    expect(result.error).toContain("branch failed");
    expect(hostCallAborted).toBe(true);
  });

  it("does not wait for a non-cooperative sibling host call after guest failure", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      `
await Promise.all([
  tools.call({ ref: "demo.never" }),
  Promise.reject(new Error("branch failed")),
]);
`,
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("branch failed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds non-cooperative fire-and-forget host calls", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      'void tools.call({ ref: "demo.never" }); return "done";',
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe("done");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("aborts in-flight host calls when the sandbox deadline expires", async () => {
    let hostCallAborted = false;
    const result = await new QuickJsRuntime().execute(
      'await tools.call({ ref: "demo.wait" });',
      async (_ref, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              hostCallAborted = true;
              reject(new Error("host call aborted"));
            },
            { once: true },
          );
        }),
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toContain("timed out");
    expect(hostCallAborted).toBe(true);
  });

  it("interrupts synchronous infinite loops", async () => {
    const result = await new QuickJsRuntime().execute("while (true) {}", async () => undefined, {
      ...options,
      timeoutMs: 50,
    });
    expect(result.error).toContain("Execution timed out after 50ms");
  });

  it("surfaces unbounded recursion as a guest runtime error, not a WASM abort", async () => {
    const result = await new QuickJsRuntime().execute(
      "function f() { return f() + 1; } f();",
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("stack overflow");
  });

  it("makes stack overflow errors catchable inside the guest", async () => {
    const result = await new QuickJsRuntime().execute(
      "let depth = 0; function f() { depth += 1; return f() + 1; } try { f(); } catch (error) { return { depth, name: error.name }; }",
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("completed");
    const value = result.value as { depth: number; name: string };
    expect(value.name).toBe("InternalError");
    expect(value.depth).toBeGreaterThan(0);
  });
  it("reports an uncaught guest error as its message, not as a dumped error object", async () => {
    const result = await new QuickJsRuntime().execute(
      'await tools.call({ ref: "demo.missing" });',
      async () => {
        throw new Error("Unknown Raft provider: nope (registered providers: agents, mcp, memory)");
      },
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toBe(
      "Unknown Raft provider: nope (registered providers: agents, mcp, memory)",
    );
    expect(result.error).not.toContain("pi-raft-setup.js");
    expect(result.error).not.toContain('"message"');
  });

  it("keeps guest frames when an error escapes from guest code", async () => {
    const result = await new QuickJsRuntime().execute(
      'function boom() { throw new Error("guest boom"); }\nboom();',
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error?.split("\n")[0]).toBe("guest boom");
    expect(result.error).not.toContain("pi-raft-setup.js");
  });

  it("keeps executing programs after a guest stack overflow", async () => {
    const runtime = new QuickJsRuntime();
    await runtime.execute("function f() { return f() + 1; } f();", async () => undefined, options);

    const result = await runtime.execute("return 1 + 1;", async () => undefined, options);

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe(2);
  });

  it("exposes named strings via π and throws a clear error for unprovided keys", async () => {
    const content = [
      "multiline",
      "` ${value} { braces }",
      "quotes: \" '",
      "nul:" + String.fromCharCode(0) + " end",
    ].join("\n");
    const provided = await new QuickJsRuntime().execute(
      `return { value: π.content, keys: Object.keys(π).join(",") };`,
      async () => undefined,
      { ...options, strings: { content } },
    );
    expect(provided.error).toBeUndefined();
    expect(provided.value).toEqual({ value: content, keys: "content" });

    const failed = await new QuickJsRuntime().execute(
      `return π.previewFile;`,
      async () => undefined,
      { ...options, strings: { content: "hello" } },
    );
    expect(failed.error).toContain("Pre-execution check: π.previewFile is referenced");
    expect(failed.error).toContain("(provided: content)");

    const dynamic = await new QuickJsRuntime().execute(
      `const k = "previewFile"; return π[k];`,
      async () => undefined,
      { ...options, strings: { content: "hello" } },
    );
    expect(dynamic.error).toContain("π.previewFile is not defined");
    expect(dynamic.error).toContain("provided: content");
  });

  it("rejects π references to missing strings keys before execution (#68)", async () => {
    const failed = await new QuickJsRuntime().execute(
      'await tools.call({ ref: "agents.list", args: {} }); return π.body;',
      async () => {
        throw new Error("host call must not run");
      },
      { ...options, strings: { other: "hello" } },
    );
    expect(failed.terminationReason).toBe("runtime_error");
    expect(failed.error).toContain("Pre-execution check: π.body is referenced");
    expect(failed.error).toContain("(provided: other)");
    expect(failed.error).toContain("Add payloads: { body: '...' }");

    const none = await new QuickJsRuntime().execute(
      "return π.summary;",
      async () => {
        throw new Error("host call must not run");
      },
      { ...options },
    );
    expect(none.error).toContain("(none provided)");

    const multiple = await new QuickJsRuntime().execute(
      "const a = π.alpha; const b = π.alpha; const c = π.beta;",
      async () => undefined,
      { ...options, strings: {} },
    );
    expect(multiple.error).toContain("π.alpha, π.beta are referenced");

    const provided = await new QuickJsRuntime().execute(
      'await tools.call({ ref: "agents.list", args: {} }); return π.body;',
      async () => undefined,
      { ...options, strings: { body: "content" } },
    );
    expect(provided.terminationReason).toBe("completed");
  });

  it("ignores π examples inside strings and comments during payload preflight", async () => {
    const code = [
      'const example = "use π.task only with a matching payload";',
      "// π.commentExample is documentation, not an access",
      "return example;",
    ].join("\n");
    const result = await new QuickJsRuntime().execute(code, async () => undefined, {
      ...options,
      strings: { contract: "content" },
    });

    expect(result.terminationReason).toBe("completed");
    expect(result.error).toBeUndefined();
  });

  it("does not flag bracket access or bare π on dynamic keys", async () => {
    const result = await new QuickJsRuntime().execute(
      'const key = "k"; return Object.keys(π).length + (π[key] === undefined ? 0 : 1);',
      async () => undefined,
      { ...options, strings: { k: "v" } },
    );
    expect(result.terminationReason).toBe("completed");
  });
});

describe("QuickJsRuntime guest stack remapping", () => {
  const remapOptions = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };

  it("remaps thrown error frames to user code lines", async () => {
    const result = await new QuickJsRuntime().execute(
      ["const before = 1;", "print(before);", 'throw new Error("boom");'].join("\n"),
      async () => undefined,
      remapOptions,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("guest code:3:");
    expect(result.error).toContain("boom");
  });

  it("remaps native parse errors raised from user code", async () => {
    const result = await new QuickJsRuntime().execute(
      ['const payload = "    },";', "JSON.parse(payload);"].join("\n"),
      async () => undefined,
      remapOptions,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("unexpected token");
    expect(result.error).toContain("guest code:2:");
    expect(result.error).toContain("at parse (native)");
  });

  it("remaps frames for pre-transpiled code when a source map is provided", async () => {
    const code = ["const a = 1;", 'throw new Error("pre");'].join("\n");
    const transpiled = transpileRaftCodeWithSourceMap(code);
    const result = await new QuickJsRuntime().execute(code, async () => undefined, {
      ...remapOptions,
      transpiledCode: transpiled.code,
      ...(transpiled.sourceMap ? { transpiledSourceMap: transpiled.sourceMap } : {}),
    });

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("guest code:2:");
  });

  it("keeps emitted frames when no source map accompanies pre-transpiled code", async () => {
    const transpiled = transpileRaftCodeWithSourceMap('throw new Error("pre");');
    const result = await new QuickJsRuntime().execute(
      'throw new Error("pre");',
      async () => undefined,
      { ...remapOptions, transpiledCode: transpiled.code },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("pi-raft-guest.js");
  });
});
