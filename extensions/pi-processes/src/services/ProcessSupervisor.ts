import { Context, Effect, Layer } from "effect";
import { ConcurrencyLimitError, formatProcessId, type ProcessEntry, type ProcessReadyState } from "../domain.js";
import { ShellExecutor } from "./ShellExecutor.js";
import { OutputBuffer, TimestampedOutputBuffer } from "../utils/output-buffer.js";
import { killTree } from "../utils/kill-tree.js";
import {
   filterLogLinesWithStreams,
   paginateLogLinesWithStreams,
   selectTimestampedLogLines,
   type LogLine
} from "../ui/log-viewer.js";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
// Local alias — recent @types/node marks ChildProcess as a deprecated
// "error" type. Use the inferred spawn return type instead.
type ChildProcess = ReturnType<typeof spawn>;

export const MAX_RUNNING_PROCESSES = 8;
export const MAX_TRACKED_PROCESSES = 32;
export const RETAINED_STREAM_BYTES = 2097152; // 2 MB

export interface ProcessSupervisorShape {
   readonly start: (params: {
      name: string;
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      ready?: { log?: string; port?: number; timeoutSec?: number };
   }) => Effect.Effect<ProcessEntry, ConcurrencyLimitError | Error>;

   readonly stop: (name: string, signal?: NodeJS.Signals) => Effect.Effect<ProcessEntry, Error>;
   readonly restart: (name: string) => Effect.Effect<ProcessEntry, ConcurrencyLimitError | Error>;
   readonly ps: Effect.Effect<ReadonlyArray<ProcessEntry>>;
   readonly logs: (
      name: string,
      options?: {
         lines?: number;
         before?: number;
         grep?: string;
         stream?: "stdout" | "stderr" | "both";
      }
   ) => Effect.Effect<{ lines: string[]; logLines: LogLine[]; before?: number }, Error>;
}

interface TrackedProcess {
   entry: ProcessEntry;
   child: ChildProcess;
   stderrBuffer: OutputBuffer;
   stdoutLogBuffer: TimestampedOutputBuffer;
   stderrLogBuffer: TimestampedOutputBuffer;
   readinessTimeout?: NodeJS.Timeout;
   portPoll?: NodeJS.Timeout;
}

