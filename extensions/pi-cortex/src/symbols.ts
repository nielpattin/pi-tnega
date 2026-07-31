import { relative } from "node:path";
import type { SymbolResult, SymbolHit } from "./types.js";
import { startRustSidecar, rustSymbolSearch } from "./protocol.js";
import { getActiveCwd, getDbPath, loadConfig } from "./config.js";

export async function symbolSearch(symbol: string, signal?: AbortSignal): Promise<SymbolHit[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   const results = await rustSymbolSearch(symbol, undefined, signal);
   return results.map((r: SymbolResult) => ({
      symbol: r.symbol,
      path: relative(getActiveCwd(), r.path) || r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      snippet: r.snippet
   }));
}
