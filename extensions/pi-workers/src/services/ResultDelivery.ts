import type { Job } from "../domain.js";

function isBatchJob(job: Job): job is Job & { readonly batchId: string; readonly batchSize: number } {
   return (
      typeof job.batchId === "string" &&
      job.batchId.length > 0 &&
      typeof job.batchSize === "number" &&
      Number.isInteger(job.batchSize) &&
      job.batchSize > 1
   );
}

export function createDeferredResultDelivery() {
   const pending = new Map<string, Job>();

   const pendingGroups = (): Job[][] => {
      const singles: Job[][] = [];
      const batches = new Map<string, Job[]>();

      for (const job of pending.values()) {
         if (!isBatchJob(job)) {
            singles.push([job]);
            continue;
         }

         const jobs = batches.get(job.batchId);
         if (jobs) {
            jobs.push(job);
         } else {
            batches.set(job.batchId, [job]);
         }
      }

      const completeBatches = Array.from(batches.values()).filter((jobs) => {
         const expected = jobs[0]?.batchSize;
         return expected !== undefined && jobs.length >= expected;
      });

      return [...singles, ...completeBatches];
   };

   return {
      shouldSuppress(job: Job): boolean {
         return job.waitInterest > 0 || job.killInterest > 0;
      },
      defer(job: Job): void {
         pending.set(job.id, job);
      },
      consume(ids: Iterable<string>): void {
         for (const id of ids) {
            pending.delete(id);
         }
      },
      pending(): Job[] {
         return Array.from(pending.values());
      },
      pendingGroups,
      drain(): Job[] {
         const results = Array.from(pending.values());
         pending.clear();
         return results;
      },
      clear(): void {
         pending.clear();
      },
      get size(): number {
         return pending.size;
      }
   };
}

export type DeferredResultDelivery = ReturnType<typeof createDeferredResultDelivery>;
