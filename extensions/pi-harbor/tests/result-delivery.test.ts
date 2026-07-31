import { describe, it, expect } from "vitest";
import { createDeferredResultDelivery } from "../src/services/ResultDelivery.js";
import type { Job } from "../src/domain.js";

describe("DeferredResultDelivery", () => {
   it("suppresses result message when waitInterest > 0 or killInterest > 0", () => {
      const delivery = createDeferredResultDelivery();

      const jobWithWait: Job = {
         id: "task-1",
         ownerSessionId: "session-1",
         name: "Wait Job",
         kind: "agent",
         promptOrCommand: "prompt",
         status: "completed",
         createdAt: Date.now(),
         waitInterest: 1,
         killInterest: 0
      };

      const jobWithKill: Job = {
         id: "task-2",
         ownerSessionId: "session-1",
         name: "Kill Job",
         kind: "agent",
         promptOrCommand: "prompt",
         status: "cancelled",
         createdAt: Date.now(),
         waitInterest: 0,
         killInterest: 1
      };

      const normalJob: Job = {
         id: "task-3",
         ownerSessionId: "session-1",
         name: "Normal Job",
         kind: "agent",
         promptOrCommand: "prompt",
         status: "completed",
         createdAt: Date.now(),
         waitInterest: 0,
         killInterest: 0
      };

      expect(delivery.shouldSuppress(jobWithWait)).toBe(true);
      expect(delivery.shouldSuppress(jobWithKill)).toBe(true);
      expect(delivery.shouldSuppress(normalJob)).toBe(false);
   });

   it("defers, consumes, and drains pending results on idle", () => {
      const delivery = createDeferredResultDelivery();

      const job1: Job = {
         id: "task-1",
         ownerSessionId: "session-1",
         name: "Job 1",
         kind: "agent",
         promptOrCommand: "prompt",
         status: "completed",
         createdAt: Date.now(),
         waitInterest: 1,
         killInterest: 0
      };

      const job2: Job = {
         id: "task-2",
         ownerSessionId: "session-1",
         name: "Job 2",
         kind: "agent",
         promptOrCommand: "prompt",
         status: "completed",
         createdAt: Date.now(),
         waitInterest: 1,
         killInterest: 0
      };

      delivery.defer(job1);
      delivery.defer(job2);
      expect(delivery.size).toBe(2);

      // Consume job1 (e.g. delivered via wait tool)
      delivery.consume(["task-1"]);
      expect(delivery.size).toBe(1);

      // Drain remaining on idle
      const flushed = delivery.drain();
      expect(flushed).toHaveLength(1);
      expect(flushed[0].id).toBe("task-2");
      expect(delivery.size).toBe(0);
   });
});
