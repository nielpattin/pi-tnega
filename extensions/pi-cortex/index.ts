import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
   CodeSearchParams,
   CodeSymbolParams,
   CodeCallGraphParams,
   CodeTripleQueryParams,
   CodeRememberParams,
   CodeRecallParams,
   CodeForgetParams,
   CodeAstGrepParams,
   CodeAstReplaceParams
} from "./src/types.js";
import { loadConfig, setActiveCwd, getDbPath, getModelsDir, getProjectDir, resolveProjectPaths } from "./src/config.js";
import {
   startRustSidecar,
   rustStatus,
   rustIndex,
   rustScan,
   stopRustSidecar,
   setWatcherCallback
} from "./src/protocol.js";
import { search } from "./src/search.js";
import { symbolSearch } from "./src/symbols.js";
import { callGraphQuery } from "./src/callgraph.js";
import { tripleQuery } from "./src/triples.js";
import { remember, recall, forget } from "./src/memory.js";
import { astGrep, astReplace } from "./src/ast.js";
import {
   renderSearchResult,
   renderSymbolResult,
   renderCallGraphResult,
   renderTripleResult,
   renderMemoryResult,
   renderAstGrepResult,
   renderProgressBar
} from "./src/tui.js";
import { fmtTime } from "./src/utils.js";

