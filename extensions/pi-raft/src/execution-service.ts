import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  RaftExecutionTraceRecorder,
  RaftTraceSafeError,
  executionOutcomeFromError,
  type RaftExecutionFailureStageV1,
  type RaftExecutionTraceOperationHandle,
  type RaftExecutionTraceV1,
} from "./audit/trace.js";
import { RaftActivityStore } from "./activity/store.js";
import { pythonErrorRecoveryHint } from "./runtime/python-error-guidance.js";
import type {
  RaftActivityEventInput,
  RaftActivityItemInput,
  RaftPhaseInput,
  RaftRunDisplay,
} from "./activity/types.js";
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS, type RaftConfig } from "./config.js";
import {
  ActionRegistry,
  type RaftCallAudit,
  type RaftRegistryActivityEvent,
} from "./core/action-registry.js";
import {
  ApprovalController,
  RaftSessionApprovals,
  type RaftAutoApprovalAudit,
} from "./core/approval-controller.js";
import { RaftAutoApprovalClassifier } from "./core/auto-approval-classifier.js";
import { codeUsesOrchestration, isBlockingOrchestrationRef } from "./runtime/orchestration.js";
import type { RaftCommittedCapabilityView } from "./protocol.js";
import { raftExecTitleHintCached } from "./ui/raft-title-hint.js";
import { stringifyUnknown } from "./util.js";
import type {
  RaftKernel,
  RaftKernelRuntime,
  RaftSandboxResult,
  RaftSandboxTerminationReason,
} from "./runtime/kernel.js";
import type { TypeScriptKernelRuntime } from "./runtime/typescript-kernel.js";
import type { RaftTypeError, RaftTypeCheckResult } from "./runtime/type-checker.js";

const executionOutcomeFromTermination = (
  reason: RaftSandboxTerminationReason,
): "succeeded" | "failed" | "aborted" | "timed_out" => {
  switch (reason) {
    case "completed":
      return "succeeded";
    case "aborted":
      return "aborted";
    case "timed_out":
      return "timed_out";
    case "runtime_error":
      return "failed";
  }
};

const aggregateUsage = (usages: Usage[]): Usage => ({
  input: usages.reduce((total, usage) => total + usage.input, 0),
  output: usages.reduce((total, usage) => total + usage.output, 0),
  cacheRead: usages.reduce((total, usage) => total + usage.cacheRead, 0),
  cacheWrite: usages.reduce((total, usage) => total + usage.cacheWrite, 0),
  ...(usages.some((usage) => usage.cacheWrite1h !== undefined)
    ? { cacheWrite1h: usages.reduce((total, usage) => total + (usage.cacheWrite1h ?? 0), 0) }
    : {}),
  ...(usages.some((usage) => usage.reasoning !== undefined)
    ? { reasoning: usages.reduce((total, usage) => total + (usage.reasoning ?? 0), 0) }
    : {}),
  totalTokens: usages.reduce((total, usage) => total + usage.totalTokens, 0),
  cost: {
    input: usages.reduce((total, usage) => total + usage.cost.input, 0),
    output: usages.reduce((total, usage) => total + usage.cost.output, 0),
    cacheRead: usages.reduce((total, usage) => total + usage.cost.cacheRead, 0),
    cacheWrite: usages.reduce((total, usage) => total + usage.cost.cacheWrite, 0),
    total: usages.reduce((total, usage) => total + usage.cost.total, 0),
  },
});

export interface RaftExecutionResult {
  success: boolean;
  kernel?: RaftKernel;
  value: unknown;
  logs: string[];
  audits: RaftCallAudit[];
  phases: string[];
  trace: RaftExecutionTraceV1;
  elapsedMs: number;
  typeErrors?: RaftTypeError[];
  error?: string;
  usage?: Usage;
}

interface RaftExecutionPartial {
  audits: RaftCallAudit[];
  phases: string[];
  progress?: string | undefined;
}

