import type { TranscriptEntry, WorkflowDetails } from "./model.ts";
import { safeStringify, truncateUtf8, writeFileAtomic } from "../shared/serialization.ts";
import * as path from "node:path";

const ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES = 8 * 1024;
export const WORKFLOW_CHECKPOINT_INTERVAL_MS = 500;
const ENTRY_TRUNCATION_MARKER = "\n[entry truncated]";

function textBytes(text: string) {
   return Buffer.byteLength(text, "utf8");
}

function boundEntry(entry: TranscriptEntry, maxBytes: number) {
   if (textBytes(entry.text) <= maxBytes) return { ...entry };
   const markerBytes = textBytes(ENTRY_TRUNCATION_MARKER);
   const text =
      maxBytes > markerBytes
         ? `${truncateUtf8(entry.text, maxBytes - markerBytes)}${ENTRY_TRUNCATION_MARKER}`
         : truncateUtf8(ENTRY_TRUNCATION_MARKER, maxBytes);
   return { ...entry, text };
}

/** Keep the full transcript while bounding any single oversized entry. */
export function boundedArtifactTranscript(transcript: TranscriptEntry[], options: { entryMaxBytes?: number } = {}) {
   if (transcript.length === 0) return [];
   const entryMaxBytes = Math.max(64, options.entryMaxBytes ?? ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES);
   return transcript.map((entry) => boundEntry(entry, entryMaxBytes));
}

function writeRunFile(runDir: string, name: string, content: string) {
   writeFileAtomic(path.join(runDir, name), content);
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
         agent.state !== "running"
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
   const transcripts = Object.fromEntries(
      details.agents.map((agent) => [agent.index, boundedArtifactTranscript(agent.transcript)])
   );
   writeRunFile(runDir, "transcripts.json", safeStringify(transcripts, { maxBytes: 2 * 1024 * 1024 }));
   if (details.result !== undefined) {
      writeRunFile(runDir, "result.json", safeStringify(details.result, { maxBytes: 1024 * 1024 }));
   }
   const compact: WorkflowDetails = {
      ...details,
      ...(details.result !== undefined ? { result: "[stored in result.json]", resultArtifact: "result.json" } : {}),
      transcriptArtifact: "transcripts.json",
      agents: details.agents.map((agent) => ({ ...agent, transcript: [] }))
   };
   writeRunFile(runDir, "workflow.json", safeStringify(compact, { maxBytes: 1024 * 1024 }));
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
