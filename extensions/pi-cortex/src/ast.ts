import { startRustSidecar, rustAstGrep } from "./protocol.js";
import { loadConfig, getDbPath } from "./config.js";

export async function astGrep(
   pattern: string,
   lang = "",
   pathFilter = "",
   topK = 20
): Promise<{ path: string; start_line: number; end_line: number; snippet: string }[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   return rustAstGrep(pattern, lang, pathFilter, topK);
}
