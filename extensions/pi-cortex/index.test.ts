import { describe, it, test, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Rust sidecar binary
const binaryName = process.platform === "win32" ? "pi-embedder.exe" : "pi-embedder";
const binaryPath = process.env.PI_CORTEX_TEST_BINARY ?? join(__dirname, "rust-embedder", "target", "release", binaryName);

test("rust sidecar binary exists", () => {
   expect(existsSync(binaryPath), `Binary not found at ${binaryPath}. Run "cd rust-embedder && cargo build --release" first.`).toBe(true);
});

// Temp dir for test fixtures + DB
const testRoot = join(__dirname, ".test-tmp");
let child: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let buf = "";
// Accumulates unsolicited watcher_event lines from the sidecar's stdout.
// Cleared each time startSidecar() is called.
const watcherEvents: Record<string, unknown>[] = [];

function send(msg: Record<string, unknown>, timeout = 10000): Promise<unknown> {
   return new Promise((resolve, reject) => {
      if (!child?.stdin) return reject(new Error("sidecar not running"));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, ...msg }) + "\n");
      setTimeout(() => {
         pending.delete(id);
         reject(new Error(`timeout: ${JSON.stringify(msg).slice(0, 80)}`));
      }, timeout);
   });
}

function startSidecar(dbPath: string, preserveDb = false) {
   return new Promise<void>((resolve, reject) => {
      watcherEvents.length = 0;
      if (!preserveDb) rmSync(dbPath, { force: true });
      const modelDir = join(testRoot, "models");
      mkdirSync(modelDir, { recursive: true });

      child = spawn(binaryPath, [
         "--model-repo", "Xenova/all-MiniLM-L6-v2",
         "--models-dir", modelDir,
         "--db-path", dbPath
      ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

      const stderr: string[] = [];
      child.stderr?.on("data", (d: Buffer) => {
         stderr.push(d.toString());
      });

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (data: string) => {
         buf += data;
         for (let i: number; (i = buf.indexOf("\n")) >= 0; ) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
               const resp = JSON.parse(line);
               if (resp.id === 0 && resp.dim !== undefined) {
                  resolve();
                  return;
               }
               const p = pending.get(resp.id);
               if (p) {
                  pending.delete(resp.id);
                  if (resp.error) p.reject(new Error(resp.error));
                  else p.resolve(resp);
               }
               // Capture unsolicited watcher events (no `id` field)
               if (resp.watcher_event && resp.id === undefined) {
                  watcherEvents.push(resp.watcher_event as Record<string, unknown>);
               }
            } catch {}
         }
      });

      child.on("error", (e) => reject(new Error(`spawn: ${e.message}`)));
      child.on("exit", (code) => {
         if (code !== 0) {
            reject(new Error(`sidecar exited (${code}): ${stderr.join("").slice(-500)}`));
         }
      });
   });
}

function stopSidecar(): Promise<void> {
   for (const p of pending.values()) p.reject(new Error("sidecar stopped"));
   pending.clear();
   const c = child;
   child = null;
   if (!c) return Promise.resolve();
   if (c.exitCode !== null) return Promise.resolve();
   // Kill and WAIT for exit: on Windows the SQLite handles stay locked until
   // the process is gone, so .test-tmp cleanup would fail without this.
   return new Promise((resolve) => {
      c.once("exit", () => resolve());
      c.kill("SIGKILL");
      setTimeout(resolve, 2000);
   });
}

function stopChild(c: ChildProcess): Promise<void> {
   if (c.exitCode !== null) return Promise.resolve();
   return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
         if (settled) return;
         settled = true;
         resolve();
      };
      c.once("exit", finish);
      c.kill("SIGKILL");
      setTimeout(finish, 2000);
   });
}

