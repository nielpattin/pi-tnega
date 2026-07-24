import { posix, win32 } from "node:path";

import { getNonEmptyString, toRecord } from "./common";
import { expandHomePath } from "./expand-home";
import { wildcardMatch } from "./wildcard-matcher";

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:(?:[\\/]|$)/;
const WINDOWS_UNC_PATH = /^\\\\/;

function slashify(pathValue: string): string {
   return pathValue.replace(/\\/g, "/");
}

function usesWindowsPath(pathValue: string): boolean {
   return WINDOWS_DRIVE_PATH.test(pathValue) || WINDOWS_UNC_PATH.test(pathValue);
}

function stripTrailingSlash(pathValue: string): string {
   if (pathValue === "/" || /^[a-zA-Z]:\/$/.test(pathValue)) {
      return pathValue;
   }
   return pathValue.replace(/\/+$/g, "");
}

function canonicalizePath(pathValue: string): string {
   const slashPath = stripTrailingSlash(slashify(pathValue));
   return usesWindowsPath(pathValue) ? slashPath.toLowerCase() : slashPath;
}

function expandHomePathForComparison(pathValue: string): string {
   return expandHomePath(pathValue);
}

export function normalizePathForComparison(pathValue: string, cwd: string): string {
   const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
   if (!trimmed) {
      return "";
   }

   let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
   normalizedPath = expandHomePathForComparison(normalizedPath);

   const slashPath = slashify(normalizedPath);
   if (SAFE_SYSTEM_PATHS.has(slashPath)) {
      return slashPath;
   }

   if (usesWindowsPath(normalizedPath) || usesWindowsPath(cwd)) {
      const absolutePath = WINDOWS_ABSOLUTE_PATH.test(normalizedPath)
         ? win32.normalize(normalizedPath)
         : win32.resolve(cwd, normalizedPath);
      return canonicalizePath(absolutePath);
   }

   const absolutePath = slashPath.startsWith("/")
      ? posix.normalize(slashPath)
      : posix.resolve(slashify(cwd), slashPath);
   return canonicalizePath(absolutePath);
}

export function isPathWithinDirectory(pathValue: string, directory: string): boolean {
   if (!pathValue || !directory) {
      return false;
   }

   if (pathValue === directory) {
      return true;
   }

   const comparablePath = canonicalizePath(pathValue);
   const comparableDirectory = canonicalizePath(directory);
   if (comparablePath === comparableDirectory) {
      return true;
   }

   const prefix = comparableDirectory.endsWith("/") ? comparableDirectory : `${comparableDirectory}/`;
   return comparablePath.startsWith(prefix);
}

/**
 * Paths that are universally safe and should never trigger external-directory checks.
 * These are OS device files: read returns EOF or process streams, write discards or goes to process streams.
 */
export const SAFE_SYSTEM_PATHS: ReadonlySet<string> = new Set([
   "/dev/null",
   "/dev/stdin",
   "/dev/stdout",
   "/dev/stderr"
]);

/**
 * Returns true if the given normalized path is a safe OS device file
 * that should never trigger external-directory checks.
 */
export function isSafeSystemPath(normalizedPath: string): boolean {
   return SAFE_SYSTEM_PATHS.has(normalizedPath);
}

/**
 * File tools that only read — never write — the filesystem.
 * Only these tools are eligible for the Pi infrastructure auto-allow.
 */
export const READ_ONLY_PATH_BEARING_TOOLS: ReadonlySet<string> = new Set(["read", "find", "grep", "ls"]);

export const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "find", "grep", "ls"]);

export function getPathBearingToolPath(toolName: string, input: unknown): string | null {
   if (!PATH_BEARING_TOOLS.has(toolName)) {
      return null;
   }

   return getNonEmptyString(toRecord(input).path);
}

export function isPathOutsideWorkingDirectory(pathValue: string, cwd: string): boolean {
   const normalizedCwd = normalizePathForComparison(cwd, cwd);
   const normalizedPath = normalizePathForComparison(pathValue, cwd);
   if (!normalizedCwd || !normalizedPath) {
      return false;
   }
   if (isSafeSystemPath(normalizedPath)) {
      return false;
   }
   return !isPathWithinDirectory(normalizedPath, normalizedCwd);
}

function containsGlobChars(value: string): boolean {
   return value.includes("*") || value.includes("?");
}

/**
 * Returns true if the given tool + normalized path combination qualifies for
 * automatic allow as a Pi infrastructure read.
 *
 * A path qualifies when:
 * 1. The tool is read-only (in READ_ONLY_PATH_BEARING_TOOLS).
 * 2. The normalized path is within one of the provided `infrastructureDirs`
 *    OR within the project-local Pi package directories
 *    (`<cwd>/.pi/npm/` or `<cwd>/.pi/git/`).
 *
 * `infrastructureDirs` entries may be absolute paths or patterns containing
 * `~`/`$HOME` (expanded at call time) or glob characters (`*`, `?`).
 * Project-local paths are computed fresh from `cwd` on each call so they
 * follow working-directory changes without a runtime rebuild.
 */
export function isPiInfrastructureRead(
   toolName: string,
   normalizedPath: string,
   infrastructureDirs: readonly string[],
   cwd: string
): boolean {
   if (!READ_ONLY_PATH_BEARING_TOOLS.has(toolName)) {
      return false;
   }

   for (const dir of infrastructureDirs) {
      const normalizedDir = normalizePathForComparison(expandHomePath(dir), cwd);
      if (containsGlobChars(dir)) {
         if (wildcardMatch(normalizedDir, normalizedPath)) return true;
      } else {
         if (isPathWithinDirectory(normalizedPath, normalizedDir)) return true;
      }
   }

   // Project-local Pi packages — checked fresh every call so CWD changes work.
   const normalizedCwd = normalizePathForComparison(cwd, cwd);
   const projectNpmDir = posix.join(normalizedCwd, ".pi", "npm");
   const projectGitDir = posix.join(normalizedCwd, ".pi", "git");
   if (isPathWithinDirectory(normalizedPath, projectNpmDir)) {
      return true;
   }
   if (isPathWithinDirectory(normalizedPath, projectGitDir)) {
      return true;
   }

   return false;
}