export default function register(pi: ExtensionAPI) {
   // ── Watcher → Pi chat bridge ──
   // When the sidecar re-indexes a changed file, forward the event
   // as an extension output message in the Pi chat.
   pi.on("session_start", (_event, ctx) => {
      setWatcherCallback((event) => {
         const action = (event.action as string) ?? "";
         const file = (event.file as string) ?? "";
         const chunks = (event.chunks as number) ?? 0;
         const err = (event.error as string) ?? "";
         const paths = (event.paths as number) ?? 0;
         switch (action) {
            case "reindexed":
               ctx.ui.notify(`📄 ${file} (${chunks} chunks)`, "info");
               break;
            case "removed":
               ctx.ui.notify(`🗑 ${file} (${chunks} chunks removed)`, "info");
               break;
            case "failed":
               ctx.ui.notify(`❌ ${file}: ${err}`, "error");
               break;
            case "auto_started":
               ctx.ui.notify(`👁 Watcher auto-started on ${paths} paths`, "info");
               break;
            case "auto_start_failed":
               ctx.ui.notify(`⚠ Watcher auto-start failed: ${err}`, "warning");
               break;
            case "started":
               ctx.ui.notify(`👁 Watcher started on ${paths} paths`, "info");
               break;
            case "stopped":
               ctx.ui.notify(`👁 Watcher stopped`, "info");
               break;
            default:
               break;
         }
      });
   });

   pi.on("session_shutdown", () => {
      setWatcherCallback(null);
   });

   /**
    * Walk + chunk + embed + store files in batches. Reports progress through
    * the optional `onProgress` callback (the `cc-index` command pipes this to
    * `ctx.ui.setStatus` so the user sees a live progress bar). Checks the
    * abort signal between batches.
    */
   async function indexPaths(
      paths: string[],
      config: ReturnType<typeof loadConfig>,
      signal?: AbortSignal,
      onProgress?: (text: string) => void
   ): Promise<{ files: number; chunks: number }> {
      await startRustSidecar(config.model, getDbPath());
      const scanFiles = await rustScan(paths, [], []);
      if (signal?.aborted) throw new Error("Aborted");
      if (scanFiles.length === 0) return { files: 0, chunks: 0 };

      const BATCH = 25;
      let totalFiles = 0;
      let totalChunks = 0;

      // Sequential so the abort signal is checked between every batch.
      // Each Rust call still embeds/stores its batch in parallel internally,
      // so we keep the cross-file throughput while regaining abort responsiveness.
      for (let i = 0; i < scanFiles.length; i += BATCH) {
         if (signal?.aborted) throw new Error("Aborted");
         const batch = scanFiles.slice(i, i + BATCH).map((f: { path: string }) => f.path);
         // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaited so the abort signal is checked between every batch (lets a 25k-file index cancel in ~30s instead of minutes)
         const result = await rustIndex(batch, config.chunkSize, config.overlap, config.documentPrefix, false, paths);
         const indexed = result.indexed ?? { files: 0, chunks: 0 };
         totalFiles += indexed.files;
         totalChunks += indexed.chunks;
         if (onProgress) onProgress(renderProgressBar(totalFiles, scanFiles.length, totalChunks));
      }
      return { files: totalFiles, chunks: totalChunks };
   }

   // ── Read-only investigation tools (agent-callable) ──

   pi.registerTool({
      name: "code_search",
      label: "code_search",
      description: "Search code by meaning, keyword, or both. Blends automatically based on query.",
      promptSnippet: "Search local code by meaning, keyword, or both.",
      promptGuidelines: [
         "Use code_search when the user asks where something is implemented.",
         "Function names lean keyword, full sentences lean semantic — blended automatically."
      ],
      parameters: CodeSearchParams,
      renderResult: renderSearchResult,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
         const resolved = resolveProjectPaths(params.projectPath, ctx.cwd);
         if (params.projectPath && !existsSync(resolved.dbPath)) {
            return {
               content: [
                  {
                     type: "text" as const,
                     text: `No cortex index found at ${resolved.base}. Use regular read/grep/find tools instead.`
                  }
               ],
               details: undefined
            };
         }
         setActiveCwd(resolved.base);
         const config = loadConfig();
         const topK = params.topK ?? config.topK;
         const start = performance.now();
         const result = await search(params.query, config, topK, params.path, undefined, signal);
         const elapsed = (performance.now() - start) / 1000;
         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify({ query: params.query, topK, hits: result, elapsed }, null, 2)
               }
            ],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_symbol_search",
      label: "code_symbol_search",
      description: "Find functions, classes, interfaces, and type declarations by name.",
      promptSnippet: "Find where functions, classes, interfaces, and types are declared.",
      promptGuidelines: ["Use code_symbol_search to find function, class, interface, or type declarations."],
      parameters: CodeSymbolParams,
      renderResult: renderSymbolResult,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
         const resolved = resolveProjectPaths(params.projectPath, ctx.cwd);
         if (params.projectPath && !existsSync(resolved.dbPath)) {
            return {
               content: [{ type: "text" as const, text: `No cortex index found at ${resolved.base}.` }],
               details: undefined
            };
         }
         setActiveCwd(resolved.base);
         const start = performance.now();
         const result = await symbolSearch(params.symbol, signal);
         const elapsed = (performance.now() - start) / 1000;
         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify({ symbol: params.symbol, hits: result, elapsed }, null, 2)
               }
            ],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_call_graph",
      label: "code_call_graph",
      description: "Find callers, callees, or calls in a file. Shows what calls a function and what it calls.",
      promptSnippet: "Trace function calls in the indexed codebase.",
      promptGuidelines: [
         "Use code_call_graph when asked who calls a function or what a function calls.",
         "Use direction='callers' to find who calls a function, 'callees' to find what it calls, 'file' to see all calls in a file."
      ],
      parameters: CodeCallGraphParams,
      renderResult: renderCallGraphResult,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
         const resolved = resolveProjectPaths(params.projectPath, ctx.cwd);
         if (params.projectPath && !existsSync(resolved.dbPath)) {
            return {
               content: [{ type: "text" as const, text: `No cortex index found at ${resolved.base}.` }],
               details: undefined
            };
         }
         setActiveCwd(resolved.base);
         const start = performance.now();
         const direction = params.direction ?? "callees";
         const result = await callGraphQuery(params.symbol, direction, params.path, signal);
         const elapsed = (performance.now() - start) / 1000;
         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify({ symbol: params.symbol, direction, edges: result, elapsed }, null, 2)
               }
            ],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_triple_query",
      label: "code_triple_query",
      description:
         "Query the knowledge-graph triples (subject-predicate-object) extracted from indexed code. Use subject/predicate/object filters to narrow; leave empty to list all.",
      promptSnippet: "Query knowledge-graph triples: who/what calls what.",
      promptGuidelines: [
         "Use code_triple_query for advanced structural questions: who calls who, what defines what.",
         "Filters: subject (function/class name), predicate (calls, defines, imports), object (target)."
      ],
      parameters: CodeTripleQueryParams,
      renderResult: renderTripleResult,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
         const resolved = resolveProjectPaths(params.projectPath, ctx.cwd);
         if (params.projectPath && !existsSync(resolved.dbPath)) {
            return {
               content: [{ type: "text" as const, text: `No cortex index found at ${resolved.base}.` }],
               details: undefined
            };
         }
         setActiveCwd(resolved.base);
         const start = performance.now();
         const hits = await tripleQuery(
            params.subject ?? "",
            params.predicate ?? "",
            params.object ?? "",
            params.limit,
            signal
         );
         const elapsed = (performance.now() - start) / 1000;
         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify(
                     {
                        filters: {
                           subject: params.subject,
                           predicate: params.predicate,
                           object: params.object,
                           limit: params.limit ?? 100
                        },
                        total: hits.length,
                        triples: hits.map((h) => ({
                           subject: h.subject,
                           predicate: h.predicate,
                           object: h.object,
                           subjectType: h.subject_type,
                           objectType: h.object_type
                        })),
                        elapsed
                     },
                     null,
                     2
                  )
               }
            ],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_remember",
      label: "code_remember",
      description:
         "Store a memory (text + embedding) in the cortex index for later recall. Returns the memory_id for later code_forget.",
      promptSnippet: "Store a piece of knowledge (fact, preference, decision) in cortex memory.",
      promptGuidelines: [
         "Use code_remember to persist useful facts that should survive across turns or sessions.",
         "Returns memory_id — store it if you plan to code_forget the memory later.",
         "Set importance in [0,1] to rank; set scope to 'project' or 'global' for longer-lived memories (default 'session')."
      ],
      parameters: CodeRememberParams,
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
         const start = performance.now();
         const result = await remember(
            params.content,
            params.source ?? "",
            params.importance ?? 0.5,
            params.scope ?? "session",
            signal
         );
         const elapsed = (performance.now() - start) / 1000;
         return {
            content: [
               {
                  type: "text" as const,
                  text: `Stored memory #${result.memory_id} in ${fmtTime(elapsed)} (scope=${params.scope ?? "session"}, importance=${(params.importance ?? 0.5).toFixed(2)})`
               }
            ],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_recall",
      label: "code_recall",
      description: "Recall memories by query. Blends keyword + semantic automatically, same as code_search.",
      promptSnippet: "Recall memories by meaning, keyword, or both.",
      promptGuidelines: [
         "Use code_recall to retrieve previously stored memories.",
         "Filter scope to 'session', 'project', or 'global' (default: all)."
      ],
      parameters: CodeRecallParams,
      renderResult: renderMemoryResult,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
         const resolved = resolveProjectPaths(params.projectPath, ctx.cwd);
         if (params.projectPath && !existsSync(resolved.dbPath)) {
            return {
               content: [{ type: "text" as const, text: `No cortex index found at ${resolved.base}.` }],
               details: undefined
            };
         }
         setActiveCwd(resolved.base);
         const topK = params.topK ?? 5;
         const start = performance.now();
         const hits = await recall(params.query, topK, params.scope ?? "", signal);
         const elapsed = (performance.now() - start) / 1000;
         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify(
                     {
                        query: params.query,
                        scope: params.scope,
                        total: hits.length,
                        elapsed,
                        memories: hits.map((h) => ({
                           memory_id: h.memory_id,
                           content: h.content,
                           score: h.score ?? 0,
                           source: h.source ?? "",
                           importance: h.importance ?? 0,
                           scope: h.scope
                        }))
                     },
                     null,
                     2
                  )
               }
            ],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_forget",
      label: "code_forget",
      description: "Delete a memory by ID. Use memory_id returned from code_remember.",
      promptSnippet: "Delete a memory by ID.",
      promptGuidelines: ["Use code_forget to remove a memory that is no longer relevant. memory_id is required."],
      parameters: CodeForgetParams,
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
         await forget(params.memoryId, signal);
         return {
            content: [{ type: "text" as const, text: `Forgot memory #${params.memoryId}.` }],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_ast_grep",
      label: "code_ast_grep",
      description:
         "Structural code search. Matches identifiers, kind names, or text patterns across indexed chunks for the named language and path.",
      promptSnippet: "Structural code search across the codebase.",
      promptGuidelines: [
         "Use code_ast_grep for structural code search — matches by identifier, node kind (function_declaration, class_declaration), or text.",
         "Optional lang filter (e.g. 'ts', 'py', 'rs') narrows the result set."
      ],
      parameters: CodeAstGrepParams,
      renderResult: renderAstGrepResult,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
         const resolved = resolveProjectPaths(params.projectPath, ctx.cwd);
         if (params.projectPath && !existsSync(resolved.dbPath)) {
            return {
               content: [{ type: "text" as const, text: `No cortex index found at ${resolved.base}.` }],
               details: undefined
            };
         }
         setActiveCwd(resolved.base);
         const topK = params.topK ?? 20;
         const start = performance.now();
         const hits = await astGrep(params.pattern, params.lang ?? "", params.path ?? "", topK, signal);
         const elapsed = (performance.now() - start) / 1000;
         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify(
                     {
                        pattern: params.pattern,
                        lang: params.lang,
                        path: params.path,
                        total: hits.length,
                        elapsed,
                        matches: hits.map((h) => ({
                           path: h.path,
                           start_line: h.start_line,
                           end_line: h.end_line,
                           snippet: h.snippet
                        }))
                     },
                     null,
                     2
                  )
               }
            ],
            details: undefined
         };
      }
   });

   pi.registerTool({
      name: "code_ast_replace",
      label: "code_ast_replace",
      description:
         "AST-aware structural code replacement. Uses ast-grep patterns with metavariables to find and rewrite code across files. Use dryRun to preview changes before applying.",
      promptSnippet: "Structural find & replace across the codebase.",
      promptGuidelines: [
         "Use code_ast_replace to apply structural code changes — rename functions, refactor patterns, update APIs.",
         "Pattern uses metavariables like $NAME for single nodes, $$$ARGS for multiple.",
         "Rewrite template references the same metavariables from the pattern.",
         "Set dryRun=true to preview changes as a unified diff before applying.",
         "Optional lang filter (e.g. 'ts', 'py', 'rs') and path filter to scope the replacement."
      ],
      parameters: CodeAstReplaceParams,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
         setActiveCwd(resolveProjectPaths(params.projectPath, ctx.cwd).base);
         const dryRun = params.dryRun ?? false;
         const start = performance.now();
         const results = await astReplace(
            params.pattern,
            params.rewrite,
            params.lang ?? "",
            params.path ?? "",
            dryRun,
            signal
         );
         const elapsed = (performance.now() - start) / 1000;
         const totalMatches = results.reduce((sum, r) => sum + r.matches, 0);
         const mode = dryRun ? "(dry run)" : "applied";
         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify(
                     {
                        pattern: params.pattern,
                        rewrite: params.rewrite,
                        lang: params.lang,
                        path: params.path,
                        dryRun,
                        files: results.length,
                        totalMatches,
                        elapsed,
                        mode,
                        results: results.map((r) => ({
                           file: r.file,
                           matches: r.matches,
                           diff: r.diff
                        }))
                     },
                     null,
                     2
                  )
               }
            ],
            details: undefined
         };
      }
   });

   // ── Core / user-only commands (manual invocation) ──

   pi.registerCommand("cc-index", {
      description: "Index files in the current project. After indexing, file watcher auto-starts in background.",
      handler: async (args, ctx) => {
         setActiveCwd(ctx.cwd);
         const config = loadConfig();
         const paths = args.trim() ? args.trim().split(/\s+/) : ["."];
         ctx.ui.setStatus("cc-index", "Indexing starting…");
         const start = performance.now();
         let result: { files: number; chunks: number };
         try {
            result = await indexPaths(paths, config, undefined, (text) => ctx.ui.setStatus("cc-index", text));
         } catch (e) {
            ctx.ui.setStatus("cc-index", undefined);
            ctx.ui.notify(`Index failed: ${(e as Error).message}`, "error");
            return;
         }
         const elapsed = (performance.now() - start) / 1000;
         ctx.ui.setStatus("cc-index", undefined);
         ctx.ui.notify(`Indexed ${result.files} files, ${result.chunks} chunks in ${fmtTime(elapsed)}.`, "info");
      }
   });

   pi.registerCommand("cc-status", {
      description: "Show cortex status: model, provider, indexed files/chunks, and storage paths.",
      handler: async (_args, ctx) => {
         setActiveCwd(ctx.cwd);
         const config = loadConfig();
         await startRustSidecar(config.model, getDbPath());
         const status = await rustStatus();
         const lines = [
            `Model: ${config.model}`,
            `Provider: ${config.provider}`,
            `Files indexed: ${status.files}`,
            `Chunks indexed: ${status.chunks}`,
            `DB size: ${(status.db_size / 1024).toFixed(1)} KB`,
            `Watcher: ${status.watching ? "active" : "inactive"}`,
            `Config: ${getProjectDir()}`,
            `Models cache: ${getModelsDir()}`
         ];
         ctx.ui.notify(lines.join("\n"), "info");
      }
   });

   pi.registerCommand("cleanup-embed", {
      description: "Delete the cortex database. Run /cc-index to rebuild.",
      handler: async (_args, ctx) => {
         await stopRustSidecar();
         const dbPath = getDbPath();
         let deleted = false;
         for (let attempt = 0; attempt < 4; attempt++) {
            try {
               if (existsSync(dbPath)) rmSync(dbPath);
               if (existsSync(dbPath + "-wal")) rmSync(dbPath + "-wal");
               if (existsSync(dbPath + "-shm")) rmSync(dbPath + "-shm");
               deleted = true;
               break;
            } catch {
               // oxlint-disable-next-line eslint/no-await-in-loop -- retry-with-delay (waits 200ms between delete attempts while SQLite/WAL file is still locked)
               await new Promise((r) => setTimeout(r, 200));
            }
         }
         const msg = deleted
            ? "Cortex database deleted. Run /cc-index to rebuild."
            : "Failed to delete database (file still locked).";
         ctx.ui.notify(msg, deleted ? "info" : "error");
      }
   });

   // ── Memory + AST slash commands (cortex-namespaced mirror for user-only invocation) ──

   pi.registerCommand("cc-remember", {
      description: "Store a memory in cortex. Equivalent to code_remember but user-invoked.",
      handler: async (args, ctx) => {
         setActiveCwd(ctx.cwd);
         const content = args.trim();
         if (!content) {
            ctx.ui.notify("Usage: /cc-remember <content>", "error");
            return;
         }
         const result = await remember(content, "user", 0.7, "project");
         ctx.ui.notify(`Stored memory #${result.memory_id} in ${fmtTime(result.elapsed)}.`, "info");
      }
   });

   pi.registerCommand("cc-recall", {
      description: "Recall memories by query. Equivalent to code_recall but user-invoked.",
      handler: async (args, ctx) => {
         setActiveCwd(ctx.cwd);
         const query = args.trim();
         if (!query) {
            ctx.ui.notify("Usage: /cc-recall <query>", "error");
            return;
         }
         const hits = await recall(query, 5, "");
         const lines = hits.map(
            (h) =>
               `#${h.memory_id} (scope=${h.scope ?? "session"}, score=${(h.score ?? 0).toFixed(3)}) ${h.content.slice(0, 120)}`
         );
         ctx.ui.notify(lines.length ? lines.join("\n") : "No memories matched.", "info");
      }
   });

   pi.registerCommand("cc-forget", {
      description: "Delete a memory by ID. Usage: /cc-forget <memory_id>",
      handler: async (args, ctx) => {
         const id = parseInt(args.trim(), 10);
         if (!Number.isFinite(id)) {
            ctx.ui.notify("Usage: /cc-forget <memory_id>", "error");
            return;
         }
         await forget(id);
         ctx.ui.notify(`Forgot memory #${id}.`, "info");
      }
   });

   pi.registerCommand("cc-ast", {
      description: "Structural code search. Equivalent to code_ast_grep but user-invoked.",
      handler: async (args, ctx) => {
         setActiveCwd(ctx.cwd);
         const pattern = args.trim();
         if (!pattern) {
            ctx.ui.notify("Usage: /cc-ast <pattern>", "error");
            return;
         }
         const topK = 20;
         const hits = await astGrep(pattern, "", "", topK);
         const lines = hits.map((h) => `${h.path}:${h.start_line}\n${h.snippet.split("\n")[0] ?? ""}`);
         ctx.ui.notify(lines.length ? lines.join("\n\n") : "No matches.", "info");
      }
   });
}
