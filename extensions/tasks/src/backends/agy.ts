/**
 * agy backend — headless print-mode runs via the Antigravity CLI.
 *
 * One-shot process: spawn `agy --print <prompt>`, stream stdout as text
 * deltas, settle when the process exits. No multi-turn steering.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { TaskBackend, TaskSession } from "../backend.ts";
import type { ReasoningEffort, RunOutcome, SpawnTask, TaskEvent, TaskMeta } from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

/** Base family model shown to the parent agent. Effort selects the CLI slug. */
export const DEFAULT_AGY_MODEL = "gemini-3.6-flash";

/** Base model families the parent can pass as `model` for agy. */
export const AGY_BASE_MODELS = [DEFAULT_AGY_MODEL] as const;

/** agy-native reasoning efforts (also used as Flash model suffixes). */
export const AGY_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type AgyReasoningEffort = (typeof AGY_REASONING_EFFORTS)[number];

/** Resolved CLI model slugs generated from base models × efforts. */
export const AGY_CLI_MODELS = AGY_BASE_MODELS.flatMap((base) =>
   AGY_REASONING_EFFORTS.map((effort) => `${base}-${effort}` as const)
);

/** @deprecated Prefer AGY_CLI_MODELS */
export const AGY_GEMINI_FLASH_MODELS = AGY_CLI_MODELS;

const DEFAULT_PRINT_TIMEOUT = "15m";
const FORCE_KILL_AFTER_MS = 2_000;
const PREVIEW_MAX_LENGTH = 1_024;

export type AgySpawnFn = (
   command: string,
   args: readonly string[],
   options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
      detached?: boolean;
      windowsHide?: boolean;
   }
) => ChildProcessWithoutNullStreams;

// --- Binary resolution -------------------------------------------------------

let cachedAgyBinary: string | null | undefined;

export function pathExistsExecutable(file: string): boolean {
   try {
      if (process.platform === "win32") {
         return fs.existsSync(file) && fs.statSync(file).isFile();
      }
      fs.accessSync(file, fs.constants.X_OK);
      return true;
   } catch {
      return false;
   }
}

/** Resolve once on first use; availability checks after that are allocation-only. */
export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
   if (cachedAgyBinary !== undefined) return cachedAgyBinary ?? undefined;
   const names = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
   for (const directory of (env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue;
      for (const name of names) {
         const candidate = path.join(directory, name);
         if (pathExistsExecutable(candidate)) {
            cachedAgyBinary = candidate;
            return candidate;
         }
      }
   }
   cachedAgyBinary = null;
   return undefined;
}

/** Test-only: reset the binary cache. */
export function resetAgyBinaryCache() {
   cachedAgyBinary = undefined;
}

// --- Args / effort -----------------------------------------------------------

export function mapReasoningEffort(effort: ReasoningEffort | undefined): "low" | "medium" | "high" {
   switch (effort) {
      case "medium":
         return "medium";
      case "high":
      case "xhigh":
      case "max":
         return "high";
      case "off":
      case "minimal":
      case "low":
      case undefined:
      default:
         return "low";
   }
}

/**
 * Resolve the final agy CLI model slug.
 *
 * - Default / bare family `gemini-3.6-flash` + effort → `gemini-3.6-flash-{low|medium|high}`
 * - Effort-encoded Flash slugs get their suffix rewritten from reasoning_effort
 * - Other models (claude-*, gpt-*, etc.) pass through unchanged
 */
export function resolveAgyCliModel(model: string | undefined, effort: ReasoningEffort | undefined): string {
   const raw = model?.trim() || DEFAULT_AGY_MODEL;
   const mappedEffort = mapReasoningEffort(effort);

   // Bare family name: compose with effort.
   if (raw === "gemini-3.6-flash") return `gemini-3.6-flash-${mappedEffort}`;

   // Rewrite effort suffix on Gemini Flash family slugs.
   const flashMatch = raw.match(/^(gemini-\d+(?:\.\d+)?-flash)-(low|medium|high)$/);
   if (flashMatch) return `${flashMatch[1]}-${mappedEffort}`;

   // Any other explicit model is passed through.
   return raw;
}