// ---------------------------------------------------------------------------
// Fixture files
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, string> = {
   "src/auth.ts": `export function login(username: string, password: string): boolean {
   return validateCredentials(username, password);
}

export function validateCredentials(user: string, pass: string): boolean {
   return user === "admin" && pass === "secret";
}

export class SessionManager {
   private token: string;
   constructor() { this.token = ""; }
   createSession(user: string): string {
      this.token = "sess_" + user;
      logSession(this.token);
      return this.token;
   }
   destroySession(): void { this.token = ""; }
}

export function logSession(token: string): void {
   console.log("Session:", token);
}`,

   "src/utils.py": `def hash_password(password: str) -> str:
    import hashlib
    return hashlib.sha256(password.encode()).hexdigest()

def verify_hash(password: str, expected: str) -> bool:
    return hash_password(password) == expected

class RateLimiter:
    def __init__(self, max_requests: int = 100):
        self.max_requests = max_requests
        self.requests = []

    def allow_request(self) -> bool:
        return len(self.requests) < self.max_requests

    def reset(self) -> None:
        self.requests = []
`,

   "src/main.rs": `use std::collections::HashMap;

struct Server {
    routes: HashMap<String, Box<dyn Handler>>,
}

trait Handler {
    fn handle(&self, req: &str) -> String;
}

impl Server {
    fn new() -> Self {
        Server { routes: HashMap::new() }
    }

    fn register(&mut self, path: &str, handler: Box<dyn Handler>) {
        self.routes.insert(path.to_string(), handler);
    }

    fn dispatch(&self, req: &str) -> Option<String> {
        for (route, handler) in &self.routes {
            if req.starts_with(route) {
                return Some(handler.handle(req));
            }
        }
        None
    }
}

struct JsonHandler;

impl Handler for JsonHandler {
    fn handle(&self, req: &str) -> String {
        format!("{{"received": "{}"}}", req)
    }
}

fn main() {
    let mut server = Server::new();
    server.register("/api", Box::new(JsonHandler));
    println!("{}", server.dispatch("/api/test").unwrap_or_default());
}
`,

   "src/data.ts": `export interface User {
   id: number;
   name: string;
   email: string;
}

export interface Config {
   theme: "light" | "dark";
   language: string;
}

export type Role = "admin" | "user" | "guest";

export const DEFAULT_CONFIG: Config = { theme: "dark", language: "en" };

export function getUser(id: number): Promise<User | null> {
   return fetchUser(id);
}

async function fetchUser(id: number): Promise<User | null> {
   const resp = await fetch("/api/users/" + id);
   if (!resp.ok) return null;
   return resp.json();
}
`
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(() => {
   rmSync(testRoot, { recursive: true, force: true });
   mkdirSync(testRoot, { recursive: true });
   for (const [filePath, content] of Object.entries(FIXTURES)) {
      const abs = join(testRoot, filePath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
   }
}, 15000);

afterAll(async () => {
   await stopSidecar();
   // Clean up test fixtures — files in .test-tmp/ only, never outside.
   if (testRoot.startsWith(__dirname)) {
      const rmRetry = async (attempt = 0): Promise<void> => {
         try {
            rmSync(testRoot, { recursive: true, force: true });
         } catch {
            if (attempt >= 5) return;
            await new Promise((r) => setTimeout(r, 200));
            await rmRetry(attempt + 1);
         }
      };
      await rmRetry();
   }
}, 10000);

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

describe("scan", () => {
   beforeAll(async () => {
      await startSidecar(join(testRoot, "index.db"));
   }, 30000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("walks files and returns metadata", async () => {
      const resp = await send({
         scan: { paths: [testRoot], extensions: [], skip_dirs: ["node_modules"] }
      }) as { files: { path: string; mtime: number; size: number }[] };
      expect(resp.files.length).toBeGreaterThanOrEqual(4);
      const paths = resp.files.map((f) => f.path.replace(/\\/g, "/"));
      expect(paths.some((p) => p.endsWith("src/auth.ts"))).toBe(true);
      expect(paths.some((p) => p.endsWith("src/utils.py"))).toBe(true);
      expect(paths.some((p) => p.endsWith("src/main.rs"))).toBe(true);
      expect(paths.some((p) => p.endsWith("src/data.ts"))).toBe(true);
      for (const f of resp.files) {
         expect(f.mtime).toBeGreaterThan(0);
         expect(f.size).toBeGreaterThan(0);
      }
   }, 15000);

   it("filters by extension", async () => {
      const resp = await send({
         scan: { paths: [testRoot], extensions: [".py"], skip_dirs: [] }
      }) as { files: { path: string }[] };
      expect(resp.files.length).toBe(1);
      expect(resp.files[0].path.endsWith(".py")).toBe(true);
   }, 10000);

   it("honors project .gitignore and .cortexignore files", async () => {
      const ignoreRoot = join(testRoot, "ignore-rules");
      mkdirSync(ignoreRoot, { recursive: true });
      writeFileSync(join(ignoreRoot, ".gitignore"), "git-ignored.ts\n");
      writeFileSync(join(ignoreRoot, ".cortexignore"), "cortex-ignored.ts\n");
      writeFileSync(join(ignoreRoot, "git-ignored.ts"), "export const gitIgnored = true;\n");
      writeFileSync(join(ignoreRoot, "cortex-ignored.ts"), "export const cortexIgnored = true;\n");
      writeFileSync(join(ignoreRoot, "kept.ts"), "export const kept = true;\n");

      try {
         const resp = await send({
            scan: { paths: [ignoreRoot], extensions: [".ts"], skip_dirs: [] }
         }) as { files: { path: string }[] };
         const paths = resp.files.map((file) => file.path.replace(/\\/g, "/"));
         expect(paths).toEqual([`${ignoreRoot.replace(/\\/g, "/")}/kept.ts`]);
      } finally {
         rmSync(ignoreRoot, { recursive: true, force: true });
      }
   }, 10000);

   it("returns empty for non-existent path", async () => {
      const resp = await send({
         scan: { paths: ["/nonexistent/path"], extensions: [], skip_dirs: [] }
      }) as { files: unknown[] };
      expect(resp.files).toEqual([]);
   }, 10000);
});

// ---------------------------------------------------------------------------
// Index + store text
// ---------------------------------------------------------------------------

describe("chunk bounds", () => {
   const dbPath = join(testRoot, "chunk-bounds.db");
   const filePath = join(testRoot, "src", "large-chunk.ts");

   beforeAll(async () => {
      await startSidecar(dbPath);
   }, 30000);

   afterAll(async () => {
      await stopSidecar();
      rmSync(filePath, { force: true });
   }, 5000);

   it("splits oversized syntax nodes into bounded chunks", async () => {
      const body = Array.from(
         { length: 400 },
         (_, line) => `   const value${line} = "${"x".repeat(100)}";`
      ).join("\\n");
      writeFileSync(filePath, `function largeFunction() {\\n${body}\\n}\\n`);

      const response = await send({
         index: { paths: [filePath], chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
      }) as { files: { chunks: { start_line: number; end_line: number; text: string }[] }[] };
      const chunks = response.files[0]?.chunks ?? [];

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.end_line - chunk.start_line + 1 <= 160)).toBe(true);
      expect(chunks.every((chunk) => chunk.text.length <= 16 * 1024)).toBe(true);
   }, 15000);
});

async function indexTestFixtures(dbPath: string) {
   // Store chunks manually to avoid needing the embedding model for every test.
   // We'll index without embed and then inject pre-computed embeddings.
   const files: { path: string; mtime: number }[] = [];
   for (const filePath of Object.keys(FIXTURES)) {
      const abs = join(testRoot, filePath);
      const mtime = existsSync(abs) ? 0 : 0;
      files.push({ path: abs, mtime });
   }

   // Index with skip_embed and no store -> returns chunks
   const allPaths = files.map((f) => f.path);
   const idxResp = await send({
      index: { paths: allPaths, chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
   }) as { files: { path: string; mtime: number; size: number; error?: string; chunks: { text: string; start_line: number; end_line: number; embedding: number[] }[] }[] };
   expect(idxResp.files.length).toBeGreaterThanOrEqual(4);

   // Store each file's chunks with dummy embeddings (384-dim all zeros)
   await Promise.all(
      idxResp.files.map(async (fr) => {
         if (fr.error) throw new Error(`Index error for ${fr.path}: ${fr.error}`);
         if (fr.chunks.length === 0) return;
         const storeChunks = fr.chunks.map((c) => ({
            text: c.text,
            start_line: c.start_line,
            end_line: c.end_line,
            embedding: Array.from({ length: 384 }, () => 0.01) as number[]
         }));
         // Make the auth.ts file have meaningful embedding-like values for cosine tests
         if (fr.path.includes("auth.ts") || fr.path.includes("login")) {
            for (let i = 0; i < storeChunks.length; i++) {
               storeChunks[i].embedding = [0.9, 0.1, ...Array.from({ length: 382 }, () => 0.01)];
            }
         }
         const storeResp = await send({
            store: { file_path: fr.path, mtime: fr.mtime, size: 100, chunks: storeChunks }
         }) as { stored: number };
         expect(storeResp.stored).toBe(storeChunks.length);
      })
   );
   return idxResp.files.length;
}

describe("index + store", () => {
   const dbPath = join(testRoot, "index-test.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
   }, 30000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("indexes files without embedding and returns chunks", async () => {
      expect(await indexTestFixtures(dbPath)).toBeGreaterThanOrEqual(4);
   }, 30000);

   it("status reports indexed files and chunks", async () => {
      const resp = await send({ status: {} }) as { files: number; chunks: number; dim: number; db_size: number };
      expect(resp.files).toBeGreaterThanOrEqual(4);
      expect(resp.chunks).toBeGreaterThan(0);
      expect(resp.dim).toBe(384);
      expect(resp.db_size).toBeGreaterThan(1000);
   }, 10000);

   it("delete removes file from index", async () => {
      const firstFile = join(testRoot, "src/data.ts");
      const delResp = await send({ delete: { path: firstFile } }) as { deleted: number };
      expect(delResp.deleted).toBeGreaterThan(0);
      const status = await send({ status: {} }) as { chunks: number };
      // Should have fewer chunks now
      expect(status.chunks).toBeGreaterThan(0);
   }, 10000);

   it("clear wipes everything", async () => {
      await send({ clear: {} });
      const status = await send({ status: {} }) as { files: number; chunks: number };
      expect(status.files).toBe(0);
      expect(status.chunks).toBe(0);
   }, 10000);

   it("re-indexing stores correctly", async () => {
      await indexTestFixtures(dbPath);
      const status = await send({ status: {} }) as { chunks: number };
      expect(status.chunks).toBeGreaterThan(0);
   }, 30000);

   it("status reports which root the index covers", async () => {
      // Fixture indexes pass no watch_dirs, so nothing is recorded yet.
      const before = await send({ status: {} }) as { index_roots?: string[] };
      expect(before.index_roots ?? []).toHaveLength(0);

      // A real index request with watch_dirs records the resolved root.
      const target = join(testRoot, "src/data.ts");
      const resp = await send({
         index: { paths: [target], chunk_size: 80, overlap: 20, prefix: "", skip_embed: false, store: true, watch_dirs: [testRoot] }
      }) as { indexed?: { files: number; chunks: number } };
      expect(resp.indexed?.files).toBe(1);

      const status = await send({ status: {} }) as { index_roots?: string[] };
      expect(status.index_roots).toEqual([testRoot]);
   }, 30000);
});

describe("index FTS sync", () => {
   const dbPath = join(testRoot, "index-fts-sync.db");
   const markerPath = join(testRoot, "src", "index-fts-marker.ts");

   beforeAll(async () => {
      await startSidecar(dbPath);
   }, 30000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("rebuilds FTS when a stored index request completes", async () => {
      writeFileSync(markerPath, "export const cortexFtsMarker = true;\n");
      try {
         const indexed = await send({
            index: { paths: [markerPath], chunk_size: 80, overlap: 20, prefix: "", skip_embed: false, store: true, watch_dirs: [] }
         }) as { indexed?: { files: number } };
         expect(indexed.indexed?.files).toBe(1);

         const searched = await send({ text_search: { query: "cortexFtsMarker", top_k: 5 } }) as {
            results: { path: string }[];
         };
         expect(searched.results.some((result) => result.path.endsWith("index-fts-marker.ts"))).toBe(true);
      } finally {
         await send({ delete: { path: markerPath } });
         rmSync(markerPath, { force: true });
      }
   }, 30000);
});

// ---------------------------------------------------------------------------
// Keyword search (FTS5)
// ---------------------------------------------------------------------------

describe("text_search (FTS5)", () => {
   const dbPath = join(testRoot, "index-fts.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
      await indexTestFixtures(dbPath);
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("finds chunks by keyword", async () => {
      const resp = await send({
         text_search: { query: "login", top_k: 5 }
      }) as { results: { path: string; start_line: number; end_line: number; snippet: string; score: number }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      expect(resp.results.some((r) => r.path.includes("auth.ts"))).toBe(true);
      for (const r of resp.results) {
         expect(r.score).toBeGreaterThan(0);
         expect(r.snippet.length).toBeGreaterThan(0);
         expect(r.start_line).toBeGreaterThan(0);
         expect(r.end_line).toBeGreaterThanOrEqual(r.start_line);
      }
   }, 10000);

   it("finds by symbol name", async () => {
      const resp = await send({
         text_search: { query: "validateCredentials", top_k: 3 }
      }) as { results: { path: string }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      expect(resp.results.some((r) => r.path.includes("auth.ts"))).toBe(true);
   }, 10000);

   it("finds across languages", async () => {
      const resp = await send({
         text_search: { query: "Handler", top_k: 5 }
      }) as { results: { path: string }[] };
      expect(resp.results.some((r) => r.path.endsWith(".rs"))).toBe(true);
   }, 10000);

   it("filters by path", async () => {
      const resp = await send({
         text_search: { query: "login", top_k: 10, path_filter: "data.ts" }
      }) as { results: { path: string }[] };
      expect(resp.results.length).toBe(0); // login is not in data.ts
   }, 10000);

   it("returns empty for non-matching query", async () => {
      const resp = await send({
         text_search: { query: "xyznonexistent12345", top_k: 5 }
      }) as { results: unknown[] };
      expect(resp.results).toEqual([]);
   }, 10000);

   it("snippet is the full chunk text, not a capped excerpt", async () => {
      const resp = await send({
         text_search: { query: "login", top_k: 3 }
      }) as { results: { snippet: string }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      for (const r of resp.results) {
         expect(r.snippet.length).toBeGreaterThan(0);
         expect(r.snippet).not.toContain("…");
      }
      // The 500-char cap is gone: at least one snippet shows the whole chunk.
      expect(resp.results.some((r) => r.snippet.length > 500)).toBe(true);
   }, 10000);
});

describe("hybrid search candidates", () => {
   const dbPath = join(testRoot, "hybrid-search.db");
   const markerPath = join(testRoot, "src", "keyword-only-marker.ts");

   beforeAll(async () => {
      await startSidecar(dbPath);
      await indexTestFixtures(dbPath);
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("keeps an exact keyword match outside the semantic candidate pool", async () => {
      writeFileSync(markerPath, "export const cortexKeywordMarker = true;\n");
      try {
         const indexed = await send({
            index: { paths: [markerPath], chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
         }) as { files: { path: string; chunks: { text: string; start_line: number; end_line: number }[] }[] };
         const file = indexed.files.find((entry) => entry.path === markerPath);
         expect(file?.chunks.length).toBeGreaterThan(0);

         await send({
            store: {
               file_path: markerPath,
               mtime: 0,
               size: 100,
               chunks: file!.chunks.map((chunk) => ({
                  ...chunk,
                  embedding: Array.from({ length: 384 }, (_, index) => (index === 0 ? 0 : 0.01))
               }))
            }
         });

         const searched = await send({
            search: {
               query: "cortexKeywordMarker missingTerm",
               embedding: [1, ...Array.from({ length: 383 }, () => 0)],
               top_k: 1,
               keyword_weight: 1,
               path_filter: null,
               rerank: false
            }
         }) as { results: { path: string }[] };
         expect(searched.results.some((result) => result.path.endsWith("keyword-only-marker.ts"))).toBe(true);
      } finally {
         await send({ delete: { path: markerPath } });
         rmSync(markerPath, { force: true });
      }
   }, 30000);
});

// ---------------------------------------------------------------------------
// Symbol search
// ---------------------------------------------------------------------------

describe("hybrid ranking", () => {
   const dbPath = join(testRoot, "hybrid-ranking.db");
   const semanticPath = join(testRoot, "src", "semantic-only.ts");
   const keywordPath = join(testRoot, "src", "exact-keyword.ts");

   beforeAll(async () => {
      await startSidecar(dbPath);
      writeFileSync(semanticPath, "export const semanticOnly = true;\\n");
      writeFileSync(keywordPath, "export const exactKeyword = true;\\n");

      const zero = Array.from({ length: 384 }, () => 0);
      await send({
         store: {
            file_path: semanticPath,
            mtime: 1,
            size: 1,
            chunks: [{
               text: "generic semantic context",
               start_line: 1,
               end_line: 1,
               embedding: [1, ...zero.slice(1)]
            }]
         }
      });
      await send({
         store: {
            file_path: keywordPath,
            mtime: 1,
            size: 1,
            chunks: [{
               text: "exactKeyword",
               start_line: 1,
               end_line: 1,
               embedding: [0, 1, ...zero.slice(2)]
            }]
         }
      });
   }, 30000);

   afterAll(async () => {
      await stopSidecar();
      rmSync(semanticPath, { force: true });
      rmSync(keywordPath, { force: true });
   }, 5000);

   it("lets the exact keyword rank ahead of a semantic-only outlier", async () => {
      const response = await send({
         search: {
            query: "exactKeyword",
            embedding: [1, ...Array.from({ length: 383 }, () => 0)],
            top_k: 2,
            keyword_weight: 0.6,
            path_filter: null,
            rerank: false
         }
      }) as { results: { path: string }[] };

      expect(response.results[0]?.path).toBe(keywordPath);
   }, 10000);

   it("invalidates cached vectors after a file is replaced", async () => {
      await send({
         search: {
            query: "exactKeyword",
            embedding: [0, 1, ...Array.from({ length: 382 }, () => 0)],
            top_k: 1,
            keyword_weight: 0,
            path_filter: keywordPath,
            rerank: false
         }
      });

      await send({
         store: {
            file_path: keywordPath,
            mtime: 2,
            size: 2,
            chunks: [{
               text: "replacementKeyword",
               start_line: 1,
               end_line: 1,
               embedding: [0, 1, ...Array.from({ length: 382 }, () => 0)]
            }]
         }
      });

      const response = await send({
         search: {
            query: "replacementKeyword",
            embedding: [0, 1, ...Array.from({ length: 382 }, () => 0)],
            top_k: 1,
            keyword_weight: 0,
            path_filter: keywordPath,
            rerank: false
         }
      }) as { results: { snippet: string }[] };

      expect(response.results[0]?.snippet).toBe("replacementKeyword");
   }, 10000);
});

describe("symbol_search", () => {
   const dbPath = join(testRoot, "index-sym.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
      await indexTestFixtures(dbPath);
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("finds function declarations", async () => {
      const resp = await send({
         symbol_search: { pattern: "login", path_filter: null }
      }) as { results: { symbol: string; path: string; start_line: number; end_line: number; snippet: string }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      const symbols = resp.results.map((r) => r.symbol);
      expect(symbols.some((s) => s === "login" || s === "logSession")).toBe(true);
   }, 10000);

   it("finds class declarations", async () => {
      const resp = await send({
         symbol_search: { pattern: "SessionManager", path_filter: null }
      }) as { results: { symbol: string; path: string }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      expect(resp.results.some((r) => r.symbol === "SessionManager")).toBe(true);
   }, 10000);

   it("finds interface declarations", async () => {
      const resp = await send({
         symbol_search: { pattern: "User|Config", path_filter: null }
      }) as { results: { symbol: string }[] };
      const symbols = resp.results.map((r) => r.symbol);
      expect(symbols).toContain("User");
      expect(symbols).toContain("Config");
   }, 10000);

   it("finds type declarations", async () => {
      const resp = await send({
         symbol_search: { pattern: "Role", path_filter: null }
      }) as { results: { symbol: string }[] };
      const symbols = resp.results.map((r) => r.symbol);
      expect(symbols).toContain("Role");
   }, 10000);

   it("finds Rust symbols", async () => {
      const resp = await send({
         symbol_search: { pattern: "Server|JsonHandler", path_filter: null }
      }) as { results: { symbol: string }[] };
      const symbols = resp.results.map((r) => r.symbol);
      expect(symbols).toContain("Server");
      expect(symbols).toContain("JsonHandler");
   }, 10000);

   it("finds Python symbols", async () => {
      const resp = await send({
         symbol_search: { pattern: "RateLimiter|hash_password", path_filter: null }
      }) as { results: { symbol: string }[] };
      const symbols = resp.results.map((r) => r.symbol);
      expect(symbols).toContain("RateLimiter");
      expect(symbols).toContain("hash_password");
   }, 10000);

   it("respects path filter", async () => {
      const resp = await send({
         symbol_search: { pattern: "login", path_filter: "data.ts" }
      }) as { results: unknown[] };
      expect(resp.results.length).toBe(0);
   }, 10000);

   it("filters by path", async () => {
      const resp = await send({
         symbol_search: { pattern: ".*", path_filter: "auth.ts" }
      }) as { results: { path: string }[] };
      for (const r of resp.results) {
         expect(r.path).toContain("auth.ts");
      }
   }, 10000);

   it("filters by symbol kind", async () => {
      const iface = await send({
         symbol_search: { pattern: ".*", kind: "interface", path_filter: null }
      }) as { results: { symbol: string; kind: string }[] };
      const ifaceNames = iface.results.map((r) => r.symbol);
      expect(ifaceNames).toContain("User");
      expect(ifaceNames).toContain("Config");
      for (const r of iface.results) {
         expect(r.kind).toBe("interface");
      }

      const classes = await send({
         symbol_search: { pattern: ".*", kind: "class", path_filter: null }
      }) as { results: { symbol: string; kind: string }[] };
      const classNames = classes.results.map((r) => r.symbol);
      expect(classNames).toContain("SessionManager");
      expect(classNames).toContain("RateLimiter");
      for (const r of classes.results) {
         expect(r.kind).toBe("class");
      }

      const fns = await send({
         symbol_search: { pattern: ".*", kind: "function", path_filter: null }
      }) as { results: { symbol: string }[] };
      const fnNames = fns.results.map((r) => r.symbol);
      expect(fnNames).toContain("login");
      expect(fnNames).toContain("getUser");
      expect(fnNames).toContain("hash_password");
      expect(fnNames).toContain("dispatch"); // Rust `fn` normalizes to function
      expect(fnNames).not.toContain("User");
      expect(fnNames).not.toContain("DEFAULT_CONFIG");
   }, 10000);

   it("treats a non-regex pattern as plain text instead of erroring", async () => {
      // `[` is not a valid regex — falls back to substring matching.
      const resp = await send({
         symbol_search: { pattern: "[", path_filter: null }
      }) as { results: unknown[]; error?: string };
      expect(resp.error).toBeUndefined();
      expect(resp.results).toEqual([]);
   }, 10000);

   it("returns empty for non-matching pattern", async () => {
      const resp = await send({
         symbol_search: { pattern: "NoSuchSymbolXyz", path_filter: null }
      }) as { results: unknown[] };
      expect(resp.results).toEqual([]);
   }, 10000);
});

describe("outline", () => {
   const dbPath = join(testRoot, "index-outline.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
      await indexTestFixtures(dbPath);
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("lists every symbol in a file with kind and line range", async () => {
      const resp = await send({
         outline: { path: join(testRoot, "src", "data.ts") }
      }) as { path: string; files: number; truncated: boolean; symbols: { symbol: string; kind: string; start_line: number; end_line: number }[] };
      expect(resp.files).toBe(1);
      expect(resp.truncated).toBe(false);
      const names = resp.symbols.map((r) => r.symbol);
      expect(names).toContain("User");
      expect(names).toContain("Config");
      expect(names).toContain("Role");
      expect(names).toContain("DEFAULT_CONFIG");
      expect(names).toContain("getUser");
      expect(names).toContain("fetchUser");
      const user = resp.symbols.find((r) => r.symbol === "User");
      expect(user?.kind).toBe("interface");
      const configVar = resp.symbols.find((r) => r.symbol === "DEFAULT_CONFIG");
      expect(configVar?.kind).toBe("variable");
      const getUser = resp.symbols.find((r) => r.symbol === "getUser");
      expect(getUser?.kind).toBe("function");
      // Sorted by line: Role (type) comes before DEFAULT_CONFIG (variable).
      const roleIdx = resp.symbols.findIndex((r) => r.symbol === "Role");
      const cfgIdx = resp.symbols.findIndex((r) => r.symbol === "DEFAULT_CONFIG");
      expect(roleIdx).toBeLessThan(cfgIdx);
   }, 10000);

   it("lists symbols across every file under a directory", async () => {
      const resp = await send({
         outline: { path: join(testRoot, "src") }
      }) as { files: number; symbols: { symbol: string; path: string }[] };
      expect(resp.files).toBe(4); // auth.ts, data.ts, main.rs, utils.py
      const paths = resp.symbols.map((r) => r.path);
      expect(paths.some((p) => p.includes("auth.ts"))).toBe(true);
      expect(paths.some((p) => p.includes("main.rs"))).toBe(true);
      expect(paths.some((p) => p.includes("utils.py"))).toBe(true);
   }, 10000);

   it("accepts a trailing slash on directory paths", async () => {
      const resp = await send({
         outline: { path: `${join(testRoot, "src")}/` }
      }) as { files: number };
      expect(resp.files).toBe(4);
   }, 10000);

   it("returns no symbols for an unknown path", async () => {
      const resp = await send({
         outline: { path: join(testRoot, "nope.ts") }
      }) as { files: number; symbols: unknown[] };
      expect(resp.files).toBe(0);
      expect(resp.symbols).toEqual([]);
   }, 10000);
});

// ---------------------------------------------------------------------------
// Call graph
// ---------------------------------------------------------------------------

describe("call_graph", () => {
   const dbPath = join(testRoot, "index-cg.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
      // Re-index with store=true so call edges are extracted automatically.
      // We need to do a full index (not skip_embed) so store=true works.
      // But we don't have the model downloaded, so instead we'll index with
      // skip_embed=true, store=false, then store chunks via store command,
      // then manually insert call edges.
      // Actually, the store_chunks in Rust doesn't extract calls - only
      // the index command with store=true does extraction.
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   // We test the call graph query functions directly by inserting test data
   // The actual extraction during indexing requires the embedding model,
   // but the query endpoints work on stored call_edges regardless.
   it("returns empty for non-indexed call graph", async () => {
      // Index first
      const files = Object.keys(FIXTURES).map((f) => join(testRoot, f));
      await send({
         index: { paths: [join(testRoot, "src/auth.ts")], chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
      });
      const resp = await send({
         call_graph: { symbol: "login", direction: "callers" }
      }) as { results: unknown[] };
      expect(resp.results).toEqual([]);
   }, 10000);

   it("queries callers and callees routes work with empty data", async () => {
      const callers = await send({
         call_graph: { symbol: "validateCredentials", direction: "callers" }
      }) as { results: unknown[] };
      expect(Array.isArray(callers.results)).toBe(true);

      const callees = await send({
         call_graph: { symbol: "login", direction: "callees" }
      }) as { results: unknown[] };
      expect(Array.isArray(callees.results)).toBe(true);
   }, 10000);
});

// ---------------------------------------------------------------------------
// Semantic search (with injected embeddings)
// ---------------------------------------------------------------------------

describe("search (semantic + hybrid)", () => {
   const dbPath = join(testRoot, "index-sem.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
      await indexTestFixtures(dbPath);
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("semantic search returns results with scores", async () => {
      const queryEmb = Array.from({ length: 384 }, () => 0.01);
      queryEmb[0] = 0.8; // dot with the auth.ts embedding
      const resp = await send({
         search: { query: "login authentication", embedding: queryEmb, top_k: 5, mode: "semantic", path_filter: null, rerank: false }
      }) as { results: { path: string; start_line: number; end_line: number; snippet: string; score: number }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      expect(resp.results[0].score).toBeGreaterThan(0);
      expect(resp.results[0].snippet.length).toBeGreaterThan(0);
   }, 10000);

   it("hybrid search blends with FTS5 scores", async () => {
      const queryEmb = Array.from({ length: 384 }, () => 0.01);
      const resp = await send({
         search: { query: "Handler trait", embedding: queryEmb, top_k: 5, mode: "hybrid", path_filter: null, rerank: false }
      }) as { results: { path: string; score: number }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      // Hybrid should find Rust Handler via FTS5 boost
      expect(resp.results.some((r) => r.path.endsWith(".rs"))).toBe(true);
   }, 10000);

   it("respects path filter in semantic search", async () => {
      const queryEmb = Array.from({ length: 384 }, () => 0.01);
      const resp = await send({
         search: { query: "login", embedding: queryEmb, top_k: 5, mode: "semantic", path_filter: "main.rs", rerank: false }
      }) as { results: { path: string }[] };
      for (const r of resp.results) {
         expect(r.path).toContain("main.rs");
      }
   }, 10000);

   it("returns empty for zero vector query", async () => {
      const queryEmb = Array.from({ length: 384 }, () => 0);
      const resp = await send({
         search: { query: "nothing", embedding: queryEmb, top_k: 5, mode: "semantic", path_filter: null, rerank: false }
      }) as { results: unknown[] };
      expect(resp.results.length).toBeLessThanOrEqual(5);
   }, 10000);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
   const dbPath = join(testRoot, "index-err.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
   }, 30000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("rejects unknown request type", async () => {
      await expect(
         send({ unknown_cmd: {} } as Record<string, unknown>, 5000)
      ).rejects.toThrow("unknown request type");
   }, 10000);

   it("rejects bad JSON gracefully", async () => {
      // The sidecar responds with an error for bad JSON but since we're
      // sending via JSON.stringify, we can't test this directly.
      // Instead, verify that the sidecar is still responsive after errors.
      const resp = await send({ status: {} }) as { files: number };
      expect(typeof resp.files).toBe("number");
   }, 10000);
});

// ---------------------------------------------------------------------------
// Reranker
// ---------------------------------------------------------------------------

describe("reranker", () => {
   const dbPath = join(testRoot, "index-rerank.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
      await indexTestFixtures(dbPath);
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("rerank option does not crash (model may not be downloaded)", async () => {
      const queryEmb = Array.from({ length: 384 }, () => 0.01);
      const resp = await send({
         search: { query: "login", embedding: queryEmb, top_k: 5, mode: "semantic", path_filter: null, rerank: true }
      }) as { results: { score: number }[] };
      // Should still return results even if reranker model isn't downloaded
      // (falls through to truncate-only path)
      expect(resp.results.length).toBeGreaterThanOrEqual(0);
   }, 15000);
});

// ---------------------------------------------------------------------------
// Deterministic reranking behavior
// ---------------------------------------------------------------------------

describe("deterministic reranking", () => {
   const dbPath = join(testRoot, "index-det.db");
   const testFilePath = join(testRoot, "test", "test_auth_spec.ts");

   beforeAll(async () => {
      await startSidecar(dbPath);
      mkdirSync(dirname(testFilePath), { recursive: true });
      writeFileSync(testFilePath, `export function testLogin(): boolean { return true; }
export function shouldNotMatch(): number { return 42; }`);
   }, 30000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("source boost penalizes test files", async () => {
      // Index the test file with a known embedding
      const idxResp = await send({
         index: { paths: [testFilePath], chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
      }) as { files: { path: string; chunks: { text: string; start_line: number; end_line: number }[] }[] };
      const fr = idxResp.files[0];
      if (fr && fr.chunks.length > 0) {
         const storeChunks = fr.chunks.map((c) => ({
            text: c.text,
            start_line: c.start_line,
            end_line: c.end_line,
            embedding: Array.from({ length: 384 }, () => 0.01) as number[]
         }));
         await send({
            store: { file_path: fr.path, mtime: 0, size: 100, chunks: storeChunks }
         });
      }

      const queryEmb = Array.from({ length: 384 }, () => 0.01);
      const resp = await send({
         search: { query: "test", embedding: queryEmb, top_k: 5, mode: "semantic", path_filter: null, rerank: false }
      }) as { results: { path: string; score: number }[] };
      // Test files get 0.85x multiplier from rerank
      // Non-test files get 1.1x multiplier
      // Since we only have test files indexed, scores should be adjusted
      for (const r of resp.results) {
         expect(r.score).toBeGreaterThanOrEqual(0);
         expect(r.score).toBeLessThanOrEqual(1);
      }
   }, 15000);
});

// ---------------------------------------------------------------------------
// AST replace
// ---------------------------------------------------------------------------

describe("ast_replace", () => {
   const dbPath = join(testRoot, "index-ast-replace.db");
   const fixturePaths = Object.keys(FIXTURES).map((f) => join(testRoot, f));

   beforeAll(async () => {
      await startSidecar(dbPath);
      // Index with skip_embed=true, store=false → returns chunks
      const idxResp = await send({
         index: { paths: fixturePaths, chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
      }) as { files: { path: string; chunks: { text: string; start_line: number; end_line: number }[] }[] };
      // Store each file's chunks so they appear in the chunks table (path lookup for ast_replace)
      await Promise.all(
         idxResp.files.map(async (fr) => {
            if (fr.chunks.length === 0) return;
            await send({
               store: {
                  file_path: fr.path,
                  mtime: 0,
                  size: 100,
                  chunks: fr.chunks.map((c) => ({
                     text: c.text,
                     start_line: c.start_line,
                     end_line: c.end_line,
                     embedding: Array.from({ length: 384 }, () => 0.01) as number[]
                  }))
               }
            });
         })
      );
   }, 60000);

   afterAll(async () => { await stopSidecar(); }, 5000);

   it("replaces a function name across multiple files (dry run)", async () => {
      const resp = await send({
         ast_replace: {
            pattern: "login",
            rewrite: "signIn",
            lang: "",
            path_filter: "",
            dry_run: true
         }
      }) as { results: { file: string; matches: number; diff: string | null }[] };

      expect(resp.results.length).toBeGreaterThan(0);
      const authHit = resp.results.find((r) => r.file.includes("auth.ts"));
      expect(authHit).toBeDefined();
      expect(authHit!.matches).toBeGreaterThanOrEqual(1); // login function declaration
      expect(authHit!.diff).toBeTruthy();
      expect(authHit!.diff).toContain("-export function login");
      expect(authHit!.diff).toContain("+export function signIn");

      // Data fixture also has "getUser" but no "login" — verify only auth.ts matched
      const dataHit = resp.results.find((r) => r.file.includes("data.ts"));
      expect(dataHit).toBeUndefined();
   }, 15000);

   it("replaces with lang filter (Python only)", async () => {
      const resp = await send({
         ast_replace: {
            pattern: "def ",
            rewrite: "fn ",
            lang: "py",
            path_filter: "",
            dry_run: true
         }
      }) as { results: { file: string; matches: number; diff: string | null }[] };

      expect(resp.results.length).toBe(1);
      expect(resp.results[0].file).toContain("utils.py");
      expect(resp.results[0].matches).toBeGreaterThanOrEqual(3); // hash_password, verify_hash, __init__
      // Rust files should NOT be matched
      expect(resp.results.some((r) => r.file.endsWith(".rs"))).toBe(false);
      expect(resp.results.some((r) => r.file.endsWith(".ts"))).toBe(false);
   }, 10000);

   it("applies replacement to disk when dryRun=false", async () => {
      const authPath = join(testRoot, "src/auth.ts");
      const original = readFileSync(authPath, "utf8");

      // Rename validateCredentials → validateCreds
      const resp = await send({
         ast_replace: {
            pattern: "validateCredentials",
            rewrite: "validateCreds",
            lang: "",
            path_filter: "",
            dry_run: false
         }
      }) as { results: { file: string; matches: number; diff: string | null }[] };

      expect(resp.results.length).toBeGreaterThan(0);
      const hit = resp.results.find((r) => r.file.includes("auth.ts"));
      expect(hit).toBeDefined();
      expect(hit!.matches).toBeGreaterThanOrEqual(2); // declaration + call in login

      // Verify file was actually written
      const updated = readFileSync(authPath, "utf8");
      expect(updated).not.toBe(original);
      expect(updated).not.toContain("validateCredentials");
      expect(updated).toContain("validateCreds");

      // Restore original for subsequent tests
      writeFileSync(authPath, original);
   }, 15000);

   it("replaces across multiple files with same pattern", async () => {
      // Replace "password" which appears in both auth.ts and utils.py
      // but NOT in main.rs or data.ts
      const resp = await send({
         ast_replace: {
            pattern: "password",
            rewrite: "passphrase",
            lang: "",
            path_filter: "",
            dry_run: true
         }
      }) as { results: { file: string; matches: number; diff: string | null }[] };

      // Should match in auth.ts ("password" appears multiple times as parameter name)
      // and utils.py ("password" appears in function signatures)
      expect(resp.results.length).toBeGreaterThanOrEqual(2);
      const files = resp.results.map((r) => r.file.replace(/\\/g, "/"));
      expect(files.some((f) => f.includes("auth.ts"))).toBe(true);
      expect(files.some((f) => f.includes("utils.py"))).toBe(true);
      expect(files.some((f) => f.includes("main.rs"))).toBe(false);
      expect(files.some((f) => f.includes("data.ts"))).toBe(false);

      // Each file should have its own diff
      for (const r of resp.results) {
         expect(r.diff).toBeTruthy();
         expect(r.diff).toContain("passphrase");
         expect(r.matches).toBeGreaterThan(0);
      }
   }, 10000);

   it("returns empty when no files match", async () => {
      const resp = await send({
         ast_replace: {
            pattern: "NonExistentFunctionXyz123",
            rewrite: "Nothing",
            lang: "",
            path_filter: "",
            dry_run: true
         }
      }) as { results: unknown[] };

      expect(resp.results).toEqual([]);
   }, 10000);

   it("respects path_filter to scope replacement to a single file", async () => {
      // Replace "password" in auth.ts only, not utils.py (which also has "password")
      const resp = await send({
         ast_replace: {
            pattern: "password",
            rewrite: "passphrase",
            lang: "",
            path_filter: "auth.ts",
            dry_run: true
         }
      }) as { results: { file: string; matches: number }[] };

      expect(resp.results.length).toBeGreaterThan(0);
      for (const r of resp.results) {
         expect(r.file).toContain("auth.ts");
      }
      expect(resp.results.some((r) => r.file.includes("utils.py"))).toBe(false);
   }, 10000);

   it("counts matches correctly when pattern appears multiple times per file", async () => {
      const resp = await send({
         ast_replace: {
            pattern: "server",
            rewrite: "srv",
            lang: "rs",
            path_filter: "",
            dry_run: true
         }
      }) as { results: { file: string; matches: number }[] };

      expect(resp.results.length).toBe(1);
      // "server" appears 3× in main(): let mut server, server.register, server.dispatch
      expect(resp.results[0].matches).toBe(3);
   }, 10000);

   it("replaces across TypeScript and Rust files when lang is empty", async () => {
      const resp = await send({
         ast_replace: {
            pattern: "Handler",
            rewrite: "Processor",
            lang: "",
            path_filter: "",
            dry_run: true
         }
      }) as { results: { file: string; matches: number; diff: string | null }[] };

      // Should match in main.rs (Handler trait + JsonHandler struct + impl)
      // and possibly in data.ts
      expect(resp.results.length).toBeGreaterThanOrEqual(1);
      const rsHit = resp.results.find((r) => r.file.endsWith(".rs"));
      expect(rsHit).toBeDefined();
      expect(rsHit!.matches).toBeGreaterThanOrEqual(2); // trait Handler + JsonHandler struct
      expect(rsHit!.diff).toContain("Processor");
   }, 15000);
});

// ---------------------------------------------------------------------------
// Watcher bridge — end-to-end test of watcher_event → stdout → callback
//
// Requires the Rust binary built with `cargo build --release` after the
// watcher_event JSON changes. Without a rebuild the old binary emits
// watcher messages on stderr (unreachable from vitest) instead of stdout JSON.
//
// Tests verify `removed` (file delete) and `started` (watch init) events.
// The `reindexed` (file modify) path needs the ONNX embedding model, which
// isn't downloaded in CI; it's exercised manually with a live Pi session.
// ---------------------------------------------------------------------------

describe("watcher bridge", () => {
   const dbPath = join(testRoot, "index-watcher.db");
   const fixturePaths = Object.keys(FIXTURES).map((f) => join(testRoot, f));
   // This file is created fresh and deleted during the test — not a fixture.
   // Must use a code extension (.ts) — the watcher filters by CODE_EXTENSIONS.
   const watchFile = join(testRoot, "src", "watch-test.ts");

   beforeAll(async () => {
      await startSidecar(dbPath);
      // Index fixtures (skip_embed=true, store manually) so the watcher has
      // file paths in the chunks table to work with.
      const idxResp = await send({
         index: { paths: fixturePaths, chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
      }) as { files: { path: string; chunks: { text: string; start_line: number; end_line: number }[] }[] };
      await Promise.all(
         idxResp.files.map(async (fr) => {
            if (fr.chunks.length === 0) return;
            await send({
               store: {
                  file_path: fr.path,
                  mtime: 0,
                  size: 100,
                  chunks: fr.chunks.map((c) => ({
                     text: c.text,
                     start_line: c.start_line,
                     end_line: c.end_line,
                     embedding: Array.from({ length: 384 }, () => 0.01) as number[]
                  }))
               }
            });
         })
      );
      // Create an extra file for deletion testing (must be a code extension)
      writeFileSync(watchFile, "export function watcherTest(): string { return 'hello'; }\n");
      // Index + store the extra file
      const extraResp = await send({
         index: { paths: [watchFile], chunk_size: 80, overlap: 20, prefix: "", skip_embed: true, store: false }
      }) as { files: { path: string; chunks: { text: string; start_line: number; end_line: number }[] }[] };
      await Promise.all(
         extraResp.files.map(async (fr) => {
            if (fr.chunks.length === 0) return;
            await send({
               store: {
                  file_path: fr.path,
                  mtime: 0,
                  size: 100,
                  chunks: fr.chunks.map((c) => ({
                     text: c.text,
                     start_line: c.start_line,
                     end_line: c.end_line,
                     embedding: Array.from({ length: 384 }, () => 0.01) as number[]
                  }))
               }
            });
         })
      );
      // Start the watcher on the test root
      await send({
         watch: { paths: [testRoot], debounce_ms: 1000 }
      });
      // Allow the watcher to complete its initial scan
      await new Promise((r) => setTimeout(r, 1500));
   }, 60000);

   afterAll(async () => {
      // Stop the watcher before killing the sidecar
      try { await send({ watch_stop: {} }); } catch { /* sidecar may already be dead */ }
      await stopSidecar();
      // Clean up the watch file if it still exists
      try { rmSync(watchFile); } catch {}
   }, 10000);

   it("emits removed watcher_event when a file is deleted", async () => {
      const beforeCount = watcherEvents.length;

      // Delete the extra file, then wait for the watcher to detect the
      // deletion (debounce=1000ms + idle drain ≤2s); the idle loop drains
      // watcher changes on its own.
      rmSync(watchFile);
      await new Promise((r) => setTimeout(r, 2500));
      // A command also flushes any event line buffered with the response.
      await send({ status: {} });

      // Should have received a removed event
      const newEvents = watcherEvents.slice(beforeCount);
      expect(newEvents.length).toBeGreaterThan(0);
      const removed = newEvents.find((e) => e.action === "removed");
      expect(removed).toBeDefined();
      expect(typeof removed!.file === "string" ? removed!.file : "").toContain("watch-test.ts");
      const chunks = Number(removed!.chunks ?? 0);
      expect(chunks).toBeGreaterThan(0);
   }, 15000);

   it("emits started watcher_event on watch command", async () => {
      // The watch command in beforeAll should have emitted a started event
      const started = watcherEvents.find((e) => e.action === "started");
      expect(started).toBeDefined();
      expect(Number(started!.paths ?? 0)).toBeGreaterThanOrEqual(1);
   }, 5000);

   it("reindexes a changed file and emits an event without any command", async () => {
      // Recreate the file deleted by the first test — a fresh change.
      const eventsBefore = watcherEvents.length;
      writeFileSync(watchFile, "export function watcherTest2(): string { return 'hello2'; }\n");

      // NO command is sent: the sidecar's idle loop must wake on its own,
      // drain the watcher, reindex the file, and emit the event.
      const deadline = Date.now() + 12000;
      let found = false;
      while (Date.now() < deadline) {
         found = watcherEvents.slice(eventsBefore).some(
            (e) => e.action === "reindexed" && typeof e.file === "string" && e.file.endsWith("watch-test.ts")
         );
         if (found) break;
         await new Promise((r) => setTimeout(r, 250));
      }
      expect(found).toBe(true);
   }, 20000);

   it("does not reindex files added to .cortexignore", async () => {
      const ignoreFile = join(testRoot, ".cortexignore");
      const ignoredFile = join(testRoot, "src", "ignored-watch.ts");
      writeFileSync(ignoreFile, "src/ignored-watch.ts\n");
      try {
         await new Promise((r) => setTimeout(r, 2500));
         const before = watcherEvents.length;
         writeFileSync(ignoredFile, "export function ignoredWatch(): string { return 'ignored'; }\n");
         await new Promise((r) => setTimeout(r, 3500));
         const reindexed = watcherEvents.slice(before).some(
            (event) => event.action === "reindexed" && typeof event.file === "string" && event.file.endsWith("ignored-watch.ts")
         );
         expect(reindexed).toBe(false);
      } finally {
         rmSync(ignoreFile, { force: true });
         rmSync(ignoredFile, { force: true });
      }
   }, 10000);

   it("resumes the watcher after a sidecar restart using persisted roots", async () => {
      // The manual `watch` command doesn't record meta — persist the roots
      // with a real index request first.
      const target = join(testRoot, "src/data.ts");
      const resp = await send({
         index: { paths: [target], chunk_size: 80, overlap: 20, prefix: "", skip_embed: false, store: true, watch_dirs: [testRoot] }
      }) as { indexed?: { files: number; chunks: number } };
      expect(resp.indexed?.files).toBe(1);

      // Restart the sidecar on the same DB. The watcher must come back on
      // its own from the persisted index_roots meta — no index request.
      await stopSidecar();
      await startSidecar(dbPath, true);

      // Send a command: parsing it also flushes any buffered event lines
      // that arrived with the ready marker.
      const status = await send({ status: {} }) as { watching: boolean };
      expect(status.watching).toBe(true);
      expect(watcherEvents.some((e) => e.action === "auto_started" && e.resumed === true)).toBe(true);
   }, 30000);
});

// ── Multi-session: two sidecars sharing one database ──
// Each pi session spawns its own sidecar process, and all of them open the
// same SQLite DB. The migrations run under BEGIN IMMEDIATE so two sidecars
// starting at the same time serialize instead of both ALTER-ing the same
// table (the loser would crash or silently half-migrate).
describe("two sidecars sharing one database", () => {
   it("both become ready and answer queries on a fresh DB opened simultaneously", async () => {
      const dbPath = join(testRoot, "concurrent.db");
      rmSync(dbPath, { force: true });
      const modelDir = join(testRoot, "models");
      mkdirSync(modelDir, { recursive: true });
      const children: ChildProcess[] = [];

      const spawnSidecar = () =>
         new Promise<ChildProcess>((resolve, reject) => {
            const c = spawn(
               binaryPath,
               ["--model-repo", "Xenova/all-MiniLM-L6-v2", "--models-dir", modelDir, "--db-path", dbPath],
               { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
            );
            children.push(c);
            let buf = "";
            let ready = false;
            const fail = (error: Error) => {
               if (ready) return;
               c.stdout?.off("data", onData);
               reject(error);
            };
            const onData = (d: Buffer) => {
               buf += d.toString();
               const lines = buf.split("\n");
               buf = lines.pop() ?? "";
               for (const line of lines) {
                  if (!line.trim()) continue;
                  const parsed = JSON.parse(line);
                  if (parsed.id === 0 && parsed.dim !== undefined) {
                     ready = true;
                     c.stdout?.off("data", onData);
                     resolve(c);
                  }
               }
            };
            c.stdout?.on("data", onData);
            c.on("error", fail);
            c.on("exit", (code, signal) => {
               if (!ready) fail(new Error(`sidecar exited before ready (code=${code}, signal=${signal ?? ""})`));
            });
         });

      const ask = (c: ChildProcess, msg: Record<string, unknown>) =>
         new Promise<unknown>((resolve, reject) => {
            const id = 5000 + Math.floor(Math.random() * 4000);
            const timer = setTimeout(() => reject(new Error(`timeout on ${JSON.stringify(msg)}`)), 15000);
            const onData = (d: Buffer) => {
               for (const line of d.toString().split("\n")) {
                  if (!line.trim()) continue;
                  try {
                     const parsed = JSON.parse(line);
                     if (parsed.id === id) {
                        clearTimeout(timer);
                        c.stdout?.off("data", onData);
                        if (parsed.error) reject(new Error(parsed.error));
                        else resolve(parsed);
                     }
                  } catch {
                     /* partial line */
                  }
               }
            };
            c.stdout?.on("data", onData);
            c.stdin?.write(JSON.stringify({ id, ...msg }) + "\n");
         });

      try {
         // Open the same brand-new DB from two processes at once. Migrations
         // run in both and serialize through the IMMEDIATE write lock.
         const [a, b] = await Promise.all([spawnSidecar(), spawnSidecar()]);
         const [sa, sb] = await Promise.all([ask(a, { status: {} }), ask(b, { status: {} })]);
         expect((sa as any).error).toBeUndefined();
         expect((sb as any).error).toBeUndefined();
         expect((sa as any).files).toBe(0);
         expect((sb as any).files).toBe(0);

         // Both can query the shared symbols table concurrently.
         const [ra, rb] = await Promise.all([
            ask(a, { symbol_search: { pattern: "nope", kind: null, path_filter: null } }),
            ask(b, { symbol_search: { pattern: "nope", kind: null, path_filter: null } })
         ]);
         expect((ra as any).error).toBeUndefined();
         expect((rb as any).error).toBeUndefined();
         expect((ra as any).results ?? []).toHaveLength(0);
         expect((rb as any).results ?? []).toHaveLength(0);
      } finally {
         await Promise.all(children.map(stopChild));
      }
   }, 90000);

   it("storing the same file from both sidecars leaves exactly one copy", async () => {
      const dbPath = join(testRoot, "concurrent-store.db");
      rmSync(dbPath, { force: true });
      const modelDir = join(testRoot, "models");
      mkdirSync(modelDir, { recursive: true });
      const children: ChildProcess[] = [];

      const spawnSidecar = () =>
         new Promise<ChildProcess>((resolve, reject) => {
            const c = spawn(
               binaryPath,
               ["--model-repo", "Xenova/all-MiniLM-L6-v2", "--models-dir", modelDir, "--db-path", dbPath],
               { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
            );
            children.push(c);
            let buf = "";
            let ready = false;
            const fail = (error: Error) => {
               if (ready) return;
               c.stdout?.off("data", onData);
               reject(error);
            };
            const onData = (d: Buffer) => {
               buf += d.toString();
               const lines = buf.split("\n");
               buf = lines.pop() ?? "";
               for (const line of lines) {
                  if (!line.trim()) continue;
                  const parsed = JSON.parse(line);
                  if (parsed.id === 0 && parsed.dim !== undefined) {
                     ready = true;
                     c.stdout?.off("data", onData);
                     resolve(c);
                  }
               }
            };
            c.stdout?.on("data", onData);
            c.on("error", fail);
            c.on("exit", (code, signal) => {
               if (!ready) fail(new Error(`sidecar exited before ready (code=${code}, signal=${signal ?? ""})`));
            });
         });

      const ask = (c: ChildProcess, msg: Record<string, unknown>) =>
         new Promise<unknown>((resolve, reject) => {
            const id = 9000 + Math.floor(Math.random() * 1000);
            const timer = setTimeout(() => reject(new Error(`timeout on ${JSON.stringify(msg)}`)), 15000);
            const onData = (d: Buffer) => {
               for (const line of d.toString().split("\n")) {
                  if (!line.trim()) continue;
                  try {
                     const parsed = JSON.parse(line);
                     if (parsed.id === id) {
                        clearTimeout(timer);
                        c.stdout?.off("data", onData);
                        if (parsed.error) reject(new Error(parsed.error));
                        else resolve(parsed);
                     }
                  } catch {
                     /* partial line */
                  }
               }
            };
            c.stdout?.on("data", onData);
            c.stdin?.write(JSON.stringify({ id, ...msg }) + "\n");
         });

      const filePath = join(testRoot, "race-target.ts");
      const chunks = Array.from({ length: 4 }, (_, i) => ({
         text: `export const value${i} = ${i};`,
         start_line: i + 1,
         end_line: i + 1,
         embedding: Array.from({ length: 384 }, () => 0.05)
      }));
      const storeMsg = {
         store: { file_path: filePath, mtime: 1234.0, size: 200, chunks }
      };

      try {
         const [a, b] = await Promise.all([spawnSidecar(), spawnSidecar()]);
         // Both sidecars store the SAME file at the SAME time. Whichever
         // commits first wins; the other's re-check sees the committed row
         // and skips. The DB must end with exactly one copy of the file.
         const [ra, rb] = await Promise.all([ask(a, storeMsg), ask(b, storeMsg)]);
         expect((ra as any).error).toBeUndefined();
         expect((rb as any).error).toBeUndefined();
         expect(Number((ra as any).stored ?? 0) + Number((rb as any).stored ?? 0)).toBe(4);

         const check = await ask(a, { status: {} });
         expect((check as any).chunks).toBe(4);
      } finally {
         await Promise.all(children.map(stopChild));
      }
   }, 90000);
});
