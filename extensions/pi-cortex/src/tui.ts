import { keyText } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SearchHit, SearchDetails, TripleDetails, MemoryDetails, AstGrepDetails } from "./types.js";
import { fmtTime } from "./utils.js";

function fg(theme: Theme | undefined, color: Parameters<Theme["fg"]>[0], text: string): string {
   return theme?.fg(color, text) ?? text;
}

function bold(theme: Theme | undefined, text: string): string {
   return theme?.bold(text) ?? text;
}

function toolTitle(theme: Theme | undefined, name: string): string {
   return fg(theme, "toolTitle", bold(theme, name));
}

function expandHint(theme: Theme | undefined, expanded: boolean): string {
   const key = fg(theme, "dim", keyText("app.tools.expand"));
   const description = fg(theme, "muted", ` ${expanded ? "to collapse" : "to expand"}`);
   return `(${key}${description})`;
}

/** ` page P/M` suffix when a result spans multiple pages (pagination). */
function pageNote(theme: Theme | undefined, data: object): string {
   const tp = Number((data as { totalPages?: unknown }).totalPages) || 0;
   if (tp <= 1) return "";
   const p = Number((data as { page?: unknown }).page) || 1;
   return ` ${fg(theme, "dim", `page ${p}/${tp}`)}`;
}

/**
 * Extract JSON-serialized data from a tool result. Returns `unknown`; callers
 * cast at the use site. Handles three cases:
 *  - `result.details` is the typed payload (preferred)
 *  - `result.details` is missing/undefined or an empty object — pi fills
 *    `details: {}` on error paths, so fall back to JSON.parse(content[0].text)
 *  - everything is missing → returns null
 */
function extract(result: unknown): unknown {
   if (!result || typeof result !== "object") return null;
   const r = result as { details?: unknown; content?: Array<{ text?: string }> };
   const d = r.details;
   if (d && typeof d === "object" && Object.keys(d).length > 0) return d;
   const text = r.content?.[0]?.text;
   if (typeof text !== "string" || !text.trim()) return null;
   try {
      return JSON.parse(text);
   } catch {
      return null;
   }
}

/**
 * Extract the error message from a tool result. Pi wraps thrown errors in
 * `content` text with `isError: true`; `context.isError` covers renderers
 * that don't receive the full result. Returns undefined when not an error.
 */
function errorText(result: unknown, context?: { isError?: boolean }): string | undefined {
   if (!result || typeof result !== "object") return undefined;
   const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
   if (!r.isError && !context?.isError) return undefined;
   const text = r.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
   return text || undefined;
}

/**
 * Render the call of `code_search`.
 */
export function renderSearchCall(
   args: { query: string; topK?: number; path?: string; page?: number },
   theme: Theme
): Text {
   const query = fg(theme, "accent", JSON.stringify(args.query));
   const path = args.path ? ` ${fg(theme, "dim", `path=${args.path}`)}` : "";
   const page = args.page ? ` ${fg(theme, "dim", `page=${args.page}`)}` : "";
   return new Text(`${toolTitle(theme, "code_search")} ${query}${path}${page}`, 0, 0);
}

/**
 * Render search results: collapsed shows only the summary line (count +
 * elapsed); expanded shows every hit with its snippet.
 */