export interface RaftExecutionAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
}

export interface RaftExecutionOptions {
  code: string;
  strings?: Record<string, string>;
  /** Per-invocation whole-program deadline request from raft_exec.timeoutMs.
   * Raises (never lowers) the configured executor.timeoutMs, subject to
   * executor.maxTimeoutMs. */
  requestedTimeoutMs?: number;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  context: ExtensionContext;
  tokenBudget?: number;
  maxAgentCalls?: number;
  display?: RaftRunDisplay;
  onPartial(snapshot: RaftExecutionPartial): void;
}

export class RaftExecutionService {
  #runtime: RaftKernelRuntime | undefined;
  #runtimeKind: string | undefined;
  #capabilityView: RaftCommittedCapabilityView | undefined;
  constructor(
    readonly registry: ActionRegistry,
    readonly config: RaftConfig,
    readonly activity?: RaftActivityStore,
    readonly authorizer?: RaftExecutionAuthorizer,
    readonly autoApprovalClassifier = new RaftAutoApprovalClassifier(),
    readonly sessionApprovals = new RaftSessionApprovals(),
    readonly brokeredNetwork?: (provider: string) => boolean,
  ) {}

  setCapabilityView(view: RaftCommittedCapabilityView | undefined): void {
    this.#capabilityView = view;
  }

  async execute(options: RaftExecutionOptions): Promise<RaftExecutionResult> {
    const startedAt = performance.now();
    const traceRecorder = new RaftExecutionTraceRecorder();
    this.activity?.start(
      options.parentToolCallId,
      options.display,
      options.display?.name?.trim()
        ? undefined
        : this.config.execution.executor.kernel === "python"
          ? "Python program"
          : raftExecTitleHintCached(options.code),
    );
    const python = this.config.execution.executor.kernel === "python";
    // Snapshot kernel identity before awaits so async setup cannot change the
    // selected language mid-run.
    const monty = python && this.config.execution.executor.pythonRuntime === "monty";
    const runtimeKind = python
      ? monty
        ? "python:monty"
        : `python:${this.config.execution.executor.cpython.binary}`
      : `typescript:${this.config.execution.executor.runtime}`;
    let runtime = this.#runtimeKind === runtimeKind ? this.#runtime : undefined;
    if (!runtime) {
      if (monty) {
        const { MontyRuntime } = await import("./runtime/monty-runtime.js");
        runtime = new MontyRuntime();
      } else if (python) {
        const { CPythonRuntime } = await import("./runtime/cpython-runtime.js");
        runtime = new CPythonRuntime(this.config.execution.executor.cpython.binary);
      } else {
        const { TypeScriptKernelRuntime } = await import("./runtime/typescript-kernel.js");
        runtime = new TypeScriptKernelRuntime(this.config.execution.executor.runtime);
      }
      this.#runtime = runtime;
      this.#runtimeKind = runtimeKind;
    }
    let code = options.code;
    let checked: RaftTypeCheckResult = { errors: [] };
    const unavailable = new Map(
      this.registry.unavailableProviders().map((entry) => [entry.name, entry.reason]),
    );
    if (!python) {
      // TypeScript alone consumes live schemas as compiler declarations. Python
      // compiles in CPython; both kernels share authoritative registry validation.
      const guestTypeSources = await this.registry.guestTypeSources({
        cwd: options.context.cwd,
        signal: options.signal,
        parentToolCallId: options.parentToolCallId,
        nestedToolCallId: `${options.parentToolCallId}_typedecls`,
        extensionContext: options.context,
        update() {},
        ...(this.#capabilityView ? { capabilityView: this.#capabilityView } : {}),
      });
      ({ code, checked } = (runtime as TypeScriptKernelRuntime).prepare(
        options.code,
        [...unavailable.keys()],
        guestTypeSources,
      ));
    }
    if (checked.errors.length > 0) {
      for (const error of checked.errors) {
        const missing = /^Cannot find name '([^']+)'/.exec(error.message);
        const reason = missing?.[1] ? unavailable.get(missing[1]) : undefined;
        if (missing && reason) {
          error.message = `${error.message} Raft provider "${missing[1]}" is unavailable: ${reason}`;
        }
      }
      this.activity?.finish(options.parentToolCallId, false, "Type checking failed");
      return {
        success: false,
        kernel: "typescript",
        value: undefined,
        logs: [],
        audits: [],
        phases: [],
        trace: traceRecorder.seal(
          "failed",
          [],
          `Type checking failed (${checked.errors.length} ${checked.errors.length === 1 ? "error" : "errors"})`,
        ),
        elapsedMs: performance.now() - startedAt,
        typeErrors: checked.errors,
      };
    }

