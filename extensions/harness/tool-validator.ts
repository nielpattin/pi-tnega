/**
 * Tool Input Validation + Auto-Repair Extension
 *
 * Validates tool inputs against expected schemas before execution.
 * If input is malformed, attempts to auto-repair common issues
 * (wrong types, alias field names, missing wrapping).
 * Falls back to blocking with a clear reason for the model to fix.
 *
 * Tracks repair metrics persisted to .pi/tool-validator-metrics.json.
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface RepairMetrics {
   total: number;
   repaired: number;
   blocked: number;
   errors: Record<string, number>;
}

interface ToolSchema {
   required: string[];
   types: Record<string, string>;
}

// Schemas for common built-in tools
const SCHEMAS: Record<string, ToolSchema> = {
   read: {
      required: ["path"],
      types: { path: "string", offset: "number", limit: "number" }
   },
   write: {
      required: ["path", "content"],
      types: { path: "string", content: "string" }
   },
   edit: {
      required: ["path", "edits"],
      types: { path: "string", edits: "array" }
   },
   bash: {
      required: ["command"],
      types: { command: "string", timeout: "number" }
   },
   grep: {
      required: ["pattern"],
      types: { pattern: "string", path: "string", limit: "number" }
   },
   find: {
      required: ["pattern"],
      types: { pattern: "string", path: "string" }
   }
};

// Field alias mappings for recovery
const ALIASES: Record<string, string[]> = {
   path: ["filePath", "file_path", "file", "target", "filepath"],
   content: ["text", "data", "body", "value", "contents"],
   pattern: ["query", "search", "term", "regex", "regexp"],
   command: ["cmd", "shell", "run", "script"],
   edits: ["edit", "changes", "replacements", "patches"]
};

function detectType(value: unknown): string {
   if (value === null || value === undefined) return "null";
   if (Array.isArray(value)) return "array";
   return typeof value;
}

function autoRepairField(field: string, expectedType: string, input: Record<string, unknown>): string | null {
   const value = input[field];
   if (value === undefined) return null;

   const actualType = detectType(value);
   if (actualType === expectedType) return null;

   // Number field got string: parse it
   if (expectedType === "number" && actualType === "string") {
      const parsed = Number(value as string);
      if (!isNaN(parsed)) {
         input[field] = parsed;
         return `${field}: parsed string → number`;
      }
   }

   // String field got number/boolean: stringify
   if (expectedType === "string" && (actualType === "number" || actualType === "boolean")) {
      input[field] = String(value);
      return `${field}: converted ${actualType} → string`;
   }

   // Array field got single object: wrap
   if (expectedType === "array" && actualType === "object" && !Array.isArray(value)) {
      input[field] = [value];
      return `${field}: wrapped single object in array`;
   }

   return null;
}

function autoRepairAlias(field: string, input: Record<string, unknown>): string | null {
   const aliases = ALIASES[field];
   if (!aliases) return null;

   for (const alias of aliases) {
      if (input[alias] !== undefined) {
         input[field] = input[alias];
         delete input[alias];
         return `${field}: mapped from '${alias}'`;
      }
   }
   return null;
}

function validate(toolName: string, input: Record<string, unknown>): string[] {
   const schema = SCHEMAS[toolName];
   if (!schema) return [];

   const errors: string[] = [];

   for (const field of schema.required) {
      if (input[field] === undefined || input[field] === null) {
         errors.push(`missing required field '${field}'`);
      }
   }

   for (const [field, expectedType] of Object.entries(schema.types)) {
      const value = input[field];
      if (value === undefined || value === null) continue;

      const actualType = detectType(value);
      if (expectedType === "array" && actualType !== "array") {
         errors.push(`'${field}' must be array, got ${actualType}`);
      } else if (expectedType !== "array" && actualType !== expectedType) {
         errors.push(`'${field}' must be ${expectedType}, got ${actualType}`);
      }
   }

   return errors;
}

function attemptRepair(toolName: string, input: Record<string, unknown>): { didRepair: boolean; repairs: string[] } {
   const repairs: string[] = [];
   const schema = SCHEMAS[toolName];
   if (!schema) return { didRepair: false, repairs };

   // Fix type mismatches for known fields
   for (const [field, expectedType] of Object.entries(schema.types)) {
      const repair = autoRepairField(field, expectedType, input);
      if (repair) repairs.push(repair);
   }

   // Fix missing required fields via aliases
   for (const field of schema.required) {
      if (input[field] === undefined || input[field] === null) {
         const repair = autoRepairAlias(field, input);
         if (repair) repairs.push(repair);
      }
   }

   return { didRepair: repairs.length > 0, repairs };
}

export default function (pi: ExtensionAPI) {
   const METRICS_DIR = join(process.cwd(), ".pi");
   const METRICS_FILE = join(METRICS_DIR, "tool-validator-metrics.json");

   let metrics: RepairMetrics = { total: 0, repaired: 0, blocked: 0, errors: {} };

   try {
      if (existsSync(METRICS_FILE)) {
         metrics = JSON.parse(readFileSync(METRICS_FILE, "utf-8"));
      }
   } catch {
      // Fresh start
   }

   function persistMetrics(): void {
      try {
         if (!existsSync(METRICS_DIR)) mkdirSync(METRICS_DIR, { recursive: true });
         writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), "utf-8");
      } catch {
         // best-effort
      }
   }

   pi.on("tool_call", async (event, ctx) => {
      const schema = SCHEMAS[event.toolName];
      if (!schema) return undefined;

      const input = event.input as Record<string, unknown>;
      const errors = validate(event.toolName, input);

      if (errors.length === 0) return undefined;

      metrics.total++;

      // Attempt auto-repair
      const { didRepair, repairs } = attemptRepair(event.toolName, input);

      if (didRepair) {
         metrics.repaired++;
         persistMetrics();
         if (ctx.hasUI) {
            ctx.ui.notify(`Repaired ${event.toolName}: ${repairs.join("; ")}`, "info");
         }
         return undefined; // execute with repaired input
      }

      // Cannot repair — block
      metrics.blocked++;
      metrics.errors[event.toolName] = (metrics.errors[event.toolName] ?? 0) + 1;
      persistMetrics();

      if (ctx.hasUI) {
         ctx.ui.notify(`Blocked ${event.toolName}: ${errors.join(", ")}`, "warning");
      }

      return {
         block: true,
         reason: `Invalid input for tool "${event.toolName}": ${errors.join("; ")}`
      };
   });

   pi.registerCommand("tool-stats", {
      description: "Show tool validation metrics",
      handler: async (_args, ctx) => {
         const lines = [
            `Tool Validation Metrics:`,
            `  Total: ${metrics.total}`,
            `  Repaired: ${metrics.repaired}`,
            `  Blocked: ${metrics.blocked}`,
            `  Errors by tool:`,
            ...(Object.keys(metrics.errors).length
               ? Object.entries(metrics.errors).map(([t, c]) => `    ${t}: ${c}`)
               : ["    (none)"])
         ];
         ctx.ui.notify(lines.join("\n"), "info");
      }
   });
}