export function renderSearchResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   theme?: Theme,
   context?: { isError?: boolean }
) {
   if (options.isPartial) return new Text(fg(theme, "warning", "Searching..."), 0, 0);

   const err = errorText(result, context);
   if (err) return new Text(fg(theme, "error", err), 0, 0);

   const data = extract(result) as (SearchDetails & { hits?: SearchHit[] }) | null;
   if (!data) return new Text(fg(theme, "muted", "(empty result)"), 0, 0);

   const hits = data.hits ?? [];
   const countColor = hits.length > 0 ? "success" : "warning";
   const lines = [
      `${fg(theme, countColor, `${hits.length} hit${hits.length === 1 ? "" : "s"}`)} ${fg(theme, "dim", `took ${fmtTime(data.elapsed ?? 0)}`)}${pageNote(theme, data)}`
   ];
   if (options.expanded) {
      if (hits.length === 0) {
         lines.push(fg(theme, "warning", "(no hits)"));
      } else {
         for (let i = 0; i < hits.length; i++) {
            const h = hits[i];
            lines.push(
               `${fg(theme, "dim", `[${i + 1}]`)} ${fg(theme, "accent", h.path)} ${fg(theme, "dim", `${h.startLine}-${h.endLine} score=${h.score.toFixed(3)}`)}`
            );
            lines.push(fg(theme, "toolOutput", String(h.snippet ?? "")));
         }
         lines.push(expandHint(theme, true));
      }
   }
   return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render the call of `code_symbol_search`.
 */
export function renderSymbolCall(args: { symbol: string; kind?: string; page?: number }, theme: Theme): Text {
   const kind = args.kind ? ` ${fg(theme, "dim", `kind=${args.kind}`)}` : "";
   const page = args.page ? ` ${fg(theme, "dim", `page=${args.page}`)}` : "";
   return new Text(`${toolTitle(theme, "code_symbol_search")} ${fg(theme, "accent", args.symbol)}${kind}${page}`, 0, 0);
}

/**
 * Render the result of `code_symbol_search`.
 */
export function renderSymbolResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   theme?: Theme,
   context?: { isError?: boolean }
) {
   if (options.isPartial) return new Text(fg(theme, "warning", "Searching..."), 0, 0);

   const err = errorText(result, context);
   if (err) return new Text(fg(theme, "error", err), 0, 0);

   const data = extract(result) as {
      symbol?: string;
      elapsed?: number;
      hits?: Array<{
         symbol: string;
         kind?: string;
         path: string;
         startLine: number;
         endLine: number;
         snippet: string;
      }>;
   } | null;
   if (!data) return new Text(fg(theme, "muted", "(empty result)"), 0, 0);

   const hits = data.hits ?? [];
   const countColor = hits.length > 0 ? "success" : "warning";
   const lines = [
      `${fg(theme, countColor, `${hits.length} hit${hits.length === 1 ? "" : "s"}`)} ${fg(theme, "dim", `took ${fmtTime(data.elapsed ?? 0)}`)}${pageNote(theme, data)}`
   ];
   if (options.expanded) {
      if (hits.length === 0) {
         lines.push(fg(theme, "warning", "(no symbols found)"));
      } else {
         for (let i = 0; i < hits.length; i++) {
            const h = hits[i];
            const kind = h.kind ? `${fg(theme, "dim", h.kind)} ` : "";
            lines.push(
               `${fg(theme, "dim", `[${i + 1}]`)} ${kind}${fg(theme, "accent", h.symbol)} ${fg(theme, "dim", `${h.path}:${h.startLine}-${h.endLine}`)}`
            );
            lines.push(fg(theme, "toolOutput", String(h.snippet ?? "")));
         }
         lines.push(expandHint(theme, true));
      }
   }
   return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render the call of `code_outline`.
 */
export function renderOutlineCall(args: { path: string; page?: number }, theme: Theme): Text {
   const page = args.page ? ` ${fg(theme, "dim", `page=${args.page}`)}` : "";
   return new Text(
      `${toolTitle(theme, "code_outline")} ${fg(theme, "accent", JSON.stringify(args.path))}${page}`,
      0,
      0
   );
}

/**
 * Render the result of `code_outline`.
 */
export function renderOutlineResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   theme?: Theme,
   context?: { isError?: boolean }
) {
   if (options.isPartial) return new Text(fg(theme, "warning", "Outlining..."), 0, 0);

   const err = errorText(result, context);
   if (err) return new Text(fg(theme, "error", err), 0, 0);

   const data = extract(result) as {
      path?: string;
      files?: number;
      truncated?: boolean;
      elapsed?: number;
      symbols?: Array<{ symbol: string; kind?: string; path: string; startLine: number; endLine: number }>;
   } | null;
   if (!data) return new Text(fg(theme, "muted", "(empty result)"), 0, 0);

   const hits = data.symbols ?? [];
   const countColor = hits.length > 0 ? "success" : "warning";
   const truncatedNote = data.truncated ? ` ${fg(theme, "warning", "(first 2000 shown)")}` : "";
   const lines = [
      `${fg(theme, countColor, `${hits.length} symbol${hits.length === 1 ? "" : "s"}`)} ${fg(theme, "dim", `took ${fmtTime(data.elapsed ?? 0)}`)}${pageNote(theme, data)}${truncatedNote}`
   ];
   if (options.expanded) {
      if (hits.length === 0) {
         lines.push(fg(theme, "warning", "(no symbols found)"));
      } else {
         for (let i = 0; i < hits.length; i++) {
            const h = hits[i];
            const kind = h.kind ? `${fg(theme, "dim", h.kind)} ` : "";
            lines.push(
               `${fg(theme, "dim", `[${i + 1}]`)} ${kind}${fg(theme, "accent", h.symbol)} ${fg(theme, "dim", `${h.path}:${h.startLine}-${h.endLine}`)}`
            );
         }
         lines.push(expandHint(theme, true));
      }
   }
   return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render the call of `code_call_graph`.
 */
export function renderCallGraphCall(args: { symbol: string; direction?: string; page?: number }, theme: Theme): Text {
   const direction = args.direction ? ` ${fg(theme, "dim", args.direction)}` : "";
   const page = args.page ? ` ${fg(theme, "dim", `page=${args.page}`)}` : "";
   return new Text(
      `${toolTitle(theme, "code_call_graph")} ${fg(theme, "accent", args.symbol)}${direction}${page}`,
      0,
      0
   );
}

/**
 * Render the result of `code_call_graph`.
 */
export function renderCallGraphResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   theme?: Theme,
   context?: { isError?: boolean }
) {
   if (options.isPartial) return new Text(fg(theme, "warning", "Tracing..."), 0, 0);

   const err = errorText(result, context);
   if (err) return new Text(fg(theme, "error", err), 0, 0);

   const data = extract(result) as {
      symbol?: string;
      direction?: string;
      elapsed?: number;
      edges?: Array<{ callerSymbol: string; callerPath: string; calleeSymbol: string; calleePath: string }>;
   } | null;
   if (!data) return new Text(fg(theme, "muted", "(empty result)"), 0, 0);

   const edges = data.edges ?? [];
   const countColor = edges.length > 0 ? "success" : "warning";
   const lines = [
      `${fg(theme, countColor, `${edges.length} edge${edges.length === 1 ? "" : "s"}`)} ${fg(theme, "dim", `took ${fmtTime(data.elapsed ?? 0)}`)}${pageNote(theme, data)}`
   ];
   if (options.expanded) {
      if (edges.length === 0) {
         lines.push(fg(theme, "warning", "(no edges)"));
      } else {
         for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            lines.push(`${fg(theme, "accent", e.callerSymbol ?? "?")} → ${fg(theme, "accent", e.calleeSymbol ?? "?")}`);
            lines.push(fg(theme, "dim", `  ${e.callerPath} → ${e.calleePath}`));
         }
         lines.push(expandHint(theme, true));
      }
   }
   return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render the result of `code_triple_query`. Collapsed: title + summary line;
 * expanded: every triple.
 */
