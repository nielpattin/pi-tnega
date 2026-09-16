import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import ts from "typescript";
import { runAbortable, settleWithin } from "../async-settlement.js";
import { createGuestStackMap, remapGuestErrorText } from "./guest-stack-map.js";
import { transpileRaftCodeWithSourceMap } from "./type-checker.js";

import type {
  RaftHostCall,
  RaftSandboxOptions,
  RaftSandboxResult,
  RaftSandboxTerminationReason,
} from "./kernel.js";
// Preserve existing import paths for runtime consumers.
export type { RaftHostCall, RaftSandboxOptions, RaftSandboxResult } from "./kernel.js";

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let quickJsModulePromise: Promise<QuickJsModule> | undefined;

// Static π.<identifier> references (bracket access like π[k] is not provable).
// Parse instead of scanning text so examples inside strings and comments do not
// become false missing-payload failures.
const referencedPiKeys = (code: string): string[] => {
  const source = ts.createSourceFile(
    "raft-exec.ts",
    `async function __raftProgram() {\n${code}\n}`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "π" &&
      !keys.includes(node.name.text)
    ) {
      keys.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
};

// Models routinely reference π.<key> without providing the payloads parameter,
// and the runtime error only lands after a full execution round trip (#68).
// Reject up front when a referenced key is statically provable missing, before
// QuickJS is even loaded.
const missingStringsKeys = (
  code: string,
  strings: Record<string, string> | undefined,
): string[] => {
  const provided = strings ?? {};
  return referencedPiKeys(code).filter((key) => !(key in provided));
};

const quickJsModule = (): Promise<QuickJsModule> => {
  quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  return quickJsModulePromise;
};

export const guestSetupSource = (): string => GUEST_SETUP;
const GUEST_SETUP = `
(() => {
const __raftBridge = globalThis.__raftHostCall;
delete globalThis.__raftHostCall;
const __call = async (ref, args) => {
  const normalizedArgs = args ?? {};
  const value = await __raftBridge(ref, normalizedArgs);
  return value;
};
const __toolsBase = {
  search: (args) => __call(
    "raft.$search",
    typeof args === "string" ? { query: args } : args,
  ),
  describe: (args) => __call("raft.$describe", args),
  call: (args) => __call("raft.$call", args),
  progress: (args) => __call("raft.$progress", args),
};
globalThis.tools = Object.freeze(__toolsBase);
const __piStrings = (typeof globalThis["π"] === "object" && globalThis["π"] !== null) ? globalThis["π"] : {};
globalThis["π"] = new Proxy(__piStrings, {
  get(target, property) {
    if (typeof property === "symbol") return undefined;
    const name = String(property);
    if (name === "then" || name === "toJSON" || name === "constructor") return undefined;
    if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
    const provided = Object.keys(target);
    throw new Error(
      "π." + name + " is not defined. π only exposes keys from the raft_exec payloads parameter" +
      (provided.length ? " (provided: " + provided.join(", ") + ")" : " (none provided)") +
      ". Pass payloads: { " + name + ": '...' } to use π." + name + "." +
      " For large or quote-heavy content, keep it in top-level payloads and reference π." + name + " instead of escaping it inside code."
    );
  },
  ownKeys(target) { return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
  has(target, prop) { return Object.prototype.hasOwnProperty.call(target, prop); }
});
globalThis.memory = Object.freeze({
  recall: (args) => __call("memory.recall", args),
  expand: (args) => __call("memory.expand", args),
});
globalThis.agents = Object.freeze({
  run: (args) => __call("agents.run", args),
  spawn: (args) => __call("agents.spawn", args),
  wait: (args) => __call("agents.wait", args),
  status: (args) => __call("agents.status", args),
  list: (args = {}) => __call("agents.list", args),
  stop: (args) => __call("agents.stop", args),
  log: (args) => __call("agents.log", args),
});
// The mcp proxy itself stays schema-less — the registry validates args at
// dispatch — but guestTypeDeclarations renders per-server argument types from
// the live descriptor cache (runtime/dynamic-guest-types.ts), so known tools
// fail type-check on argument-shape mistakes before this proxy ever runs.
globalThis.mcp = new Proxy({}, {
  get(_target, server) {
    if (server === "then") return undefined;
    if (server === "servers") return () => __call("mcp.$servers", {});
    if (server === "reload") return () => __call("mcp.$reload", {});
    if (server === "register") return (args) => __call("mcp.$register", args);
    if (server === "call") return (args) => __call("mcp.$call", args);
    return new Proxy({}, {
      get(_serverTarget, tool) {
        if (tool === "then") return undefined;
        return (args = {}) => __call("mcp." + String(server) + "." + String(tool), args);
      },
    });
  },
});
globalThis.console = Object.freeze({ log: print, info: print, warn: print, error: print });
})();
`;

const formatValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

// The sandbox driver shim is evaluated under this name, so its frames are the only
// ones worth hiding: they name harness code the reader cannot open or change.
const GUEST_SETUP_FILENAME = "pi-raft-setup.js";

// An uncaught guest error crosses the sandbox as a dumped `{message, name, stack}`
// object, and JSON-serializing it puts escaped braces and a harness frame in front of
// the model: `{"message":"Unknown Raft provider: nope","name":"Error","stack":
// "    at __call (pi-raft-setup.js:7:37)"}`. Report the message and the frames that
// name real locations; guest frames are remapped to source lines right after this.
const formatGuestError = (value: unknown): string => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return formatValue(value);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string") return formatValue(value);
  const name = typeof record.name === "string" && record.name !== "Error" ? `${record.name}: ` : "";
  const frames =
    typeof record.stack === "string"
      ? record.stack
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.includes(GUEST_SETUP_FILENAME))
      : [];
  return [`${name}${record.message}`, ...frames].join("\n");
};

