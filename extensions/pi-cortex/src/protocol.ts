import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { getLogPath, getModelsDir } from "./config.js";
import type { StatusResult, SearchResult, SymbolResult, CallGraphResult, ScanFile, IndexFileResult } from "./types.js";

// ── Rust sidecar lifecycle ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const binaryName = process.platform === "win32" ? "pi-embedder.exe" : "pi-embedder";
export const binaryPath = join(__dirname, "..", "rust-embedder", "target", "release", binaryName);

// Log rotation threshold. ONNX init emits ~50KB; watcher events are sparse;
// 5MB holds weeks of normal use before rotating.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// `ChildProcess` trips oxlint's `typescript/no-redundant-type-constituents`
// because recent @types/node exposes it as a type containing `any`. Importing
// `Writable`/`Readable`/`NodeJS.Signals` pulls in the same flagged namespace,
// so declare the tiny surface the sidecar touches using only primitives and
// inline object types.
interface RustSidecarStdin {
   writable: boolean;
   write(chunk: string): boolean;
}

interface RustSidecarStdout {
   on(event: "data", listener: (chunk: Buffer) => void): unknown;
   off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

interface RustSidecarChildProcess {
   stdin: RustSidecarStdin | null;
   stdout: RustSidecarStdout | null;
   stderr: RustSidecarStdout | null;
   killed: boolean;
   exitCode: number | null;
   kill(signal?: string | number): boolean;
   on(event: "error", listener: (err: Error) => void): this;
   on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
   once(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
   off(event: "error", listener: (err: Error) => void): this;
}
let child: RustSidecarChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let buf = "";
let ready = false;
let startingPromise: Promise<void> | null = null;

export function rustSend(msg: Record<string, unknown>, timeout = 10000, signal?: AbortSignal): Promise<unknown> {
   return new Promise((resolve, reject) => {
      if (!child?.stdin?.writable || !ready) {
         reject(new Error("Sidecar not running"));
         return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, ...msg }) + "\n");

      const abort = () => {
         if (pending.has(id)) {
            pending.delete(id);
            reject(new Error("Aborted"));
         }
      };

      if (signal) {
         if (signal.aborted) {
            abort();
            return;
         }
         signal.addEventListener("abort", abort, { once: true });
      }

      const timer = setTimeout(() => {
         if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`Timeout after ${timeout}ms`));
         }
      }, timeout);
   });
}

/**
 * Spawn the Rust sidecar and wait until it prints its readiness marker
 * (`[embedder] ready (dim=N)` on stderr or `{"id":0,"dim":N}` on stdout).
 * Concurrent callers share the same starting promise so we only spawn once.
 */
export function startRustSidecar(model: string, dbPath: string): Promise<void> {
   if (child && !child.killed && ready) return Promise.resolve();
   if (startingPromise) return startingPromise;

   startingPromise = doStartSidecar(model, dbPath).finally(() => {
      startingPromise = null;
   });
   return startingPromise;
}

