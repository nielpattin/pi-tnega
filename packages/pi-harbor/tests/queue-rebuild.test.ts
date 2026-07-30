import { describe, it, expect } from "vitest";

function rebuildQueuesAfterPop(steering: string[], followUp: string[]) {
   if (steering.length > 0) {
      const popped = steering[0];
      const remainingSteer = steering.slice(1);
      return {
         popped,
         type: "steer" as const,
         remainingSteering: remainingSteer,
         remainingFollowUp: followUp
      };
   }
   if (followUp.length > 0) {
      const popped = followUp[0];
      const remainingFollowUp = followUp.slice(1);
      return {
         popped,
         type: "followUp" as const,
         remainingSteering: steering,
         remainingFollowUp
      };
   }
   return null;
}

function popLastQueued(steering: string[], followUp: string[]) {
   if (followUp.length > 0) {
      const popped = followUp[followUp.length - 1];
      const remainingFollowUp = followUp.slice(0, -1);
      return {
         popped,
         remainingSteering: steering,
         remainingFollowUp
      };
   }
   if (steering.length > 0) {
      const popped = steering[steering.length - 1];
      const remainingSteering = steering.slice(0, -1);
      return {
         popped,
         remainingSteering,
         remainingFollowUp: followUp
      };
   }
   return null;
}

describe("Queue Rebuild & Pop Logic", () => {
   it("rebuildQueuesAfterPop prefers last steer then last follow-up", () => {
      const steering = ["steer-1", "steer-2"];
      const followUp = ["follow-1"];

      const res1 = rebuildQueuesAfterPop(steering, followUp);
      expect(res1?.popped).toBe("steer-1");
      expect(res1?.type).toBe("steer");
      expect(res1?.remainingSteering).toEqual(["steer-2"]);
      expect(res1?.remainingFollowUp).toEqual(["follow-1"]);

      const res2 = rebuildQueuesAfterPop([], followUp);
      expect(res2?.popped).toBe("follow-1");
      expect(res2?.type).toBe("followUp");
      expect(res2?.remainingFollowUp).toEqual([]);
   });

   it("popLastQueued restores remaining queues correctly", () => {
      const steering = ["steer-1"];
      const followUp = ["follow-1", "follow-2"];

      const res = popLastQueued(steering, followUp);
      expect(res?.popped).toBe("follow-2");
      expect(res?.remainingSteering).toEqual(["steer-1"]);
      expect(res?.remainingFollowUp).toEqual(["follow-1"]);
   });
});
