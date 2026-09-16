// Language-neutral execution contract shared by all Raft kernel backends.
export type RaftKernel = "typescript" | "python";

export type RaftSandboxTerminationReason = "completed" | "runtime_error" | "timed_out" | "aborted";

export interface RaftSandboxResult {
  value: unknown;
  logs: string[];
  terminationReason: RaftSandboxTerminationReason;
  error?: string;
}

export interface RaftSandboxOptions {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxLogChars?: number;
  strings?: Record<string, string>;
  tokenBudget?: number;
  signal?: AbortSignal;
  cwd?: string;
  minimumTimeoutMsForHostCall?(ref: string, args: Record<string, unknown>): number | undefined;
  transpiledCode?: string;
  transpiledSourceMap?: string;
}

export type RaftHostCall = (
  ref: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface RaftKernelRuntime {
  execute(
    code: string,
    hostCall: RaftHostCall,
    options: RaftSandboxOptions,
  ): Promise<RaftSandboxResult>;
}
