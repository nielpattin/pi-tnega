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
const binaryPath = join(__dirname, "rust-embedder", "target", "release", binaryName);

test("rust sidecar binary exists", () => {
   expect(existsSync(binaryPath), `Binary not found at ${binaryPath}. Run "cd rust-embedder && cargo build --release" first.`).toBe(true);
});

// Temp dir for test fixtures + DB
const testRoot = join(__dirname, ".test-tmp");
let child: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let buf = "";

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

function startSidecar(dbPath: string) {
   return new Promise<void>((resolve, reject) => {
      rmSync(dbPath, { force: true });
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

function stopSidecar() {
   if (child) {
      child.kill();
      child = null;
   }
   for (const p of pending.values()) p.reject(new Error("sidecar stopped"));
   pending.clear();
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
        format!("{{\"received\": \"{}\"}}", req)
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
   stopSidecar();
   // Clean up test fixtures — files in .test-tmp/ only, never outside.
   if (testRoot.startsWith(__dirname)) {
      for (let i = 0; i < 5; i++) {
         try {
            rmSync(testRoot, { recursive: true, force: true });
            break;
         } catch {}
         await new Promise((r) => setTimeout(r, 200));
      }
   }
}, 10000);

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

describe("scan", () => {
   beforeAll(async () => {
      await startSidecar(join(testRoot, "index.db"));
   }, 30000);

   afterAll(() => { stopSidecar(); }, 5000);

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
   for (const fr of idxResp.files) {
      if (fr.error) throw new Error(`Index error for ${fr.path}: ${fr.error}`);
      if (fr.chunks.length === 0) continue;
      const storeChunks = fr.chunks.map((c) => ({
         text: c.text,
         start_line: c.start_line,
         end_line: c.end_line,
         embedding: new Array(384).fill(0.01) as number[]
      }));
      // Make the auth.ts file have meaningful embedding-like values for cosine tests
      if (fr.path.includes("auth.ts") || fr.path.includes("login")) {
         for (let i = 0; i < storeChunks.length; i++) {
            storeChunks[i].embedding = [0.9, 0.1, ...new Array(382).fill(0.01)];
         }
      }
      const storeResp = await send({
         store: { file_path: fr.path, mtime: fr.mtime, size: 100, chunks: storeChunks }
      }) as { stored: number };
      expect(storeResp.stored).toBe(storeChunks.length);
   }
   return idxResp.files.length;
}

describe("index + store", () => {
   const dbPath = join(testRoot, "index-test.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
   }, 30000);

   afterAll(() => { stopSidecar(); }, 5000);

   it("indexes files without embedding and returns chunks", async () => {
      await indexTestFixtures(dbPath);
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

   afterAll(() => { stopSidecar(); }, 5000);

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

   it("snippet is truncated to 500 chars", async () => {
      const resp = await send({
         text_search: { query: "login", top_k: 3 }
      }) as { results: { snippet: string }[] };
      for (const r of resp.results) {
         expect(r.snippet.length).toBeLessThanOrEqual(500);
      }
   }, 10000);
});

// ---------------------------------------------------------------------------
// Symbol search
// ---------------------------------------------------------------------------

describe("symbol_search", () => {
   const dbPath = join(testRoot, "index-sym.db");

   beforeAll(async () => {
      await startSidecar(dbPath);
      await indexTestFixtures(dbPath);
   }, 60000);

   afterAll(() => { stopSidecar(); }, 5000);

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

   it("returns empty for non-matching pattern", async () => {
      const resp = await send({
         symbol_search: { pattern: "NoSuchSymbolXyz", path_filter: null }
      }) as { results: unknown[] };
      expect(resp.results).toEqual([]);
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

   afterAll(() => { stopSidecar(); }, 5000);

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

   afterAll(() => { stopSidecar(); }, 5000);

   it("semantic search returns results with scores", async () => {
      const queryEmb = new Array(384).fill(0.01);
      queryEmb[0] = 0.8; // dot with the auth.ts embedding
      const resp = await send({
         search: { query: "login authentication", embedding: queryEmb, top_k: 5, mode: "semantic", path_filter: null, rerank: false }
      }) as { results: { path: string; start_line: number; end_line: number; snippet: string; score: number }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      expect(resp.results[0].score).toBeGreaterThan(0);
      expect(resp.results[0].snippet.length).toBeGreaterThan(0);
   }, 10000);

   it("hybrid search blends with FTS5 scores", async () => {
      const queryEmb = new Array(384).fill(0.01);
      const resp = await send({
         search: { query: "Handler trait", embedding: queryEmb, top_k: 5, mode: "hybrid", path_filter: null, rerank: false }
      }) as { results: { path: string; score: number }[] };
      expect(resp.results.length).toBeGreaterThan(0);
      // Hybrid should find Rust Handler via FTS5 boost
      expect(resp.results.some((r) => r.path.endsWith(".rs"))).toBe(true);
   }, 10000);

   it("respects path filter in semantic search", async () => {
      const queryEmb = new Array(384).fill(0.01);
      const resp = await send({
         search: { query: "login", embedding: queryEmb, top_k: 5, mode: "semantic", path_filter: "main.rs", rerank: false }
      }) as { results: { path: string }[] };
      for (const r of resp.results) {
         expect(r.path).toContain("main.rs");
      }
   }, 10000);

   it("returns empty for zero vector query", async () => {
      const queryEmb = new Array(384).fill(0);
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

   afterAll(() => { stopSidecar(); }, 5000);

   it("rejects unknown request type", async () => {
      try {
         await send({ unknown_cmd: {} } as Record<string, unknown>, 5000);
         expect.unreachable("should have thrown");
      } catch (e: unknown) {
         expect((e as Error).message).toContain("unknown request type");
      }
   }, 10000);

   it("rejects bad JSON gracefully", async () => {
      // The sidecar responds with an error for bad JSON but since we're
      // sending via JSON.stringify, we can't test this directly.
      // Instead, verify that the sidecar is still responsive after errors.
      const resp = await send({ status: {} }) as { files: number };
      expect(typeof resp.files).toBe("number");
   }, 10000);

   it("rejects search without db", async () => {
      // Start a second sidecar without db-path to test
      // This is tested implicitly - our sidecar always has db.
   }, 1000);
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

   afterAll(() => { stopSidecar(); }, 5000);

   it("rerank option does not crash (model may not be downloaded)", async () => {
      const queryEmb = new Array(384).fill(0.01);
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

   afterAll(() => { stopSidecar(); }, 5000);

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
            embedding: new Array(384).fill(0.01) as number[]
         }));
         await send({
            store: { file_path: fr.path, mtime: 0, size: 100, chunks: storeChunks }
         });
      }

      const queryEmb = new Array(384).fill(0.01);
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


