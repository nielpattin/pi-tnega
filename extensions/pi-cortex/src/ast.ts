import { startRustSidecar, rustAstGrep, rustAstReplace } from "./protocol.js";
import { loadConfig, getDbPath } from "./config.js";

export async function astGrep(
   pattern: string,
   lang = "",
   pathFilter = "",
   topK = 20,
   signal?: AbortSignal
): Promise<{ path: string; start_line: number; end_line: number; snippet: string }[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   return rustAstGrep(pattern, lang, pathFilter, topK, signal);
}

export async function astReplace(
   pattern: string,
   rewrite: string,
   lang = "",
   pathFilter = "",
   dryRun = false,
   signal?: AbortSignal
): Promise<{ file: string; matches: number; diff?: string }[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   return rustAstReplace(pattern, rewrite, lang, pathFilter, dryRun, signal);
}
