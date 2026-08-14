import { Type, type Static } from "typebox";
import { Effect } from "effect";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import { DEFAULT_PROCESS_SNAPSHOT_LINES, MAX_PROCESS_SNAPSHOT_LINES, type ProcessEntry } from "../domain.js";

const ProcessNameSchema = Type.String({
   minLength: 1,
   description: "Display name for the supervised process, for example api."
});
const ProcessJobIdSchema = Type.String({
   minLength: 1,
   description: "Process job ID returned by process_start, for example process-1."
});
const EnvironmentSchema = Type.Optional(
   Type.Record(Type.String(), Type.String(), { description: "Environment variables added to the process." })
);
const ReadySchema = Type.Optional(
   Type.Object(
      {
         log: Type.Optional(Type.String({ description: "Log text that marks the process ready." })),
         port: Type.Optional(Type.Number({ description: "TCP port that marks the process ready." })),
         timeoutSec: Type.Optional(Type.Number({ description: "Readiness timeout in seconds." }))
      },
      { description: "Optional process readiness condition." }
   )
);

export const ProcessStartToolParamsSchema = Type.Object(
   {
      name: ProcessNameSchema,
      command: Type.String({
         minLength: 1,
         description:
            "Shell command to run in the background. Use for retained services or any command explicitly requested in background."
      }),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session directory." })),
      env: EnvironmentSchema,
      ready: ReadySchema
   },
   {
      description:
         "Start a named background OS process, including finite commands explicitly requested in background. Use bash for foreground one-shot commands."
   }
);
export type ProcessStartToolParams = Static<typeof ProcessStartToolParamsSchema>;

export const ProcessSnapshotToolParamsSchema = Type.Object(
   {
      id: ProcessJobIdSchema,
      lines: Type.Optional(
         Type.Integer({
            minimum: 1,
            maximum: MAX_PROCESS_SNAPSHOT_LINES,
            description: `Number of newest log lines to return. Defaults to ${DEFAULT_PROCESS_SNAPSHOT_LINES}.`
         })
      ),
      before: Type.Optional(
         Type.Integer({
            minimum: 1,
            description: "Numeric paging bookmark returned by an earlier process_snapshot result."
         })
      ),
      grep: Type.Optional(Type.String({ description: "Filter log lines by this text or pattern." }))
   },
   { description: "Read a bounded window of combined stdout and stderr for a process job." }
);
export type ProcessSnapshotToolParams = Static<typeof ProcessSnapshotToolParamsSchema>;

export const ProcessRestartToolParamsSchema = Type.Object(
   {
      id: ProcessJobIdSchema
   },
   { description: "Restart a process job by job ID." }
);
export type ProcessRestartToolParams = Static<typeof ProcessRestartToolParamsSchema>;

export const ProcessListToolParamsSchema = Type.Object({}, { description: "List all long-running process jobs." });
export type ProcessListToolParams = Static<typeof ProcessListToolParamsSchema>;

export const ProcessStopToolParamsSchema = Type.Object(
   {
      id: ProcessJobIdSchema
   },
   { description: "Stop a long-running process job by job ID or name." }
);
export type ProcessStopToolParams = Static<typeof ProcessStopToolParamsSchema>;

function findProcess(processes: ReadonlyArray<ProcessEntry>, id: string): ProcessEntry | undefined {
   return processes.find((process) => process.id === id || process.name === id);
}

export function processView(process: ProcessEntry): Record<string, unknown> {
   return {
      id: process.id,
      name: process.name,
      command: process.command,
      cwd: process.cwd,
      pid: process.pid,
      status: process.status,
      readyCondition: process.readyCondition ? { ...process.readyCondition } : undefined,
      spawnTime: process.spawnTime,
      settledAt: process.settledAt,
      exitCode: process.exitCode,
      signal: process.signal,
      errorText: process.errorText
   };
}

function processNotFound(id: string) {
   return { ok: false as const, error: `Process job "${id}" not found.` };
}

export const handleProcessStart = Effect.fn("process.handleStart")(function* (params: ProcessStartToolParams) {
   const supervisor = yield* ProcessSupervisor;
   const process = yield* supervisor.start({
      name: params.name,
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      ready: params.ready
   });
   return { ok: true, process: processView(process) };
});

export const handleProcessList = Effect.fn("process.handleList")(function* (_params: ProcessListToolParams) {
   const supervisor = yield* ProcessSupervisor;
   const processes = yield* supervisor.ps;
   return { ok: true, processes: processes.map(processView) };
});

export const handleProcessSnapshot = Effect.fn("process.handleSnapshot")(function* (params: ProcessSnapshotToolParams) {
   const supervisor = yield* ProcessSupervisor;
   const process = findProcess(yield* supervisor.ps, params.id);
   if (!process) return processNotFound(params.id);

   const logs = yield* supervisor.logs(process.name, {
      lines: params.lines,
      before: params.before,
      grep: params.grep
   });
   return {
      ok: true,
      process: processView(process),
      lines: logs.lines,
      ...(logs.before === undefined ? {} : { before: logs.before })
   };
});

export const handleProcessRestart = Effect.fn("process.handleRestart")(function* (params: ProcessRestartToolParams) {
   const supervisor = yield* ProcessSupervisor;
   const process = findProcess(yield* supervisor.ps, params.id);
   if (!process) return processNotFound(params.id);

   const restarted = yield* supervisor.restart(process.name);
   return { ok: true, process: processView(restarted) };
});

export const handleProcessStop = Effect.fn("process.handleStop")(function* (params: ProcessStopToolParams) {
   const supervisor = yield* ProcessSupervisor;
   const process = findProcess(yield* supervisor.ps, params.id);
   if (!process) return processNotFound(params.id);

   const stopped = yield* supervisor.stop(process.name);
   return { ok: true, action: "stopped" as const, id: params.id, process: processView(stopped) };
});
