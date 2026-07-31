import path from "path";
import type { ReferenceInfo } from "./types.js";
import { reportWarning } from "./status.js";

// ─── Cross-extension service accessor ─────────────────────────────
// Mirrors pi-permission-system's getPermissionsService() but without
// importing the package (graceful degradation if not installed).

const SERVICE_KEY = Symbol.for("@nielpattin/pi-permission-system:service");

interface PermissionsServiceLike {
   approveSessionRule?(surface: string, pattern: string): void;
}

function getPermissionsService(): PermissionsServiceLike | undefined {
   return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as PermissionsServiceLike | undefined;
}

// ─── Path normalization ───────────────────────────────────────────
// Mirror pi-permission-system's normalizePathForComparison: resolve to
// absolute, slashify, lowercase on Windows.

export function normalizeForPermission(rawPath: string, cwd: string): string {
   const abs = path.resolve(cwd, rawPath);
   let normalized = abs.replace(/\\/g, "/");
   if (process.platform === "win32") normalized = normalized.toLowerCase();
   if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
   return normalized;
}

// ─── Auto-allow reference directories ─────────────────────────────

/**
 * Register session-scoped allow rules for reference directories on the
 * external_directory surface. This lets the agent read/grep/find/ls files
 * in reference dirs without per-access permission prompts.
 *
 * Gracefully no-ops if pi-permission-system is not loaded.
 */
export function allowReferenceDirs(references: ReferenceInfo[], cwd: string): void {
   const svc = getPermissionsService();
   if (!svc?.approveSessionRule) {
      reportWarning("pi-permission-system not loaded; reference dirs will prompt on first access");
      return;
   }

   for (const ref of references) {
      const normalized = normalizeForPermission(ref.path, cwd);
      svc.approveSessionRule("external_directory", `${normalized}/*`);
   }
}
