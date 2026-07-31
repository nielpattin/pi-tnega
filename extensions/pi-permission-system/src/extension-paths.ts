import { posix } from "node:path";
import { getGlobalLogsDir } from "./config-paths";
import { discoverGlobalNodeModulesRoot } from "./node-modules-discovery";
import { normalizePathForComparison } from "./path-utils";

/**
 * Immutable path constants derived from `agentDir` at construction time.
 *
 * Computed once at startup in `computeExtensionPaths()` and embedded into
 * `ExtensionRuntime`. Later refactorings (#129 PermissionSession, #130
 * handler classes) consume this as a single dep instead of individual fields.
 */
export interface ExtensionPaths {
   readonly agentDir: string;
   readonly sessionsDir: string;
   readonly subagentSessionsDir: string;
   readonly forwardingDir: string;
   readonly globalLogsDir: string;
   /**
    * Static Pi infrastructure directories used for external-directory
    * read auto-allow. Computed once from `agentDir` and
    * `discoverGlobalNodeModulesRoot()`. Config-based extras
    * (`piInfrastructureReadPaths`) are read from `runtime.config` at
    * call time in the handler so they pick up config reloads.
    */
   readonly piInfrastructureDirs: readonly string[];
}

/**
 * Compute all immutable path constants from `agentDir`.
 *
 * Calls `discoverGlobalNodeModulesRoot()` internally so the result is
 * self-contained. Call this once at extension startup, not at module scope.
 */
export function computeExtensionPaths(agentDir: string): ExtensionPaths {
   const normalizedAgentDir = normalizePathForComparison(agentDir, agentDir);
   const sessionsDir = posix.join(normalizedAgentDir, "sessions");
   const subagentSessionsDir = posix.join(normalizedAgentDir, "subagent-sessions");
   const forwardingDir = posix.join(sessionsDir, "permission-forwarding");
   const globalLogsDir = getGlobalLogsDir(normalizedAgentDir);

   const globalNodeModulesRoot = discoverGlobalNodeModulesRoot();
   const piInfrastructureDirs: string[] = [
      normalizedAgentDir,
      posix.join(normalizedAgentDir, "git"),
      ...(globalNodeModulesRoot ? [globalNodeModulesRoot] : [])
   ];

   return {
      agentDir: normalizedAgentDir,
      sessionsDir,
      subagentSessionsDir,
      forwardingDir,
      globalLogsDir,
      piInfrastructureDirs
   };
}