export class ProcessSupervisor extends Context.Service<ProcessSupervisor, ProcessSupervisorShape>()(
   "processes/ProcessSupervisor"
) {
   static readonly layer = Layer.effect(
      ProcessSupervisor,
      Effect.gen(function* () {
         const executor = yield* ShellExecutor;
         const processes = new Map<string, TrackedProcess>();
         let reservedProcessSlots = 0;
         let processSeq = 0;

         const runningCount = () => {
            let count = 0;
            for (const p of processes.values()) {
               if (p.entry.status === "running") {
                  count++;
               }
            }
            return count;
         };

         const pruneExited = () => {
            if (processes.size <= MAX_TRACKED_PROCESSES) return;
            const candidates: TrackedProcess[] = [];
            for (const p of processes.values()) {
               if (p.entry.status === "exited" || p.entry.status === "failed") {
                  candidates.push(p);
               }
            }

            candidates.sort((a, b) => (a.entry.settledAt ?? 0) - (b.entry.settledAt ?? 0));

            while (processes.size > MAX_TRACKED_PROCESSES && candidates.length > 0) {
               const victim = candidates.shift();
               if (victim) {
                  processes.delete(victim.entry.name);
               }
            }
         };

         const settle = (
            tracked: TrackedProcess,
            status: "exited" | "failed",
            code: number | null,
            signal: NodeJS.Signals | null
         ) => {
            if (tracked.entry.status === "exited" || tracked.entry.status === "failed") return;

            if (tracked.readinessTimeout) clearTimeout(tracked.readinessTimeout);
            if (tracked.portPoll) clearInterval(tracked.portPoll);
            tracked.readinessTimeout = undefined;
            tracked.portPoll = undefined;
            tracked.entry.status = status;
            tracked.entry.exitCode = code ?? undefined;
            tracked.entry.signal = signal ?? undefined;
            tracked.entry.settledAt = Date.now();
            if (status === "failed") {
               tracked.entry.errorText =
                  tracked.stderrBuffer.view().text.trim() ||
                  `Process exited with ${code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`}`;
            }
         };

         const start = Effect.fn("ProcessSupervisor.start")(function* (params) {
            const existing = processes.get(params.name);
            if (existing?.entry.status === "running") {
               return yield* Effect.fail(new Error(`Process "${params.name}" is already running.`));
            }
            if (existing) processes.delete(params.name);

            if (runningCount() + reservedProcessSlots + 1 > MAX_RUNNING_PROCESSES) {
               return yield* new ConcurrencyLimitError({
                  message: `Maximum running background processes limit (${MAX_RUNNING_PROCESSES}) reached.`,
                  limit: MAX_RUNNING_PROCESSES
               });
            }

            reservedProcessSlots++;

            return yield* Effect.gen(function* () {
               pruneExited();
               processSeq++;
               const id = formatProcessId(processSeq);
               const child = yield* executor.spawnProcess(params.command, {
                  cwd: params.cwd,
                  env: params.env
               });

               const stderrBuffer = new OutputBuffer(RETAINED_STREAM_BYTES);
               let logSequence = 0;
               const nextLogSequence = () => {
                  logSequence++;
                  return logSequence;
               };
               const stdoutLogBuffer = new TimestampedOutputBuffer(RETAINED_STREAM_BYTES, nextLogSequence);
               const stderrLogBuffer = new TimestampedOutputBuffer(RETAINED_STREAM_BYTES, nextLogSequence);

               const requiresLog = typeof params.ready?.log === "string" && params.ready.log.length > 0;
               const requiresPort = params.ready?.port !== undefined;
               const initialReadyState: ProcessReadyState = {
                  ready: !requiresLog && !requiresPort,
                  logMatched: false,
                  portMatched: !requiresPort
               };

               const entry: ProcessEntry = {
                  id,
                  name: params.name,
                  command: params.command,
                  cwd: params.cwd ?? process.cwd(),
                  pid: child.pid ?? 0,
                  status: "running",
                  readyCondition: params.ready,
                  readyState: initialReadyState,
                  spawnTime: Date.now()
               };

               const tracked: TrackedProcess = {
                  entry,
                  child,
                  stderrBuffer,
                  stdoutLogBuffer,
                  stderrLogBuffer
               };

               const updateReadiness = () => {
                  const logReady = !requiresLog || entry.readyState.logMatched;
                  const portReady = !requiresPort || entry.readyState.portMatched;
                  entry.readyState.ready = logReady && portReady;
                  if (entry.readyState.ready) {
                     if (tracked.readinessTimeout) clearTimeout(tracked.readinessTimeout);
                     if (tracked.portPoll) clearInterval(tracked.portPoll);
                     tracked.readinessTimeout = undefined;
                     tracked.portPoll = undefined;
                  }
               };

               if (requiresPort) {
                  const probePort = () => {
                     const socket = createConnection({ host: "127.0.0.1", port: params.ready!.port! });
                     socket.once("connect", () => {
                        entry.readyState.portMatched = true;
                        socket.destroy();
                        updateReadiness();
                     });
                     socket.once("error", () => socket.destroy());
                  };
                  probePort();
                  tracked.portPoll = setInterval(probePort, 50);
                  tracked.portPoll.unref?.();
               }
               if (params.ready?.timeoutSec !== undefined && params.ready.timeoutSec > 0 && !entry.readyState.ready) {
                  tracked.readinessTimeout = setTimeout(() => {
                     if (!entry.readyState.ready) {
                        entry.readyState.timedOut = true;
                        if (tracked.portPoll) clearInterval(tracked.portPoll);
                        tracked.portPoll = undefined;
                     }
                  }, params.ready.timeoutSec * 1000);
                  tracked.readinessTimeout.unref?.();
               }

               processes.set(params.name, tracked);

               child.stdout?.on("data", (chunk: Buffer | string) => {
                  const str = chunk.toString("utf8");
                  stdoutLogBuffer.push(str);
                  if (params.ready?.log && !entry.readyState.logMatched) {
                     let matched = false;
                     try {
                        matched = new RegExp(params.ready.log).test(str) || str.includes(params.ready.log);
                     } catch {
                        matched = str.includes(params.ready.log);
                     }
                     if (matched) {
                        entry.readyState.logMatched = true;
                        updateReadiness();
                     }
                  }
               });

               child.stderr?.on("data", (chunk: Buffer | string) => {
                  const str = chunk.toString("utf8");
                  stderrBuffer.push(str);
                  stderrLogBuffer.push(str);
                  if (params.ready?.log && !entry.readyState.logMatched) {
                     let matched = false;
                     try {
                        matched = new RegExp(params.ready.log).test(str) || str.includes(params.ready.log);
                     } catch {
                        matched = str.includes(params.ready.log);
                     }
                     if (matched) {
                        entry.readyState.logMatched = true;
                        updateReadiness();
                     }
                  }
               });

               child.once("error", (error) => {
                  if (entry.status === "exited" || entry.status === "failed") return;
                  const message = error instanceof Error ? error.message : String(error);
                  stderrBuffer.push(message);
                  stderrLogBuffer.push(message);
                  settle(tracked, "failed", null, null);
               });

               child.once("close", (code, signal) => {
                  settle(tracked, code === 0 ? "exited" : "failed", code, signal);
               });

               return entry;
            }).pipe(
               Effect.ensuring(
                  Effect.sync(() => {
                     if (reservedProcessSlots > 0) reservedProcessSlots--;
                  })
               )
            );
         });

         const stop = Effect.fn("ProcessSupervisor.stop")(function* (name, signal = "SIGTERM") {
            const tracked = processes.get(name);
            if (!tracked) {
               throw new Error(`Process not found: ${name}`);
            }

            return yield* Effect.sync(() => {
               if (tracked.entry.status === "running") {
                  killTree(tracked.child, signal);
                  settle(tracked, "exited", null, signal);
               }
               return tracked.entry;
            });
         });

         const restart = Effect.fn("ProcessSupervisor.restart")(function* (name) {
            const tracked = processes.get(name);
            if (!tracked) {
               throw new Error(`Process not found: ${name}`);
            }
            yield* stop(name, "SIGKILL");
            return yield* start({
               name: tracked.entry.name,
               command: tracked.entry.command,
               cwd: tracked.entry.cwd,
               ready: tracked.entry.readyCondition
            });
         });

         const ps = Effect.sync(() => Array.from(processes.values()).map((p) => p.entry));

         const logs = Effect.fn("ProcessSupervisor.logs")(function* (name, options) {
            const tracked = processes.get(name);
            if (!tracked) {
               return yield* Effect.fail(new Error(`Process not found: ${name}`));
            }

            const rawLines = selectTimestampedLogLines(
               tracked.stdoutLogBuffer.view(),
               tracked.stderrLogBuffer.view(),
               options?.stream
            );
            const filtered = filterLogLinesWithStreams(rawLines, options?.grep);
            const paginated = paginateLogLinesWithStreams(filtered, options);

            return {
               lines: paginated.lines.map((entry) => entry.line),
               logLines: paginated.lines,
               ...(paginated.before === undefined ? {} : { before: paginated.before })
            };
         });

         return ProcessSupervisor.of({
            start,
            stop,
            restart,
            ps,
            logs
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: ProcessSupervisorShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | ProcessSupervisor> {
      return Effect.gen(function* () {
         const svc = yield* ProcessSupervisor;
         return yield* fn(svc);
      });
   }
}
