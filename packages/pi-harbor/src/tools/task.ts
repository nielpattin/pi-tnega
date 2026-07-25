import { Type, type Static } from "typebox";
import { Effect } from "effect";
import { TaskManager } from "../services/TaskManager.js";
import { JobRegistry } from "../services/JobRegistry.js";
import { normalizeTaskSpecs, prependContext } from "../domain.js";

export const TaskSpecSchema = Type.Object({
   task: Type.String({ description: "Detailed instruction prompt for the subagent worker." }),
   name: Type.Optional(Type.String({ description: "Display name handle for the job." })),
   agent: Type.Optional(Type.String({ description: "Target agent profile name." })),
   model: Type.Optional(Type.String({ description: "Model identifier override for child session." })),
   outputSchema: Type.Optional(Type.Unknown({ description: "RAW JSON Schema document." })),
   schemaMode: Type.Optional(
      Type.Union([Type.Literal("strict"), Type.Literal("permissive")], { default: "permissive" })
   ),
   async: Type.Optional(
      Type.Boolean({ default: true, description: "True runs background job; false blocks parent until settled." })
   )
});

export const TaskToolParamsSchema = Type.Union([
   Type.Object({
      context: Type.Optional(Type.String({ description: "Shared background context prepended to all task prompts." })),
      tasks: Type.Array(TaskSpecSchema, { minItems: 1, maxItems: 4 })
   }),
   TaskSpecSchema
]);

export type TaskToolParams = Static<typeof TaskToolParamsSchema>;

export const taskToolDefinition = {
   name: "task",
   description: "Spawn subagent worker jobs.",
   parameters: TaskToolParamsSchema
};

export interface HandleTaskOptions {
   ownerSessionId?: string;
   timeoutMs?: number;
}

export const handleTask = Effect.fn("task.handleTask")(function* (params: TaskToolParams, options?: HandleTaskOptions) {
   const taskManager = yield* TaskManager;
   const registry = yield* JobRegistry;

   const rawSpecs = normalizeTaskSpecs(params);
   const contextStr = (params as any)?.context;
   const prependedSpecs = prependContext(rawSpecs, contextStr);

   const jobs = yield* taskManager.spawnBatch(prependedSpecs, {
      ownerSessionId: options?.ownerSessionId
   });

   const syncJobs: string[] = [];
   for (let i = 0; i < prependedSpecs.length; i++) {
      const spec = prependedSpecs[i];
      const job = jobs[i];
      if (spec.async === false) {
         syncJobs.push(job.id);
      }
   }

   let syncSettled = true;
   if (syncJobs.length > 0) {
      const settledList = yield* registry.awaitSettlement(syncJobs, options?.timeoutMs);
      syncSettled =
         settledList.length === syncJobs.length &&
         settledList.every((j) => j.status !== "running" && j.status !== "pending");
   }

   const batchId = `batch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
   const jobSummaries = [];

   for (let i = 0; i < jobs.length; i++) {
      const origJob = jobs[i];
      const spec = prependedSpecs[i];
      const latest = yield* registry.get(origJob.id);
      const j = latest ?? origJob;

      jobSummaries.push({
         id: j.id,
         name: j.name ?? null,
         agent: j.agent ?? "task",
         status: j.status,
         async: spec.async !== false,
         result: j.resultData ?? null,
         errorText: j.errorText ?? null,
         schemaWarning: j.schemaWarning ?? null
      });
   }

   const isFlat = !Array.isArray((params as any)?.tasks);
   const response: Record<string, any> = {
      ok: true,
      batchId,
      count: jobs.length,
      jobs: jobSummaries,
      syncSettled,
      timedOut: false,
      aborted: false
   };

   if (isFlat && jobs.length > 0) {
      response.id = jobs[0].id;
   }

   return response;
});