function doStartSidecar(model: string, dbPath: string): Promise<void> {
   return new Promise<void>((resolve, reject) => {
      if (!existsSync(binaryPath)) {
         reject(
            new Error(
               `Cortex sidecar binary not found at ${binaryPath}. ` +
                  `Run "pnpm --dir extensions/pi-cortex build:rust" to build it.`
            )
         );
         return;
      }

      // Rotate an oversized log before starting — single back-buffer at <log>.1.
      // NB: getLogPath() also mkdir's the project dir if missing.
      const logPath = getLogPath();
      try {
         if (statSync(logPath).size > MAX_LOG_BYTES) {
            renameSync(logPath, `${logPath}.1`);
         }
      } catch {
         /* log doesn't exist on first run, or stat/rename failed — fine */
      }

      const modelsDir = getModelsDir();
      child = spawn(binaryPath, ["--model-repo", model, "--models-dir", modelsDir, "--db-path", dbPath], {
         stdio: ["pipe", "pipe", "pipe"]
      });
      buf = "";
      ready = false;
      let stderrBuf = "";

      let settled = false;
      // Cold start downloads ~90MB ONNX model from Hugging Face — generous timeout.
      // Warm start (any .onnx file already cached) is sub-second — 30s is plenty.
      const onnxDir = join(modelsDir, "onnx");
      let onnxCached = false;
      try {
         onnxCached = readdirSync(onnxDir).some((f) => f.endsWith(".onnx"));
      } catch {
         // onnx/ subdir doesn't exist on cold start → default to long timeout.
         onnxCached = false;
      }
      const timeoutMs = onnxCached ? 30_000 : 300_000;
      const timer = setTimeout(
         () =>
            settle(() =>
               reject(
                  new Error(
                     `Sidecar failed to become ready within ${timeoutMs / 1000}s. Last stderr:\n${stderrBuf.trim() || "(empty)"}`
                  )
               )
            ),
         timeoutMs
      );

      const settle = (fn: () => void) => {
         if (settled) return;
         settled = true;
         // Only detach the readiness detector — the permanent logger stays attached
         // so post-ready stderr (watcher events, model errors, etc.) is still visible.
         child?.stderr?.off("data", stderrReadyDetector);
         child?.off("error", errorHandler);
         clearTimeout(timer);
         fn();
      };

      // One-shot detector for the stderr readiness marker.
      const stderrReadyDetector = (data: Buffer) => {
         if (settled) return;
         const text = data.toString("utf-8");
         if (text.includes("[embedder] ready")) {
            ready = true;
            settle(resolve);
         }
      };

      // Per-project log file captures all sidecar stderr for later inspection.
      // `stderrBuf` is also retained so timeout/exit error messages include
      // the sidecar's last words. By default we do NOT forward stderr to
      // process.stderr — it spams the user's terminal. Set PI_CORTEX_DEBUG=1
      // to opt back in to live echoing.
      const cortexDebug = process.env.PI_CORTEX_DEBUG === "1";
      const stderrLogger = (data: Buffer) => {
         const text = data.toString("utf-8");
         // Skip the ready marker — detector handled it; including it in the log
         // or diagnostic dump would make post-ready crashes look like startup
         // failures and spam the log on every warm restart.
         if (text.includes("[embedder] ready")) return;
         stderrBuf += text;
         // Append to pi-cortex.log. Logging failures (disk full, EACCES,
         // file locked) must NEVER kill the sidecar — writes are best-effort.
         try {
            appendFileSync(logPath, text, "utf-8");
         } catch {
            /* swallow */
         }
         if (cortexDebug) {
            const line = text.trim();
            if (line && !line.startsWith("(Press") && !line.startsWith("▶")) {
               process.stderr.write(`[cortex] ${line}\n`);
            }
         }
      };

      const stdoutHandler = (data: Buffer) => {
         buf += data.toString("utf-8");
         const lines = buf.split("\n");
         buf = lines.pop() ?? "";
         for (const line of lines) {
            if (!line.trim()) continue;
            try {
               const parsed = JSON.parse(line);
               // The sidecar's handshake line looks like {"id":0,"dim":N}.
               if (!settled && parsed.id === 0 && parsed.dim !== undefined) {
                  ready = true;
                  settle(resolve);
                  continue;
               }
               if (parsed.id && pending.has(parsed.id)) {
                  const p = pending.get(parsed.id)!;
                  pending.delete(parsed.id);
                  if (parsed.error) {
                     p.reject(new Error(parsed.error));
                  } else {
                     p.resolve(parsed);
                  }
               }
            } catch {
               // partial parse — keep buffering
            }
         }
      };

      const errorHandler = (err: Error) => settle(() => reject(err));

      child.stderr?.on("data", stderrReadyDetector);
      child.stderr?.on("data", stderrLogger);
      child.stdout?.on("data", stdoutHandler);
      child.on("error", errorHandler);
      child.on("exit", (code, signal) => {
         child = null;
         ready = false;
         if (!settled)
            settle(() =>
               reject(
                  new Error(
                     `Sidecar exited before becoming ready (code=${code}, signal=${signal}). Last stderr:\n${stderrBuf.trim() || "(empty)"}`
                  )
               )
            );
      });
   });
}

/**
 * Kill the sidecar and wait for it to exit so file handles (SQLite/WAL) are
 * released before callers touch the DB file.
 */
export async function stopRustSidecar(): Promise<void> {
   if (!child || child.killed) return;
   const c = child;
   child = null;
   ready = false;
   c.kill("SIGKILL");
   await new Promise<void>((resolve) => {
      if (c.exitCode !== null) return resolve();
      c.once("exit", () => resolve());
      setTimeout(resolve, 1000);
   });
   for (const [id, p] of pending) {
      p.reject(new Error("Sidecar stopped"));
      pending.delete(id);
   }
}

