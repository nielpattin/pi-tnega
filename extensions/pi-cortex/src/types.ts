import { Type } from "@sinclair/typebox";

// ── Config ──

export interface Config {
   model: string;
   provider: string;
   baseUrl: string;
   apiKey: string;
   chunkSize: number;
   overlap: number;
   topK: number;
   indexBatchSize: number;
   queryPrefix: string;
   documentPrefix: string;
   watcherDebounceMs: number;
}

export const DEFAULT_CONFIG: Config = {
   model: "Xenova/all-MiniLM-L6-v2",
   provider: "local",
   baseUrl: "",
   apiKey: "",
   chunkSize: 80,
   overlap: 20,
   topK: 50,
   indexBatchSize: 256,
   queryPrefix: "query: ",
   documentPrefix: "passage: ",
   watcherDebounceMs: 2000
};

// ── Protocol types ──

export interface ScanFile {
   path: string;
   size: number;
   mtime: number;
}

export interface ChunkResult {
   text: string;
   start_line: number;
   end_line: number;
}

export interface IndexFileResult {
   path: string;
   error?: string;
   chunks: ChunkResult[];
}

export interface SearchResult {
   path: string;
   start_line: number;
   end_line: number;
   snippet: string;
   score: number;
}

export interface SymbolResult {
   symbol: string;
   kind: string;
   path: string;
   start_line: number;
   end_line: number;
   snippet: string;
}

export interface CallGraphResult {
   file_path: string;
   line: number;
   callee: string;
   caller: string;
}

export interface StatusResult {
   files: number;
   chunks: number;
   dim: number;
   db_size: number;
   watching: boolean;
   index_roots?: string[];
}

// ── Tool result types ──

export interface SearchHit {
   path: string;
   startLine: number;
   endLine: number;
   snippet: string;
   score: number;
}

export interface SymbolHit {
   symbol: string;
   kind: string;
   path: string;
   startLine: number;
   endLine: number;
   snippet: string;
}

export interface CallGraphHit {
   callerPath: string;
   callerSymbol: string;
   calleePath: string;
   calleeSymbol: string;
}

export interface SearchDetails {
   query?: string;
   path?: string;
   elapsed?: number;
   page?: number;
   pageSize?: number;
   totalPages?: number;
   hits: SearchHit[];
}

export interface TripleHit {
   subject: string;
   predicate: string;
   object: string;
   subjectType: string;
   objectType: string;
}

export interface TripleDetails {
   subject?: string;
   predicate?: string;
   elapsed?: number;
   total?: number;
   limit?: number;
   page?: number;
   pageSize?: number;
   totalPages?: number;
   hits: TripleHit[];
}

export interface MemoryHit {
   memoryId: number;
   content: string;
   score: number;
   source: string;
   importance: number;
   scope: string;
}

export interface MemoryDetails {
   query?: string;
   scope?: string;
   elapsed?: number;
   page?: number;
   pageSize?: number;
   totalPages?: number;
   hits: MemoryHit[];
}

export interface AstGrepHit {
   path: string;
   startLine: number;
   endLine: number;
   snippet: string;
}

export interface AstGrepDetails {
   pattern: string;
   lang?: string;
   path?: string;
   elapsed?: number;
   page?: number;
   pageSize?: number;
   totalPages?: number;
   hits: AstGrepHit[];
}

export interface OutlineHit {
   symbol: string;
   kind: string;
   path: string;
   startLine: number;
   endLine: number;
}

export interface OutlineDetails {
   path?: string;
   files?: number;
   truncated?: boolean;
   elapsed?: number;
   page?: number;
   pageSize?: number;
   totalPages?: number;
   hits: OutlineHit[];
}

export const CodeOutlineParams = Type.Object({
   path: Type.String({ description: "File or directory to outline (lists every symbol with kind and line range)" }),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   projectPath: Type.Optional(Type.String({ description: "Project root (defaults to current project)" }))
});

// ── TypeBox schemas ──

export const CodeSearchParams = Type.Object({
   query: Type.String({
      description:
         'Search query. Function names (validateInput) lean keyword; sentences ("how does auth work") lean semantic; blended automatically.'
   }),
   topK: Type.Optional(Type.Number({ description: "Number of results", minimum: 1, maximum: 50 })),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   path: Type.Optional(Type.String({ description: "Limit search to this path" })),
   projectPath: Type.Optional(Type.String({ description: "Project root to search (defaults to current project)" }))
});

