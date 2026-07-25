import { Context, Effect, Layer, Deferred } from "effect";
import { ConcurrencyLimitError, type ProcessEntry, type ProcessReadyState } from "../domain.js";
import { ShellExecutor } from "./ShellExecutor.js";
import { OutputBuffer } from "../utils/output-buffer.js";
import { killTree } from "../utils/kill-tree.js";
import { filterLogLines, paginateLogLines, formatMultiProcessLogLines, selectLogStream } from "../ui/log-viewer.js";
import { defaultTelemetryReader, type ProcessTelemetry, type TelemetryReader } from "../utils/process-telemetry.js";
import type { ChildProcess } from "node:child_process";

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
      stdin?: boolean;
   }) => Effect.Effect<ProcessEntry, ConcurrencyLimitError>;

   readonly stop: (name: string, signal?: NodeJS.Signals) => Effect.Effect<ProcessEntry, Error>;
   readonly restart: (name: string) => Effect.Effect<ProcessEntry, ConcurrencyLimitError | Error>;
   readonly ps: Effect.Effect<ReadonlyArray<ProcessEntry>>;
   readonly logs: (
      name: string | ReadonlyArray<string>,
      options?: {
         lines?: number;
         head?: boolean;
         grep?: string;
         cursor?: number;
         stream?: "stdout" | "stderr" | "both";
         follow?: boolean;
         timeoutSec?: number;
      }
   ) => Effect.Effect<{ lines: string[]; cursor: number }, Error>;

   readonly awaitExit: (name: string, timeoutMs?: number) => Effect.Effect<ProcessEntry, Error>;
   readonly writeStdin: (name: string, data: string | Buffer) => Effect.Effect<void, Error>;
   readonly closeStdin: (name: string) => Effect.Effect<void, Error>;
   readonly telemetry: (name: string, reader?: TelemetryReader) => Effect.Effect<ProcessTelemetry, Error>;
}

interface TrackedProcess {
   entry: ProcessEntry;
   child: ChildProcess;
   stdoutBuffer: OutputBuffer;
   stderrBuffer: OutputBuffer;
   exitDeferred: Deferred.Deferred<ProcessEntry>;
}

