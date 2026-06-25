import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, getAgentDir, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Resolve the bundled pi CLI entry point so we can spawn it via process.execPath.
// This avoids relying on the `pi` shell shim (.cmd on Windows) being on PATH.
// The extension lives in <agentDir>/extensions/, so the package is two levels up
// in node_modules/@earendil-works/pi-coding-agent/dist/cli.js.
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PI_CLI_PATH = (() => {
   const candidates = [
      join(EXTENSION_DIR, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      join(getAgentDir(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
   ];
   for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
   }
   return candidates[0]!;
})();

const SESSION_REF_PREFIX = "@S-";
const CACHE_TTL_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 45_000;
const SESSION_EXCERPT_BUDGETS = [60_000, 25_000, 12_000];
const MAX_SESSION_EXCERPT_MESSAGES = 120;
const SESSION_CONFIG_PATH = join(getAgentDir(), "sessions.json");
const SESSION_LOG_PATH = join(getAgentDir(), "pi-sessions.log");
const DEFAULT_SUMMARY_CONFIG = {
   summary: {
      provider: "xiaomi-token-plan-sgp",
      model: "mimo-v2.5",
      thinking: "high"
   }
};

let sessionsCache: { loadedAt: number; promise: Promise<SessionInfo[]> } | undefined;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function writeSessionLog(event: string, details: string): void {
   try {
      appendFileSync(SESSION_LOG_PATH, `[${new Date().toISOString()}] ${event}: ${details}\n`, "utf8");
   } catch {
      // Logging must never break session commands.
   }
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function clip(text: string, max = 72): string {
   return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function extractText(content: unknown): string {
   if (typeof content === "string") return content.trim();
   if (!Array.isArray(content)) return "";
   return content
      .map((part) => {
         if (!part || typeof part !== "object") return "";
         const block = part as { type?: string; text?: string };
         return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
}

type SessionFileEntry = {
   type?: string;
   id?: string;
   parentId?: string | null;
   timestamp?: string;
   message?: unknown;
   summary?: string;
   provider?: string;
   modelId?: string;
   thinkingLevel?: string;
   command?: string;
   output?: string;
   role?: string;
   content?: unknown;
   toolName?: string;
   isError?: boolean;
};

function extractSessionMessageText(message: unknown): string {
   if (!message || typeof message !== "object") return "";
   const block = message as SessionFileEntry;
   if (block.role === "bashExecution") {
      return [
         typeof block.command === "string" ? `Command: ${block.command}` : "",
         typeof block.output === "string" ? block.output : ""
      ]
         .filter(Boolean)
         .join("\n")
         .trim();
   }
   if (block.role === "branchSummary" || block.role === "compactionSummary") {
      return typeof block.summary === "string" ? block.summary.trim() : "";
   }
   if (typeof block.content !== "undefined") return extractText(block.content);
   if (typeof block.output === "string") return block.output.trim();
   if (typeof block.summary === "string") return block.summary.trim();
   return "";
}

// ---------------------------------------------------------------------------
// Session file reading & tree traversal
// ---------------------------------------------------------------------------

function readSessionFileEntries(sessionPath: string): SessionFileEntry[] {
   const entries: SessionFileEntry[] = [];
   const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);
   for (const line of lines) {
      if (!line.trim()) continue;
      try {
         entries.push(JSON.parse(line) as SessionFileEntry);
      } catch {
         // Skip malformed lines.
      }
   }
   return entries;
}

function normalizeFocusTokens(focus: string): string[] {
   return [...new Set((focus.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? []).slice(0, 12))];
}

function buildSessionExcerpt(
   sessionPath: string,
   focus: string,
   maxChars: number,
   maxEntries = MAX_SESSION_EXCERPT_MESSAGES
): string {
   const entries = readSessionFileEntries(sessionPath);
   const byId = new Map<string, SessionFileEntry>();
   let leaf: SessionFileEntry | undefined;

   for (const entry of entries) {
      if (entry.id) byId.set(entry.id, entry);
      if (entry.id) leaf = entry;
   }

   // Walk parent pointers from leaf to root (the active branch).
   const branch: SessionFileEntry[] = [];
   for (let current = leaf; current; ) {
      branch.push(current);
      if (!current.parentId) break;
      current = byId.get(current.parentId) ?? undefined;
   }
   branch.reverse();

   // Focus-based windowing: narrow to entries near the last keyword match.
   const focusTokens = normalizeFocusTokens(focus);
   let selected = branch;
   if (focusTokens.length > 0) {
      const matches = branch
         .map((entry, index) => ({
            entry,
            index,
            text: extractSessionMessageText((entry as SessionFileEntry).message ?? entry)
         }))
         .filter(({ text }) => focusTokens.some((token) => text.toLowerCase().includes(token)));

      if (matches.length > 0) {
         const pivot = matches[matches.length - 1]!.index;
         const start = Math.max(0, pivot - Math.floor(maxEntries / 3));
         const end = Math.min(branch.length, start + maxEntries);
         selected = branch.slice(start, end);
      }
   }

   if (selected.length > maxEntries) selected = selected.slice(selected.length - maxEntries);

   const linesOut = selected
      .map((entry) => {
         const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
         const kind = entry.type ?? "entry";
         const text =
            kind === "message"
               ? extractSessionMessageText(entry.message)
               : typeof entry.summary === "string"
                 ? entry.summary
                 : "";
         if (!text.trim()) return "";
         return `${timestamp ? `[${timestamp}] ` : ""}${kind}: ${clip(text.trim(), 1200)}`;
      })
      .filter(Boolean);

   let excerpt = linesOut.join("\n\n").trim();
   if (!excerpt) {
      // Fallback: raw tail of the file.
      excerpt = readFileSync(sessionPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-80).join("\n").trim();
   }
   if (excerpt.length > maxChars) excerpt = excerpt.slice(excerpt.length - maxChars);
   return excerpt;
}

// ---------------------------------------------------------------------------
// Session list caching
// ---------------------------------------------------------------------------

async function loadSessions(): Promise<SessionInfo[]> {
   const fresh = sessionsCache && Date.now() - sessionsCache.loadedAt < CACHE_TTL_MS ? sessionsCache : undefined;
   if (fresh) return fresh.promise;

   const promise = SessionManager.listAll();
   sessionsCache = { loadedAt: Date.now(), promise };

   try {
      const sessions = await promise;
      return sessions.sort((a, b) => b.created.getTime() - a.created.getTime());
   } catch (error) {
      sessionsCache = undefined;
      writeSessionLog("loadSessions:fail", error instanceof Error ? error.message : String(error));
      throw error;
   }
}

// ---------------------------------------------------------------------------
// Summary config
// ---------------------------------------------------------------------------

type SummaryConfig = { provider: string; model: string; thinking: string };

function loadSummaryConfig(): SummaryConfig {
   try {
      const raw = JSON.parse(readFileSync(SESSION_CONFIG_PATH, "utf8")) as Partial<{ summary: Partial<SummaryConfig> }>;
      return {
         provider: raw.summary?.provider?.trim() || DEFAULT_SUMMARY_CONFIG.summary.provider,
         model: raw.summary?.model?.trim() || DEFAULT_SUMMARY_CONFIG.summary.model,
         thinking: raw.summary?.thinking?.trim() || "off"
      };
   } catch {
      return { ...DEFAULT_SUMMARY_CONFIG.summary, thinking: "off" };
   }
}

// ---------------------------------------------------------------------------
// Pi subprocess summarization
// ---------------------------------------------------------------------------

type SpawnResult = {
   stdout: string;
   stderr: string;
   code: number | null;
   signal: NodeJS.Signals | null;
};

function spawnCommand(
   command: string,
   args: string[],
   stdinText: string,
   signal: AbortSignal | undefined,
   timeoutMs?: number
): Promise<SpawnResult> {
   return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
         env: process.env,
         cwd: process.cwd(),
         signal,
         stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
         stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
         stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code, procSignal) => {
         if (timer) clearTimeout(timer);
         resolve({ stdout, stderr, code, signal: procSignal });
      });

      if (timeoutMs) {
         timer = setTimeout(() => {
            child.kill("SIGTERM");
         }, timeoutMs);
      }
      if (stdinText.length > 0) child.stdin.write(stdinText);
      child.stdin.end();
   });
}

function isContextLengthExceeded(stderr: string): boolean {
   return /context_length_exceeded/i.test(stderr);
}

async function runPiSummary(
   prompt: string,
   stdinText: string,
   summaryConfig: SummaryConfig,
   signal: AbortSignal | undefined,
   timeoutMs: number
): Promise<SpawnResult> {
   const args = [
      PI_CLI_PATH,
      "--provider",
      summaryConfig.provider,
      "--model",
      summaryConfig.model,
      "--thinking",
      summaryConfig.thinking,
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      prompt
   ];

   return spawnCommand(process.execPath, args, stdinText, signal, timeoutMs);
}

async function summarizeSessionWithPi(
   sessionPath: string,
   focus: string,
   signal: AbortSignal | undefined,
   ctx: ExtensionContext
): Promise<string> {
   const summaryConfig = loadSummaryConfig();
   const prompt = [
      "Summarize the following pi session excerpt and return only the most relevant excerpt plus a short rationale.",
      "Use markdown headings exactly: ## Excerpt and ## Rationale.",
      focus ? `Focus: ${focus}` : "Focus on the user's current request and the most useful surrounding context."
   ].join("\n");
   const commandPreview = `node ${PI_CLI_PATH} --provider ${summaryConfig.provider} --model ${summaryConfig.model} --thinking ${summaryConfig.thinking} -p --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files`;

   for (let i = 0; i < SESSION_EXCERPT_BUDGETS.length; i += 1) {
      const excerptBudget = SESSION_EXCERPT_BUDGETS[i]!;
      const transcript = buildSessionExcerpt(sessionPath, focus, excerptBudget);
      writeSessionLog(
         "summarize:start",
         `cmd=${commandPreview} transcriptChars=${transcript.length} excerptBudget=${excerptBudget} sessionPath=${sessionPath} focus=${focus || "<none>"}`
      );
      if (ctx.hasUI) ctx.ui.setStatus("read-session", `Summarizing session...`);

      try {
         const { stdout } = await runPiSummary(prompt, transcript, summaryConfig, signal, SUMMARY_TIMEOUT_MS);
         const output = stdout.trim();
         if (!output) throw new Error("pi returned empty output");
         writeSessionLog("summarize:ok", `sessionPath=${sessionPath} outputChars=${output.length}`);
         return output;
      } catch (error) {
         const code =
            typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
         const stderr =
            typeof error === "object" &&
            error &&
            "stderr" in error &&
            typeof (error as { stderr?: unknown }).stderr === "string"
               ? (error as { stderr: string }).stderr.trim()
               : "";
         const message = error instanceof Error ? error.message : String(error);
         writeSessionLog(
            "summarize:fail",
            `sessionPath=${sessionPath} code=${code || "<none>"} stderr=${stderr || "<none>"} message=${message}`
         );
         if (isContextLengthExceeded(stderr) && i < SESSION_EXCERPT_BUDGETS.length - 1) {
            writeSessionLog(
               "summarize:retry",
               `context_length_exceeded; reducing excerpt budget to ${SESSION_EXCERPT_BUDGETS[i + 1]}`
            );
            continue;
         }
         throw error;
      } finally {
         if (ctx.hasUI) ctx.ui.setStatus("read-session", undefined);
      }
   }

   throw new Error("Unable to summarize session after excerpt retries.");
}

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

function extractSessionRefs(text: string): string[] {
   return [...text.matchAll(/@S-([A-Za-z0-9_-]+)/g)].map((match) => `${SESSION_REF_PREFIX}${match[1]}`);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function readSessionExtension(pi: ExtensionAPI) {
   // Register the read_session tool.
   pi.registerTool({
      name: "read_session",
      label: "Read Session",
      description: "Fetch a referenced session via a separate pi process and extract the relevant excerpt.",
      promptSnippet: "Read session references like @S-<session-id>",
      promptGuidelines: [
         "Use read_session immediately when the user's message contains an @S-<session-id> reference.",
         "Resolve every @S- reference before answering the user."
      ],
      parameters: Type.Object({
         sessionRef: Type.String({ description: "Session reference in the form @S-<session-id>" }),
         focus: Type.Optional(Type.String({ description: "Optional focus keywords for extraction" }))
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         const sessionRef = typeof params.sessionRef === "string" ? params.sessionRef.trim() : "";
         const focus = typeof params.focus === "string" ? params.focus.trim() : "";
         const sessionId = sessionRef.startsWith(SESSION_REF_PREFIX)
            ? sessionRef.slice(SESSION_REF_PREFIX.length).trim()
            : "";

         if (!sessionId) {
            writeSessionLog("read_session:invalid", `sessionRef=${sessionRef || "<empty>"}`);
            return {
               content: [{ type: "text" as const, text: `Invalid session reference: ${sessionRef}` }],
               isError: true,
               details: undefined
            };
         }

         const sessions = await loadSessions();
         const session = sessions.find((item) => item.id === sessionId);
         if (!session) {
            writeSessionLog("read_session:not_found", `sessionRef=${sessionRef}`);
            return {
               content: [{ type: "text" as const, text: `Session not found: ${sessionRef}` }],
               isError: true,
               details: undefined
            };
         }

         writeSessionLog(
            "read_session:start",
            `sessionRef=${sessionRef} sessionPath=${session.path} focus=${focus || "<none>"}`
         );
         onUpdate?.({ content: [{ type: "text" as const, text: `Reading ${sessionRef}...` }], details: undefined });

         try {
            const text = await summarizeSessionWithPi(session.path, focus, signal, ctx);
            writeSessionLog(
               "read_session:ok",
               `sessionRef=${sessionRef} sessionPath=${session.path} outputChars=${text.length}`
            );
            return {
               content: [{ type: "text" as const, text: text || "No relevant excerpt found." }],
               details: { sessionRef, sessionPath: session.path }
            };
         } catch (error) {
            if (signal?.aborted) {
               writeSessionLog("read_session:aborted", `sessionRef=${sessionRef} sessionPath=${session.path}`);
               return {
                  content: [{ type: "text" as const, text: "read_session aborted." }],
                  isError: true,
                  details: undefined
               };
            }
            const code =
               typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
            const stderr =
               typeof error === "object" &&
               error &&
               "stderr" in error &&
               typeof (error as { stderr?: unknown }).stderr === "string"
                  ? (error as { stderr: string }).stderr.trim()
                  : "";
            const message = error instanceof Error ? error.message : String(error);
            const timeoutNote = code === "ETIMEDOUT" ? ` after ${Math.round(SUMMARY_TIMEOUT_MS / 1000)}s` : "";
            writeSessionLog(
               "read_session:fail",
               `sessionRef=${sessionRef} sessionPath=${session.path} code=${code || "<none>"} stderr=${stderr || "<none>"} message=${message}`
            );
            return {
               content: [{ type: "text" as const, text: `read_session failed${timeoutNote}: ${stderr || message}` }],
               isError: true,
               details: undefined
            };
         }
      }
   });

   // Auto-inject resolution directives when @S- references appear in user input.
   pi.on("input", async (event) => {
      if (event.source === "extension") return { action: "continue" };

      const refs = [...new Set(extractSessionRefs(event.text))];
      if (refs.length === 0) return { action: "continue" };

      const directive = [
         `Resolve the referenced session(s) with read_session before answering: ${refs.join(", ")}.`,
         "Do not answer until the session context has been read.",
         "Then answer the user's request using the retrieved context."
      ].join(" ");

      return {
         action: "transform",
         text: `${event.text}\n\n${directive}`
      };
   });
}