export function renderTripleResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
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
   c.addChild(
      new Text(`hits=${triples.length} elapsed=${(data.elapsed ?? 0).toFixed(3)}s${pageNote(undefined, data)}`)
   );
   const visible = options.expanded ? triples : triples.slice(0, 1);
   for (const t of visible as Array<{ subject: string; predicate: string; object: string }>) {
      c.addChild(new Text(`${t.subject} --${t.predicate}--> ${t.object}`));
   }
   return c;
}

/**
 * Render the result of `code_recall`. Collapsed: title + summary line;
 * expanded: every memory with its snippet.
 */
export function renderMemoryResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
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
   c.addChild(
      new Text(`hits=${memories.length} elapsed=${(data.elapsed ?? 0).toFixed(3)}s${pageNote(undefined, data)}`)
   );
   const visible = options.expanded ? memories : memories.slice(0, 1);
   for (const m of visible as Array<{
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
      c.addChild(new Text(m.content ?? ""));
   }
   return c;
}

/**
 * Render the call of `code_ast_grep`.
 */
export function renderAstGrepCall(
   args: { pattern: string; lang?: string; path?: string; topK?: number; page?: number },
   theme: Theme
): Text {
   const lang = args.lang ? ` lang=${args.lang}` : "";
   const path = args.path ? ` path=${args.path}` : "";
   const page = args.page ? ` page=${args.page}` : "";
   return new Text(
      `${toolTitle(theme, "code_ast_grep")} ${fg(theme, "accent", JSON.stringify(args.pattern))}${fg(theme, "dim", `${lang}${path}${page}`)}`,
      0,
      0
   );
}

/**
 * Render the result of `code_ast_grep`.
 */
