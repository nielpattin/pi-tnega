import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toRecord } from "./common";

export const EXTENSION_ID = "pi-permission-system";

export type PermissionMode = "default" | "auto" | "yolo";

export interface PermissionSystemExtensionConfig {
   debugLog: boolean;
   permissionReviewLog: boolean;
   permissionMode: PermissionMode;
   /** Legacy/deprecated flag preserved for backwards compatibility. */
   yoloMode?: boolean;
   /** Additional directories to auto-allow for reads as Pi infrastructure. */
   piInfrastructureReadPaths?: string[];
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
   debugLog: false,
   permissionReviewLog: true,
   permissionMode: "default",
   yoloMode: false
};

function resolveExtensionRoot(moduleUrl = import.meta.url): string {
   return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();

const PERMISSION_POLICY_KEYS: ReadonlySet<string> = new Set([
   "defaultPolicy",
   "tools",
   "bash",
   "mcp",
   "skills",
   "special",
   "external_directory"
]);

export function detectMisplacedPermissionKeys(raw: Record<string, unknown>): string[] {
   return Object.keys(raw).filter((key) => PERMISSION_POLICY_KEYS.has(key));
}

export function normalizePermissionSystemConfig(raw: unknown): PermissionSystemExtensionConfig {
   const record = toRecord(raw);
   const rawPaths = record.piInfrastructureReadPaths;
   const piInfrastructureReadPaths: string[] | undefined =
      Array.isArray(rawPaths) && rawPaths.every((p): p is string => typeof p === "string") ? rawPaths : undefined;

   let mode: PermissionMode = "default";
   if (record.permissionMode === "default" || record.permissionMode === "auto" || record.permissionMode === "yolo") {
      mode = record.permissionMode;
   } else if (record.yoloMode === true) {
      mode = "yolo";
   }

   const result: PermissionSystemExtensionConfig = {
      debugLog: record.debugLog === true,
      permissionReviewLog: record.permissionReviewLog !== false,
      permissionMode: mode,
      yoloMode: mode === "yolo"
   };
   if (piInfrastructureReadPaths !== undefined) {
      result.piInfrastructureReadPaths = piInfrastructureReadPaths;
   }
   return result;
}

export function ensurePermissionSystemLogsDirectory(logsDir: string): string | undefined {
   try {
      mkdirSync(logsDir, { recursive: true });
      return undefined;
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to create permission-system log directory '${logsDir}': ${message}`;
   }
}
