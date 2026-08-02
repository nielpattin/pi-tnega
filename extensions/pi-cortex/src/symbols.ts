import { relative } from "node:path";
import type { SymbolResult, SymbolHit, OutlineHit } from "./types.js";
import { startRustSidecar, rustSymbolSearch, rustOutline } from "./protocol.js";
import { getActiveCwd, getDbPath, loadConfig } from "./config.js";

export async function symbolSearch(symbol: string, kind?: string, signal?: AbortSignal): Promise<SymbolHit[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   const results = await rustSymbolSearch(symbol, kind, undefined, signal);
   return results.map((r: SymbolResult) => ({
      symbol: r.symbol,
      kind: r.kind ?? "",
      path: relative(getActiveCwd(), r.path) || r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      snippet: r.snippet
   }));
}

export async function outline(
   path: string,
   signal?: AbortSignal
): Promise<{
   files: number;
   truncated: boolean;
   hits: OutlineHit[];
}> {
   await startRustSidecar(loadConfig().model, getDbPath());
   const r = await rustOutline(path, signal);
   return {
      files: r.files,
      truncated: r.truncated,
      hits: r.symbols.map((s) => ({
         symbol: s.symbol,
         kind: s.kind ?? "",
         path: relative(getActiveCwd(), s.path) || s.path,
         startLine: s.start_line,
         endLine: s.end_line
      }))
   };
}
