import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SUBAGENT_ENV_HINT_KEYS } from "./permission-forwarding";
import { normalizePathForComparison } from "./path-utils";
import type { SubagentSessionRegistry } from "./subagent-registry";

export function normalizeFilesystemPath(pathValue: string): string {
   return normalizePathForComparison(pathValue, pathValue);
}

function isPathWithinDirectoryForSubagent(pathValue: string, directory: string): boolean {
   if (!pathValue || !directory) {
      return false;
   }

   if (pathValue === directory) {
      return true;
   }

   const prefix = directory.endsWith("/") ? directory : `${directory}/`;
   return pathValue.startsWith(prefix);
}

export function isSubagentExecutionContext(
   ctx: ExtensionContext,
   subagentSessionsDir: string,
   registry?: SubagentSessionRegistry
): boolean {
   const sessionDir = ctx.sessionManager.getSessionDir();

   // 1. Explicit registry — in-process subagent extensions register before
   //    bindExtensions(); checked first so it takes priority over heuristics.
   if (registry && sessionDir && registry.has(sessionDir)) {
      return true;
   }

   // 2. Env vars — process-based subagent extensions (nicobailon/pi-subagents,
   //    HazAT/pi-interactive-subagents, pi-agent-router, etc.).
   for (const key of SUBAGENT_ENV_HINT_KEYS) {
      const value = process.env[key];
      if (typeof value === "string" && value.trim()) {
         return true;
      }
   }

   // 3. Filesystem path — fallback heuristic for extensions that store sessions
   //    under a known subagent root directory.
   if (!sessionDir) {
      return false;
   }

   const normalizedSessionDir = normalizeFilesystemPath(sessionDir);
   const normalizedSubagentRoot = normalizeFilesystemPath(subagentSessionsDir);
   return isPathWithinDirectoryForSubagent(normalizedSessionDir, normalizedSubagentRoot);
}
