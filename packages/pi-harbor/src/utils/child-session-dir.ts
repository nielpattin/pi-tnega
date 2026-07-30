import * as path from "node:path";

/**
 * Derive a sibling child-session directory from the active parent session file.
 *
 * A persisted parent session lives at `<dir>/<timestamp>_<id>.jsonl`; its
 * child sessions are routed into the sibling directory `<dir>/<timestamp>_<id>/`.
 *
 * Returns `undefined` when the parent has no persisted session file (ephemeral
 * or in-memory) or when the path does not look like a Pi JSONL session file.
 */
export function deriveChildSessionDirectory(parentSessionFile: string | undefined | null): string | undefined {
   if (!parentSessionFile) return undefined;

   const resolved = path.resolve(parentSessionFile);
   const fileName = path.basename(resolved);
   if (!fileName.endsWith(".jsonl")) return undefined;

   const base = fileName.slice(0, -".jsonl".length);
   if (!base) return undefined;

   return path.join(path.dirname(resolved), base);
}
