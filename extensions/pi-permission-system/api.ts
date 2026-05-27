/**
 * Permission API and event surfaces.
 *
 * Exposes extension commands for listing pending requests and replying,
 * and provides prompt metadata formatters for UI/CLI surfaces.
 */

import type { PermissionService } from "./service.ts";
import type { PermissionRequest, PermissionReply, PermissionEvent } from "./types.ts";

// ── API endpoints ───────────────────────────────────────────────────

export interface PermissionAPI {
   /** List all pending permission requests. */
   listPending(): PermissionRequest[];

   /** List pending requests for a specific session. */
   listPendingForSession(sessionId: string): PermissionRequest[];

   /** Reply to a pending permission request. */
   reply(reply: PermissionReply): boolean;

   /** Check if a request is still pending. */
   isPending(requestId: string): boolean;

   /** Get count of pending requests. */
   pendingCount(): number;
}

/**
 * Create a permission API instance from a service.
 */
export function createPermissionAPI(service: PermissionService): PermissionAPI {
   return {
      listPending: () => service.listPending(),
      listPendingForSession: (sessionId: string) => service.listPendingForSession(sessionId),
      reply: (reply: PermissionReply) => service.reply(reply),
      isPending: (requestId: string) => service.isPending(requestId),
      pendingCount: () => service.pendingCount
   };
}

// ── Event types ─────────────────────────────────────────────────────

export type PermissionEventType = "permission-requested" | "permission-resolved";

export interface PermissionEventHandler {
   (event: PermissionEvent): void;
}

/**
 * Subscribe to permission events from the service.
 */
export function subscribeToPermissionEvents(service: PermissionService, handler: PermissionEventHandler): () => void {
   const onRequest = (event: PermissionEvent) => handler(event);
   const onResolve = (event: PermissionEvent) => handler(event);

   service.on("permission-requested", onRequest);
   service.on("permission-resolved", onResolve);

   // Return unsubscribe function
   return () => {
      service.off("permission-requested", onRequest);
      service.off("permission-resolved", onResolve);
   };
}

// ── Prompt metadata formatters ──────────────────────────────────────

export interface FormattedPermissionPrompt {
   /** Title/header for the permission prompt. */
   title: string;
   /** Description of what's being requested. */
   description: string;
   /** Permission domain label. */
   domain: string;
   /** Primary value being requested (command, file path, etc.). */
   primaryValue: string;
   /** Additional context lines for the prompt. */
   contextLines: string[];
   /** Risk indicator: "low", "medium", "high". */
   risk: "low" | "medium" | "high";
}

/**
 * Format a permission request into a human-readable prompt.
 */
export function formatPermissionPrompt(request: PermissionRequest): FormattedPermissionPrompt {
   const { permission, metadata } = request;

   switch (permission) {
      case "bash":
         return formatBashPrompt(metadata);
      case "edit":
         return formatEditPrompt(metadata);
      case "read":
         return formatReadPrompt(metadata);
      case "task":
         return formatTaskPrompt(metadata);
      case "external_directory":
         return formatExternalDirectoryPrompt(metadata);
      default:
         return formatGenericPrompt(permission, request);
   }
}

function formatBashPrompt(metadata: Record<string, unknown>): FormattedPermissionPrompt {
   const command = (metadata.command as string) ?? "unknown";
   const commandName = (metadata.commandName as string) ?? "";

   // Higher risk for destructive commands
   const destructive = ["rm", "mkfs", "dd", "format", "del"].some((cmd) => commandName.toLowerCase().startsWith(cmd));
   const network = ["curl", "wget", "ssh", "scp", "rsync"].some((cmd) => commandName.toLowerCase().startsWith(cmd));

   return {
      title: "Bash Command Execution",
      description: `Allow execution of bash command?`,
      domain: "bash",
      primaryValue: command,
      contextLines: [
         `Command: ${command}`,
         `Base: ${commandName}`,
         ...(destructive ? ["⚠️  Destructive command detected"] : []),
         ...(network ? ["⚠️  Network command detected"] : [])
      ],
      risk: destructive ? "high" : network ? "medium" : "low"
   };
}

function formatEditPrompt(metadata: Record<string, unknown>): FormattedPermissionPrompt {
   const filePath = (metadata.filePath as string) ?? "unknown";
   const diff = (metadata.diff as string) ?? "";

   return {
      title: "File Edit",
      description: `Allow editing of file?`,
      domain: "edit",
      primaryValue: filePath,
      contextLines: [
         `File: ${filePath}`,
         `Extension: ${metadata.extension as string}`,
         "",
         "Diff preview:",
         ...diff.split("\n").slice(0, 20),
         ...(diff.split("\n").length > 20 ? ["... (truncated)"] : [])
      ],
      risk: "medium"
   };
}

function formatReadPrompt(metadata: Record<string, unknown>): FormattedPermissionPrompt {
   const path = (metadata.path as string) ?? "unknown";

   return {
      title: "File Read",
      description: `Allow reading of file/directory?`,
      domain: "read",
      primaryValue: path,
      contextLines: [`Path: ${path}`],
      risk: "low"
   };
}

function formatTaskPrompt(metadata: Record<string, unknown>): FormattedPermissionPrompt {
   const description = (metadata.taskDescription as string) ?? "unknown task";
   const agentName = (metadata.agentName as string) ?? "unknown";

   return {
      title: "Subagent Task",
      description: `Allow spawning subagent task?`,
      domain: "task",
      primaryValue: description,
      contextLines: [`Task: ${description}`, `Agent: ${agentName}`],
      risk: "medium"
   };
}

function formatExternalDirectoryPrompt(metadata: Record<string, unknown>): FormattedPermissionPrompt {
   const directory = (metadata.directory as string) ?? "unknown";

   return {
      title: "External Directory Access",
      description: `Allow access to directory outside workspace?`,
      domain: "external_directory",
      primaryValue: directory,
      contextLines: [
         `Directory: ${directory}`,
         `Parent: ${metadata.parentDirectory as string}`,
         "⚠️  Accessing files outside the current workspace"
      ],
      risk: "high"
   };
}

function formatGenericPrompt(permission: string, request: PermissionRequest): FormattedPermissionPrompt {
   return {
      title: `Permission: ${permission}`,
      description: `Permission required for ${permission} operation`,
      domain: permission,
      primaryValue: request.patterns[0] ?? "*",
      contextLines: [`Permission: ${permission}`, `Patterns: ${request.patterns.join(", ")}`],
      risk: "medium"
   };
}