/** @deprecated Prefer resolveAgyCliModel */
export const resolveAgyModelSlug = resolveAgyCliModel;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Capture agy conversation ids from stdout/stderr/log output.
 *
 * Print mode does NOT print the id to stdout. The reliable source is the
 * private CLI log (`--log-file`), which contains lines like:
 *   Print mode: conversation=<uuid>, sending message
 *   Created conversation <uuid>
 */
export function extractAgyConversationId(text: string): string | undefined {
   if (!text) return undefined;

   // Highest confidence: printmode / server log lines.
   const preferred = [
      /Print mode:\s*conversation=([0-9a-f-]{36})/i,
      /Created conversation\s+([0-9a-f-]{36})/i,
      /Streaming conversation\s+([0-9a-f-]{36})/i,
      /conversation\s+([0-9a-f-]{36})\s*\(active/i,
      /Conversation ID[:\s*`*]+([0-9a-f-]{36})/i
   ];
   for (const re of preferred) {
      const match = text.match(re);
      if (match?.[1]) return match[1];
   }

   // Fallback: first UUID anywhere (tests / unexpected formats).
   const any = text.match(UUID_RE);
   return any ? any[0] : undefined;
}

export function buildAgyArgs(task: {
   readonly prompt: string;
   readonly cwd: string;
   readonly model?: string;
   readonly reasoningEffort?: ReasoningEffort;
   readonly conversationId?: string;
   /** Private log path so we can recover conversation ids print mode hides. */
   readonly logFile?: string;
}): string[] {
   const modelSlug = resolveAgyCliModel(task.model, task.reasoningEffort);
   const args: string[] = [];
   if (task.conversationId) {
      args.push("--conversation", task.conversationId);
   }
   if (task.logFile) {
      args.push("--log-file", task.logFile);
   }
   args.push(
      "--model",
      modelSlug,
      "--effort",
      mapReasoningEffort(task.reasoningEffort),
      "--mode",
      "accept-edits",
      "--dangerously-skip-permissions",
      "--add-dir",
      task.cwd,
      "--print-timeout",
      DEFAULT_PRINT_TIMEOUT,
      "--print",
      task.prompt
   );
   return args;
}

function makeAgyLogFilePath(): string {
   return path.join(os.tmpdir(), `agy-task-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
}

function readFileIfExists(filePath: string): string {
   try {
      return fs.readFileSync(filePath, "utf8");
   } catch {
      return "";
   }
}

function unlinkQuiet(filePath: string | undefined) {
   if (!filePath) return;
   try {
      fs.unlinkSync(filePath);
   } catch {
      // best-effort cleanup
   }
}

// --- Process helpers ---------------------------------------------------------

export function buildTaskkillArgs(pid: number): string[] {
   return ["/pid", String(pid), "/T", "/F"];
}

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
   if (process.platform === "win32") {
      // Prefer taskkill for real process trees. If pid is missing (tests) or
      // taskkill cannot start, fall through to the Node kill path.
      if (typeof child.pid === "number") {
         try {
            spawn("taskkill", buildTaskkillArgs(child.pid), {
               stdio: "ignore",
               windowsHide: true
            });
         } catch {
            // Fall through.
         }
      }
      try {
         child.kill(signal);
      } catch {
         // Already gone.
      }
      return;
   }
   if (child.pid) {
      try {
         process.kill(-child.pid, signal);
         return;
      } catch {
         // Group may already be gone.
      }
   }
   child.kill(signal);
}

function terminateChild(child: ChildProcessWithoutNullStreams, exited: () => boolean) {
   if (exited()) return Promise.resolve();
   return new Promise<void>((resolve) => {
      let done = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let lastTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
         if (done) return;
         done = true;
         if (forceTimer) clearTimeout(forceTimer);
         if (lastTimer) clearTimeout(lastTimer);
         resolve();
      };
      child.once("exit", finish);
      child.once("close", finish);
      killTree(child, "SIGTERM");
      forceTimer = setTimeout(() => {
         if (!exited()) killTree(child, "SIGKILL");
      }, FORCE_KILL_AFTER_MS);
      lastTimer = setTimeout(finish, FORCE_KILL_AFTER_MS + 500);
   });
}

function boundedError(error: unknown) {
   return (error instanceof Error ? error.message : String(error)).slice(0, PREVIEW_MAX_LENGTH * 4);
}

// --- Session -----------------------------------------------------------------

const makeAgySession = (
   task: SpawnTask,
   resolveBinary: () => string | undefined,
   spawnImpl: AgySpawnFn
): Effect.Effect<TaskSession, SpawnError, Scope.Scope> =>
   Effect.gen(function* () {
      const binary = resolveBinary();
      if (!binary) {
         return yield* new SpawnError({
            message: "agy executable was not found on PATH."
         });
      }

      const events = yield* Queue.unbounded<TaskEvent, Cause.Done>();
      const emit = (event: TaskEvent) => {
         Queue.offerUnsafe(events, event);
      };

      const modelLabel = resolveAgyCliModel(task.model, task.reasoningEffort);
      const state = {
         closed: false,
         exited: false,
         settled: false,
         interruptRequested: false,
         activeRun: false,
         stdout: "",
         stderr: "",
         currentChild: null as ChildProcessWithoutNullStreams | null,
         nativeSessionId: undefined as string | undefined,
         meta: {
            backend: "agy" as const,
            modelLabel
         } satisfies TaskMeta as TaskMeta
      };

      const captureConversationId = (sources: string[]) => {
         if (state.nativeSessionId) return state.nativeSessionId;
         for (const source of sources) {
            const extractedId = extractAgyConversationId(source);
            if (!extractedId) continue;
            state.nativeSessionId = extractedId;
            state.meta = { ...state.meta, nativeSessionId: extractedId };
            emit({ _tag: "MetaChanged", meta: { nativeSessionId: extractedId } });
            return extractedId;
         }
         return undefined;
      };

      const runProcess = (prompt: string, conversationId?: string) => {
         state.stdout = "";
         state.stderr = "";
         state.exited = false;
         state.interruptRequested = false;
         state.activeRun = true;

         // Private log is the only reliable place print mode writes the conversation id.
         const logFile = conversationId ? undefined : makeAgyLogFilePath();

         emit({ _tag: "RunStarted" });
         emit({ _tag: "MetaChanged", meta: state.meta });
         emit({ _tag: "UserMessage", text: prompt });

         try {
            const child = spawnImpl(
               binary,
               buildAgyArgs({
                  prompt,
                  cwd: task.cwd,
                  model: task.model,
                  reasoningEffort: task.reasoningEffort,
                  conversationId,
                  logFile
               }),
               {
                  cwd: task.cwd,
                  env: process.env,
                  stdio: ["ignore", "pipe", "pipe"],
                  detached: process.platform !== "win32",
                  windowsHide: true
               }
            );
            state.currentChild = child;

            const settle = (outcome: RunOutcome) => {
               if (state.settled) return;
               state.settled = true;
               state.activeRun = false;
               emit({ _tag: "RunSettled", outcome });
            };

            child.stdout.on("data", (chunk: Buffer | string) => {
               if (state.closed || state.settled) return;
               const text = String(chunk);
               state.stdout += text;
               if (text) {
                  emit({ _tag: "AssistantDelta", kind: "text", delta: text });
               }
            });

            child.stderr.on("data", (chunk: Buffer | string) => {
               if (state.closed) return;
               state.stderr += String(chunk);
            });

            child.on("error", (error) => {
               state.exited = true;
               if (logFile) {
                  captureConversationId([state.stdout, state.stderr, readFileIfExists(logFile)]);
                  try {
                     fs.unlinkSync(logFile);
                  } catch {
                     // best effort
                  }
               }
               if (state.interruptRequested) {
                  settle({
                     _tag: "Interrupted",
                     partialText: state.stdout.trim() || undefined
                  });
                  return;
               }
               settle({
                  _tag: "Failed",
                  errorText: boundedError(error),
                  partialText: state.stdout.trim() || undefined
               });
            });

            child.on("close", (code, signal) => {
               state.exited = true;
               if (state.settled) return;
               const finalText = state.stdout.trim();

               // Prefer private log, then stderr, then stdout.
               if (logFile) {
                  captureConversationId([readFileIfExists(logFile), state.stderr, finalText]);
                  try {
                     fs.unlinkSync(logFile);
                  } catch {
                     // best effort
                  }
               } else {
                  captureConversationId([state.stderr, finalText]);
               }

               if (state.interruptRequested) {
                  settle({
                     _tag: "Interrupted",
                     partialText: finalText || undefined
                  });
                  return;
               }
               if (code === 0) {
                  if (finalText) {
                     emit({
                        _tag: "AssistantMessage",
                        parts: [{ type: "text", text: finalText }]
                     });
                  }
                  settle({ _tag: "Completed", finalText });
                  return;
               }
               const errorText =
                  state.stderr.trim() ||
                  (signal ? `agy terminated by signal ${signal}` : `agy exited with code ${code ?? "unknown"}`);
               settle({
                  _tag: "Failed",
                  errorText: boundedError(errorText),
                  partialText: finalText || undefined
               });
            });
         } catch (error) {
            state.settled = true;
            state.activeRun = false;
            if (logFile) {
               try {
                  fs.unlinkSync(logFile);
               } catch {
                  // best effort
               }
            }
            emit({
               _tag: "RunSettled",
               outcome: { _tag: "Failed", errorText: boundedError(error) }
            });
         }
      };

      const initialPrompt = task.customPrompt ? `${task.customPrompt}\n\n# USER TASK\n${task.prompt}` : task.prompt;
      runProcess(initialPrompt);

      yield* Effect.addFinalizer(() =>
         Effect.promise(async () => {
            state.closed = true;
            if (state.currentChild && !state.exited) {
               state.interruptRequested = true;
               await terminateChild(state.currentChild, () => state.exited);
            }
            if (!state.settled) {
               state.settled = true;
               state.activeRun = false;
               emit({
                  _tag: "RunSettled",
                  outcome: {
                     _tag: "Interrupted",
                     partialText: state.stdout.trim() || undefined
                  }
               });
            }
            Queue.endUnsafe(events);
         })
      );

      return {
         meta: Effect.sync(() => state.meta),
         events: Stream.fromQueue(events),
         send: (text) =>
            Effect.suspend(() => {
               if (!state.nativeSessionId) {
                  return Effect.fail(
                     new SendError({
                        message: "Cannot resume agy session: no conversation ID was captured from initial run."
                     })
                  );
               }
               if (state.activeRun) {
                  return Effect.fail(
                     new SendError({
                        message: "agy session is currently running."
                     })
                  );
               }
               state.settled = false;
               runProcess(text, state.nativeSessionId);
               return Effect.void;
            }),
         interrupt: Effect.promise(async () => {
            if (state.closed || state.settled || state.exited || !state.currentChild) return;
            state.interruptRequested = true;
            await terminateChild(state.currentChild, () => state.exited);
            if (!state.settled) {
               state.settled = true;
               state.activeRun = false;
               emit({
                  _tag: "RunSettled",
                  outcome: {
                     _tag: "Interrupted",
                     partialText: state.stdout.trim() || undefined
                  }
               });
            }
         }),
         popLastQueued: () => Effect.succeed(undefined)
      } satisfies TaskSession;
   });

/** Testable factory: inject binary resolution and process spawn. */
export function createAgyBackend(
   options: {
      resolveBinary?: () => string | undefined;
      spawn?: AgySpawnFn;
   } = {}
): TaskBackend {
   const resolveBinary = options.resolveBinary ?? (() => resolveAgyBinary());
   const spawnImpl: AgySpawnFn =
      options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions as any));

   return {
      name: "agy",
      capabilities: {
         steering: true,
         modelSelection: true,
         reasoningEffort: true
      },
      available: Effect.sync(() => resolveBinary() !== undefined),
      spawn: (task) => makeAgySession(task, resolveBinary, spawnImpl)
   };
}

export const agyBackend: TaskBackend = createAgyBackend();
