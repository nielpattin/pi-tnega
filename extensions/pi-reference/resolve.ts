import { existsSync } from "fs";
import type { Source, ReferenceInfo } from "./types.js";
import { readReferences } from "./config.js";
import { computeRepoPath, syncGitRepos, type GitSyncTask } from "./git-cache.js";

/**
 * Resolve all references for the given cwd.
 * Reads settings, parses entries, and creates ReferenceInfo objects.
 * For git references, the cache path is available immediately;
 * the clone/fetch happens asynchronously (fire-and-forget).
 */
export async function resolveReferences(cwd: string): Promise<ReferenceInfo[]> {
   const sources = await readReferences(cwd);
   const infos: ReferenceInfo[] = [];
   const gitRepos: GitSyncTask[] = [];

   for (const [alias, source] of sources) {
      const info = resolveOne(alias, source);
      if (!info) continue;

      infos.push(info);

      // Collect git repos for batch sync
      if (source.type === "git") {
         gitRepos.push({ repository: source.repository, branch: source.branch });
      }
   }

   // Batch-sync all git repos through a serial queue with progress tracking.
   // Fire-and-forget: returns immediately, sync happens in background.
   if (gitRepos.length > 0) {
      syncGitRepos(gitRepos);
   }

   return infos;
}

function resolveOne(name: string, source: Source): ReferenceInfo | null {
   if (source.type === "local") {
      return {
         name,
         path: source.path,
         description: source.description,
         hidden: source.hidden,
         source
      };
   }

   // Git: compute cache path immediately (synchronous, no git operation)
   const cachePath = computeRepoPath(source.repository);
   if (!cachePath) return null;

   return {
      name,
      path: cachePath,
      description: source.description,
      hidden: source.hidden,
      source
   };
}

/** Check if a reference path exists on disk. */
export function referenceExists(info: ReferenceInfo): boolean {
   return existsSync(info.path);
}