export class ProcessSupervisor extends Context.Service<ProcessSupervisor, ProcessSupervisorShape>()(
   "harbor/ProcessSupervisor"
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
               if (p.entry.status === "starting" || p.entry.status === "running") {
                  count++;
               }
            }
            return count;
         };

         const pruneExited = () => {
            if (processes.size <= MAX_TRACKED_PROCESSES) return;
            const candidates: TrackedProcess[] = [];
            for (const p of processes.values()) {
               if (
                  (p.entry.status === "exited" || p.entry.status === "failed") &&
                  p.entry.processWaitInterest === 0 &&
                  p.entry.processKillInterest === 0
               ) {
                  candidates.push(p);
               }
            }

            candidates.sort((a, b) => (a.entry.settledAt ?? 0) - (b.entry.settledAt ?? 0));

            while (processes.size > MAX_TRACKED_PROCESSES && candidates.length > 0) {
               const victim = candidates.shift();
               if (victim) {
                  processes.delete(victim.entry.name ?? victim.entry.id);
               }
            }
         };

         const start = Effect.fn("ProcessSupervisor.start")(function* (params) {
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
               const id = `bash-${processSeq}`;
               const child = yield* executor.spawnProcess(params.command, {
                  cwd: params.cwd,
                  env: params.env,
                  stdin: params.stdin
               });

               const stdoutBuffer = new OutputBuffer(RETAINED_STREAM_BYTES);
               const stderrBuffer = new OutputBuffer(RETAINED_STREAM_BYTES);
               const exitDeferred = yield* Deferred.make<ProcessEntry>();

               const initialReadyState: ProcessReadyState = {
                  ready: !params.ready,
                  logMatched: false,
                  portMatched: false
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
                  spawnTime: Date.now(),
                  stdoutBytes: 0,
                  stderrBytes: 0,
                  processWaitInterest: 0,
                  processKillInterest: 0
               };

               const tracked: TrackedProcess = {
                  entry,
                  child,
                  stdoutBuffer,
                  stderrBuffer,
                  exitDeferred
               };

               processes.set(params.name, tracked);

               child.stdout?.on("data", (chunk: Buffer | string) => {
                  const str = chunk.toString("utf8");
                  stdoutBuffer.push(str);
                  entry.stdoutBytes += Buffer.byteLength(str, "utf8");
               });

               child.stderr?.on("data", (chunk: Buffer | string) => {
                  const str = chunk.toString("utf8");
                  stderrBuffer.push(str);
                  entry.stderrBytes += Buffer.byteLength(str, "utf8");
               });

               child.once("close", (code, signal) => {
                  entry.status = code === 0 ? "exited" : "failed";
                  entry.exitCode = code ?? undefined;
                  entry.signal = signal ?? undefined;
                  entry.settledAt = Date.now();
                  Effect.runFork(Deferred.succeed(exitDeferred, entry));
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
            yield* Effect.void;
            const tracked = processes.get(name);
            if (!tracked) {
               throw new Error(`Process not found: ${name}`);
            }

            if (tracked.entry.status === "running" || tracked.entry.status === "starting") {
               killTree(tracked.child, signal);
               tracked.entry.status = "exited";
               tracked.entry.settledAt = Date.now();
               Effect.runFork(Deferred.succeed(tracked.exitDeferred, tracked.entry));
            }

            return tracked.entry;
         });

         const restart = Effect.fn("ProcessSupervisor.restart")(function* (name) {
            const tracked = processes.get(name);
            if (!tracked) {
               throw new Error(`Process not found: ${name}`);
            }
            yield* stop(name, "SIGKILL");
            return yield* start({
               name: tracked.entry.name ?? name,
               command: tracked.entry.command,
               cwd: tracked.entry.cwd,
               ready: tracked.entry.readyCondition
            });
         });

         const ps = Effect.sync(() => Array.from(processes.values()).map((p) => p.entry));

         const logs = Effect.fn("ProcessSupervisor.logs")(function* (nameOrNames, options) {
            yield* Effect.void;
            const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames as string];

            const processEntries: Array<{ name: string; lines: string[] }> = [];

            for (const name of names) {
               const tracked = processes.get(name);
               if (!tracked) {
                  if (!Array.isArray(nameOrNames)) {
                     return yield* Effect.fail(new Error(`Process not found: ${name}`));
                  }
                  continue;
               }
               const stdoutText = tracked.stdoutBuffer.view().text;
               const stderrText = tracked.stderrBuffer.view().text;
               const rawLines = selectLogStream(stdoutText, stderrText, options?.stream);
               processEntries.push({ name, lines: rawLines });
            }

            let allLines: string[];
            if (Array.isArray(nameOrNames)) {
               allLines = formatMultiProcessLogLines(processEntries);
            } else {
               allLines = processEntries[0]?.lines ?? [];
            }

            const filtered = filterLogLines(allLines, options?.grep);
            const paginated = paginateLogLines(filtered, options);

            return { lines: paginated.lines, cursor: paginated.cursor };
         });

         const awaitExit = Effect.fn("ProcessSupervisor.awaitExit")(function* (name, timeoutMs) {
            const tracked = processes.get(name);
            if (!tracked) {
               throw new Error(`Process not found: ${name}`);
            }

            if (tracked.entry.status === "exited" || tracked.entry.status === "failed") {
               return tracked.entry;
            }

            tracked.entry.processWaitInterest++;
            return yield* Effect.gen(function* () {
               if (timeoutMs !== undefined && timeoutMs > 0) {
                  yield* Deferred.await(tracked.exitDeferred).pipe(
                     Effect.timeout(`${timeoutMs} millis`),
                     Effect.ignore
                  );
               } else {
                  yield* Deferred.await(tracked.exitDeferred);
               }
               return tracked.entry;
            }).pipe(
               Effect.ensuring(
                  Effect.sync(() => {
                     if (tracked.entry.processWaitInterest > 0) {
                        tracked.entry.processWaitInterest--;
                     }
                  })
               )
            );
         });

         const writeStdin = Effect.fn("ProcessSupervisor.writeStdin")(function* (name, data) {
            yield* Effect.void;
            const tracked = processes.get(name);
            if (!tracked) {
               return yield* Effect.fail(new Error(`Process not found: ${name}`));
            }
            if (tracked.entry.status !== "running" && tracked.entry.status !== "starting") {
               return yield* Effect.fail(new Error(`Process ${name} is not running`));
            }
            if (!tracked.child.stdin || tracked.child.stdin.destroyed || !tracked.child.stdin.writable) {
               return yield* Effect.fail(new Error(`Stdin not available for process: ${name}`));
            }
            return yield* Effect.callback<void, Error>((resume) => {
               tracked.child.stdin!.write(data, (err) => {
                  if (err) {
                     resume(Effect.fail(err));
                  } else {
                     resume(Effect.succeed(undefined));
                  }
               });
            });
         });

         const closeStdin = Effect.fn("ProcessSupervisor.closeStdin")(function* (name) {
            yield* Effect.void;
            const tracked = processes.get(name);
            if (!tracked) {
               return yield* Effect.fail(new Error(`Process not found: ${name}`));
            }
            if (!tracked.child.stdin || tracked.child.stdin.destroyed) {
               return yield* Effect.fail(new Error(`Stdin not available for process: ${name}`));
            }
            yield* Effect.sync(() => {
               tracked.child.stdin!.end();
            });
            return yield* Effect.void;
         });

         const telemetry = Effect.fn("ProcessSupervisor.telemetry")(function* (name, customReader) {
            yield* Effect.void;
            const tracked = processes.get(name);
            if (!tracked) {
               return yield* Effect.fail(new Error(`Process not found: ${name}`));
            }
            if (tracked.entry.status !== "running" && tracked.entry.status !== "starting") {
               return yield* Effect.succeed<ProcessTelemetry>({
                  status: "unavailable",
                  pid: tracked.entry.pid,
                  reason: `Process is ${tracked.entry.status}`,
                  timestamp: Date.now()
               });
            }
            const reader = customReader ?? defaultTelemetryReader;
            return yield* reader(tracked.entry.pid) as Effect.Effect<ProcessTelemetry, Error>;
         });

         return ProcessSupervisor.of({
            start,
            stop,
            restart,
            ps,
            logs,
            awaitExit,
            writeStdin,
            closeStdin,
            telemetry
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
