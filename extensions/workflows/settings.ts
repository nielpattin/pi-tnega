import * as fs from "node:fs";
import * as path from "node:path";

export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkflowSettings {
   /** Provider/model identifier for the mandatory final Summary. Omitted means inherit the active model. */
   summaryModel?: string;
   /** Thinking level for the mandatory final Summary. Omitted means inherit the active level. */
   summaryThinking?: WorkflowThinkingLevel;
   /** Custom list of fallback model identifiers to swap to and retry from the last message when an agent fails. */
   fallbackModels?: string[];
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {};
export const WORKFLOW_THINKING_LEVELS: readonly WorkflowThinkingLevel[] = [
   "off",
   "minimal",
   "low",
   "medium",
   "high",
   "xhigh",
   "max"
];

const THINKING_LEVELS: ReadonlySet<WorkflowThinkingLevel> = new Set(WORKFLOW_THINKING_LEVELS);

function homeDirectory(): string {
   return process.env.HOME || process.env.USERPROFILE || "";
}

export function workflowSettingsPath(home = homeDirectory()): string {
   return path.join(home, ".pi", "agent", ".ext-config", "workflows.json");
}

/** Normalize UI/config values and discard unsupported settings. */
export function normalizeWorkflowSettings(value: unknown): WorkflowSettings {
   if (!value || typeof value !== "object" || Array.isArray(value)) return {};
   const raw = value as { summaryModel?: unknown; summaryThinking?: unknown; fallbackModels?: unknown };
   const model = typeof raw.summaryModel === "string" ? raw.summaryModel.trim().slice(0, 256) : "";
   const summaryModel =
      model && !["default", "inherit", "auto", "none"].includes(model.toLowerCase()) ? model : undefined;
   const summaryThinking = THINKING_LEVELS.has(raw.summaryThinking as WorkflowThinkingLevel)
      ? (raw.summaryThinking as WorkflowThinkingLevel)
      : undefined;
   const fallbackModels = Array.isArray(raw.fallbackModels)
      ? raw.fallbackModels
           .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
           .map((m) => m.trim().slice(0, 256))
      : undefined;
   return {
      ...(summaryModel ? { summaryModel } : {}),
      ...(summaryThinking ? { summaryThinking } : {}),
      ...(fallbackModels && fallbackModels.length > 0 ? { fallbackModels } : {})
   };
}

export function readWorkflowSettings(filePath = workflowSettingsPath()): WorkflowSettings {
   try {
      return normalizeWorkflowSettings(JSON.parse(fs.readFileSync(filePath, "utf8")));
   } catch {
      return { ...DEFAULT_WORKFLOW_SETTINGS };
   }
}

export function writeWorkflowSettings(settings: WorkflowSettings, filePath = workflowSettingsPath()): void {
   const normalized = normalizeWorkflowSettings(settings);
   fs.mkdirSync(path.dirname(filePath), { recursive: true });
   fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}
