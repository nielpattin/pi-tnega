/**
 * /btw side-task command implementation and pure helpers.
 */

import { Effect } from "effect";
import type { TaskSpec } from "../domain.js";
import type { TaskManagerShape } from "../services/TaskManager.js";

export function canSpawnBtw(activeBtwCount: number): boolean {
   return activeBtwCount < 1;
}

export function buildBtwJobFields(prompt: string, parentModel?: string): TaskSpec & { origin: "btw" } {
   return {
      task: prompt,
      agent: "task",
      model: parentModel,
      name: "btw",
      origin: "btw"
   };
}

export function formatBtwResultEntry(job: {
   id: string;
   status: string;
   promptOrCommand?: string;
   resultData?: unknown;
   errorText?: string;
}) {
   const resultValue =
      job.resultData !== null && typeof job.resultData === "object" && "data" in job.resultData
         ? (job.resultData as { data?: unknown }).data
         : job.resultData;
   const resultText =
      typeof resultValue === "string"
         ? resultValue
         : resultValue === undefined
           ? (job.errorText ?? "")
           : JSON.stringify(resultValue);
   return {
      customType: "btw-result",
      data: {
         jobId: job.id,
         status: job.status,
         prompt: job.promptOrCommand ?? "",
         text: resultText
      }
   };
}

export interface HandleBtwParams {
   prompt: string;
   parentModel?: string;
   parentSessionFile?: string;
   activeBtwCount: number;
   taskManager: TaskManagerShape;
}

export async function handleBtwCommand(
   params: HandleBtwParams
): Promise<{ ok: boolean; message?: string; jobId?: string }> {
   if (!canSpawnBtw(params.activeBtwCount)) {
      return {
         ok: false,
         message: "Maximum 1 concurrent /btw side-task allowed."
      };
   }

   const fields = buildBtwJobFields(params.prompt, params.parentModel);
   const { origin: _origin, ...spec } = fields;

   const jobEffect = params.taskManager.spawnTask(spec, {
      origin: "btw",
      skipAgentSlot: true,
      parentSessionFile: params.parentSessionFile
   });

   try {
      const job = await Effect.runPromise(jobEffect);
      return {
         ok: true,
         jobId: job.id
      };
   } catch (err: any) {
      return {
         ok: false,
         message: err?.message ?? "Failed to spawn /btw task"
      };
   }
}