const jsonText = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "null";
  return serialized;
};

const jsonHandle = (context: any, jsonObject: any, jsonParse: any, value: unknown): any => {
  if (value === undefined) return context.undefined;
  if (value === null) return context.null;
  if (typeof value === "string") return context.newString(value);
  if (typeof value === "boolean") return value ? context.true : context.false;
  if (typeof value === "number") {
    return Number.isFinite(value) ? context.newNumber(value) : context.null;
  }
  const serialized = context.newString(jsonText(value));
  try {
    return context.unwrapResult(context.callFunction(jsonParse, jsonObject, serialized));
  } finally {
    serialized.dispose();
  }
};

const HOST_TASK_SETTLE_GRACE_MS = 250;

// The release-sync WASM variant otherwise exhausts the host stack before
// QuickJS can throw its guest-catchable InternalError.
const QUICKJS_MAX_STACK_SIZE_BYTES = 256 * 1024;
const QUICKJS_GC_LIST_ASSERTION = "list_empty(&rt->gc_obj_list)";

// Preserve an already-computed result for this known Emscripten teardown
// assertion while allowing every unrelated disposal failure to escape.
const disposeQuickJsContext = (context: any): void => {
  try {
    context.dispose();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(QUICKJS_GC_LIST_ASSERTION) && message.includes("JS_FreeRuntime")) return;
    throw error;
  }
};

