import { relative } from "node:path";
import type { CallGraphResult, CallGraphHit } from "./types.js";
import { startRustSidecar, rustCallGraph, logLine } from "./protocol.js";
import { getActiveCwd, getDbPath, loadConfig } from "./config.js";

/**
 * Map raw sidecar rows (file_path/line/callee/caller) to render-friendly
 * hits. Pure and platform-aware so it can be unit-tested. The sidecar stores
 * one row per call site: the row's file_path is the caller's file when the
 * caller is known, but `extract_calls` only captures the callee name today,
 * so both caller and callee path default to the row's file.
 */
export function toCallGraphHits(results: CallGraphResult[], cwd: string): CallGraphHit[] {
   return results.map((r) => {
      const callerPath = relative(cwd, r.file_path) || r.file_path;
      return {
         callerPath,
         callerSymbol: r.caller,
         calleePath: callerPath,
         calleeSymbol: r.callee
      };
   });
}

export async function callGraphQuery(
   symbol: string,
   direction: string,
   filePath?: string,
   signal?: AbortSignal
): Promise<CallGraphHit[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   const cwd = getActiveCwd();
   const results = await rustCallGraph(symbol, direction, filePath, signal);
   const hits = toCallGraphHits(results, cwd);
   logLine(
      `call_graph: symbol=${JSON.stringify(symbol)} direction=${direction} path=${filePath ?? "None"} → ${hits.length} edge(s)`
   );
   return hits;
}
