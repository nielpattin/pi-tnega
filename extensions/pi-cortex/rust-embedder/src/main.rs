//! Pi embedding sidecar with built-in SQLite storage.
//!
//! JSON-over-stdio protocol:
//!   Embed:    {"id":1,"texts":[...],"prefix":"passage"}
//!             → {"id":1,"embeddings":[[...],...]}
//!   Scan:     {"id":2,"scan":{"paths":["src/"],"extensions":[],"skip_dirs":[]}}
//!             → {"id":2,"files":[{"path":"...","mtime":0.0,"size":0},...]}
//!   Index:    {"id":3,"index":{"paths":["/f.ts"],"chunk_size":80,"overlap":20,"store":true}}
//!             → {"id":3,"indexed":{"files":5,"chunks":42}}
//!   Index     {"id":4,"index":{"paths":["/f.ts"],"chunk_size":80,"overlap":20,"skip_embed":true}}
//!   (no store):→ {"id":4,"files":[{"path":"...","mtime":0.0,"size":0,"chunks":[...]}]}
//!   Store:    {"id":5,"store":{"file_path":"...","mtime":0.0,"size":0,"chunks":[...]}}
//!             → {"id":5,"stored":42}
//!   Delete:   {"id":6,"delete":{"path":"..."}}
//!             → {"id":6,"deleted":5}
//!   Search:   {"id":7,"search":{"query":"...","embedding":[...],"top_k":10,"mode":"hybrid","path_filter":null}}
//!             → {"id":7,"results":[...]}
//!   TextSearch:{"id":8,"text_search":{"query":"...","top_k":10,"path_filter":null}}
//!             → {"id":8,"results":[...]}
//!   SymbolSearch:{"id":9,"symbol_search":{"pattern":"class.*Handler"}}
//!             → {"id":9,"results":[...]}
//!   Status:   {"id":10,"status":{}}
//!             → {"id":10,"files":100,"chunks":500,"dim":384}
//!   Clear:    {"id":11,"clear":{}}
//!             → {"id":11,"ok":true}

use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::thread::available_parallelism;

use ndarray::Axis;
use ort::ep;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokenizers::Tokenizer;
use tree_sitter::{Language, Parser};

// ── Protocol types ──

#[derive(Debug, Deserialize)]
struct EmbedRequest {
    id: u64,
    texts: Vec<String>,
    #[serde(default)]
    prefix: String,
}

#[derive(Debug, Deserialize)]
struct ScanRequest {
    id: u64,
    scan: ScanParams,
}

