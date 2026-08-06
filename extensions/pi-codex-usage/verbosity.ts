import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CODEX_USAGE_CONFIG_FILE = "pi-codex-usage.json";
const DEFAULT_CODEX_VERBOSITY: CodexVerbosity = "low";

/** Response verbosity levels supported by the OpenAI Responses API. */
export type CodexVerbosity = "low" | "medium" | "high";

/** All supported Codex response verbosity levels. */
export const CODEX_VERBOSITY_LEVELS: readonly CodexVerbosity[] = ["low", "medium", "high"];

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(): string {
   return join(getAgentDir(), CODEX_USAGE_CONFIG_FILE);
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
 * Load the persisted Codex response verbosity.
 *
 * @returns The saved verbosity, or `low` when no valid setting is stored.
 */
export async function loadCodexVerbosity(): Promise<CodexVerbosity> {
   try {
      const value: unknown = JSON.parse(await readFile(configPath(), "utf8"));
      const savedVerbosity = isRecord(value) ? normalizeCodexVerbosity(value.verbosity) : undefined;
      return savedVerbosity ?? DEFAULT_CODEX_VERBOSITY;
   } catch {
      return DEFAULT_CODEX_VERBOSITY;
   }
}

/**
 * Persist the Codex response verbosity for future sessions.
 *
 * @param verbosity - The verbosity to save.
 */
export async function saveCodexVerbosity(verbosity: CodexVerbosity): Promise<void> {
   const path = configPath();
   await mkdir(getAgentDir(), { recursive: true });
   await writeFile(path, `${JSON.stringify({ verbosity }, null, 2)}\n`);
}

/**
 * Apply the configured verbosity to a Codex Responses request payload.
 *
 * @param payload - The provider request payload.
 * @param verbosity - The verbosity to send to OpenAI.
 * @returns The payload with the requested response verbosity.
 */
export function applyCodexVerbosity(payload: unknown, verbosity: CodexVerbosity): unknown {
   if (!isRecord(payload)) return payload;
   const text = isRecord(payload.text) ? payload.text : {};
   return {
      ...payload,
      text: { ...text, verbosity }
   };
}