    const classifierUsages: Usage[] = [];
    const recordAutoDecision = (
      audit: RaftAutoApprovalAudit,
      decision?: { usage: Usage },
    ): void => {
      const operation = traceRecorder.issueCall("raft.approval.auto", {
        action: audit.action,
        risk: audit.risk,
      });
      operation.succeed(audit);
      if (decision) classifierUsages.push(decision.usage);
    };
    const approval = new ApprovalController(
      this.config.safety.approvals,
      options.context,
      this.sessionApprovals,
      this.autoApprovalClassifier,
      recordAutoDecision,
      this.brokeredNetwork,
    );
    const audits: RaftCallAudit[] = [];
    const phases: string[] = [];
    let agentCalls = 0;
    const maxAgentCalls = Math.max(
      1,
      Math.min(
        options.maxAgentCalls ?? this.config.agents.maxPerExecution,
        this.config.agents.maxPerExecution,
      ),
    );
    const guardAgentCall = (ref: string): void => {
      if (ref !== "agents.run" && ref !== "agents.spawn") return;
      agentCalls++;
      if (agentCalls > maxAgentCalls) {
        throw new RaftTraceSafeError(
          `Raft agent budget exhausted (${maxAgentCalls} per execution)`,
        );
      }
    };
    let currentProgress: string | undefined;
    let emitPending = false;
    let emitTimer: NodeJS.Timeout | undefined;
    const emitNow = (): void => {
      emitPending = false;
      options.onPartial({
        audits: audits.slice(),
        phases: phases.slice(),
        progress: currentProgress,
      });
    };
    const flushEmit = (): void => {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = undefined;
      if (emitPending) emitNow();
    };
    // One execution-wide timer coalesces updates from every parallel nested
    // call. Keeping this global to the Raft program prevents each call from
    // independently churning rows while preserving a trailing final snapshot.
    const emit = (): void => {
      emitPending = true;
      const debounceMs = this.config.appearance.ui.updateDebounceMs;
      if (debounceMs <= 0) {
        flushEmit();
        return;
      }
      // Throttle to one render per window without resetting the timer. A
      // trailing debounce starves continuously streaming tools because every
      // delta postpones the render until the tool finishes.
      if (emitTimer) return;
      emitTimer = setTimeout(() => {
        emitTimer = undefined;
        if (emitPending) emitNow();
      }, debounceMs);
      emitTimer.unref?.();
    };
    const update = (message: string): void => {
      currentProgress = message;
      emit();
    };
    const observeInvocation = (event: RaftRegistryActivityEvent): void => {
      if (this.activity) {
        if (event.type === "call_start") {
          this.activity.beginCall(options.parentToolCallId, event);
        } else if (event.type === "call_update") {
          this.activity.updateCall(options.parentToolCallId, event.callId, event.update);
        } else if (event.type === "call_args") {
          this.activity.updateCallArgs(options.parentToolCallId, event.callId, event.args);
        } else {
          this.activity.finishCall(options.parentToolCallId, event.callId, event);
        }
      }
      if (event.type === "call_end") emit();
    };
    const baseContext = {
      cwd: options.context.cwd,
      signal: options.signal,
      parentToolCallId: options.parentToolCallId,
      nestedToolCallId: `${options.parentToolCallId}_metadata`,
      extensionContext: options.context,
      update,
      ...(this.#capabilityView ? { capabilityView: this.#capabilityView } : {}),
    };
    // Start known orchestration programs with the longer deadline. Calls
    // reached through generic or computed refs are classified again at the
    // host bridge and can extend the active sandbox deadline before they run.
    // An explicit per-invocation request raises (never lowers) the starting
    // deadline, capped by the configured policy maximum.
    const orchestrationTimeoutMs = Math.max(
      this.config.execution.executor.timeoutMs,
      this.config.agents.timeoutMs,
    );
    const requestedTimeoutMs =
      typeof options.requestedTimeoutMs === "number" && Number.isFinite(options.requestedTimeoutMs)
        ? Math.max(1, Math.floor(options.requestedTimeoutMs))
        : 0;
    const effectiveTimeoutMs = Math.max(
      codeUsesOrchestration(code)
        ? orchestrationTimeoutMs
        : this.config.execution.executor.timeoutMs,
      Math.min(requestedTimeoutMs, this.config.execution.executor.maxTimeoutMs),
    );
    const minimumTimeoutMsForHostCall = (
      ref: string,
      args: Record<string, unknown>,
    ): number | undefined => {
      const targetRef = ref === "raft.$call" && typeof args.ref === "string" ? args.ref : ref;
      const targetArgs =
        ref === "raft.$call" &&
        typeof args.args === "object" &&
        args.args !== null &&
        !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : args;
      // Exact-ref configured floors raise the enclosing deadline for known
      // long-running host calls without any tool-side timeout argument.
      const refFloor = this.config.execution.executor.hostCallTimeouts[targetRef];
      if (refFloor !== undefined) {
        return Math.max(
          this.config.execution.executor.timeoutMs,
          Math.min(Math.floor(refFloor), this.config.execution.executor.maxTimeoutMs),
        );
      }
      if (!isBlockingOrchestrationRef(targetRef)) return undefined;
      const requestedTimeoutMs =
        targetRef === "agents.run" &&
        typeof targetArgs.timeoutMs === "number" &&
        Number.isFinite(targetArgs.timeoutMs)
          ? Math.max(
              MIN_AGENT_TIMEOUT_MS,
              Math.min(Math.floor(targetArgs.timeoutMs), MAX_AGENT_TIMEOUT_MS),
            )
          : 0;
      return Math.max(orchestrationTimeoutMs, requestedTimeoutMs);
    };
    const traceAttempt = async <T>(
      ref: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
      run: (setStage: (stage: RaftExecutionFailureStageV1) => void) => T | Promise<T>,
    ): Promise<T> => {
      const operation = traceRecorder.issueCall(ref, args);
      let stage: RaftExecutionFailureStageV1 = "invoke";
      try {
        const value = await run((nextStage) => {
          stage = nextStage;
        });
        operation.succeed(undefined);
        return value;
      } catch (error) {
        operation.fail(stage, error, executionOutcomeFromError(error, signal));
        throw error;
      }
    };
    const invokeAction = async (
      ref: string,
      args: Record<string, unknown>,
      callContext: typeof baseContext & { signal: AbortSignal },
    ): Promise<unknown> => {
      const traceOperation = traceRecorder.issueCall(ref, args);
      try {
        guardAgentCall(ref);
      } catch (error) {
        traceOperation.fail("guard", error, executionOutcomeFromError(error, callContext.signal));
        throw error;
      }
      return this.registry.invoke(ref, args, {
        ...callContext,
        ...(this.authorizer
          ? {
              authorize: (action) =>
                this.authorizer!.authorize(action.ref, options.parentToolCallId),
            }
          : {}),
        approve: async (action, preparedArgs) => {
          await approval.approve(action, preparedArgs);
        },
        audits,
        maxResultChars: this.config.execution.executor.maxNestedResultChars,
        traceOperation,
        observeInvocation,
      });
    };
    let sandboxResult: RaftSandboxResult;
    try {
      sandboxResult = await runtime.execute(
        code,
        async (ref, args, runtimeSignal) => {
          const callContext = { ...baseContext, signal: runtimeSignal };
          switch (ref) {
            case "raft.$search":
              return traceAttempt("raft.discovery.search", args, runtimeSignal, async () => {
                const actions = await this.registry.search(
                  stringifyUnknown(args.query),
                  callContext,
                  typeof args.limit === "number" ? args.limit : undefined,
                );
                return actions;
              });
            case "raft.$describe":
              return traceAttempt(
                "raft.discovery.describe",
                args,
                runtimeSignal,
                async (setStage) => {
                  const targetRef = stringifyUnknown(args.ref);
                  setStage("resolve");
                  return this.registry.describe(targetRef, callContext);
                },
              );
            case "raft.$call": {
              if (typeof args.ref !== "string" || !args.ref.trim()) {
                throw new Error(
                  "tools.call requires a non-empty ref string; discover dynamic refs with tools.search/describe.",
                );
              }
              if (
                args.args !== undefined &&
                (typeof args.args !== "object" || args.args === null || Array.isArray(args.args))
              ) {
                throw new Error(
                  python
                    ? 'tools.call args must be a dictionary; use await tools.call(ref="provider.action", args={"key": "value"}).'
                    : 'tools.call args must be an object; use await tools.call({ref: "provider.action", args: {key: "value"}}).',
                );
              }
              const callArgs = { ...(args.args as Record<string, unknown> | undefined) };
              const targetRef = args.ref;
              return await invokeAction(targetRef, callArgs, callContext);
            }
            case "raft.$progress":
              return traceAttempt("raft.progress", args, runtimeSignal, () =>
                update(stringifyUnknown(args.message ?? "Working")),
              );
            default:
              return invokeAction(ref, args, callContext);
          }
        },
        {
          timeoutMs: effectiveTimeoutMs,
          cwd: options.context.cwd,
          memoryLimitBytes: this.config.execution.executor.memoryLimitBytes,
          maxLogChars: this.config.execution.executor.maxOutputChars,
          minimumTimeoutMsForHostCall,
          ...(checked.javascript ? { transpiledCode: checked.javascript } : {}),
          ...(checked.sourceMap ? { transpiledSourceMap: checked.sourceMap } : {}),
          ...(options.strings ? { strings: options.strings } : {}),
          ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity?.finish(options.parentToolCallId, false, message);
      throw error;
    } finally {
      await this.registry.endInvocation(options.parentToolCallId);
      flushEmit();
    }

    if (python && sandboxResult.terminationReason === "runtime_error" && sandboxResult.error) {
      const hint = pythonErrorRecoveryHint(code, sandboxResult.error, monty ? "monty" : "cpython");
      if (hint && !sandboxResult.error.includes(hint))
        sandboxResult.error += `\n\nRecovery hint: ${hint}`;
    }

    const runOutcome = executionOutcomeFromTermination(sandboxResult.terminationReason);
    const succeeded = runOutcome === "succeeded";
    this.activity?.finish(options.parentToolCallId, succeeded, sandboxResult.error);
    return {
      success: succeeded,
      kernel: python ? "python" : "typescript",
      value: sandboxResult.value,
      logs: sandboxResult.logs,
      audits,
      phases,
      // Guest and provider error text may embed tool output or source
      // literals, so the durable trace records only safe causes.
      trace: traceRecorder.seal(runOutcome, phases),
      elapsedMs: performance.now() - startedAt,
      ...(sandboxResult.error ? { error: sandboxResult.error } : {}),
      ...(classifierUsages.length > 0 ? { usage: aggregateUsage(classifierUsages) } : {}),
    };
  }
}