#[derive(Debug, Deserialize)]
struct ScanParams {
    paths: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    skip_dirs: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct IndexRequest {
    id: u64,
    index: IndexParams,
}

#[derive(Debug, Deserialize)]
struct IndexParams {
    paths: Vec<String>,
    chunk_size: usize,
    #[serde(default)]
    overlap: usize,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    skip_embed: bool,
    #[serde(default)]
    store: bool,
    #[serde(default)]
    watch_dirs: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct StoreRequest {
    id: u64,
    store: StoreParams,
}

#[derive(Debug, Deserialize)]
struct StoreParams {
    file_path: String,
    mtime: f64,
    size: u64,
    chunks: Vec<ChunkData>,
}

#[derive(Debug, Deserialize)]
struct DeleteRequest {
    id: u64,
    delete: DeleteParams,
}

#[derive(Debug, Deserialize)]
struct DeleteParams {
    path: String,
}

#[derive(Debug, Deserialize)]
struct SearchRequest {
    id: u64,
    search: SearchParams,
}

#[derive(Debug, Deserialize)]
struct SearchParams {
    query: String,
    embedding: Vec<f32>,
    top_k: usize,
    #[serde(default = "default_keyword_weight")]
    keyword_weight: f32,
    #[serde(default)]
    path_filter: Option<String>,
    #[serde(default)]
    rerank: bool,
}

fn default_keyword_weight() -> f32 { 0.3 }

#[derive(Debug, Deserialize)]
struct TextSearchRequest {
    id: u64,
    text_search: TextSearchParams,
}

#[derive(Debug, Deserialize)]
struct TextSearchParams {
    query: String,
    top_k: usize,
    #[serde(default)]
    path_filter: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SymbolSearchRequest {
    id: u64,
    symbol_search: SymbolSearchParams,
}

#[derive(Debug, Deserialize)]
struct SymbolSearchParams {
    pattern: String,
    #[serde(default)]
    path_filter: Option<String>,
}


#[derive(Debug, Deserialize)]
struct CallGraphRequest {
    id: u64,
    call_graph: CallGraphParams,
}

#[derive(Debug, Deserialize)]
struct CallGraphParams {
    symbol: String,
    #[serde(default)]
    direction: String, // "callers" | "callees" | "file"
    #[serde(default)]
    path: Option<String>,
}

// ── Response types ──

#[derive(Debug, Serialize)]
struct EmbedResponse {
    id: u64,
    embeddings: Vec<Vec<f32>>,
}

#[derive(Debug, Serialize)]
struct ScanResponse {
    id: u64,
    files: Vec<FileMeta>,
}

#[derive(Debug, Serialize)]
struct IndexResponse {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    indexed: Option<IndexSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<Vec<IndexedFile>>,
}

#[derive(Debug, Serialize)]
struct IndexSummary {
    files: usize,
    chunks: usize,
}

#[derive(Debug, Serialize)]
struct StoreResponse {
    id: u64,
    stored: usize,
}

#[derive(Debug, Serialize)]
struct DeleteResponse {
    id: u64,
    deleted: usize,
}

#[derive(Debug, Serialize)]
struct SearchResultItem {
    path: String,
    start_line: usize,
    end_line: usize,
    snippet: String,
    score: f32,
}

#[derive(Debug, Serialize)]
struct SearchResponse {
    id: u64,
    results: Vec<SearchResultItem>,
}

#[derive(Debug, Serialize)]
struct SymbolResultItem {
    symbol: String,
    path: String,
    start_line: usize,
    end_line: usize,
    snippet: String,
}

#[derive(Debug, Serialize)]
struct SymbolSearchResponse {
    id: u64,
    results: Vec<SymbolResultItem>,
}

#[derive(Debug, Serialize)]
struct StatusResponse {
    id: u64,
    files: usize,
    chunks: usize,
    dim: usize,
    db_size: u64,
    watching: bool,
}

#[derive(Debug, Serialize)]
struct ClearResponse {
    id: u64,
    ok: bool,
}

#[derive(Debug, Serialize)]
struct CallGraphItem {
    file_path: String,
    line: usize,
    callee: String,
    caller: String,
}

#[derive(Debug, Serialize)]
struct CallGraphResponse {
    id: u64,
    results: Vec<CallGraphItem>,
}

#[derive(Debug, Serialize)]
struct FileMeta {
    path: String,
    mtime: f64,
    size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct IndexedFile {
    path: String,
    mtime: f64,
    size: u64,
    error: Option<String>,
    chunks: Vec<ChunkData>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChunkData {
    text: String,
    start_line: usize,
    end_line: usize,
    #[serde(default)]
    embedding: Vec<f32>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    id: u64,
    error: String,
}

// ── New feature types: triples, memories, AST grep ──

#[derive(Debug, Deserialize)]
struct TripleQueryRequest {
    id: u64,
    triple_query: TripleQueryParams,
}

#[derive(Debug, Deserialize)]
struct TripleQueryParams {
    #[serde(default)]
    subject: String,
    #[serde(default)]
    predicate: String,
    #[serde(default)]
    object: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize { 100 }

#[derive(Debug, Serialize)]
struct TripleQueryResponse {
    id: u64,
    results: Vec<TripleItem>,
}

#[derive(Debug, Serialize)]
struct TripleItem {
    subject: String,
    predicate: String,
    object: String,
    subject_type: String,
    object_type: String,
}

#[derive(Debug, Deserialize)]
struct MemoryStoreRequest {
    id: u64,
    memory_store: MemoryStoreParams,
}

#[derive(Debug, Deserialize)]
struct MemoryStoreParams {
    content: String,
    embedding: Vec<f32>,
    #[serde(default)]
    source: String,
    #[serde(default = "default_importance")]
    importance: f64,
    #[serde(default = "default_scope")]
    scope: String,
}

fn default_importance() -> f64 { 0.5 }
fn default_scope() -> String { "session".to_string() }

#[derive(Debug, Serialize)]
struct MemoryStoreResponse {
    id: u64,
    memory_id: i64,
}

#[derive(Debug, Deserialize)]
struct MemoryRecallRequest {
    id: u64,
    memory_recall: MemoryRecallParams,
}

#[derive(Debug, Deserialize)]
struct MemoryRecallParams {
    embedding: Vec<f32>,
    #[serde(default = "default_top_k")]
    top_k: usize,
    #[serde(default)]
    scope: String,
}

fn default_top_k() -> usize { 5 }

#[derive(Debug, Serialize)]
struct MemoryRecallResponse {
    id: u64,
    results: Vec<MemoryRecallItem>,
}

#[derive(Debug, Serialize)]
struct MemoryRecallItem {
    memory_id: i64,
    content: String,
    score: f64,
    source: String,
    importance: f64,
    scope: String,
}

#[derive(Debug, Deserialize)]
struct MemoryForgetRequest {
    id: u64,
    memory_forget: MemoryForgetParams,
}

#[derive(Debug, Deserialize)]
struct MemoryForgetParams {
    memory_id: i64,
}

#[derive(Debug, Serialize)]
struct MemoryForgetResponse {
    id: u64,
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct AstGrepRequest {
    id: u64,
    ast_grep: AstGrepParams,
}

#[derive(Debug, Deserialize)]
struct AstGrepParams {
    pattern: String,
    #[serde(default)]
    _lang: String,
    #[serde(default)]
    path_filter: String,
    #[serde(default = "default_top_k")]
    top_k: usize,
}

#[derive(Debug, Serialize)]
struct AstGrepResponse {
    id: u64,
    results: Vec<AstGrepItem>,
}

#[derive(Debug, Serialize)]
struct AstGrepItem {
    path: String,
    start_line: usize,
    end_line: usize,
    snippet: String,
}

// ── Constants ──

const MAX_LEN: usize = 512;
const MAX_BATCH_ATTENTION_UNITS: usize = 4_000_000;
const CODE_EXTENSIONS: &[&str] = &[
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt", ".scala", ".sql",
];
const DEFAULT_SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "target", ".venv", "venv",
    "vendor", ".next", ".cache", "__pycache__",
];
const COSINE_NORM_EPS: f32 = 1e-12;

// ── Utility ──

fn intra_threads() -> usize {
    available_parallelism()
        .map(|p| p.get().max(1))
        .unwrap_or(1)
}

fn download(url: &str, dest: &Path) -> anyhow::Result<()> {
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    eprintln!("[embedder] downloading {url} -> {}", dest.display());
    let resp = ureq::get(url)
        .call()
        .map_err(|e| anyhow::anyhow!("download failed: {e}"))?;
    let mut reader = resp.into_reader();
    let mut buf = Vec::new();
    reader.read_to_end(&mut buf)?;
    std::fs::write(dest, buf)?;
    Ok(())
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default()
        .to_lowercase()
}

// ── File walking ──

fn walk_dir(dir: &Path, extensions: &HashSet<String>, skip_dirs: &HashSet<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if let Ok(meta) = path.metadata() {
            if meta.is_dir() {
                if skip_dirs.contains(&fname) || fname.starts_with('.') {
                    continue;
                }
                out.extend(walk_dir(&path, extensions, skip_dirs));
            } else if meta.is_file() {
                if extensions.is_empty() || extensions.contains(&ext_of(&path)) {
                    out.push(path);
                }
            }
        }
    }
    out
}

// ── Chunking (tree-sitter) ──

fn lang_for_ext(ext: &str) -> Option<Language> {
    match ext.to_lowercase().as_str() {
        ".ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        ".tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        ".js" | ".jsx" | ".mjs" | ".cjs" => Some(tree_sitter_javascript::LANGUAGE.into()),
        ".py" => Some(tree_sitter_python::LANGUAGE.into()),
        ".rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        ".go" => Some(tree_sitter_go::LANGUAGE.into()),
        ".java" => Some(tree_sitter_java::LANGUAGE.into()),
        ".c" | ".h" => Some(tree_sitter_c::LANGUAGE.into()),
        ".cpp" | ".hpp" | ".cc" | ".hh" => Some(tree_sitter_cpp::LANGUAGE.into()),
        _ => None,
    }
}

fn chunk_text(text: &str, file_path: &str, chunk_size: usize, _overlap: usize) -> Vec<(usize, usize, String)> {
    let ext = Path::new(file_path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let lang = match lang_for_ext(&ext) {
        Some(l) => l,
        None => return Vec::new(),
    };

    let mut parser = Parser::new();
    if parser.set_language(&lang).is_err() {
        return Vec::new();
    }

    let tree = match parser.parse(text, None) {
        Some(t) => t,
        None => return Vec::new(),
    };

    let lines: Vec<&str> = text.lines().collect();
    let n = lines.len();
    if n == 0 {
        return Vec::new();
    }

    let root = tree.root_node();
    let mut split_rows: Vec<usize> = Vec::new();
    split_rows.push(0);

    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let start = child.start_position().row;
        let end = child.end_position().row;
        let span = end.saturating_sub(start) + 1;
        if span >= 3 && start > *split_rows.last().unwrap_or(&0) {
            split_rows.push(start);
        }
    }
    split_rows.push(n);

    let target = if chunk_size < 5 { 5 } else { chunk_size };
    let mut merged: Vec<usize> = Vec::new();
    merged.push(0);
    for &s in &split_rows[1..] {
        let last = *merged.last().unwrap_or(&0);
        if s - last >= target {
            merged.push(s);
        }
    }
    if *merged.last().unwrap_or(&0) < n {
        merged.push(n);
    }

    let mut out = Vec::new();
    for i in 0..merged.len() - 1 {
        let start_row = merged[i];
        let end_row = merged[i + 1];
        if start_row >= end_row {
            continue;
        }
        let slice = lines[start_row..end_row].join("\n");
        out.push((start_row + 1, end_row, slice));
    }
    out
}

// ── SQLite storage ──

struct Store {
    db: Connection,
}

impl Store {
    fn new(db_path: &str) -> anyhow::Result<Self> {
        let db = Connection::open(db_path)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
                path  TEXT PRIMARY KEY,
                mtime REAL NOT NULL,
                size  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chunks (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                path       TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line   INTEGER NOT NULL,
                text       TEXT NOT NULL,
                embedding  BLOB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path);
            CREATE INDEX IF NOT EXISTS chunks_id_idx ON chunks(id);
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                text,
                content=chunks,
                content_rowid=id,
                tokenize='porter unicode61',
                detail=none
            );"
        )?;

        // Migrate old FTS5 table (pre-content=chunks or pre-detail=none) to new schema
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        if version < 2 {
            db.execute_batch(
                "DROP TABLE IF EXISTS chunks_fts;
                 CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                     text,
                     content=chunks,
                     content_rowid=id,
                     tokenize='porter unicode61',
                     detail=none
                 );
                 PRAGMA user_version = 2;"
            )?;
            let count: i64 = db.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap_or(0);
            if count > 0 {
                db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')", [])?;
            }
        }
        if version < 3 {
            db.execute_batch(
                "DROP TABLE IF EXISTS chunks_fts;
                 CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                     text,
                     content=chunks,
                     content_rowid=id,
                     tokenize='porter unicode61',
                     detail=none
                 );
                 PRAGMA user_version = 3;"
            )?;
            let count: i64 = db.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap_or(0);
            if count > 0 {
                db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')", [])?;
            }
            // Reclaim space from dropped old FTS5 shadow tables + free pages.
            // VACUUM and checkpoint must run outside any transaction.
            let _ = db.execute_batch("VACUUM;");
            let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS call_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                line INTEGER NOT NULL,
                callee TEXT NOT NULL,
                caller TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS call_edges_callee_idx ON call_edges(callee);
            CREATE INDEX IF NOT EXISTS call_edges_file_idx ON call_edges(file_path);
            CREATE TABLE IF NOT EXISTS triples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subject TEXT NOT NULL,
                predicate TEXT NOT NULL,
                object TEXT NOT NULL,
                subject_type TEXT DEFAULT '',
                object_type TEXT DEFAULT '',
                file_path TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS triples_subject_idx ON triples(subject);
            CREATE INDEX IF NOT EXISTS triples_predicate_idx ON triples(predicate);
            CREATE INDEX IF NOT EXISTS triples_object_idx ON triples(object);
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                embedding BLOB,
                source TEXT DEFAULT '',
                importance REAL DEFAULT 0.5,
                scope TEXT DEFAULT 'session',
                created_at TEXT DEFAULT (datetime('now'))
            );",
        )?;

        // Migration 4: add triples + memories
        if version < 4 {
            db.execute_batch(
                "INSERT OR IGNORE INTO triples (subject, predicate, object, subject_type, object_type, file_path)
                 SELECT DISTINCT caller, 'calls', callee, 'function', 'function', file_path FROM call_edges WHERE caller != '';"
            )?;
            db.execute_batch("PRAGMA user_version = 4;")?;
        }

        Ok(Self { db })
    }

