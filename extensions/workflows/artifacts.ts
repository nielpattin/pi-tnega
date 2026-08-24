import type { WorkflowDetails } from "./model.ts";
import { safeStringify, writeFileAtomic } from "../shared/serialization.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export const WORKFLOW_CHECKPOINT_INTERVAL_MS = 500;

function writeRunFile(runDir: string, name: string, content: string) {
   writeFileAtomic(path.join(runDir, name), content);
}

type CompactAgent = Omit<WorkflowDetails["agents"][number], "transcript" | "preview"> & {
   /** The Summary has no child session file, so its transcript must remain durable here. */
   transcript?: WorkflowDetails["agents"][number]["transcript"];
};

type CompactWorkflowDetails = Omit<WorkflowDetails, "agents"> & {
   agents: CompactAgent[];
};

/** Remove child transcript payloads from workflow metadata while retaining the final Summary transcript. */
export function compactWorkflowDetails(details: WorkflowDetails): CompactWorkflowDetails {
   const { agents, ...metadata } = details;
   return {
      ...metadata,
      agents: agents.map(({ transcript, preview: _preview, ...agent }) => {
         void _preview;
         return agent.phase === "Summary" ? { ...agent, transcript } : agent;
      })
   };
}

/**
 * Recover a persisted workflow that was running when its owner session ended.
 *
 * Recovery is observational. It records the interrupted state and never
 * restarts provider work automatically.
 *
 * @param details - Persisted workflow details.
 * @param recoveredAt - Timestamp used for deterministic recovery and tests.
 * @returns Recovered details, or the original terminal details unchanged.
 */
export function recoverWorkflowDetails(details: WorkflowDetails, recoveredAt = Date.now()): WorkflowDetails {
   if (details.status !== "running") return details;
   const finishedAt = details.finishedAt ?? recoveredAt;
   return {
      ...details,
      status: "aborted",
      finishedAt,
      error: details.error ?? "Recovered stale workflow that was not active",
      agents: details.agents.map((agent) =>
         agent.state !== "running" && agent.state !== "waiting"
            ? agent
            : {
                 ...agent,
                 state: "error",
                 error: agent.error ?? "Run ended before this agent settled",
                 finishedAt: agent.finishedAt ?? finishedAt
              }
      )
   };
}

export function persistWorkflowJson(runDir: string, details: WorkflowDetails) {
   fs.rmSync(path.join(runDir, "transcripts.json"), { force: true });
   fs.rmSync(path.join(runDir, "result.json"), { force: true });
   writeRunFile(
      runDir,
      "workflow.json",
      safeStringify(compactWorkflowDetails(details), {
         maxBytes: 1024 * 1024,
         maxStringBytes: 1024 * 1024
      })
   );
}

/** Coalesce live checkpoints while keeping final persistence synchronous. */
export function createWorkflowPersistence(
   runDir: string,
   details: WorkflowDetails,
   options: {
      intervalMs?: number;
      persist?: (runDir: string, details: WorkflowDetails) => void;
   } = {}
) {
   const intervalMs = Math.max(0, options.intervalMs ?? WORKFLOW_CHECKPOINT_INTERVAL_MS);
   const persist = options.persist ?? persistWorkflowJson;
   let lastPersistedAt = Date.now();
   let dirty = false;
   let timer: ReturnType<typeof setTimeout> | undefined;

   const savePending = () => {
      timer = undefined;
      if (!dirty) return;
      try {
         persist(runDir, details);
         dirty = false;
         lastPersistedAt = Date.now();
      } catch {
         // Final flush retries and reports persistence failures synchronously.
      }
   };

   return {
      checkpoint(checkpointOptions: { immediate?: boolean } = {}) {
         dirty = true;
         if (checkpointOptions.immediate) {
            if (timer) clearTimeout(timer);
            timer = undefined;
            savePending();
            return;
         }
         if (timer) return;
         const delay = Math.max(0, intervalMs - (Date.now() - lastPersistedAt));
         if (delay === 0) {
            savePending();
            return;
         }
         timer = setTimeout(savePending, delay);
      },
      flush() {
         if (timer) clearTimeout(timer);
         timer = undefined;
         persist(runDir, details);
         dirty = false;
         lastPersistedAt = Date.now();
      }
   };
}
