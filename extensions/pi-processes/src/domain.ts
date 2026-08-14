import { Schema } from "effect";

/** Default number of newest log lines returned by process_snapshot. */
export const DEFAULT_PROCESS_SNAPSHOT_LINES = 100;

/** Maximum number of log lines returned by process_snapshot. */
export const MAX_PROCESS_SNAPSHOT_LINES = 2000;

/** Maximum retained log bytes returned by process_snapshot. */
export const MAX_PROCESS_SNAPSHOT_BYTES = 50_000;

/** Readiness state for a supervised process. */
export interface ProcessReadyState {
   ready: boolean;
   logMatched: boolean;
   portMatched: boolean;
   timedOut?: boolean;
}

/** A retained process and its observable lifecycle state. */
export interface ProcessEntry {
   readonly id: string;
   readonly name: string;
   readonly command: string;
   readonly cwd: string;
   readonly pid: number;
   status: "running" | "exited" | "failed";
   readonly readyCondition?: { log?: string; port?: number; timeoutSec?: number };
   readyState: ProcessReadyState;
   readonly spawnTime: number;
   settledAt?: number;
   exitCode?: number;
   signal?: string;
   errorText?: string;
}

/** Typed failure returned when the process concurrency limit is reached. */
export class ConcurrencyLimitError extends Schema.TaggedError<ConcurrencyLimitError>()("ConcurrencyLimitError", {
   message: Schema.String,
   limit: Schema.Number
}) {}

/** Format a stable process identity. */
export function formatProcessId(sequence: number): string {
   return `process-${sequence}`;
}
