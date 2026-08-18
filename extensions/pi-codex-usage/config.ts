import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CODEX_USAGE_CONFIG_FILE = "pi-codex-usage.json";
const DEFAULT_CODEX_VERBOSITY: CodexVerbosity = "low";
const DEFAULT_CODEX_FAST_MODE = false;

/** Response verbosity levels supported by the OpenAI Responses API. */
export type CodexVerbosity = "low" | "medium" | "high";

/** All supported Codex response verbosity levels. */
export const CODEX_VERBOSITY_LEVELS: readonly CodexVerbosity[] = ["low", "medium", "high"];

/** Persisted Codex request options. */
export interface CodexUsageConfig {
   /** Use OpenAI's `priority` service tier (fast mode) for Codex requests. */
   fast: boolean;
   /** Response verbosity sent to OpenAI. */
   verbosity: CodexVerbosity;
}

export const DEFAULT_CODEX_USAGE_CONFIG: CodexUsageConfig = {
   fast: DEFAULT_CODEX_FAST_MODE,
   verbosity: DEFAULT_CODEX_VERBOSITY
};

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(dir: string): string {
   return join(dir, CODEX_USAGE_CONFIG_FILE);
}

/**
 * Parse a user-provided verbosity value.
 *
 * @param value - The value to parse.
 * @returns A supported verbosity level, or `undefined` when the value is invalid.
 */
export function normalizeCodexVerbosity(value: unknown): CodexVerbosity | undefined {
   if (typeof value !== "string") return undefined;
   const normalized = value.trim().toLowerCase();
   return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : undefined;
}

/**
 * Parse a user-provided fast mode value.
 *
 * @param value - The value to parse.
 * @returns The boolean value, or `undefined` when the value is not a boolean.
 */
export function normalizeFastMode(value: unknown): boolean | undefined {
   return typeof value === "boolean" ? value : undefined;
}

/**
 * Load the persisted Codex request options.
 *
 * @param dir - Directory holding the config file (defaults to the agent dir).
 * @returns The saved options, or defaults when no valid settings are stored.
 */
export async function loadCodexUsageConfig(dir: string = getAgentDir()): Promise<CodexUsageConfig> {
   try {
      const value: unknown = JSON.parse(await readFile(configPath(dir), "utf8"));
      if (!isRecord(value)) return { ...DEFAULT_CODEX_USAGE_CONFIG };
      return {
         fast: normalizeFastMode(value.fast) ?? DEFAULT_CODEX_FAST_MODE,
         verbosity: normalizeCodexVerbosity(value.verbosity) ?? DEFAULT_CODEX_VERBOSITY
      };
   } catch {
      return { ...DEFAULT_CODEX_USAGE_CONFIG };
   }
}

/**
 * Persist the Codex request options for future sessions.
 *
 * @param config - The options to save.
 * @param dir - Directory holding the config file (defaults to the agent dir).
 */
export async function saveCodexUsageConfig(config: CodexUsageConfig, dir: string = getAgentDir()): Promise<void> {
   await mkdir(dir, { recursive: true });
   await writeFile(configPath(dir), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Apply the configured Codex request options to a Responses request payload.
 *
 * Fast mode maps to OpenAI's `priority` service tier, mirroring the option
 * pi-codex-conversion exposes. Verbosity is sent inside the `text` block.
 *
 * @param payload - The provider request payload.
 * @param config - The configured request options.
 * @returns The payload with fast mode and verbosity applied.
 */
export function applyCodexRequestOptions(payload: unknown, config: CodexUsageConfig): unknown {
   if (!isRecord(payload)) return payload;
   const text = isRecord(payload.text) ? payload.text : {};
   return {
      ...payload,
      ...(config.fast ? { service_tier: "priority" } : {}),
      text: { ...text, verbosity: config.verbosity }
   };
}
