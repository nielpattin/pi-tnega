import { posix } from "node:path";

import { normalizePathForComparison } from "./path-utils";

const EXTENSION_ID = "pi-permission-system";

function joinConfigPath(base: string, ...segments: string[]): string {
   return posix.join(normalizePathForComparison(base, base), ...segments);
}

export const DEBUG_LOG_FILENAME = `${EXTENSION_ID}-debug.jsonl`;
export const REVIEW_LOG_FILENAME = `${EXTENSION_ID}-permission-review.jsonl`;

export function getGlobalConfigDir(agentDir: string): string {
   return joinConfigPath(agentDir, "extensions", EXTENSION_ID);
}

export function getGlobalConfigPath(agentDir: string): string {
   return joinConfigPath(agentDir, "permission.jsonc");
}

export function getGlobalLogsDir(agentDir: string): string {
   return joinConfigPath(getGlobalConfigDir(agentDir), "logs");
}

export function getProjectConfigPath(cwd: string): string {
   return joinConfigPath(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

export function getLegacyGlobalPolicyPath(agentDir: string): string {
   return joinConfigPath(agentDir, "pi-permissions.jsonc");
}

export function getLegacyProjectPolicyPath(cwd: string): string {
   return joinConfigPath(cwd, ".pi", "agent", "pi-permissions.jsonc");
}

export function getLegacyExtensionConfigPath(extensionRoot: string): string {
   return joinConfigPath(extensionRoot, "config.json");
}
