import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";

/** Details about one filesystem deletion failure. */
export interface DeleteFailure {
   /** Path that could not be removed. */
   readonly path: string;
   /** Node filesystem error code, or UNKNOWN when unavailable. */
   readonly code: string;
   /** Original filesystem error message. */
   readonly message: string;
}

/** Result of removing Cortex index files. */
export interface DeleteFilesResult {
   /** Number of files removed by this operation. */
   readonly deleted: number;
   /** Number of existing files that could not be removed. */
   readonly failed: number;
   /** Filesystem errors for files that remain. */
   readonly failures: readonly DeleteFailure[];
}

const DELETE_ATTEMPTS = 4;
const DELETE_RETRY_DELAY_MS = 200;

function describeDeleteError(error: unknown): Pick<DeleteFailure, "code" | "message"> {
   const message = error instanceof Error ? error.message : String(error);
   const code =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
         ? error.code
         : "UNKNOWN";
   return { code, message };
}

/**
 * Remove existing files and report only actual deletions.
 *
 * @param paths - Index database and sidecar files to remove.
 * @returns Counts and filesystem errors for files that could not be removed.
 */
export async function deleteExistingFiles(paths: readonly string[]): Promise<DeleteFilesResult> {
   let deleted = 0;
   let failed = 0;
   const failures: DeleteFailure[] = [];

   for (const path of paths) {
      let removed = false;
      let lastFailure: DeleteFailure | undefined;
      for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
         if (!existsSync(path)) {
            removed = true;
            break;
         }
         try {
            rmSync(path);
            deleted++;
            removed = true;
            break;
         } catch (error) {
            lastFailure = { path, ...describeDeleteError(error) };
            if (attempt < DELETE_ATTEMPTS - 1) {
               // oxlint-disable-next-line eslint/no-await-in-loop -- retries the same failed file sequentially
               await new Promise((resolve) => setTimeout(resolve, DELETE_RETRY_DELAY_MS));
            }
         }
      }
      if (!removed && existsSync(path)) {
         failed++;
         failures.push(lastFailure ?? { path, code: "UNKNOWN", message: "Deletion failed without an error" });
      }
   }

   return { deleted, failed, failures };
}

/** Result of removing grouped Cortex index artifacts. */
export interface DeleteIndexesResult {
   /** Number of distinct indexes found. */
   readonly found: number;
   /** Number of indexes with at least one artifact removed. */
   readonly deleted: number;
   /** Number of indexes with at least one artifact that could not be removed. */
   readonly failed: number;
   /** Filesystem errors for artifacts that could not be removed. */
   readonly failures: readonly DeleteFailure[];
}

const INDEX_ARTIFACT_SUFFIXES = ["-wal", "-shm", "-journal", ".lock", ""] as const;

/**
 * Delete database files while counting a database and its sidecars as one index.
 *
 * @param paths - Candidate files found under the sessions directory.
 * @returns Counts of distinct indexes found, changed, and still present.
 */
export async function deleteIndexArtifacts(paths: readonly string[]): Promise<DeleteIndexesResult> {
   const groups = new Map<string, string[]>();

   for (const path of paths) {
      const name = basename(path);
      const suffix = INDEX_ARTIFACT_SUFFIXES.find((candidate) => name === `pi-cortex.db${candidate}`);
      if (suffix === undefined) continue;
      const dbPath = suffix ? path.slice(0, -suffix.length) : path;
      const artifacts = groups.get(dbPath);
      if (artifacts) artifacts.push(path);
      else groups.set(dbPath, [path]);
   }

   let deleted = 0;
   let failed = 0;
   const failures: DeleteFailure[] = [];
   for (const artifacts of groups.values()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- retrying each index group keeps its artifacts together
      const result = await deleteExistingFiles(artifacts);
      if (result.deleted > 0) deleted++;
      if (result.failed > 0) failed++;
      failures.push(...result.failures);
   }

   return { found: groups.size, deleted, failed, failures };
}
