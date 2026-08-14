import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompactionLimits } from "./core/compaction";

/** Configuration for deterministic compaction. */
export interface CompactionConfig {
   readonly enabled: boolean;
   readonly compaction: Required<CompactionLimits>;
}

/** A safe configuration parse error. */
export interface ConfigParseError {
   readonly _tag: "ConfigParseError";
   readonly message: string;
}

/** A value-or-error result for config boundaries. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** The config file name under an agent directory's extensions folder. */
export const CONFIG_FILE_NAME = "pi-constellation.json";
const LEGACY_CONFIG_FILE_NAMES = ["pi-compaction.json", "pi-smart-context.json"];

/** Return bounded defaults for deterministic compaction. */
export function defaultConfig(): CompactionConfig {
   return {
      enabled: true,
      compaction: { maxChars: 12_000, maxItemsPerSection: 12, maxBriefLines: 80, maxRecentTailChars: 4_000 }
   };
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
   if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
   const integer = Math.floor(value);
   return integer >= minimum && integer <= maximum ? integer : fallback;
}

/** Parse untrusted JSON configuration and ignore removed pruning settings. */
export function parseConfig(input: unknown): Result<CompactionConfig, ConfigParseError> {
   const defaults = defaultConfig();
   if (!isRecord(input)) return { ok: true, value: defaults };
   const compaction = isRecord(input.compaction) ? input.compaction : {};
   return {
      ok: true,
      value: {
         enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
         compaction: {
            maxChars: integerValue(compaction.maxChars, defaults.compaction.maxChars, 1_000, 200_000),
            maxItemsPerSection: integerValue(
               compaction.maxItemsPerSection,
               defaults.compaction.maxItemsPerSection,
               1,
               100
            ),
            maxBriefLines: integerValue(compaction.maxBriefLines, defaults.compaction.maxBriefLines, 1, 500),
            maxRecentTailChars: integerValue(
               compaction.maxRecentTailChars,
               defaults.compaction.maxRecentTailChars,
               0,
               50_000
            )
         }
      }
   };
}

/** Return the extension config path under the shared hidden config directory. */
export function configPath(agentDir: string): string {
   return join(agentDir, ".ext-config", CONFIG_FILE_NAME);
}

/** Read config from disk, falling back to the former extension filename during migration. */
export async function loadConfig(agentDir: string): Promise<CompactionConfig> {
   const paths = [
      configPath(agentDir),
      ...LEGACY_CONFIG_FILE_NAMES.map((fileName) => join(agentDir, ".ext-config", fileName))
   ];
   const files = await Promise.allSettled(paths.map((path) => readFile(path, "utf8")));
   for (const file of files) {
      if (file.status !== "fulfilled") continue;
      try {
         const parsed: unknown = JSON.parse(file.value);
         const result = parseConfig(parsed);
         return result.ok ? result.value : defaultConfig();
      } catch {
         // Try the legacy file, then fail open to defaults.
      }
   }
   return defaultConfig();
}
