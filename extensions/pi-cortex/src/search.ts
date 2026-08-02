import { rustSend } from "./protocol.js";
import { relative } from "node:path";
import type { Config, SearchResult, SearchHit } from "./types.js";
import { startRustSidecar, rustSearch, rustTextSearch } from "./protocol.js";
import { getActiveCwd, getDbPath, loadConfig } from "./config.js";
import { detectKeywordWeight, isExactIdentifierQuery } from "./utils.js";

/**
 * Embed a single query text using the configured embedder. Wraps `getEmbedder`
 * with the document/query prefix so callers don't have to repeat that logic.
 */
export async function embedQuery(text: string, config: Config, signal?: AbortSignal): Promise<Float32Array> {
   const embedder = await getEmbedder(config);
   const [vec] = await embedder.embed([config.queryPrefix + text], signal);
   return vec;
}

/**
 * Run a search query. Exact identifiers use the lexical lane; other queries
 * are embedded and sent to the sidecar with an auto-detected blend weight.
 */
export async function search(
   query: string,
   config: Config,
   topK: number,
   pathFilter?: string,
   rerank?: boolean,
   signal?: AbortSignal
): Promise<SearchHit[]> {
   await startRustSidecar(config.model, getDbPath());

   if (isExactIdentifierQuery(query)) {
      const results = await rustTextSearch(query, topK, pathFilter, signal);
      return mapSearchResults(results);
   }

   const run = await getEmbedder(config);
   const [queryEmb] = await run.embed([config.queryPrefix + query], signal);

   const keywordWeight = detectKeywordWeight(query);
   const results = await rustSearch(query, Array.from(queryEmb), topK, keywordWeight, pathFilter, rerank, signal);
   return mapSearchResults(results);
}

function mapSearchResults(results: SearchResult[]): SearchHit[] {
   return results.map((r: SearchResult) => ({
      path: relative(getActiveCwd(), r.path) || r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      snippet: r.snippet,
      score: r.score
   }));
}

// ── Embedder abstraction ──

interface Embedder {
   embed: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;
}

const _embedderCache = new Map<string, Embedder>();

async function getRemoteEmbedder(config: Config): Promise<Embedder> {
   const cacheKey = `remote:${config.model}:${config.baseUrl}:${config.apiKey}`;
   const cached = _embedderCache.get(cacheKey);
   if (cached) return cached;

   const embed = async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
      const res = await fetch(`${config.baseUrl || "https://api.openai.com/v1"}/embeddings`, {
         method: "POST",
         headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
         },
         body: JSON.stringify({ model: config.model, input: texts }),
         signal
      });
      if (!res.ok) {
         const body = await res.text().catch(() => "");
         throw new Error(`Embedding API error ${res.status}: ${body}`);
      }
      const json = await res.json();
      const data = (json as { data: { embedding: number[] }[] }).data;
      return data.map((d) => new Float32Array(d.embedding));
   };

   const e = { embed };
   _embedderCache.set(cacheKey, e);
   return e;
}

function getLocalEmbedder(config: Config): Embedder {
   const cacheKey = `local:${config.model}`;
   const cached = _embedderCache.get(cacheKey);
   if (cached) return cached;

   const embed = async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
      const r = (await rustSend({ texts: { model: config.model, texts } }, 60000, signal)) as {
         embeddings: number[][];
      };
      return r.embeddings.map((e) => new Float32Array(e));
   };

   const e = { embed };
   _embedderCache.set(cacheKey, e);
   return e;
}

export async function getEmbedder(config: Config): Promise<Embedder> {
   if (config.provider === "local") return getLocalEmbedder(config);
   return getRemoteEmbedder(config);
}
