import { posix, win32 } from "node:path";

import type { Ruleset } from "./rule";

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WIN_UNC_RE = /^\\\\/;

function slashifyPath(p: string): string {
   return p.replace(/\\/g, "/");
}

/**
 * Resolve a tool path to an absolute, slashified, case-preserving form.
 *
 * Mirrors `normalizePathForComparison`'s cross-platform branching (Windows vs
 * posix) so resolution is identical, but intentionally preserves character
 * case — the result is used for the human-readable dialog label, and stored
 * patterns are re-normalized (and lowercased on Windows) by `evaluate()` at
 * match time, so case preservation here does not affect matching.
 */
function resolveAbsolutePath(path: string, cwd: string): string {
   const slashCwd = slashifyPath(cwd);
   const slashPath = slashifyPath(path);
   const isWindows = WIN_DRIVE_RE.test(slashCwd) || WIN_DRIVE_RE.test(slashPath) || WIN_UNC_RE.test(slashPath);
   if (isWindows) {
      const isAbs = WIN_DRIVE_RE.test(slashPath) || WIN_UNC_RE.test(slashPath);
      const abs = isAbs ? win32.normalize(slashPath) : win32.resolve(slashCwd, slashPath);
      return slashifyPath(abs);
   }
   return slashPath.startsWith("/") ? posix.normalize(slashPath) : posix.resolve(slashCwd, slashPath);
}

/**
 * Ephemeral in-memory store of session-scoped permission approvals.
 *
 * Each approval is stored as a `Rule` with `action: "allow"`, making the
 * ruleset directly usable with `evaluate()` — no custom matching engine needed.
 *
 * Cleared on session_shutdown — never persisted to disk.
 */
export class SessionRules {
   private rules: Ruleset = [];

   /** Record a wildcard pattern as approved for the given surface. */
   approve(surface: string, pattern: string): void {
      this.rules.push({
         surface,
         pattern,
         action: "allow",
         layer: "session",
         origin: "session"
      });
   }

   /** Return a defensive copy of the current session ruleset. */
   getRuleset(): Ruleset {
      return [...this.rules];
   }

   /** Remove all session approvals. */
   clear(): void {
      this.rules = [];
   }
}

/**
 * Derive the wildcard glob pattern to approve from a tool path.
 *
 * The path is first normalized to an absolute, canonical form (resolved against
 * `cwd`) so that the stored pattern — and the dialog label — read as an absolute
 * directory glob (e.g. `C:/Users/.../proj/*`) rather than a bare relative `./*`.
 * Evaluation re-normalizes both sides, and absolute paths ignore cwd, so this is
 * consistent with `evaluate()` / `wildcardMatch()` regardless of the stored form.
 *
 * Returns `<parent-dir>/*` so that all paths under the approved directory match.
 * For paths that already end with a separator (directories), the separator is
 * treated as the directory boundary and `*` is appended directly.
 */
export function deriveApprovalPattern(path: string, cwd?: string): string {
   const effectiveCwd = cwd || process.cwd();
   // Detect a trailing separator before resolving — resolve/normalize strip it,
   // which would lose the "this is a directory" signal.
   const isDirectory = /[\\/]$/.test(path);
   const absolute = resolveAbsolutePath(path, effectiveCwd);
   if (isDirectory) {
      const dir = absolute.endsWith("/") ? absolute : `${absolute}/`;
      return `${dir}*`;
   }
   const dir = posix.dirname(absolute);
   if (dir === absolute) {
      // Root path, where dirname("/") === "/".
      return `${dir}*`;
   }
   const prefix = dir.endsWith("/") ? dir : `${dir}/`;
   return `${prefix}*`;
}
