import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveAgentDir } from "./agent-dir.js";
import type { RaftModelUsage } from "./model-resolution.js";

/**
 * Usage store filename written by the pi-model-sort extension under the pi
 * agent directory's extensions folder. pi-raft consumes it read-only: the
 * extension is installed separately and might be absent entirely.
 */
const MODEL_USAGE_FILENAME = "pi-model-sort.json";

/**
 * Load model last-used timestamps (`provider/id` → Unix ms) recorded by the
 * pi-model-sort extension. Missing or malformed data degrades to an empty map,
 * in which case resolution simply falls back to its no-recency tie-break.
 */
export const loadModelUsage = (agentDir: string = resolveAgentDir()): RaftModelUsage => {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(agentDir, "extensions", MODEL_USAGE_FILENAME), "utf8"),
    );
    const lastUsed = (raw as { lastUsed?: unknown } | null)?.lastUsed;
    if (typeof lastUsed !== "object" || lastUsed === null) return {};
    const usage: RaftModelUsage = {};
    for (const [key, value] of Object.entries(lastUsed)) {
      if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
    }
    return usage;
  } catch {
    return {};
  }
};
