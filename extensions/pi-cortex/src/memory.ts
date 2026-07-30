import { performance } from "node:perf_hooks";
import { startRustSidecar, rustMemoryStore, rustMemoryRecall, rustMemoryForget } from "./protocol.js";
import { loadConfig, getDbPath } from "./config.js";
import { embedQuery } from "./search.js";

export async function remember(
   content: string,
   source = "",
   importance = 0.5,
   scope = "session"
): Promise<{ memory_id: number; elapsed: number }> {
   await startRustSidecar(loadConfig().model, getDbPath());
   const config = loadConfig();
   const start = performance.now();

   const embedding = Array.from(await embedQuery(content, config));
   const memoryId = await rustMemoryStore(content, embedding, source, importance, scope);
   const elapsed = (performance.now() - start) / 1000;

   return { memory_id: memoryId, elapsed };
}

export interface MemoryRecallItem {
   memory_id: number;
   content: string;
   score: number;
   source: string;
   importance: number;
   scope: string;
   elapsed: number;
}

export async function recall(query: string, topK = 5, scope = ""): Promise<MemoryRecallItem[]> {
   await startRustSidecar(loadConfig().model, getDbPath());
   const config = loadConfig();
   const start = performance.now();

   const embedding = Array.from(await embedQuery(query, config));
   const results = await rustMemoryRecall(embedding, topK, scope);
   const elapsed = (performance.now() - start) / 1000;

   return results.map((r) => ({ ...r, elapsed }));
}

export async function forget(memoryId: number): Promise<void> {
   await startRustSidecar(loadConfig().model, getDbPath());
   await rustMemoryForget(memoryId);
}
