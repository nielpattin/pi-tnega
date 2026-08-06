import type { Job } from "../domain.js";

export function createDeferredResultDelivery() {
   const pending = new Map<string, Job>();

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
