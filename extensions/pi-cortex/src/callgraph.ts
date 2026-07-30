import { relative } from "node:path";
import type { CallGraphResult, CallGraphHit } from "./types.js";
import { startRustSidecar, rustCallGraph } from "./protocol.js";
import { getActiveCwd, getDbPath, loadConfig } from "./config.js";

export async function callGraphQuery(symbol: string, direction: string, filePath?: string): Promise<CallGraphHit[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   const results = await rustCallGraph(symbol, direction, filePath);
   return results.map((r: CallGraphResult) => ({
      callerPath: relative(getActiveCwd(), r.caller_path) || r.caller_path,
      callerSymbol: r.caller_symbol,
      calleePath: relative(getActiveCwd(), r.callee_path) || r.callee_path,
      calleeSymbol: r.callee_symbol
   }));
}