export function renderAstGrepResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   theme?: Theme,
   context?: { isError?: boolean }
) {
   if (options.isPartial) return new Text(fg(theme, "warning", "Searching..."), 0, 0);

   const err = errorText(result, context);
   if (err) return new Text(fg(theme, "error", err), 0, 0);

   const data = extract(result) as
      | (AstGrepDetails & {
           matches?: Array<{ path: string; start_line: number; end_line: number; snippet: string }>;
        })
      | null;
   if (!data) return new Text(fg(theme, "muted", "(empty result)"), 0, 0);

   const matches = data.hits ?? data.matches ?? [];
   const countColor = matches.length > 0 ? "success" : "warning";
   const lines = [
      `${fg(theme, countColor, `${matches.length} hit${matches.length === 1 ? "" : "s"}`)} ${fg(theme, "dim", `took ${fmtTime(data.elapsed ?? 0)}`)}${pageNote(theme, data)}`
   ];
   if (options.expanded) {
      if (matches.length === 0) {
         lines.push(fg(theme, "warning", "(no matches)"));
      } else {
         for (let i = 0; i < matches.length; i++) {
            const h = matches[i] as {
               path: string;
               startLine?: number;
               start_line?: number;
               endLine?: number;
               end_line?: number;
               snippet?: string;
            };
            const sl = h.startLine ?? h.start_line ?? 0;
            const el = h.endLine ?? h.end_line ?? 0;
            lines.push(
               `${fg(theme, "dim", `[${i + 1}]`)} ${fg(theme, "accent", h.path)} ${fg(theme, "dim", `${sl}-${el}`)}`
            );
            lines.push(fg(theme, "toolOutput", String(h.snippet ?? "")));
         }
         lines.push(expandHint(theme, true));
      }
   }
   return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render the call of `code_ast_replace`.
 */
export function renderAstReplaceCall(
   args: { pattern: string; rewrite: string; lang?: string; path?: string; dryRun?: boolean; page?: number },
   theme: Theme
): Text {
   const dry = args.dryRun ? " (dry run)" : "";
   const lang = args.lang ? ` lang=${args.lang}` : "";
   const path = args.path ? ` path=${args.path}` : "";
   const page = args.page ? ` page=${args.page}` : "";
   return new Text(
      `${toolTitle(theme, "code_ast_replace")} ${fg(theme, "accent", JSON.stringify(args.pattern))} ${fg(theme, "dim", `→ ${JSON.stringify(args.rewrite)}${dry}${lang}${path}${page}`)}`,
      0,
      0
   );
}

/**
 * Render the result of `code_ast_replace`. Collapsed: only the summary line.
 * Expanded: one stat row per file (`path  N matches  +added/-removed`).
 * Diffs are intentionally not rendered — the agent transcript already omits
 * them, and the stat rows are all the summary needs.
 */
export function renderAstReplaceResult(
   result: unknown,
   options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
   theme?: Theme,
   context?: { isError?: boolean }
) {
   if (options.isPartial) return new Text(fg(theme, "warning", "Previewing..."), 0, 0);

   const err = errorText(result, context);
   if (err) return new Text(fg(theme, "error", err), 0, 0);

   const data = extract(result) as {
      pattern?: string;
      rewrite?: string;
      lang?: string;
      dryRun?: boolean;
      files?: number;
      totalMatches?: number;
      elapsed?: number;
      truncated?: boolean;
      results?: Array<{ file: string; matches: number; added?: number; removed?: number; diff?: string }>;
   } | null;
   if (!data) return new Text(fg(theme, "muted", "(empty result)"), 0, 0);

   const files = data.results ?? [];
   const countColor = files.length > 0 ? "success" : "warning";
   const lines = [
      `${fg(theme, countColor, `${files.length} file${files.length === 1 ? "" : "s"} ${data.totalMatches ?? 0} match${data.totalMatches === 1 ? "" : "es"}`)} ${fg(theme, "dim", `took ${fmtTime(data.elapsed ?? 0)}`)}${pageNote(theme, data)}`
   ];
   if (options.expanded) {
      if (files.length === 0) {
         lines.push(
            fg(
               theme,
               "warning",
               "(no literal matches: this tool matches substrings, not AST nodes, so metavariables like $MSG never match)"
            )
         );
      } else {
         for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const stats = `${fg(theme, "toolDiffAdded", `+${f.added ?? 0}`)}/${fg(theme, "toolDiffRemoved", `-${f.removed ?? 0}`)}`;
            lines.push(
               `${fg(theme, "dim", `[${i + 1}]`)} ${fg(theme, "accent", f.file)} ${fg(theme, "dim", `${f.matches} match${f.matches === 1 ? "" : "es"}`)} ${stats}`
            );
         }
         lines.push(expandHint(theme, true));
      }
   }
   return new Text(lines.join("\n"), 0, 0);
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
