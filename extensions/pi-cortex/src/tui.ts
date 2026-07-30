import { Container, Text } from "@earendil-works/pi-tui";
import type { SearchHit, SearchDetails, TripleDetails, MemoryDetails, AstGrepDetails } from "./types.js";

/**
 * Extract JSON-serialized data from a tool result. Returns `unknown`; callers
 * cast at the use site. Handles two cases:
 *  - `result.details` is the typed payload (preferred)
 *  - `result.details` is missing/undefined — fall back to JSON.parse(content[0].text)
 *  - everything is missing → returns null
 */
function extract(result: unknown): unknown {
   if (!result || typeof result !== "object") return null;
   const r = result as { details?: unknown; content?: Array<{ text?: string }> };
   const d = r.details;
   if (d && typeof d === "object") return d;
   const text = r.content?.[0]?.text;
   if (typeof text !== "string" || !text.trim()) return null;
   try {
      return JSON.parse(text);
   } catch {
      return null;
   }
}

/**
 * Render search results: header + trimmed-line hits.
 */
export function renderSearchResult(
   result: unknown,
   _options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   _theme?: unknown
) {
   const root = new Container();
   root.addChild(new Text("code_search", 1, 0));

   const data = extract(result) as (SearchDetails & { hits?: SearchHit[] }) | null;
   if (!data) {
      root.addChild(new Text("(empty result)"));
      return root;
   }

   root.addChild(new Text(`query=${JSON.stringify(data.query ?? "")} hits=${data.hits?.length ?? 0}`));

   const hits = data.hits ?? [];
   if (hits.length === 0) {
      root.addChild(new Text("(no hits)"));
      return root;
   }
   for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const head = `[${i + 1}] ${h.path}:${h.startLine}-${h.endLine}  score=${h.score.toFixed(3)}`;
      root.addChild(new Text(head));
      const snippet = (h.snippet ?? "").split("\n").slice(0, 6).join("\n");
      root.addChild(new Text(snippet));
   }
   return root;
}

/**
 * Render the result of `code_symbol_search`.
 */
export function renderSymbolResult(
   result: unknown,
   _options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   _theme?: unknown
) {
   const c = new Container();
   c.addChild(new Text("code_symbol_search", 1, 0));
   const data = extract(result) as {
      hits?: Array<{ symbol: string; path: string; startLine: number; endLine: number; snippet: string }>;
   } | null;
   const hits = data?.hits ?? [];
   if (hits.length === 0) {
      c.addChild(new Text("(no symbols found)"));
      return c;
   }
   for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      c.addChild(new Text(`[${i + 1}] ${h.symbol}  ${h.path}:${h.startLine}-${h.endLine}`));
      c.addChild(new Text(String(h.snippet ?? "").slice(0, 240)));
   }
   return c;
}

/**
 * Render the result of `code_call_graph`.
 */
export function renderCallGraphResult(
   result: unknown,
   _options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   _theme?: unknown
) {
   const c = new Container();
   c.addChild(new Text("code_call_graph", 1, 0));
   const data = extract(result) as {
      edges?: Array<{ callerPath: string; callerSymbol: string; calleePath: string; calleeSymbol: string }>;
   } | null;
   const edges = data?.edges ?? [];
   if (edges.length === 0) {
      c.addChild(new Text("(no edges)"));
      return c;
   }
   for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      c.addChild(new Text(`[${i + 1}] ${e.callerSymbol ?? "?"} -> ${e.calleeSymbol ?? "?"}`));
      c.addChild(new Text(`    ${e.callerPath}  →  ${e.calleePath}`));
   }
   return c;
}

/**
 * Render the result of `code_triple_query`.
 */
export function renderTripleResult(
   result: unknown,
   _options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   _theme?: unknown
) {
   const c = new Container();
   c.addChild(new Text("code_triple_query", 1, 0));
   const data = extract(result) as
      | (TripleDetails & { triples?: Array<{ subject: string; predicate: string; object: string }> })
      | null;
   if (!data) {
      c.addChild(new Text("(empty)"));
      return c;
   }
   const triples = data.hits ?? data.triples ?? [];
   c.addChild(new Text(`hits=${triples.length} elapsed=${(data.elapsed ?? 0).toFixed(3)}s`));
   for (const t of triples as Array<{ subject: string; predicate: string; object: string }>) {
      c.addChild(new Text(`${t.subject} --${t.predicate}--> ${t.object}`));
   }
   return c;
}

/**
 * Render the result of `code_recall`.
 */
export function renderMemoryResult(
   result: unknown,
   _options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   _theme?: unknown
) {
   const c = new Container();
   c.addChild(new Text("code_recall", 1, 0));
   const data = extract(result) as
      | (MemoryDetails & {
           memories?: Array<{
              memory_id: number;
              content: string;
              score: number;
              source: string;
              importance: number;
              scope: string;
           }>;
           hits?: Array<{
              memoryId: number;
              content: string;
              score: number;
              source: string;
              importance: number;
              scope: string;
           }>;
        })
      | null;
   if (!data) {
      c.addChild(new Text("(empty)"));
      return c;
   }
   const memories = data.hits ?? data.memories ?? [];
   c.addChild(new Text(`hits=${memories.length} elapsed=${(data.elapsed ?? 0).toFixed(3)}s`));
   for (const m of memories as Array<{
      memoryId?: number;
      memory_id?: number;
      content: string;
      score: number;
      source: string;
      importance: number;
      scope: string;
   }>) {
      const id = m.memoryId ?? m.memory_id ?? "?";
      const head = `#${id} (${m.scope ?? "session"}, imp=${(m.importance ?? 0).toFixed(2)}) score=${(m.score ?? 0).toFixed(3)} ${m.source ? `[${m.source}]` : ""}`;
      c.addChild(new Text(head));
      c.addChild(new Text((m.content ?? "").slice(0, 240)));
   }
   return c;
}

/**
 * Render the result of `code_ast_grep`.
 */
export function renderAstGrepResult(
   result: unknown,
   _options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   _theme?: unknown
) {
   const c = new Container();
   c.addChild(new Text("code_ast_grep", 1, 0));
   const data = extract(result) as
      | (AstGrepDetails & {
           matches?: Array<{ path: string; start_line: number; end_line: number; snippet: string }>;
        })
      | null;
   if (!data) {
      c.addChild(new Text("(empty)"));
      return c;
   }
   const matches = data.hits ?? data.matches ?? [];
   c.addChild(new Text(`pattern=${JSON.stringify(data.pattern ?? "")} hits=${matches.length}`));
   for (const h of matches as Array<{
      path: string;
      start_line?: number;
      startLine?: number;
      end_line?: number;
      endLine?: number;
      snippet: string;
   }>) {
      const sl = h.startLine ?? h.start_line ?? 0;
      const el = h.endLine ?? h.end_line ?? 0;
      c.addChild(new Text(`${h.path}:${sl}-${el}`));
      c.addChild(new Text((h.snippet ?? "").slice(0, 240)));
   }
   return c;
}

/**
 * Plain-text progress bar used during indexing.
 */
export function renderProgressBar(files: number, total: number, chunks: number): string {
   const width = 20;
   const pct = total > 0 ? files / total : 0;
   const filled = Math.round(pct * width);
   const bar = "▰".repeat(filled) + "▱".repeat(width - filled);
   return `Indexing [${bar}] ${files}/${total} files, ${chunks} chunks`;
}
