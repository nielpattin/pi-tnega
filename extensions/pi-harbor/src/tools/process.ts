import { Type, type Static } from "typebox";
import { Effect } from "effect";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import type { ProcessEntry } from "../domain.js";

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
         description: "Shell command for the never-ending service (for example pnpm dev). For one-shot checks use bash."
      }),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session directory." })),
      env: EnvironmentSchema,
      ready: ReadySchema
   },
   { description: "Start a named long-running OS process that runs until stopped. For one-shot commands use bash." }
);
export type ProcessStartToolParams = Static<typeof ProcessStartToolParamsSchema>;

export const ProcessSnapshotToolParamsSchema = Type.Object(
   {
      id: ProcessJobIdSchema,
      lines: Type.Optional(Type.Number({ description: "Maximum number of trailing log lines." })),
      grep: Type.Optional(Type.String({ description: "Filter log lines by this text or pattern." }))
   },
   { description: "Read the current status and recent logs for a process job." }
);
export type ProcessSnapshotToolParams = Static<typeof ProcessSnapshotToolParamsSchema>;

export const ProcessRestartToolParamsSchema = Type.Object(
   {
      id: ProcessJobIdSchema
   },
   { description: "Restart a process job by Harbor job ID." }
);
export type ProcessRestartToolParams = Static<typeof ProcessRestartToolParamsSchema>;

export const processStartToolDefinition = {
   name: "process_start",
   label: "Process Start",
   description:
      "Start a retained long-running process job that runs until stopped (for example pnpm dev). For one-shot shell checks like lint, typecheck, fmt, or git diff, use bash instead.",
   parameters: ProcessStartToolParamsSchema
};

export const processSnapshotToolDefinition = {
   name: "process_snapshot",
   label: "Process Snapshot",
   description: "Read status and recent logs for a retained process job. For one-shot bash output use bash.",
   parameters: ProcessSnapshotToolParamsSchema
};

export const processRestartToolDefinition = {
   name: "process_restart",
   label: "Process Restart",
   description: "Restart a retained process job by Harbor job ID.",
   parameters: ProcessRestartToolParamsSchema
};

function findProcess(processes: ReadonlyArray<ProcessEntry>, id: string): ProcessEntry | undefined {
   return processes.find((process) => process.id === id);
}

function processView(process: ProcessEntry): Record<string, unknown> {
   return {
      ...process,
      kind: "process",
      readyCondition: process.readyCondition ? { ...process.readyCondition } : undefined,
      readyState: { ...process.readyState }
   };
}

function processNotFound(id: string) {
   return { ok: false as const, error: `Process job "${id}" not found.` };
}

export const handleProcessStart = Effect.fn("process.handleStart")(function* (params: ProcessStartToolParams) {
   if (!params.name || !params.command) {
      return { ok: false as const, error: 'process_start requires "name" and "command".' };
   }
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

export const handleProcessSnapshot = Effect.fn("process.handleSnapshot")(function* (params: ProcessSnapshotToolParams) {
   const supervisor = yield* ProcessSupervisor;
   const process = findProcess(yield* supervisor.ps, params.id);
   if (!process?.name) return processNotFound(params.id);

   const logs = yield* supervisor.logs(process.name, {
      lines: params.lines,
      grep: params.grep
   });
   return {
      ok: true,
      process: processView(process),
      lines: logs.lines,
      cursor: logs.cursor
   };
});

export const handleProcessRestart = Effect.fn("process.handleRestart")(function* (params: ProcessRestartToolParams) {
   const supervisor = yield* ProcessSupervisor;
   const process = findProcess(yield* supervisor.ps, params.id);
   if (!process?.name) return processNotFound(params.id);

   const restarted = yield* supervisor.restart(process.name);
   return { ok: true, process: processView(restarted) };
});
