/**
 * Tool permission adapters.
 *
 * Generates permission patterns and metadata for each tool type,
 * enabling the permission service to make informed decisions.
 */

import { normalize, isAbsolute, dirname } from "path";

// ── Types ───────────────────────────────────────────────────────────

export interface ToolPermissionRequest {
   /** Permission domain (e.g. "bash", "edit", "read"). */
   permission: string;
   /** Patterns to evaluate against the ruleset. */
   patterns: string[];
   /** Metadata for UI rendering and decision-making. */
   metadata: Record<string, unknown>;
}

// ── Bash adapter ────────────────────────────────────────────────────

/**
 * Generate permission request for a bash command.
 *
 * Produces patterns:
 * - The full command string (for exact match rules)
 * - The command name + wildcard (for broad rules like "git *")
 * - Just "*" as a fallback
 *
 * Always-pattern candidates: the command name + "*" pattern.
 */
export function bashAdapter(command: string): ToolPermissionRequest {
   const trimmed = command.trim();
   const parts = trimmed.split(/\s+/);
   const commandName = parts[0] ?? "";

   const patterns: string[] = [
      trimmed, // Exact command match
      `${commandName} *`, // Command name + wildcard
      "*" // Global fallback
   ];

   return {
      permission: "bash",
      patterns,
      metadata: {
         command: trimmed,
         commandName,
         args: parts.slice(1)
      }
   };
}

/**
 * Derive the "always" pattern from a bash command.
 * Uses "commandName *" so future commands with the same base are allowed.
 */
export function bashAlwaysPattern(command: string): string {
   const parts = command.trim().split(/\s+/);
   const commandName = parts[0] ?? "";
   return `${commandName} *`;
}

// ── Edit adapter ────────────────────────────────────────────────────

/**
 * Generate permission request for an edit operation.
 *
 * Produces patterns:
 * - The exact file path
 * - The file extension wildcard (e.g. "*.ts")
 * - The directory glob (e.g. "src/**")
 * - "*" as fallback
 */
export function editAdapter(filePath: string, oldText: string, newText: string, cwd?: string): ToolPermissionRequest {
   const normalizedPath = normalizePath(filePath, cwd);
   const ext = getExtension(filePath);
   const dir = dirname(normalizedPath);

   const patterns: string[] = [
      normalizedPath, // Exact file
      `*${ext}`, // Extension wildcard
      `${dir}/**`, // Directory glob
      "*" // Global fallback
   ];

   // Generate a simple diff for metadata
   const diff = generateSimpleDiff(oldText, newText, filePath);

   return {
      permission: "edit",
      patterns,
      metadata: {
         filePath: normalizedPath,
         extension: ext,
         directory: dir,
         diff,
         oldText: truncate(oldText, 500),
         newText: truncate(newText, 500)
      }
   };
}

/**
 * Derive the "always" pattern for an edit operation.
 * Uses the file extension wildcard for broad matching.
 */
export function editAlwaysPattern(filePath: string): string {
   const ext = getExtension(filePath);
   return `*${ext}`;
}

// ── Read adapter ────────────────────────────────────────────────────

/**
 * Generate permission request for a read operation.
 *
 * Produces patterns:
 * - The exact file/directory path
 * - The directory glob
 * - "*" as fallback
 */
export function readAdapter(path: string, cwd?: string): ToolPermissionRequest {
   const normalizedPath = normalizePath(path, cwd);
   const dir = dirname(normalizedPath);
   const ext = getExtension(path);

   const patterns: string[] = [
      normalizedPath, // Exact path
      ext ? `*${ext}` : `${normalizedPath}/**`, // Extension or directory glob
      `${dir}/**`, // Parent directory
      "*" // Global fallback
   ];

   return {
      permission: "read",
      patterns,
      metadata: {
         path: normalizedPath,
         directory: dir,
         extension: ext,
         isAbsolute: isAbsolute(path)
      }
   };
}

// ── Task adapter ────────────────────────────────────────────────────

/**
 * Generate permission request for a task (subagent) operation.
 *
 * Produces patterns:
 * - The task/goal description hash (for specific matching)
 * - The agent name wildcard
 * - "*" as fallback
 */
export function taskAdapter(
   taskDescription: string,
   agentName?: string,
   metadata?: Record<string, unknown>
): ToolPermissionRequest {
   const patterns: string[] = [
      "*" // Global fallback
   ];

   if (agentName) {
      patterns.unshift(`${agentName} *`); // Agent wildcard
   }

   return {
      permission: "task",
      patterns,
      metadata: {
         taskDescription: truncate(taskDescription, 200),
         agentName: agentName ?? "unknown",
         ...metadata
      }
   };
}

// ── External directory adapter ──────────────────────────────────────

/**
 * Generate permission request for accessing an external directory.
 *
 * Produces patterns:
 * - The exact directory path
 * - The directory with glob wildcard
 * - Parent directories
 * - "*" as fallback
 */
export function externalDirectoryAdapter(directoryPath: string, cwd?: string): ToolPermissionRequest {
   const normalizedPath = normalizePath(directoryPath, cwd);
   const parentDir = dirname(normalizedPath);

   const patterns: string[] = [
      normalizedPath, // Exact directory
      `${normalizedPath}/**`, // Directory contents
      `${parentDir}/**`, // Parent directory
      "*" // Global fallback
   ];

   return {
      permission: "external_directory",
      patterns,
      metadata: {
         directory: normalizedPath,
         parentDirectory: parentDir,
         isAbsolute: isAbsolute(directoryPath)
      }
   };
}

/**
 * Derive the "always" pattern for external directory access.
 * Uses the directory with glob wildcard.
 */
export function externalDirectoryAlwaysPattern(directoryPath: string, cwd?: string): string {
   const normalizedPath = normalizePath(directoryPath, cwd);
   return `${normalizedPath}/**`;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a file path relative to cwd if it's not absolute.
 * Always uses forward slashes for cross-platform consistency.
 */
function normalizePath(path: string, cwd?: string): string {
   let normalized: string;
   if (isAbsolute(path)) {
      normalized = normalize(path);
   } else if (cwd) {
      normalized = normalize(`${cwd}/${path}`);
   } else {
      normalized = normalize(path);
   }
   // Normalize to forward slashes for consistent pattern matching
   return normalized.replace(/\\/g, "/");
}

/**
 * Get the file extension including the dot (e.g. ".ts").
 */
function getExtension(filePath: string): string {
   const lastDot = filePath.lastIndexOf(".");
   if (lastDot === -1) return "";
   return filePath.slice(lastDot);
}

/**
 * Generate a simple unified diff string for metadata.
 */
function generateSimpleDiff(oldText: string, newText: string, filePath: string): string {
   const oldLines = oldText.split("\n");
   const newLines = newText.split("\n");
   const diff: string[] = [];

   diff.push(`--- a/${filePath}`);
   diff.push(`+++ b/${filePath}`);

   // Simple line-by-line comparison
   const maxLen = Math.max(oldLines.length, newLines.length);
   for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine === newLine) {
         diff.push(` ${oldLine}`);
      } else {
         if (oldLine !== undefined) diff.push(`-${oldLine}`);
         if (newLine !== undefined) diff.push(`+${newLine}`);
      }
   }

   return diff.join("\n");
}

/**
 * Truncate a string to a maximum length, adding "..." if truncated.
 */
function truncate(str: string, maxLen: number): string {
   if (str.length <= maxLen) return str;
   return str.slice(0, maxLen - 3) + "...";
}