export const CodeSymbolParams = Type.Object({
   symbol: Type.String({ description: "Symbol name to look up" }),
   kind: Type.Optional(
      Type.String({
         description: "Only symbols of this kind: function, class, variable, interface, type, struct, enum, trait"
      })
   ),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   projectPath: Type.Optional(Type.String({ description: "Project root to search (defaults to current project)" }))
});

export const CodeCallGraphParams = Type.Object({
   symbol: Type.String({ description: "Function or method name to trace" }),
   direction: Type.Optional(
      Type.String({ description: "Trace direction", enum: ["callers", "callees", "file"] as const })
   ),
   path: Type.Optional(Type.String({ description: "File path filter (required when direction='file')" })),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   projectPath: Type.Optional(Type.String({ description: "Project root to query (defaults to current project)" }))
});

export const CodeTripleQueryParams = Type.Object({
   subject: Type.Optional(Type.String({ description: "Filter on subject (function/class/module name)" })),
   predicate: Type.Optional(Type.String({ description: "Filter on predicate (calls, defines, imports, etc.)" })),
   object: Type.Optional(Type.String({ description: "Filter on object (target name)" })),
   limit: Type.Optional(Type.Number({ description: "Max triples to return", minimum: 1, maximum: 500 })),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   projectPath: Type.Optional(Type.String({ description: "Project root to query (defaults to current project)" }))
});

export const CodeRememberParams = Type.Object({
   content: Type.String({ description: "The text to remember. Will be embedded and stored for later recall." }),
   source: Type.Optional(Type.String({ description: "Where this memory came from (e.g. tool name, url, file)" })),
   importance: Type.Optional(
      Type.Number({ description: "Importance 0-1; higher = prioritised in recall", minimum: 0, maximum: 1 })
   ),
   scope: Type.Optional(Type.String({ description: "Memory scope", enum: ["session", "project", "global"] as const }))
});

export const CodeRecallParams = Type.Object({
   query: Type.String({
      description: "Query to recall memories for. Function names lean keyword; sentences lean semantic."
   }),
   topK: Type.Optional(Type.Number({ description: "Number of memories to return", minimum: 1, maximum: 50 })),
   scope: Type.Optional(
      Type.String({ description: "Limit to memories in this scope (session, project, global); empty = all" })
   ),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   projectPath: Type.Optional(Type.String({ description: "Project root (defaults to current project)" }))
});

export const CodeForgetParams = Type.Object({
   memoryId: Type.Number({ description: "Memory ID returned by code_remember" })
});

export const CodeAstGrepParams = Type.Object({
   pattern: Type.String({
      description:
         "Pattern to match. For function names use a plain identifier (e.g. 'login'); for node kinds use a kind (e.g. 'function_declaration'); for text use any string.",
      minLength: 1
   }),
   lang: Type.Optional(
      Type.String({ description: "Limit to files of this language/extension (e.g. 'ts', 'py', 'rs')" })
   ),
   path: Type.Optional(Type.String({ description: "Limit to this file or directory" })),
   topK: Type.Optional(Type.Number({ description: "Max results", minimum: 1, maximum: 200 })),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   projectPath: Type.Optional(Type.String({ description: "Project root (defaults to current project)" }))
});

export const CodeAstReplaceParams = Type.Object({
   pattern: Type.String({
      description: "ast-grep pattern with metavariables (e.g. 'console.log($MSG)'). Same syntax as code_ast_grep.",
      minLength: 1
   }),
   rewrite: Type.String({
      description:
         "Replacement template using bound metavariables (e.g. 'logger.info($MSG)'). All $vars must appear in the pattern.",
      minLength: 1
   }),
   lang: Type.Optional(
      Type.String({ description: "Limit to files of this language/extension (e.g. 'ts', 'py', 'rs')" })
   ),
   path: Type.Optional(Type.String({ description: "Limit to this file or directory" })),
   dryRun: Type.Optional(
      Type.Boolean({ description: "Preview changes without applying (default false). Returns unified diff." })
   ),
   page: Type.Optional(Type.Number({ description: "Page number (1-based); 10 results per page", minimum: 1 })),
   projectPath: Type.Optional(Type.String({ description: "Project root (defaults to current project)" }))
});
