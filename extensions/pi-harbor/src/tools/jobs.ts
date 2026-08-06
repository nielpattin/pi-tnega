import { Effect } from "effect";
import { Type, type Static } from "typebox";
import { JobRegistry } from "../services/JobRegistry.js";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import { TaskManager } from "../services/TaskManager.js";
import type { Job, ProcessEntry } from "../domain.js";

const JobIdSchema = Type.String({
   minLength: 1,
   description: "Harbor job ID returned by task_spawn or process_start."
});

export const JobListToolParamsSchema = Type.Object(
   {},
   { description: "List all Harbor task and long-running process jobs." }
);
export type JobListToolParams = Static<typeof JobListToolParamsSchema>;

export const JobCancelToolParamsSchema = Type.Object(
   {
      id: JobIdSchema
   },
   { description: "Cancel an agent task or stop a long-running process by Harbor job ID." }
);
export type JobCancelToolParams = Static<typeof JobCancelToolParamsSchema>;

export const jobListToolDefinition = {
   name: "job_list",
   label: "Job List",
   description: "List agent task jobs and long-running process jobs.",
   parameters: JobListToolParamsSchema
};

export const jobCancelToolDefinition = {
   name: "job_cancel",
   label: "Job Cancel",
   description: "Cancel an agent task or stop a long-running process by job ID.",
   parameters: JobCancelToolParamsSchema
};

function taskJobView(job: Job): Record<string, unknown> {
   return {
      id: job.id,
      name: job.name ?? job.id,
      kind: "task",
      status: job.status,
      agent: job.agent,
      harness: job.harness,
      model: job.model,
      cwd: job.cwd,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      settledAt: job.settledAt,
      errorText: job.errorText ? job.errorText.slice(0, 1000) : undefined
   };
}

function processJobView(process: ProcessEntry): Record<string, unknown> {
   return {
      id: process.id,
      name: process.name ?? process.id,
      kind: "process",
      command: process.command,
      cwd: process.cwd,
      pid: process.pid,
      status: process.status,
      readyCondition: process.readyCondition ? { ...process.readyCondition } : undefined,
      readyState: { ...process.readyState },
      spawnTime: process.spawnTime,
      settledAt: process.settledAt,
      exitCode: process.exitCode,
      signal: process.signal
   };
}

function findProcess(processes: ReadonlyArray<ProcessEntry>, id: string): ProcessEntry | undefined {
   return processes.find((process) => process.id === id);
}

export const handleJobList = Effect.fn("jobs.handleJobList")(function* (_params: JobListToolParams) {
   const registry = yield* JobRegistry;
   const supervisor = yield* ProcessSupervisor;
   const [tasks, processes] = yield* Effect.all([registry.list(), supervisor.ps]);

   return {
      ok: true,
      jobs: [...tasks.map(taskJobView), ...processes.map(processJobView)]
   };
});

export const handleJobCancel = Effect.fn("jobs.handleJobCancel")(function* (params: JobCancelToolParams) {
   const registry = yield* JobRegistry;
   const taskManager = yield* TaskManager;
   const supervisor = yield* ProcessSupervisor;

   const task = yield* registry.get(params.id);
   if (task) {
      const cancelled = yield* taskManager.cancelJob(params.id);
      return {
         ok: true,
         action: "cancelled" as const,
         id: params.id,
         job: cancelled ? taskJobView(cancelled) : undefined
      };
   }

   const process = findProcess(yield* supervisor.ps, params.id);
   if (process?.name) {
      const stopped = yield* supervisor.stop(process.name);
      return { ok: true, action: "stopped" as const, id: params.id, job: processJobView(stopped) };
   }

   return { ok: false, error: `Harbor job "${params.id}" not found.` };
});
