import { relative } from "node:path";
import { startRustSidecar, rustTripleQuery } from "./protocol.js";
import { getActiveCwd, getDbPath, loadConfig } from "./config.js";

export async function tripleQuery(
   subject = "",
   predicate = "",
   object = "",
   limit = 100,
   signal?: AbortSignal
): Promise<{ subject: string; predicate: string; object: string; subject_type: string; object_type: string }[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   return rustTripleQuery(subject, predicate, object, limit, signal);
}