// ── Protocol helpers ──

export async function rustScan(paths: string[], extensions: string[], skipDirs: string[]): Promise<ScanFile[]> {
   const r = await rustSend({ scan: { paths, extensions, skip_dirs: skipDirs } }, 30000);
   return (r as any).files ?? [];
}

export async function rustIndex(
   paths: string[],
   chunkSize: number,
   overlap: number,
   prefix: string,
   skipEmbed?: boolean,
   watchDirs?: string[]
): Promise<{ files?: IndexFileResult[]; indexed?: { files: number; chunks: number } }> {
   const msg: Record<string, unknown> = {
      index: {
         paths,
         chunk_size: chunkSize,
         overlap,
         prefix,
         skip_embed: skipEmbed ?? false,
         store: !skipEmbed,
         watch_dirs: watchDirs ?? []
      }
   };
   return rustSend(msg, 300000) as any;
}

export async function rustSearch(
   query: string,
   embedding: number[],
   topK: number,
   keywordWeight: number,
   pathFilter?: string,
   rerank?: boolean
): Promise<SearchResult[]> {
   const r = await rustSend(
      {
         search: {
            query,
            embedding,
            top_k: topK,
            keyword_weight: keywordWeight,
            path_filter: pathFilter ?? null,
            rerank: rerank ?? false
         }
      },
      15000
   );
   return (r as any).results;
}

export async function rustTextSearch(query: string, topK: number, pathFilter?: string): Promise<SearchResult[]> {
   const r = await rustSend({ text_search: { query, top_k: topK, path_filter: pathFilter ?? null } }, 15000);
   return (r as any).results;
}

export async function rustStatus(): Promise<StatusResult> {
   return rustSend({ status: {} }, 5000) as any;
}

export async function rustSymbolSearch(symbol: string, pathFilter?: string): Promise<SymbolResult[]> {
   const r = await rustSend({ symbol_search: { symbol, path_filter: pathFilter ?? null } }, 15000);
   return (r as any).results ?? [];
}

export async function rustCallGraph(symbol: string, direction: string, filePath?: string): Promise<CallGraphResult[]> {
   const r = await rustSend({ call_graph: { symbol, direction, path: filePath ?? null } }, 15000);
   return (r as any).results ?? [];
}

export async function rustDelete(path: string): Promise<void> {
   await rustSend({ delete: { path } }, 30000);
}

export async function rustRebuildFts(): Promise<void> {
   await rustSend({ rebuild_fts: {} }, 60000);
}

// ── New features: triples, memories, AST grep ──

export async function rustTripleQuery(
   subject: string,
   predicate: string,
   object: string,
   limit = 100
): Promise<Array<{ subject: string; predicate: string; object: string; subject_type: string; object_type: string }>> {
   const r = await rustSend({ triple_query: { subject, predicate, object, limit } }, 15000);
   return (r as any).results ?? [];
}

export async function rustMemoryStore(
   content: string,
   embedding: number[],
   source = "",
   importance = 0.5,
   scope = "session"
): Promise<number> {
   const r = await rustSend({ memory_store: { content, embedding, source, importance, scope } }, 15000);
   return (r as any).memory_id ?? 0;
}

export interface MemoryRecallHit {
   memory_id: number;
   content: string;
   score: number;
   source: string;
   importance: number;
   scope: string;
}

export async function rustMemoryRecall(embedding: number[], topK = 5, scope = ""): Promise<MemoryRecallHit[]> {
   const r = await rustSend({ memory_recall: { embedding, top_k: topK, scope } }, 15000);
   return (r as any).results ?? [];
}

export async function rustMemoryForget(memoryId: number): Promise<void> {
   await rustSend({ memory_forget: { memory_id: memoryId } }, 15000);
}

export async function rustAstGrep(
   pattern: string,
   lang = "",
   pathFilter = "",
   topK = 20
): Promise<Array<{ path: string; start_line: number; end_line: number; snippet: string }>> {
   const r = await rustSend({ ast_grep: { pattern, lang, path_filter: pathFilter, top_k: topK } }, 15000);
   return (r as any).results ?? [];
}
