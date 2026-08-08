/**
 * /btw side-worker command implementation and pure helpers.
 */

import { Effect } from "effect";
import type { WorkerSpec } from "../domain.js";
import type { WorkerManagerShape } from "../services/WorkerManager.js";

export function canSpawnBtw(activeBtwCount: number): boolean {
   return activeBtwCount < 1;
}

export function buildBtwJobFields(prompt: string): WorkerSpec & { origin: "btw" } {
   return {
      worker: prompt,
      agent: "worker",
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
   parentSessionFile?: string;
   activeBtwCount: number;
   workerManager: WorkerManagerShape;
}

export async function handleBtwCommand(
   params: HandleBtwParams
): Promise<{ ok: boolean; message?: string; jobId?: string }> {
   if (!canSpawnBtw(params.activeBtwCount)) {
      return {
         ok: false,
         message: "Maximum 1 concurrent /btw side-worker allowed."
      };
   }

   const fields = buildBtwJobFields(params.prompt);
   const { origin: _origin, ...spec } = fields;

   const jobEffect = params.workerManager.spawnWorker(spec, {
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
         message: err?.message ?? "Failed to spawn /btw worker"
      };
   }
}
