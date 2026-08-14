import * as path from "node:path";

/**
 * Derive a sibling directory for child Pi sessions from a persisted parent file.
 *
 * A parent session at `<dir>/<name>.jsonl` receives child sessions under
 * `<dir>/<name>/`. Ephemeral parents intentionally return no directory.
 *
 * @param parentSessionFile - The persisted parent session path, when available.
 * @returns The parent-scoped child directory or `undefined` for ephemeral paths.
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