export class QuickJsRuntime {
  async execute(
    code: string,
    hostCall: RaftHostCall,
    options: RaftSandboxOptions,
  ): Promise<RaftSandboxResult> {
    if (options.signal?.aborted) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "aborted",
        error: "Execution cancelled",
      };
    }
    const missingKeys = missingStringsKeys(code, options.strings);
    if (missingKeys.length > 0) {
      const provided = Object.keys(options.strings ?? {});
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error:
          "Pre-execution check: " +
          missingKeys.map((key) => "π." + key).join(", ") +
          (missingKeys.length === 1
            ? " is referenced in code but its key is missing from the payloads parameter"
            : " are referenced in code but their keys are missing from the payloads parameter") +
          (provided.length ? " (provided: " + provided.join(", ") + ")" : " (none provided)") +
          ". Add payloads: { " +
          missingKeys.join(": '...', ") +
          ": '...' } to the raft_exec arguments, then reference the value as π.<key>." +
          " For large or quote-heavy content, keep it in top-level payloads and reference π.<key> instead of escaping it inside code.",
      };
    }
    if (
      !Number.isSafeInteger(options.memoryLimitBytes) ||
      options.memoryLimitBytes < 1 ||
      options.memoryLimitBytes > 0xffff_ffff
    ) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error:
          "QuickJS memory limit must be an integer between 1 byte and 4294967295 bytes (WASM32 maximum)",
      };
    }
    const module = await quickJsModule();
    const context = module.newContext();
    const runtime = context.runtime;
    const jsonObject = context.getProp(context.global, "JSON");
    const jsonParse = context.getProp(jsonObject, "parse");
    const executionStartedAt = Date.now();
    let effectiveTimeoutMs = options.timeoutMs;
    let executionDeadlineAt = executionStartedAt + effectiveTimeoutMs;
    let interruptedByDeadline = false;
    runtime.setMemoryLimit(options.memoryLimitBytes);
    runtime.setMaxStackSize(QUICKJS_MAX_STACK_SIZE_BYTES);
    runtime.setInterruptHandler(() => {
      if (options.signal?.aborted === true) return true;
      if (Date.now() <= executionDeadlineAt) return false;
      interruptedByDeadline = true;
      return true;
    });
    const logs: string[] = [];
    const maxLogChars = options.maxLogChars ?? 100_000;
    let logChars = 0;
    let logsTruncated = false;
    const pendingHostPromises = new Set<any>();
    const hostTasks = new Set<Promise<void>>();
    const pendingTimers = new Set<NodeJS.Timeout>();
    let closing = false;
    let cancelled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let rejectDeadline: ((error: Error) => void) | undefined;
    let abortHandler: (() => void) | undefined;
    let activePromiseHandle: any;
    let executionGate: any;
    let pendingResolution: Promise<any> | undefined;
    const hostAbortController = new AbortController();
    const abortHostCalls = (reason: string): void => {
      if (!hostAbortController.signal.aborted) {
        hostAbortController.abort(new Error(reason));
      }
    };

    const rejectExecutionGate = (message: string): void => {
      if (!executionGate || executionGate.alive === false) return;
      const errorHandle = context.newError(message);
      executionGate.reject(errorHandle);
      errorHandle.dispose();
      runtime.executePendingJobs();
    };

    const timeoutMessage = (): string => `Execution timed out after ${effectiveTimeoutMs}ms`;
    const expireDeadline = (): void => {
      if (closing || cancelled || timedOut) return;
      timedOut = true;
      const message = timeoutMessage();
      abortHostCalls(message);
      rejectExecutionGate(message);
      rejectDeadline?.(new Error(message));
    };
    const scheduleDeadline = (): void => {
      if (!rejectDeadline || closing || cancelled || timedOut) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(expireDeadline, Math.max(0, executionDeadlineAt - Date.now()));
    };
    const extendExecutionTimeout = (ref: string, args: Record<string, unknown>): void => {
      const requestedTimeoutMs = options.minimumTimeoutMsForHostCall?.(ref, args);
      if (typeof requestedTimeoutMs !== "number" || !Number.isFinite(requestedTimeoutMs)) {
        return;
      }
      const requestedDurationMs = Math.max(1, Math.floor(requestedTimeoutMs));
      const nextDeadlineAt = Date.now() + requestedDurationMs;
      const nextTimeoutMs = nextDeadlineAt - executionStartedAt;
      if (nextDeadlineAt <= executionDeadlineAt) return;
      effectiveTimeoutMs = nextTimeoutMs;
      executionDeadlineAt = nextDeadlineAt;
      scheduleDeadline();
    };

    try {
      const hostFunction = context.newFunction(
        "__raftHostCall",
        (referenceHandle: any, argsHandle: any) => {
          const reference = context.getString(referenceHandle);
          const dumpedArgs = context.dump(argsHandle);
          const args =
            typeof dumpedArgs === "object" && dumpedArgs !== null && !Array.isArray(dumpedArgs)
              ? (dumpedArgs as Record<string, unknown>)
              : {};
          extendExecutionTimeout(reference, args);
          const promise = context.newPromise();
          pendingHostPromises.add(promise);
          void promise.settled.then(() => pendingHostPromises.delete(promise));
          const task = runAbortable(hostAbortController.signal, () =>
            hostCall(reference, args, hostAbortController.signal),
          )
            .then((value) => {
              if (closing || promise.alive === false) return;
              const handle = jsonHandle(context, jsonObject, jsonParse, value);
              promise.resolve(handle);
              handle.dispose();
            })
            .catch((error) => {
              if (closing || promise.alive === false) return;
              const errorHandle = context.newError(
                error instanceof Error ? error.message : String(error),
              );
              promise.reject(errorHandle);
              errorHandle.dispose();
            })
            .finally(() => {
              if (!closing) runtime.executePendingJobs();
            });
          hostTasks.add(task);
          void task.finally(() => hostTasks.delete(task));
          return promise.handle;
        },
      );
      context.setProp(context.global, "__raftHostCall", hostFunction);
      hostFunction.dispose();

      const printFunction = context.newFunction("print", (...handles: any[]) => {
        if (logsTruncated) return;
        const line = handles.map((handle) => formatValue(context.dump(handle))).join(" ");
        const remaining = maxLogChars - logChars;
        if (line.length > remaining) {
          if (remaining > 0) logs.push(line.slice(0, remaining));
          logs.push("[Pi Raft log output truncated]");
          logsTruncated = true;
          return;
        }
        logs.push(line);
        logChars += line.length;
      });
      context.setProp(context.global, "print", printFunction);
      printFunction.dispose();

      const strings = jsonHandle(context, jsonObject, jsonParse, options.strings ?? {});
      context.setProp(context.global, "π", strings);
      strings.dispose();
      const tokenBudget = context.newNumber(options.tokenBudget ?? Number.POSITIVE_INFINITY);
      context.setProp(context.global, "__raftTokenBudget", tokenBudget);
      tokenBudget.dispose();

      const setupResult = context.evalCode(guestSetupSource(), GUEST_SETUP_FILENAME);
      if (setupResult.error) {
        const deadlineExceeded = interruptedByDeadline || Date.now() > executionDeadlineAt;
        if (deadlineExceeded) timedOut = true;
        const error = options.signal?.aborted
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : formatGuestError(context.dump(setupResult.error));
        setupResult.error.dispose();
        abortHostCalls(error);
        return {
          value: undefined,
          logs,
          terminationReason: options.signal?.aborted
            ? "aborted"
            : deadlineExceeded
              ? "timed_out"
              : "runtime_error",
          error,
        };
      }
      setupResult.value.dispose();

      executionGate = context.newPromise();
      context.setProp(context.global, "__raftExecutionGate", executionGate.handle);
      const guestBundle =
        options.transpiledCode === undefined
          ? transpileRaftCodeWithSourceMap(code)
          : { code: options.transpiledCode, sourceMap: options.transpiledSourceMap };
      const guestStackMap = createGuestStackMap(guestBundle.sourceMap);
      const guestLineCount = guestBundle.code.split("\n").length;
      const wrappedCode = `${guestBundle.code}\nPromise.race([__piRaftMain(), globalThis.__raftExecutionGate])`;
      const evaluation = context.evalCode(wrappedCode, "pi-raft-guest.js");
      runtime.executePendingJobs();
      if (evaluation.error) {
        const deadlineExceeded = interruptedByDeadline || Date.now() > executionDeadlineAt;
        if (deadlineExceeded) timedOut = true;
        const error = options.signal?.aborted
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : remapGuestErrorText(
                formatGuestError(context.dump(evaluation.error)),
                guestStackMap,
                guestLineCount,
              );
        evaluation.error.dispose();
        abortHostCalls(error);
        return {
          value: undefined,
          logs,
          terminationReason: options.signal?.aborted
            ? "aborted"
            : deadlineExceeded
              ? "timed_out"
              : "runtime_error",
          error,
        };
      }

      activePromiseHandle = evaluation.value;
      const cancellation = new Promise<never>((_resolve, reject) => {
        abortHandler = () => {
          cancelled = true;
          hostAbortController.abort(options.signal?.reason);
          rejectExecutionGate("Execution cancelled");
          reject(new Error("Execution cancelled"));
        };
        if (options.signal?.aborted) abortHandler();
        else options.signal?.addEventListener("abort", abortHandler, { once: true });
      });
      void cancellation.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
        scheduleDeadline();
      });
      pendingResolution = context.resolvePromise(activePromiseHandle);
      runtime.executePendingJobs();
      const resolution = await Promise.race([pendingResolution, deadline, cancellation]);
      pendingResolution = undefined;
      activePromiseHandle.dispose();
      activePromiseHandle = undefined;
      if (resolution.error) {
        const deadlineExceeded =
          timedOut || interruptedByDeadline || Date.now() > executionDeadlineAt;
        if (deadlineExceeded) timedOut = true;
        const error = options.signal?.aborted
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : remapGuestErrorText(
                formatGuestError(context.dump(resolution.error)),
                guestStackMap,
                guestLineCount,
              );
        resolution.error.dispose();
        abortHostCalls(error);
        return {
          value: undefined,
          logs,
          terminationReason: options.signal?.aborted
            ? "aborted"
            : deadlineExceeded
              ? "timed_out"
              : "runtime_error",
          error,
        };
      }
      const value = context.dump(resolution.value);
      resolution.value.dispose();
      return { value, logs, terminationReason: "completed" };
    } catch (error) {
      const deadlineExceeded =
        timedOut || interruptedByDeadline || Date.now() > executionDeadlineAt;
      if (deadlineExceeded) timedOut = true;
      abortHostCalls(error instanceof Error ? error.message : String(error));
      return {
        value: undefined,
        logs,
        terminationReason: cancelled ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
        error: cancelled
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : error instanceof Error
              ? error.message
              : String(error),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      for (const timer of pendingTimers) clearTimeout(timer);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
      if (hostTasks.size > 0) {
        const settled = await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
        if (!settled) {
          abortHostCalls("Raft guest execution ended before its host calls settled");
          await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
        }
        runtime.executePendingJobs();
      }
      closing = true;
      if (timedOut || cancelled || pendingHostPromises.size > 0) {
        const cleanupMessage = cancelled
          ? "Execution cancelled"
          : timedOut
            ? timeoutMessage()
            : "Raft guest execution ended before its host calls settled";
        if (!hostAbortController.signal.aborted)
          hostAbortController.abort(new Error(cleanupMessage));
        rejectExecutionGate(cleanupMessage);
        const errorHandle = context.newError(cleanupMessage);
        for (const promise of pendingHostPromises) promise.reject(errorHandle);
        errorHandle.dispose();
        runtime.executePendingJobs();
        await new Promise((resolve) => setImmediate(resolve));
        const settled = await Promise.race<any>([
          pendingResolution ? pendingResolution.catch(() => undefined) : Promise.resolve(undefined),
          new Promise<undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), 1_000);
            timer.unref?.();
          }),
        ]);
        if (settled?.error) settled.error.dispose();
        if (settled?.value) settled.value.dispose();
        for (const promise of pendingHostPromises) {
          if (promise.alive !== false) promise.dispose();
        }
      }
      if (activePromiseHandle?.alive !== false) activePromiseHandle?.dispose();
      if (executionGate?.alive !== false) executionGate?.dispose();
      runtime.executePendingJobs();
      jsonParse.dispose();
      jsonObject.dispose();
      disposeQuickJsContext(context);
    }
  }
}