    fn file_is_unchanged(&self, file_path: &str, mtime: f64, size: u64) -> bool {
        self.db.query_row(
            "SELECT mtime, size FROM files WHERE path = ?1",
            params![file_path],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, u64>(1)?))
        ).ok().is_some_and(|(em, es)| (em - mtime).abs() < 0.001 && es == size)
    }

    fn store_chunks(&mut self, file_path: &str, mtime: f64, size: u64, chunks: &[ChunkData]) -> anyhow::Result<usize> {
        // Skip if file is unchanged
        if self.file_is_unchanged(file_path, mtime, size) {
            return Ok(0);
        }

        let tx = self.db.transaction()?;

        tx.execute("DELETE FROM chunks WHERE path = ?1", params![file_path])?;
        for c in chunks {
            let emb_bytes: Vec<u8> = c.embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
            tx.execute(
                "INSERT INTO chunks (path, start_line, end_line, text, embedding) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![file_path, c.start_line, c.end_line, c.text, emb_bytes],
            )?;
        }
        tx.execute(
            "INSERT INTO files (path, mtime, size) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size",
            params![file_path, mtime, size],
        )?;
        tx.commit()?;
        Ok(chunks.len())
    }

    fn delete_path(&mut self, file_path: &str) -> anyhow::Result<usize> {
        let deleted = self.db.execute("DELETE FROM chunks WHERE path = ?1", params![file_path])?;
        self.db.execute("DELETE FROM files WHERE path = ?1", params![file_path])?;
        Ok(deleted)
    }

    fn clear_all(&mut self) -> anyhow::Result<()> {
        self.db.execute_batch("DELETE FROM chunks; DELETE FROM files; DROP TABLE IF EXISTS chunks_fts;")?;
        self.db.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                 text,
                 content=chunks,
                 content_rowid=id,
                 tokenize='porter unicode61',
                 detail=none
             );"
        )?;
        Ok(())
    }

    fn file_count(&self) -> anyhow::Result<usize> {
        self.db.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0)).map_err(Into::into)
    }

    fn chunk_count(&self) -> anyhow::Result<usize> {
        self.db.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0)).map_err(Into::into)
    }

    fn db_file_size(&self, db_path: &str) -> u64 {
        std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
    }

    fn text_search(
        &self,
        query: &str,
        top_k: usize,
        path_filter: Option<&str>,
    ) -> anyhow::Result<Vec<(String, usize, usize, f32)>> {
        if let Some(pf) = path_filter {
            let pattern = format!("%{}%", pf);
            let mut stmt = self.db.prepare(
                "SELECT c.path, c.start_line, c.end_line, rank
                 FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
                 WHERE chunks_fts MATCH ?1 AND c.path LIKE ?2
                 ORDER BY rank LIMIT ?3"
            )?;
            let rows = stmt.query_map(params![query, pattern, top_k], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i32>(1)? as usize,
                    row.get::<_, i32>(2)? as usize,
                    1.0 / (row.get::<_, f64>(3)? as f32 + 1.0),
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        } else {
            let mut stmt = self.db.prepare(
                "SELECT c.path, c.start_line, c.end_line, rank
                 FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
                 WHERE chunks_fts MATCH ?1
                 ORDER BY rank LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![query, top_k], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i32>(1)? as usize,
                    row.get::<_, i32>(2)? as usize,
                    1.0 / (row.get::<_, f64>(3)? as f32 + 1.0),
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        }
    }

    fn rerank(&self, results: &mut [SearchResultItem], query: &str) {
        let query_lower = query.to_lowercase();
        let query_terms: Vec<&str> = query_lower.split_whitespace().filter(|t| t.len() > 1).collect();
        let mut seen_in_file = std::collections::HashSet::new();

        for item in results.iter_mut() {
            let path_lower = item.path.to_lowercase();

            // Source boost: penalize test/spec/mock/fixture/example files
            if path_lower.contains("test") || path_lower.contains("spec")
                || path_lower.contains("mock") || path_lower.contains("fixture")
                || path_lower.contains("example") || path_lower.contains("__test__")
            {
                item.score *= 0.85;
            } else {
                item.score *= 1.1;
            }

            // Boost exact identifier matches in query
            let snippet_lower = item.snippet.to_lowercase();
            for term in &query_terms {
                if snippet_lower.contains(term) {
                    item.score *= 1.05;
                }
            }

            // Diversity: penalize duplicate chunks from the same file
            let file_key = item.path.clone();
            if seen_in_file.contains(&file_key) {
                item.score *= 0.9;
            }
            seen_in_file.insert(file_key);

            // Clamp
            item.score = item.score.clamp(0.0, 1.0);
        }
    }

    fn semantic_search(
        &self,
        query_emb: &[f32],
        top_k: usize,
        path_filter: Option<&str>,
    ) -> anyhow::Result<Vec<SearchResultItem>> {
        let sql = if path_filter.is_some() {
            "SELECT rowid, path, start_line, end_line, text, embedding FROM chunks WHERE path LIKE ?1"
        } else {
            "SELECT rowid, path, start_line, end_line, text, embedding FROM chunks"
        };
        let mut stmt = self.db.prepare(sql)?;

        let rows: Vec<(String, i32, i32, String, Vec<u8>)> = if let Some(pf) = path_filter {
            let pattern = format!("%{}%", pf);
            let r = stmt.query_map(params![pattern], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })?;
            r.collect::<Result<Vec<_>, _>>()?
        } else {
            let r = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })?;
            r.collect::<Result<Vec<_>, _>>()?
        };

        let mut scored: Vec<SearchResultItem> = Vec::with_capacity(rows.len());
        for (path, sl, el, text, emb_bytes) in &rows {
            if emb_bytes.len() != query_emb.len() * 4 {
                continue;
            }
            let emb: Vec<f32> = emb_bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();

            let mut dot = 0.0f32;
            let mut norm_a = 0.0f32;
            let mut norm_b = 0.0f32;
            for i in 0..emb.len() {
                dot += query_emb[i] * emb[i];
                norm_a += query_emb[i] * query_emb[i];
                norm_b += emb[i] * emb[i];
            }
            let score = dot / (norm_a.sqrt() * norm_b.sqrt() + COSINE_NORM_EPS);
            scored.push(SearchResultItem {
                path: path.clone(),
                start_line: *sl as usize,
                end_line: *el as usize,
                snippet: text.chars().take(500).collect(),
                score,
            });
        }

        scored.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);
        self.rerank(&mut scored, "");
        scored.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored)
    }

    fn hybrid_search(
        &self,
        query_emb: &[f32],
        query_text: &str,
        top_k: usize,
        path_filter: Option<&str>,
        keyword_weight: f32,
    ) -> anyhow::Result<Vec<SearchResultItem>> {
        let sem_weight = (1.0 - keyword_weight).clamp(0.0, 1.0);
        let kw_weight = keyword_weight.clamp(0.0, 1.0);

        let mut sem = self.semantic_search(query_emb, top_k * 3, path_filter)?;
        let fts = self.text_search(query_text, top_k * 3, path_filter).unwrap_or_default();

        let mut fts_map: std::collections::HashMap<(String, usize), f32> = std::collections::HashMap::new();
        for (path, sl, _el, score) in &fts {
            fts_map.insert((path.clone(), *sl), *score);
        }

        for item in &mut sem {
            let kw = fts_map.get(&(item.path.clone(), item.start_line)).copied().unwrap_or(0.0);
            item.score = item.score * sem_weight + kw * kw_weight;
        }

        sem.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        sem.truncate(top_k);
        self.rerank(&mut sem, query_text);
        sem.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        Ok(sem)
    }

    fn symbol_search(&self, pattern: &str, path_filter: Option<&str>) -> anyhow::Result<Vec<SymbolResultItem>> {
        let re = Regex::new(pattern).map_err(|e| anyhow::anyhow!("bad regex: {e}"))?;

        let stmt2 = if let Some(pf) = path_filter {
            let pattern = format!("%{}%", pf);
            let mut s = self.db.prepare("SELECT path, start_line, end_line, text FROM chunks WHERE path LIKE ?1")?;
            let rows = s
                .query_map(params![pattern], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i32>(1)? as usize,
                        row.get::<_, i32>(2)? as usize,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        } else {
            let mut s = self.db.prepare("SELECT path, start_line, end_line, text FROM chunks")?;
            let rows = s
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i32>(1)? as usize,
                        row.get::<_, i32>(2)? as usize,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let sym_patterns = &[
            r"(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)",
            r"(?:export\s+)?(?:async\s+)?class\s+([a-zA-Z_$][\w$]*)",
            r"(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*[:=]",
            r"(?:export\s+)?interface\s+([a-zA-Z_$][\w$]*)",
            r"(?:export\s+)?type\s+([a-zA-Z_$][\w$]*)\s*=",
            r"(?:pub\s+)?fn\s+([a-zA-Z_$][\w$]*)",
            r"(?:pub\s+)?struct\s+([a-zA-Z_$][\w$]*)",
            r"(?:pub\s+)?enum\s+([a-zA-Z_$][\w$]*)",
            r"(?:pub\s+)?trait\s+([a-zA-Z_$][\w$]*)",
            r"def\s+([a-zA-Z_$][\w$]*)\s*\(",
            r"class\s+([a-zA-Z_$][\w$]*)\s*(?::|\(|\{)?",
            r"func\s+([a-zA-Z_$][\w$]*)\s*\(",
        ];
        let sym_res: Vec<Regex> = sym_patterns.iter().filter_map(|p| Regex::new(p).ok()).collect();

        let mut results = Vec::new();
        for (path, sl, el, text) in &stmt2 {
            for sym_re in &sym_res {
                for cap in sym_re.captures_iter(text) {
                    if let Some(name) = cap.get(1) {
                        let sym = name.as_str().to_string();
                        if re.is_match(&sym) && results.iter().all(|r: &SymbolResultItem| r.symbol != sym || r.path != *path) {
                            results.push(SymbolResultItem {
                                symbol: sym,
                                path: path.clone(),
                                start_line: *sl,
                                end_line: *el,
                                snippet: text.chars().take(300).collect(),
                            });
                        }
                    }
                }
            }
        }

        results.truncate(20);
        Ok(results)
    }

    // ── Call graph ──

    fn store_calls(&mut self, file_path: &str, calls: &[(String, usize, String)]) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        tx.execute("DELETE FROM call_edges WHERE file_path = ?1", params![file_path])?;
        tx.execute("DELETE FROM triples WHERE file_path = ?1 AND predicate = 'calls'", params![file_path])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO call_edges (file_path, line, callee, caller) VALUES (?1, ?2, ?3, ?4)"
            )?;
            for (callee, line, caller) in calls {
                stmt.execute(params![file_path, *line, callee, caller])?;
            }
        }
        // Mirror into triples table
        {
            let mut tstmt = tx.prepare(
                "INSERT OR IGNORE INTO triples (subject, predicate, object, subject_type, object_type, file_path) VALUES (?1, 'calls', ?2, 'function', 'function', ?3)"
            )?;
            for (callee, _, caller) in calls {
                if !caller.is_empty() {
                    tstmt.execute(params![caller, callee, file_path])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn query_callers(&self, callee: &str) -> anyhow::Result<Vec<(String, usize, String, String)>> {
        let mut stmt = self.db.prepare(
            "SELECT file_path, line, callee, caller FROM call_edges WHERE callee = ?1 ORDER BY file_path, line LIMIT 50"
        )?;
        let rows = stmt.query_map(params![callee], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i32>(1)? as usize,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn query_callees(&self, caller: &str) -> anyhow::Result<Vec<(String, usize, String, String)>> {
        let mut stmt = self.db.prepare(
            "SELECT file_path, line, callee, caller FROM call_edges WHERE caller = ?1 ORDER BY file_path, line LIMIT 50"
        )?;
        let rows = stmt.query_map(params![caller], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i32>(1)? as usize,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn query_calls_in_file(&self, file_path: &str) -> anyhow::Result<Vec<(usize, String, String)>> {
        let mut stmt = self.db.prepare(
            "SELECT line, callee, caller FROM call_edges WHERE file_path = ?1 ORDER BY line LIMIT 200"
        )?;
        let rows = stmt.query_map(params![file_path], |row| {
            Ok((
                row.get::<_, i32>(0)? as usize,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ── Triple store ──

    fn query_triples(&self, subj: &str, pred: &str, obj: &str, limit: usize) -> anyhow::Result<Vec<(String, String, String, String, String)>> {
        let mut clauses = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if !subj.is_empty() { clauses.push(format!("subject = ?{}", params_vec.len() + 1)); params_vec.push(Box::new(subj.to_string())); }
        if !pred.is_empty() { clauses.push(format!("predicate = ?{}", params_vec.len() + 1)); params_vec.push(Box::new(pred.to_string())); }
        if !obj.is_empty() { clauses.push(format!("object = ?{}", params_vec.len() + 1)); params_vec.push(Box::new(obj.to_string())); }
        let where_clause = if clauses.is_empty() { "1=1".to_string() } else { clauses.join(" AND ") };
        let sql = format!("SELECT subject, predicate, object, subject_type, object_type FROM triples WHERE {} LIMIT ?{}", where_clause, params_vec.len() + 1);
        params_vec.push(Box::new(limit as i64));
        let refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
        let mut stmt = self.db.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn _store_triple(&mut self, subj: &str, pred: &str, obj: &str, subj_type: &str, obj_type: &str) -> anyhow::Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO triples (subject, predicate, object, subject_type, object_type) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![subj, pred, obj, subj_type, obj_type],
        )?;
        Ok(())
    }

    // ── Memories ──

    fn store_memory(&mut self, content: &str, embedding: &[f32], source: &str, importance: f64, scope: &str) -> anyhow::Result<i64> {
        let mut blob = Vec::with_capacity(embedding.len() * 4);
        for f in embedding {
            blob.extend_from_slice(&f.to_le_bytes());
        }
        self.db.execute(
            "INSERT INTO memories (content, embedding, source, importance, scope) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![content, blob, source, importance, scope],
        )?;
        Ok(self.db.last_insert_rowid())
    }

    fn recall_memories(&self, query_emb: &[f32], top_k: usize, scope_filter: &str) -> anyhow::Result<Vec<(i64, String, f64, String, f64, String)>> {
        let results: Vec<(i64, String, Vec<u8>, f64, String, String)> = if scope_filter.is_empty() {
            let mut stmt = self.db.prepare("SELECT id, content, embedding, importance, source, scope FROM memories ORDER BY id DESC LIMIT 200")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = self.db.prepare("SELECT id, content, embedding, importance, source, scope FROM memories WHERE scope = ?1 ORDER BY id DESC LIMIT 200")?;
            let rows = stmt.query_map(params![scope_filter], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut scored: Vec<(i64, String, f64, String, f64, String)> = results.into_iter()
            .filter_map(|(id, content, blob, importance, source, scope): (i64, String, Vec<u8>, f64, String, String)| {
                if blob.len() < 4 { return None; }
                if blob.len() != query_emb.len() * 4 { return None; }
                let emb: Vec<f32> = blob.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                let dot: f32 = emb.iter().zip(query_emb).map(|(a, b)| a * b).sum();
                let norm_a = (emb.iter().map(|x| x * x).sum::<f32>()).sqrt();
                let norm_b = (query_emb.iter().map(|x| x * x).sum::<f32>()).sqrt();
                let cos = if norm_a > 0.0 && norm_b > 0.0 { dot / (norm_a * norm_b) } else { 0.0 };
                let score = (cos as f64) * 0.7 + importance * 0.3;
                Some((id, content, score, source, importance, scope))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);
        Ok(scored)
    }

    fn forget_memory(&self, id: i64) -> anyhow::Result<()> {
        self.db.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        Ok(())
    }
}

// ── Call extraction ──

/// Tree-sitter query strings for call detection, keyed by file extension.
fn call_query_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        ".ts" | ".tsx" | ".js" | ".jsx" | ".mjs" | ".cjs" => Some(
            "(call_expression function: (identifier) @callee)
             (call_expression function: (member_expression property: (property_identifier) @callee))"
        ),
        ".py" => Some(
            "(call function: (identifier) @callee)
             (call function: (attribute attribute: (identifier) @callee))"
        ),
        ".rs" => Some(
            "(call_expression function: (identifier) @callee)
             (call_expression function: (field_expression field: (field_identifier) @callee))"
        ),
        ".go" => Some(
            "(call_expression function: (identifier) @callee)
             (call_expression function: (selector_expression field: (field_identifier) @callee))"
        ),
        ".java" => Some(
            "(method_invocation name: (identifier) @callee)
             (method_invocation . (identifier) @callee)"
        ),
        ".c" | ".h" | ".cpp" | ".hpp" | ".cc" | ".hh" => Some(
            "(call_expression function: (identifier) @callee)"
        ),
        _ => None,
    }
}

/// Extract call edges from source text using tree-sitter queries.
fn extract_calls(text: &str, ext: &str) -> Vec<(String, usize, String)> {
    use tree_sitter::Query;

    let lang = match lang_for_ext(ext) {
        Some(l) => l,
        None => return Vec::new(),
    };
    let query_str = match call_query_for_ext(ext) {
        Some(q) => q,
        None => return Vec::new(),
    };

    let query = match Query::new(&lang, query_str) {
        Ok(q) => q,
        Err(_) => return Vec::new(),
    };

    let mut parser = Parser::new();
    if parser.set_language(&lang).is_err() {
        return Vec::new();
    }
    let tree = match parser.parse(text, None) {
        Some(t) => t,
        None => return Vec::new(),
    };

    let mut cursor = tree_sitter::QueryCursor::new();
    let matches = cursor.matches(&query, tree.root_node(), text.as_bytes());
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();

    for m in matches {
        for cap in m.captures {
            let name = query.capture_names()[cap.index as usize];
            if name == "callee" {
                let node = cap.node;
                let callee = &text[node.byte_range()];
                if callee.len() > 50 { continue; }
                let line = node.start_position().row + 1;
                let key = (callee.to_string(), line);
                if seen.insert(key) {
                    results.push((callee.to_string(), line, String::new()));
                }
            }
        }
    }
    results
}

struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
    wants_token_type_ids: bool,
    dim: usize,
}

impl Embedder {
    fn new(model_repo: &str, model_dir: &Path) -> anyhow::Result<Self> {
        let onnx_path = model_dir.join("onnx").join("model_quantized.onnx");
        let tok_path = model_dir.join("tokenizer.json");

        let files: &[(&str, &str)] = &[
            ("config.json", "config.json"),
            ("tokenizer.json", "tokenizer.json"),
            ("tokenizer_config.json", "tokenizer_config.json"),
            ("special_tokens_map.json", "special_tokens_map.json"),
            ("onnx/model_quantized.onnx", "onnx/model_quantized.onnx"),
        ];
        for (remote, local) in files {
            let url = format!("https://huggingface.co/{model_repo}/resolve/main/{remote}");
            let dest = model_dir.join(local);
            if let Err(e) = download(&url, &dest) {
                eprintln!("[embedder] warn: {url}: {e}");
            }
        }

        eprintln!(
            "[embedder] loading {} (intra_threads={})",
            onnx_path.display(),
            intra_threads()
        );

        let model_bytes = std::fs::read(&onnx_path)?;

        let build_cpu = |bytes: &[u8]| -> anyhow::Result<Session> {
            let mut builder = Session::builder().map_err(|e| anyhow::anyhow!("ort: {e}"))?;
            builder = builder
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow::anyhow!("ort: {e}"))?;
            builder = builder
                .with_intra_threads(intra_threads())
                .map_err(|e| anyhow::anyhow!("ort: {e}"))?;
            builder
                .commit_from_memory(bytes)
                .map_err(|e| anyhow::anyhow!("ort: {e}"))
        };

        let mut session: Session = (|| -> anyhow::Result<Session> {
            #[cfg(feature = "directml")]
            {
                let mut builder = Session::builder().map_err(|e| anyhow::anyhow!("ort: {e}"))?;
                builder = builder
                    .with_optimization_level(GraphOptimizationLevel::Level3)
                    .map_err(|e| anyhow::anyhow!("ort: {e}"))?;
                builder = builder
                    .with_intra_threads(1)
                    .map_err(|e| anyhow::anyhow!("ort: {e}"))?;
                match builder.with_execution_providers([ep::DirectML::default().build()]) {
                    Ok(mut b) => match b.commit_from_memory(&model_bytes) {
                        Ok(s) => {
                            eprintln!("[embedder] DirectML GPU EP enabled");
                            return Ok(s);
                        }
                        Err(e) => {
                            eprintln!("[embedder] DirectML session failed: {e}, falling back to CPU");
                        }
                    },
                    Err(e) => {
                        eprintln!("[embedder] DirectML unavailable: {e}, falling back to CPU");
                    }
                }
            }

            build_cpu(&model_bytes)
        })()?;
        let wants_token_type_ids = session.inputs().iter().any(|i| i.name() == "token_type_ids");
        let tokenizer =
            Tokenizer::from_file(&tok_path).map_err(|e| anyhow::anyhow!("tokenizer load: {e}"))?;

        // Probe dim
        let probe = tokenizer.encode_batch(vec!["probe"], false)
            .map_err(|e| anyhow::anyhow!("probe tokenize: {e}"))?;
        let pad = probe[0].len();
        let ids: Vec<i64> = probe.iter().flat_map(|e| e.get_ids().iter().map(|i| *i as i64)).collect();
        let mask: Vec<i64> = probe.iter().flat_map(|e| e.get_attention_mask().iter().map(|i| *i as i64)).collect();
        let a_ids = TensorRef::from_array_view(([1, pad], &*ids))?;
        let a_mask = TensorRef::from_array_view(([1, pad], &*mask))?;

        let outputs = if wants_token_type_ids {
            let tti = vec![0i64; pad];
            let a_tti = TensorRef::from_array_view(([1, pad], &*tti))?;
            session.run(ort::inputs![a_ids, a_mask, a_tti])
        } else {
            session.run(ort::inputs![a_ids, a_mask])
        }
        .map_err(|e| anyhow::anyhow!("probe: {e}"))?;

        let embeddings = outputs[0]
            .try_extract_array::<f32>()?
            .into_dimensionality::<ndarray::IxDyn>()?;
        let dim = if embeddings.ndim() == 2 {
            embeddings.shape()[1]
        } else {
            embeddings.shape()[2]
        };
        drop(outputs);

        Ok(Self {
            session,
            tokenizer,
            wants_token_type_ids,
            dim,
        })
    }

    fn embed(&mut self, texts: &[String], prefix: &str) -> anyhow::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let prefixed: Vec<String> = if prefix.is_empty() {
            texts.to_vec()
        } else {
            texts.iter().map(|t| format!("{prefix} {t}")).collect()
        };
        let encodings = self.tokenizer.encode_batch(prefixed, true)
            .map_err(|e| anyhow::anyhow!("tokenize: {e}"))?;

        let mut result: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        let mut start = 0usize;
        let mut max_so_far = 0usize;
        for (i, enc) in encodings.iter().enumerate() {
            let len = enc.get_ids().len().min(MAX_LEN).max(1);
            let count = i - start;
            let cand = max_so_far.max(len);
            let cost = (count + 1).saturating_mul(cand).saturating_mul(cand);
            if count > 0 && cost > MAX_BATCH_ATTENTION_UNITS {
                result.extend(self.run_inference(&encodings[start..i])?);
                start = i;
                max_so_far = len;
            } else {
                max_so_far = cand;
            }
        }
        result.extend(self.run_inference(&encodings[start..])?);
        Ok(result)
    }

    fn run_inference(&mut self, encodings: &[tokenizers::Encoding]) -> anyhow::Result<Vec<Vec<f32>>> {
        if encodings.is_empty() {
            return Ok(Vec::new());
        }
        let batch = encodings.len();
        let pad = encodings.iter().map(|e| e.get_ids().len().min(MAX_LEN)).max().unwrap_or(1).max(1);

        let mut ids = vec![0i64; batch * pad];
        let mut mask = vec![0i64; batch * pad];
        for (b, enc) in encodings.iter().enumerate() {
            let id_slice = enc.get_ids();
            let m_slice = enc.get_attention_mask();
            let len = id_slice.len().min(pad);
            for s in 0..len {
                ids[b * pad + s] = id_slice[s] as i64;
                mask[b * pad + s] = m_slice[s] as i64;
            }
        }

        let a_ids = TensorRef::from_array_view(([batch, pad], &*ids))?;
        let a_mask = TensorRef::from_array_view(([batch, pad], &*mask))?;
        let outputs = if self.wants_token_type_ids {
            let tti = vec![0i64; batch * pad];
            let a_tti = TensorRef::from_array_view(([batch, pad], &*tti))?;
            self.session.run(ort::inputs![a_ids, a_mask, a_tti])?
        } else {
            self.session.run(ort::inputs![a_ids, a_mask])?
        };

        let embeddings = outputs[0]
            .try_extract_array::<f32>()?
            .into_dimensionality::<ndarray::IxDyn>()?;

        if embeddings.ndim() == 2 {
            return Ok((0..batch).map(|b| {
                let v = embeddings.index_axis(Axis(0), b);
                v.iter().copied().collect::<Vec<_>>()
            }).collect());
        }

        let mut out: Vec<Vec<f32>> = Vec::with_capacity(batch);
        for b in 0..batch {
            let mut sum = 0f32;
            let mut vec = vec![0f32; self.dim];
            let row = embeddings.index_axis(Axis(0), b);
            for s in 0..pad {
                let m = mask[b * pad + s] as f32;
                if m == 0.0 { continue; }
                sum += m;
                for h in 0..self.dim {
                    vec[h] += row[[s, h]] * m;
                }
            }
            let denom = sum.max(1e-6);
            for h in 0..self.dim { vec[h] /= denom; }
            let mut norm = 0f32;
            for h in 0..self.dim { norm += vec[h] * vec[h]; }
            norm = norm.sqrt() + 1e-12;
            for h in 0..self.dim { vec[h] /= norm; }
            out.push(vec);
        }
        Ok(out)
    }
}

// ── Cross-encoder reranker ──

const RERANK_REPO: &str = "Xenova/ms-marco-MiniLM-L-6-v2";
const RERANK_FILE: &str = "onnx/model_uint8.onnx";

struct Reranker {
    session: Session,
    tokenizer: Tokenizer,
    wants_token_type_ids: bool,
}

impl Reranker {
    fn new(models_dir: &Path) -> anyhow::Result<Self> {
        let model_dir = models_dir.join("Xenova--ms-marco-MiniLM-L-6-v2");
        let onnx_path = model_dir.join(&RERANK_FILE);
        let tok_path = model_dir.join("tokenizer.json");

        let files: &[(&str, &str)] = &[
            ("tokenizer.json", "tokenizer.json"),
            (RERANK_FILE, &RERANK_FILE.replace("onnx/", "")),
        ];
        for (remote, local) in files {
            let url = format!("https://huggingface.co/{RERANK_REPO}/resolve/main/{remote}");
            let dest = model_dir.join(local);
            if let Err(e) = download(&url, &dest) {
                eprintln!("[embedder] warn reranker: {url}: {e}");
            }
        }

        eprintln!("[embedder] loading reranker {} (intra_threads={})", onnx_path.display(), intra_threads());

        let mut builder = Session::builder().map_err(|e| anyhow::anyhow!("ort: {e}"))?;
        builder = builder
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| anyhow::anyhow!("ort: {e}"))?;
        builder = builder
            .with_intra_threads(intra_threads())
            .map_err(|e| anyhow::anyhow!("ort: {e}"))?;
        let session = builder
            .commit_from_memory(&std::fs::read(&onnx_path)?)
            .map_err(|e| anyhow::anyhow!("ort: {e}"))?;

        let wants_token_type_ids = session.inputs().iter().any(|i| i.name() == "token_type_ids");
        let tokenizer = Tokenizer::from_file(&tok_path)
            .map_err(|e| anyhow::anyhow!("tokenizer load: {e}"))?;

        Ok(Self { session, tokenizer, wants_token_type_ids })
    }

    fn score(&mut self, query: &str, texts: &[&str]) -> anyhow::Result<Vec<f32>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // Tokenize as (query, text) pairs
        let pairs: Vec<(&str, &str)> = texts.iter().map(|t| (query, *t)).collect();
        let encodings = self.tokenizer.encode_batch(pairs, true)
            .map_err(|e| anyhow::anyhow!("reranker tokenize: {e}"))?;

        // Find max length for padding
        let pad = encodings.iter().map(|e| e.get_ids().len().min(512)).max().unwrap_or(1).max(1);
        let batch = encodings.len();

        let mut ids = vec![0i64; batch * pad];
        let mut mask = vec![0i64; batch * pad];
        let mut tti = vec![0i64; batch * pad];

        for (b, enc) in encodings.iter().enumerate() {
            let id_slice = enc.get_ids();
            let m_slice = enc.get_attention_mask();
            let t_slice = enc.get_type_ids();
            let len = id_slice.len().min(pad);
            for s in 0..len {
                ids[b * pad + s] = id_slice[s] as i64;
                mask[b * pad + s] = m_slice[s] as i64;
                if s < t_slice.len() {
                    tti[b * pad + s] = t_slice[s] as i64;
                }
            }
        }

        let a_ids = TensorRef::from_array_view(([batch, pad], &*ids))?;
        let a_mask = TensorRef::from_array_view(([batch, pad], &*mask))?;

        let outputs = if self.wants_token_type_ids {
            let a_tti = TensorRef::from_array_view(([batch, pad], &*tti))?;
            self.session.run(ort::inputs![a_ids, a_mask, a_tti])?
        } else {
            self.session.run(ort::inputs![a_ids, a_mask])?
        };

        let logits = outputs[0]
            .try_extract_array::<f32>()?
            .into_dimensionality::<ndarray::IxDyn>()?;

        // Logits shape: [batch, 2]. First element is relevance score for the pair.
        let mut scores = Vec::with_capacity(batch);
        for b in 0..batch {
            scores.push(logits[[b, 0]]);
        }
        Ok(scores)
    }
}

// ── Watcher ──

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

struct WatcherState {
    _thread: thread::JoinHandle<()>,
    _stop_tx: mpsc::Sender<()>,
}

/// Snapshot of (mtime_ms, size) for a file.
#[derive(Clone)]
struct FileSnapshot {
    mtime: f64,
    size: u64,
}

/// Poll the watched directories periodically, comparing mtime+size against a
/// cached snapshot. Changed or deleted paths are pushed into `pending`.
fn start_watcher(
    paths: &[String],
    pending: Arc<Mutex<HashSet<String>>>,
    poll_interval_ms: u64,
) -> Result<WatcherState, String> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let watch_paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let ext_set: HashSet<String> = CODE_EXTENSIONS.iter().map(|s| s.to_string()).collect();
    let skip_set: HashSet<String> = DEFAULT_SKIP_DIRS.iter().map(|d| d.to_string()).collect();

    let thread = thread::Builder::new()
        .name("code-embed-watcher".into())
        .spawn(move || {
            let interval = Duration::from_millis(poll_interval_ms);

            // Helper: scan a root into a HashMap
            let scan_all = || -> HashMap<String, FileSnapshot> {
                let mut result = HashMap::new();
                for root in &watch_paths {
                    if let Ok(meta) = root.metadata() {
                        if meta.is_dir() {
                            for entry in walk_dir(root, &ext_set, &skip_set) {
                                if let Ok(m) = entry.metadata() {
                                    if let Some(path_str) = entry.to_str() {
                                        let mtime = m.modified()
                                            .ok()
                                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                            .map(|d| d.as_secs_f64() * 1000.0)
                                            .unwrap_or(0.0);
                                        result.insert(path_str.to_string(), FileSnapshot { mtime, size: m.len() });
                                    }
                                }
                            }
                        } else if meta.is_file() {
                            if let Some(path_str) = root.to_str() {
                                let mtime = meta.modified()
                                    .ok()
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs_f64() * 1000.0)
                                    .unwrap_or(0.0);
                                result.insert(path_str.to_string(), FileSnapshot { mtime, size: meta.len() });
                            }
                        }
                    }
                }
                result
            };

            // Initial snapshot
            let mut snapshot = scan_all();

            // Poll loop
            loop {
                if stop_rx.try_recv().is_ok() {
                    return;
                }

                thread::sleep(interval);

                let current = scan_all();

                // Diff: new or changed files
                let mut changed: Vec<String> = Vec::new();
                for (path, snap) in &current {
                    match snapshot.get(path) {
                        Some(old) if (old.mtime - snap.mtime).abs() < 0.001 && old.size == snap.size => {}
                        _ => changed.push(path.clone()),
                    }
                }
                // Deleted files
                for path in snapshot.keys() {
                    if !current.contains_key(path) {
                        changed.push(format!("__DELETE__:{}", path));
                    }
                }

                if !changed.is_empty() {
                    if let Ok(mut set) = pending.lock() {
                        for p in changed {
                            set.insert(p);
                        }
                    }
                }

                snapshot = current;
            }
        })
        .map_err(|e| format!("spawn watcher: {e}"))?;

    Ok(WatcherState { _thread: thread, _stop_tx: stop_tx })
}

/// Re-index a single file, updating the store in-place.
fn reindex_file(
    store: &mut Store,
    embedder: &mut Embedder,
    file_path: &str,
    chunk_size: usize,
    overlap: usize,
) -> anyhow::Result<usize> {
    let path = Path::new(file_path);
    let meta = path.metadata()?;
    let mtime = meta.modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let size = meta.len();

    // Skip if unchanged
    if store.file_is_unchanged(file_path, mtime, size) {
        return Ok(0);
    }

    let text = std::fs::read_to_string(path)?;
    let line_chunks = chunk_text(&text, file_path, chunk_size, overlap);
    if line_chunks.is_empty() {
        return Ok(0);
    }

    // Embed in one batch
    let texts: Vec<String> = line_chunks.iter().map(|(_, _, t)| t.clone()).collect();
    let embeddings = embedder.embed(&texts, "")?;

    // Build chunk data
    let chunks: Vec<ChunkData> = line_chunks.into_iter().zip(embeddings.into_iter())
        .map(|((start, end, text), embedding)| ChunkData {
            text, start_line: start, end_line: end, embedding,
        })
        .collect();

    let n = chunks.len();
    store.store_chunks(file_path, mtime, size, &chunks)?;

    // Update call edges
    let ext = Path::new(file_path).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let calls = extract_calls(&text, &ext);
    if !calls.is_empty() {
        let _ = store.store_calls(file_path, &calls);
    }

    Ok(n)
}

// ── Main ──

fn main() -> anyhow::Result<()> {
    std::panic::set_hook(Box::new(|info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() { (*s).to_string() }
        else if let Some(s) = info.payload().downcast_ref::<String>() { s.clone() }
        else { "unknown panic".to_string() };
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        eprintln!("[embedder] PANIC at {loc}: {msg}");
        let _ = io::stderr().flush();
        std::process::exit(1);
    }));

    let mut model_repo: Option<String> = None;
    let mut model_dir: Option<String> = None;
    let mut db_path: Option<String> = None;
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--model-repo" => model_repo = args.next(),
            "--models-dir" => model_dir = args.next(),
            "--db-path" => db_path = args.next(),
            _ => {}
        }
    }
    let model_repo = model_repo.ok_or_else(|| anyhow::anyhow!("missing --model-repo"))?;
    let model_dir = PathBuf::from(model_dir.ok_or_else(|| anyhow::anyhow!("missing --models-dir"))?);

    let mut embedder = Embedder::new(&model_repo, &model_dir)?;
    let dim = embedder.dim;
    eprintln!("[embedder] ready (dim={dim})");

    let mut store: Option<Store> = db_path.as_ref().map(|p| Store::new(p).unwrap());
    let mut reranker: Option<Reranker> = None;
    let pending_changes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut watcher_state: Option<WatcherState> = None;

    let ready = serde_json::to_string(&serde_json::json!({"id": 0, "dim": dim}))?;
    println!("{ready}");
    io::stdout().flush()?;

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut reader = stdin.lock();
    let mut line = String::new();

    loop {
        // Drain pending watcher events before processing next command
        if let Some(ref mut s) = store {
            let changes: Vec<String> = {
                if let Ok(mut p) = pending_changes.lock() {
                    p.drain().collect()
                } else {
                    Vec::new()
                }
            };
            if !changes.is_empty() {
                for entry in &changes {
                    if let Some(rest) = entry.strip_prefix("__DELETE__:") {
                        let n = s.delete_path(rest).unwrap_or(0);
                        if n > 0 {
                            eprintln!("[embedder] watcher: removed {} ({} chunks)", rest, n);
                        }
                    } else if Path::new(entry).exists() {
                        match reindex_file(s, &mut embedder, entry, 80, 20) {
                            Ok(n) => {
                                if n > 0 {
                                    eprintln!("[embedder] watcher: re-indexed {} ({} chunks)", entry, n);
                                }
                            }
                            Err(e) => {
                                eprintln!("[embedder] watcher: failed {}: {}", entry, e);
                            }
                        }
                    }
                }
                let _ = s.db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')", []);
            }
        }

        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 { break; }
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let val: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => { err(&mut out, 0, &format!("bad json: {e}"))?; continue; }
        };
        let id = val.get("id").and_then(|v| v.as_u64()).unwrap_or(0);

        if val.get("texts").is_some() {
            let req: EmbedRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad embed req: {e}"))?;
            match embedder.embed(&req.texts, &req.prefix) {
                Ok(embeddings) => {
                    serde_json::to_writer(&mut out, &EmbedResponse { id: req.id, embeddings })?;
                    out.write_all(b"\n")?;
                }
                Err(e) => err(&mut out, req.id, &format!("{e}"))?,
            }
        } else if val.get("scan").is_some() {
            let req: ScanRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad scan req: {e}"))?;
            let ext_set: HashSet<String> = if req.scan.extensions.is_empty() {
                CODE_EXTENSIONS.iter().map(|s| s.to_string()).collect()
            } else {
                req.scan.extensions.iter().map(|s| s.to_lowercase()).collect()
            };
            let skip_set: HashSet<String> = {
                let mut s: HashSet<String> = DEFAULT_SKIP_DIRS.iter().map(|d| d.to_string()).collect();
                s.extend(req.scan.skip_dirs);
                s
            };
            let mut files = Vec::new();
            for p in &req.scan.paths {
                let root = PathBuf::from(p);
                let abs = if root.is_absolute() { root }
                else { env::current_dir().ok().map(|c| c.join(&root)).unwrap_or(root) };
                if let Ok(meta) = abs.metadata() {
                    if meta.is_dir() {
                        for f in walk_dir(&abs, &ext_set, &skip_set) {
                            if let Ok(m) = f.metadata() {
                                if let Ok(mtime) = m.modified() {
                                    let d = mtime.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                                    files.push(FileMeta {
                                        path: f.to_string_lossy().to_string(),
                                        mtime: d.as_secs_f64() * 1000.0,
                                        size: m.len(),
                                    });
                                }
                            }
                        }
                    } else if meta.is_file() {
                        if let Ok(mtime) = meta.modified() {
                            let d = mtime.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                            files.push(FileMeta {
                                path: abs.to_string_lossy().to_string(),
                                mtime: d.as_secs_f64() * 1000.0,
                                size: meta.len(),
                            });
                        }
                    }
                }
            }
            serde_json::to_writer(&mut out, &ScanResponse { id: req.id, files })?;
            out.write_all(b"\n")?;
        } else if val.get("index").is_some() {
            let req: IndexRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad index req: {e}"))?;
            let mut files = Vec::new();
            let mut total_chunks = 0usize;

            // Pass 1: stat, read, and chunk all files (no embedding yet)
            struct PendingFile {
                path: String,
                mtime: f64,
                size: u64,
                text: String,
                chunks: Vec<(usize, usize, String)>,
            }
            let mut pending: Vec<PendingFile> = Vec::new();

            for p in &req.index.paths {
                let path = PathBuf::from(p);
                let meta = match path.metadata() {
                    Ok(m) => m,
                    Err(e) => { files.push(IndexedFile { path: p.clone(), mtime: 0.0, size: 0, error: Some(format!("stat: {e}")), chunks: Vec::new() }); continue; }
                };
                let mtime = meta.modified().ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
                let size = meta.len();

                // Skip unchanged files (mtime + size match)
                if req.index.store && !req.index.skip_embed {
                    if let Some(ref s) = store {
                        if s.file_is_unchanged(p, mtime, size) {
                            files.push(IndexedFile { path: p.clone(), mtime, size, error: None, chunks: Vec::new() });
                            continue;
                        }
                    }
                }

                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => { files.push(IndexedFile { path: p.clone(), mtime, size, error: Some(format!("read: {e}")), chunks: Vec::new() }); continue; }
                };

                let line_chunks = chunk_text(&text, p, req.index.chunk_size, req.index.overlap);
                if line_chunks.is_empty() {
                    files.push(IndexedFile { path: p.clone(), mtime, size, error: None, chunks: Vec::new() });
                    continue;
                }

                pending.push(PendingFile { path: p.clone(), mtime, size, text, chunks: line_chunks });
            }

            // Pass 2: embed all chunks across all files in one batch
            let mut all_texts: Vec<String> = Vec::new();
            if req.index.skip_embed {
                for pf in &pending {
                    for _ in &pf.chunks {
                        all_texts.push(String::new()); // placeholder, embeddings not needed
                    }
                }
            } else {
                for pf in &pending {
                    for (_, _, text) in &pf.chunks {
                        if req.index.prefix.is_empty() {
                            all_texts.push(text.clone());
                        } else {
                            all_texts.push(format!("{} {}", req.index.prefix, text));
                        }
                    }
                }
            }

            let all_embeddings: Vec<Vec<f32>> = if req.index.skip_embed {
                (0..all_texts.len()).map(|_| Vec::new()).collect()
            } else if all_texts.is_empty() {
                Vec::new()
            } else {
                match embedder.embed(&all_texts, "") {
                    Ok(v) => v,
                    Err(e) => {
                        // Mark all pending files as failed and clear pending
                        for pf in pending.drain(..) {
                            files.push(IndexedFile { path: pf.path, mtime: pf.mtime, size: pf.size, error: Some(format!("embed: {e}")), chunks: Vec::new() });
                        }
                        Vec::new()
                    }
                }
            };

            // Pass 3: distribute embeddings back and store
            let mut emb_idx = 0;
            for pf in pending {
                let mut chunks: Vec<ChunkData> = Vec::with_capacity(pf.chunks.len());
                for (start, end, text) in pf.chunks {
                    let embedding = if emb_idx < all_embeddings.len() { all_embeddings[emb_idx].clone() } else { Vec::new() };
                    emb_idx += 1;
                    chunks.push(ChunkData { text, start_line: start, end_line: end, embedding });
                }
                let n = chunks.len();

                if req.index.store && !req.index.skip_embed {
                    if let Some(ref mut s) = store {
                        if let Err(e) = s.store_chunks(&pf.path, pf.mtime, pf.size, &chunks) {
                            files.push(IndexedFile { path: pf.path, mtime: pf.mtime, size: pf.size, error: Some(format!("db store: {e}")), chunks: Vec::new() });
                            continue;
                        }
                        // Extract and store call edges from stored text
                        let ext = Path::new(&pf.path).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                        let calls = extract_calls(&pf.text, &ext);
                        if !calls.is_empty() {
                            let _ = s.store_calls(&pf.path, &calls);
                        }
                        total_chunks += n;
                    }
                }

                files.push(IndexedFile { path: pf.path, mtime: pf.mtime, size: pf.size, error: None, chunks });
            }

            if req.index.store && !req.index.skip_embed {
                serde_json::to_writer(&mut out, &IndexResponse {
                    id: req.id,
                    indexed: Some(IndexSummary { files: files.iter().filter(|f| f.error.is_none()).count(), chunks: total_chunks }),
                    files: None,
                })?;

                // Auto-start watcher if watch_dirs provided and not already watching
                if watcher_state.is_none() && !req.index.watch_dirs.is_empty() {
                    match start_watcher(&req.index.watch_dirs, pending_changes.clone(), 2000) {
                        Ok(state) => {
                            watcher_state = Some(state);
                            eprintln!("[embedder] watcher auto-started on {} paths", req.index.watch_dirs.len());
                        }
                        Err(e) => {
                            eprintln!("[embedder] failed to auto-start watcher: {e}");
                        }
                    }
                }
            } else {
                serde_json::to_writer(&mut out, &IndexResponse { id: req.id, indexed: None, files: Some(files) })?;
            }
            out.write_all(b"\n")?;
        } else if val.get("store").is_some() {
            let req: StoreRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad store req: {e}"))?;
            let s = store.as_mut().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let n = s.store_chunks(&req.store.file_path, req.store.mtime, req.store.size, &req.store.chunks)?;
            let _ = s.db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')", []);
            serde_json::to_writer(&mut out, &StoreResponse { id: req.id, stored: n })?;
            out.write_all(b"\n")?;
        } else if val.get("delete").is_some() {
            let req: DeleteRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad delete req: {e}"))?;
            let s = store.as_mut().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let n = s.delete_path(&req.delete.path)?;
            let _ = s.db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')", []);
            serde_json::to_writer(&mut out, &DeleteResponse { id: req.id, deleted: n })?;
            out.write_all(b"\n")?;
        } else if val.get("search").is_some() {
            let req: SearchRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad search req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let mut results = s.hybrid_search(
                &req.search.embedding,
                &req.search.query,
                req.search.top_k.max(50),
                req.search.path_filter.as_deref(),
                req.search.keyword_weight,
            )?;

            if req.search.rerank && !results.is_empty() {
                if reranker.is_none() {
                    if let Ok(r) = Reranker::new(&model_dir) {
                        reranker = Some(r);
                    }
                }
                if let Some(ref mut r) = reranker {
                    let texts: Vec<&str> = results.iter().map(|ri| ri.snippet.as_str()).collect();
                    if let Ok(scores) = r.score(&req.search.query, &texts) {
                        let mut reranked: Vec<SearchResultItem> = results.into_iter().zip(scores.into_iter())
                            .map(|(mut item, score)| { item.score = score.max(0.0); item })
                            .collect();
                        reranked.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                        reranked.truncate(req.search.top_k);
                        results = reranked;
                    } else {
                        results.truncate(req.search.top_k);
                    }
                } else {
                    results.truncate(req.search.top_k);
                }
            } else {
                results.truncate(req.search.top_k);
            }
            serde_json::to_writer(&mut out, &SearchResponse { id: req.id, results })?;
            out.write_all(b"\n")?;
        } else if val.get("text_search").is_some() {
            let req: TextSearchRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad text_search req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let mut results: Vec<SearchResultItem> = Vec::new();
            if let Ok(fts) = s.text_search(&req.text_search.query, req.text_search.top_k, req.text_search.path_filter.as_deref()) {
                for (path, sl, el, score) in &fts {
                    let snippet = s.db.query_row(
                        "SELECT text FROM chunks WHERE path = ?1 AND start_line = ?2 AND end_line = ?3",
                        params![path, *sl, *el],
                        |row| row.get::<_, String>(0),
                    ).unwrap_or_default();
                    results.push(SearchResultItem {
                        path: path.clone(), start_line: *sl, end_line: *el,
                        snippet: snippet.chars().take(500).collect(), score: *score,
                    });
                }
                results.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                s.rerank(&mut results, &req.text_search.query);
                results.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            }
            serde_json::to_writer(&mut out, &SearchResponse { id: req.id, results })?;
            out.write_all(b"\n")?;
        } else if val.get("symbol_search").is_some() {
            let req: SymbolSearchRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad symbol_search req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let results = s.symbol_search(&req.symbol_search.pattern, req.symbol_search.path_filter.as_deref())?;
            serde_json::to_writer(&mut out, &SymbolSearchResponse { id: req.id, results })?;
            out.write_all(b"\n")?;
        } else if val.get("watch").is_some() {
            if watcher_state.is_some() {
                serde_json::to_writer(&mut out, &serde_json::json!({"id": id, "ok": true, "watching": true}))?;
            } else if store.is_some() {
                let paths: Vec<String> = val["watch"]["paths"].as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let debounce_ms = val["watch"]["debounce_ms"].as_u64().unwrap_or(2000);
                match start_watcher(&paths, pending_changes.clone(), debounce_ms) {
                    Ok(state) => {
                        watcher_state = Some(state);
                        eprintln!("[embedder] watcher started on {} paths (debounce={}ms)", paths.len(), debounce_ms);
                        serde_json::to_writer(&mut out, &serde_json::json!({"id": id, "ok": true, "watching": true}))?;
                    }
                    Err(e) => err(&mut out, id, &format!("watch: {e}"))?,
                }
            } else {
                err(&mut out, id, "no db configured")?;
            }
            out.write_all(b"\n")?;
        } else if val.get("watch_stop").is_some() {
            if watcher_state.take().is_some() {
                eprintln!("[embedder] watcher stopped");
                serde_json::to_writer(&mut out, &serde_json::json!({"id": id, "ok": true}))?;
            } else {
                serde_json::to_writer(&mut out, &serde_json::json!({"id": id, "ok": true, "note": "no active watcher"}))?;
            }
            out.write_all(b"\n")?;
        } else if val.get("status").is_some() {
            let watching = watcher_state.is_some();
            if let Some(ref s) = store {
                let files = s.file_count().unwrap_or(0);
                let chunks = s.chunk_count().unwrap_or(0);
                let dbp = db_path.as_deref().unwrap_or("");
                let db_size = s.db_file_size(dbp);
                serde_json::to_writer(&mut out, &StatusResponse { id, files, chunks, dim, db_size, watching })?;
            } else {
                serde_json::to_writer(&mut out, &StatusResponse { id, files: 0, chunks: 0, dim, db_size: 0, watching })?;
            }
            out.write_all(b"\n")?;
        } else if val.get("clear").is_some() {
            if let Some(ref mut s) = store { s.clear_all()?; }
            serde_json::to_writer(&mut out, &ClearResponse { id, ok: true })?;
            out.write_all(b"\n")?;
        } else if val.get("rebuild_fts").is_some() {
            if let Some(ref s) = store {
                s.db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')", [])?;
            }
            serde_json::to_writer(&mut out, &ClearResponse { id, ok: true })?;
            out.write_all(b"\n")?;
        } else if val.get("call_graph").is_some() {
            let req: CallGraphRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad call_graph req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let results = match req.call_graph.direction.as_str() {
                "callees" => s.query_callees(&req.call_graph.symbol)?,
                "file" => {
                    let path = req.call_graph.path.as_deref().unwrap_or("");
                    s.query_calls_in_file(path)?
                        .into_iter()
                        .map(|(line, callee, caller)| (String::new(), line, callee, caller))
                        .collect()
                },
                _ => s.query_callers(&req.call_graph.symbol)?, // default: callers
            };
            let items: Vec<CallGraphItem> = results
                .into_iter()
                .map(|(fp, line, callee, caller)| CallGraphItem {
                    file_path: fp,
                    line,
                    callee,
                    caller,
                })
                .collect();
            serde_json::to_writer(&mut out, &CallGraphResponse { id: req.id, results: items })?;
            out.write_all(b"\n")?;
        } else if val.get("triple_query").is_some() {
            let req: TripleQueryRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad triple_query req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let results = s.query_triples(&req.triple_query.subject, &req.triple_query.predicate, &req.triple_query.object, req.triple_query.limit)?;
            let items: Vec<TripleItem> = results.into_iter()
                .map(|(subject, predicate, object, stype, otype)| TripleItem { subject, predicate, object, subject_type: stype, object_type: otype })
                .collect();
            serde_json::to_writer(&mut out, &TripleQueryResponse { id: req.id, results: items })?;
            out.write_all(b"\n")?;
        } else if val.get("memory_store").is_some() {
            let req: MemoryStoreRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad memory_store req: {e}"))?;
            let s = store.as_mut().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let memory_id = s.store_memory(&req.memory_store.content, &req.memory_store.embedding, &req.memory_store.source, req.memory_store.importance, &req.memory_store.scope)?;
            serde_json::to_writer(&mut out, &MemoryStoreResponse { id: req.id, memory_id })?;
            out.write_all(b"\n")?;
        } else if val.get("memory_recall").is_some() {
            let req: MemoryRecallRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad memory_recall req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let results = s.recall_memories(&req.memory_recall.embedding, req.memory_recall.top_k, &req.memory_recall.scope)?;
            let items: Vec<MemoryRecallItem> = results.into_iter()
                .map(|(memory_id, content, score, source, importance, scope)| MemoryRecallItem { memory_id, content, score, source, importance, scope })
                .collect();
            serde_json::to_writer(&mut out, &MemoryRecallResponse { id: req.id, results: items })?;
            out.write_all(b"\n")?;
        } else if val.get("memory_forget").is_some() {
            let req: MemoryForgetRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad memory_forget req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            s.forget_memory(req.memory_forget.memory_id)?;
            serde_json::to_writer(&mut out, &MemoryForgetResponse { id: req.id, ok: true })?;
            out.write_all(b"\n")?;
        } else if val.get("ast_grep").is_some() {
            let req: AstGrepRequest = serde_json::from_value(val).map_err(|e| anyhow::anyhow!("bad ast_grep req: {e}"))?;
            let s = store.as_ref().ok_or_else(|| anyhow::anyhow!("no db configured"))?;
            let pattern_lower = req.ast_grep.pattern.to_lowercase();
            let rows: Vec<(String, i32, i32, String)> = if req.ast_grep.path_filter.is_empty() {
                let mut stmt = s.db.prepare("SELECT path, start_line, end_line, text FROM chunks LIMIT 5000")?;
                let r = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?, row.get::<_, i32>(2)?, row.get::<_, String>(3)?)))?;
                r.collect::<Result<Vec<_>, _>>()?
            } else {
                let mut stmt = s.db.prepare("SELECT path, start_line, end_line, text FROM chunks WHERE path LIKE ?1 LIMIT 5000")?;
                let r = stmt.query_map(params![format!("%{}%", req.ast_grep.path_filter)], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?, row.get::<_, i32>(2)?, row.get::<_, String>(3)?)))?;
                r.collect::<Result<Vec<_>, _>>()?
            };
            let matched: Vec<AstGrepItem> = rows
                .into_iter()
                .filter(|(_, _, _, text)| text.to_lowercase().contains(&pattern_lower))
                .take(req.ast_grep.top_k)
                .map(|(path, sl, el, text)| {
                    let first_match = text.lines().next().unwrap_or("").trim().chars().take(200).collect::<String>();
                    AstGrepItem { path, start_line: sl as usize, end_line: el as usize, snippet: first_match }
                })
                .collect();
            serde_json::to_writer(&mut out, &AstGrepResponse { id: req.id, results: matched })?;
            out.write_all(b"\n")?;
        } else {
            err(&mut out, id, "unknown request type")?;
        }
        out.flush()?;
    }
    Ok(())
}

fn err(out: &mut impl Write, id: u64, msg: &str) -> anyhow::Result<()> {
    serde_json::to_writer(&mut *out, &ErrorResponse { id, error: msg.to_string() })?;
    out.write_all(b"\n")?;
    Ok(())
}
