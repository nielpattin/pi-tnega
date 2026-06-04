#!/usr/bin/env node

// src/adapters/amp.ts
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
function getAmpThreadsDir() {
   return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "amp", "threads");
}
function ampAdapter() {
   return {
      name: "amp",
      async *messages(options) {
         const threadsDir = getAmpThreadsDir();
         let files;
         try {
            files = await readdir(threadsDir);
         } catch {
            return;
         }
         const jsonFiles = files.filter((f) => f.endsWith(".json"));
         for (const file of jsonFiles) {
            const filePath = join(threadsDir, file);
            const threadId = file.replace(".json", "");
            try {
               const raw = await readFile(filePath, "utf-8");
               const thread = JSON.parse(raw);
               if (!thread.messages || !Array.isArray(thread.messages)) continue;
               for (const msg of thread.messages) {
                  if (msg.role !== "user") continue;
                  const text = extractText(msg.content);
                  if (!text) continue;
                  const timestamp = msg.timestamp ?? msg.createdAt ?? void 0;
                  if (options?.since && timestamp) {
                     const ts = new Date(timestamp);
                     if (ts < options.since) continue;
                  }
                  yield {
                     text,
                     timestamp,
                     session: threadId
                  };
               }
            } catch {}
         }
      }
   };
}
function extractText(content) {
   if (typeof content === "string") return content;
   if (Array.isArray(content)) {
      const parts = content
         .filter((p) => typeof p === "object" && p !== null && typeof p.text === "string")
         .map((p) => p.text);
      return parts.length > 0 ? parts.join(" ") : null;
   }
   return null;
}

// src/adapters/claude.ts
import { createReadStream } from "node:fs";
import { readdir as readdir2, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var CLAUDE_DIR = join2(homedir2(), ".claude", "projects");
function claudeAdapter() {
   return {
      name: "claude",
      async *messages(options) {
         const projectsDir = CLAUDE_DIR;
         let projectDirs;
         try {
            projectDirs = await readdir2(projectsDir);
         } catch {
            return;
         }
         for (const projectDir of projectDirs) {
            const projectPath = join2(projectsDir, projectDir);
            const projectStat = await stat(projectPath);
            if (!projectStat.isDirectory()) continue;
            const entries = await readdir2(projectPath);
            const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
            for (const file of jsonlFiles) {
               const filePath = join2(projectPath, file);
               const session = file.replace(".jsonl", "");
               yield* parseClaudeJsonl(filePath, {
                  session,
                  project: projectDir,
                  since: options?.since
               });
            }
            const subdirs = entries.filter((f) => !f.includes("."));
            for (const subdir of subdirs) {
               const subagentsDir = join2(projectPath, subdir, "subagents");
               try {
                  const subFiles = await readdir2(subagentsDir);
                  const subJsonl = subFiles.filter((f) => f.endsWith(".jsonl"));
                  for (const file of subJsonl) {
                     yield* parseClaudeJsonl(join2(subagentsDir, file), {
                        session: `${subdir}/${file.replace(".jsonl", "")}`,
                        project: projectDir,
                        since: options?.since
                     });
                  }
               } catch {}
            }
         }
      }
   };
}
async function* parseClaudeJsonl(filePath, context) {
   const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity
   });
   for await (const line of rl) {
      if (!line.trim()) continue;
      try {
         const entry = JSON.parse(line);
         const text = extractUserText(entry);
         if (!text) continue;
         const timestamp = extractTimestamp(entry);
         if (context.since && timestamp) {
            const ts = new Date(timestamp);
            if (ts < context.since) continue;
         }
         yield {
            text,
            timestamp: timestamp ?? void 0,
            session: context.session,
            project: context.project
         };
      } catch {}
   }
}
function extractUserText(entry) {
   if (entry.type === "user") {
      const message = entry.message;
      if (!message) return null;
      return contentToString(message.content);
   }
   if (entry.type === "human") {
      const message = entry.message;
      if (!message) return null;
      return contentToString(message.content);
   }
   if (entry.role === "user") {
      return contentToString(entry.content);
   }
   return null;
}
function contentToString(content) {
   if (typeof content === "string") return content;
   if (Array.isArray(content)) {
      const parts = content.filter((p) => typeof p === "object" && p !== null && p.type === "text").map((p) => p.text);
      return parts.length > 0 ? parts.join(" ") : null;
   }
   return null;
}
function extractTimestamp(entry) {
   if (typeof entry.timestamp === "string") return entry.timestamp;
   if (typeof entry.createdAt === "string") return entry.createdAt;
   return null;
}

// src/adapters/cline.ts
import { readdir as readdir3, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
function getClineTaskDirs() {
   const dirs = [];
   const vscodePaths = getVSCodeGlobalStoragePaths();
   const extensionIds = ["saoudrizwan.claude-dev", "rooveterinaryinc.roo-cline"];
   for (const basePath of vscodePaths) {
      for (const extId of extensionIds) {
         const tasksDir = join3(basePath, extId, "tasks");
         if (existsSync(tasksDir)) dirs.push(tasksDir);
      }
   }
   const clineStandalone = join3(homedir3(), ".cline", "data", "tasks");
   if (existsSync(clineStandalone)) dirs.push(clineStandalone);
   return dirs;
}
function getVSCodeGlobalStoragePaths() {
   const paths = [];
   if (process.platform === "darwin") {
      paths.push(
         join3(homedir3(), "Library", "Application Support", "Code", "User", "globalStorage"),
         join3(homedir3(), "Library", "Application Support", "Code - Insiders", "User", "globalStorage"),
         join3(homedir3(), "Library", "Application Support", "Cursor", "User", "globalStorage")
      );
   } else if (process.platform === "linux") {
      const configBase = process.env.XDG_CONFIG_HOME ?? join3(homedir3(), ".config");
      paths.push(
         join3(configBase, "Code", "User", "globalStorage"),
         join3(configBase, "Code - Insiders", "User", "globalStorage"),
         join3(configBase, "Cursor", "User", "globalStorage")
      );
   } else {
      const appData = process.env.APPDATA ?? join3(homedir3(), "AppData", "Roaming");
      paths.push(
         join3(appData, "Code", "User", "globalStorage"),
         join3(appData, "Code - Insiders", "User", "globalStorage"),
         join3(appData, "Cursor", "User", "globalStorage")
      );
   }
   return paths;
}
function clineAdapter() {
   return {
      name: "cline",
      async *messages(options) {
         const taskDirs = getClineTaskDirs();
         for (const tasksDir of taskDirs) {
            let taskIds;
            try {
               taskIds = await readdir3(tasksDir);
            } catch {
               continue;
            }
            for (const taskId of taskIds) {
               const taskDir = join3(tasksDir, taskId);
               const taskStat = await stat2(taskDir).catch(() => null);
               if (!taskStat?.isDirectory()) continue;
               const historyFile = join3(taskDir, "api_conversation_history.json");
               try {
                  const raw = await readFile2(historyFile, "utf-8");
                  const messages = JSON.parse(raw);
                  if (!Array.isArray(messages)) continue;
                  for (const msg of messages) {
                     if (msg.role !== "user") continue;
                     const text = extractText2(msg.content);
                     if (!text) continue;
                     const timestamp = msg.ts ?? void 0;
                     if (options?.since && timestamp) {
                        const ts = new Date(timestamp);
                        if (ts < options.since) continue;
                     }
                     yield {
                        text,
                        session: taskId
                     };
                  }
               } catch {}
            }
         }
      }
   };
}
function extractText2(content) {
   if (typeof content === "string") return content;
   if (Array.isArray(content)) {
      const parts = content
         .filter((p) => typeof p === "object" && p !== null && p.type === "text" && typeof p.text === "string")
         .map((p) => p.text);
      return parts.length > 0 ? parts.join(" ") : null;
   }
   return null;
}

// src/adapters/codex.ts
import { createReadStream as createReadStream2 } from "node:fs";
import { readdir as readdir4, stat as stat3 } from "node:fs/promises";
import { createInterface as createInterface2 } from "node:readline";
import { homedir as homedir4 } from "node:os";
import { join as join4 } from "node:path";
var CODEX_SESSIONS_DIR = join4(homedir4(), ".codex", "sessions");
function codexAdapter() {
   return {
      name: "codex",
      async *messages(options) {
         yield* walkCodexSessions(CODEX_SESSIONS_DIR, options);
      }
   };
}
async function* walkCodexSessions(dir, options) {
   let entries;
   try {
      entries = await readdir4(dir);
   } catch {
      return;
   }
   for (const entry of entries) {
      const fullPath = join4(dir, entry);
      const entryStat = await stat3(fullPath);
      if (entryStat.isDirectory()) {
         yield* walkCodexSessions(fullPath, options);
      } else if (entry.endsWith(".jsonl")) {
         const session = entry.replace(".jsonl", "");
         yield* parseCodexJsonl(fullPath, { session, since: options?.since });
      }
   }
}
async function* parseCodexJsonl(filePath, context) {
   const rl = createInterface2({
      input: createReadStream2(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity
   });
   for await (const line of rl) {
      if (!line.trim()) continue;
      try {
         const entry = JSON.parse(line);
         if (entry.type !== "response_item") continue;
         const payload = entry.payload;
         if (payload?.role !== "user") continue;
         const text = extractText3(payload.content);
         if (!text) continue;
         if (text.startsWith("<environment_context>")) continue;
         if (text.startsWith("<permissions instructions>")) continue;
         if (context.since && entry.timestamp) {
            const ts = new Date(entry.timestamp);
            if (ts < context.since) continue;
         }
         yield {
            text,
            timestamp: entry.timestamp,
            session: context.session
         };
      } catch {}
   }
}
function extractText3(content) {
   if (!Array.isArray(content)) return null;
   const parts = content
      .filter((p) => typeof p === "object" && p !== null && p.type === "input_text" && typeof p.text === "string")
      .map((p) => p.text);
   return parts.length > 0 ? parts.join(" ") : null;
}

// src/adapters/opencode.ts
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join5 } from "node:path";
function getOpencodeDatabasePath() {
   const xdgPath = join5(process.env.XDG_DATA_HOME ?? join5(homedir5(), ".local", "share"), "opencode", "opencode.db");
   if (existsSync2(xdgPath)) return xdgPath;
   if (process.platform === "darwin") {
      const macPath = join5(homedir5(), "Library", "Application Support", "opencode", "opencode.db");
      if (existsSync2(macPath)) return macPath;
   }
   return null;
}
function opencodeAdapter() {
   return {
      name: "opencode",
      async *messages(options) {
         const dbPath = getOpencodeDatabasePath();
         if (!dbPath) return;
         let db;
         try {
            const BetterSqlite3 = await import("better-sqlite3");
            const Ctor = BetterSqlite3.default ?? BetterSqlite3;
            db = new Ctor(dbPath, { readonly: true });
         } catch {
            console.warn("devrage: better-sqlite3 not available, skipping OpenCode sessions");
            return;
         }
         try {
            yield* queryUserMessages(db, options);
         } finally {
            db.close();
         }
      }
   };
}
function* queryUserMessages(db, options) {
   let query = `
    SELECT
      m.session_id,
      m.time_created,
      json_extract(p.data, '$.text') as text
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
  `;
   if (options?.since) {
      const sinceMs = options.since.getTime();
      query += ` AND m.time_created >= ${sinceMs}`;
   }
   query += ` ORDER BY m.time_created ASC`;
   const rows = db.prepare(query).all();
   for (const row of rows) {
      if (!row.text?.trim()) continue;
      yield {
         text: row.text,
         timestamp: new Date(row.time_created).toISOString(),
         session: row.session_id
      };
   }
}

// src/adapters/zed.ts
import { readdir as readdir5, readFile as readFile3 } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join6 } from "node:path";
function getZedPaths() {
   if (process.platform === "darwin") {
      const base2 = join6(homedir6(), "Library", "Application Support", "Zed");
      return {
         conversations: join6(base2, "conversations"),
         db: join6(base2, "db")
      };
   }
   const base = join6(process.env.XDG_DATA_HOME ?? join6(homedir6(), ".local", "share"), "zed");
   return {
      conversations: join6(base, "conversations"),
      db: join6(base, "db")
   };
}
function zedAdapter() {
   return {
      name: "zed",
      async *messages(options) {
         const paths = getZedPaths();
         yield* parseTextThreads(paths.conversations, options);
         yield* parseAgentThreads(paths.db, options);
      }
   };
}
async function* parseTextThreads(dir, _options) {
   if (!existsSync3(dir)) return;
   let files;
   try {
      files = await readdir5(dir);
   } catch {
      return;
   }
   const jsonFiles = files.filter((f) => f.endsWith(".json"));
   for (const file of jsonFiles) {
      const filePath = join6(dir, file);
      const session = file.replace(".json", "");
      try {
         const raw = await readFile3(filePath, "utf-8");
         const conversation = JSON.parse(raw);
         if (!conversation.messages || !Array.isArray(conversation.messages)) continue;
         for (const msg of conversation.messages) {
            if (msg.role !== "user") continue;
            const text = typeof msg.content === "string" ? msg.content : null;
            if (!text) continue;
            yield {
               text,
               session
            };
         }
      } catch {}
   }
}
async function* parseAgentThreads(dbDir, _options) {
   if (!existsSync3(dbDir)) return;
   let dbFiles;
   try {
      const entries = await readdir5(dbDir);
      dbFiles = entries.filter((f) => f.endsWith(".db"));
   } catch {
      return;
   }
   if (dbFiles.length === 0) return;
   let Database;
   try {
      const mod = await import("better-sqlite3");
      Database = mod.default ?? mod;
   } catch {
      return;
   }
   for (const dbFile of dbFiles) {
      const dbPath = join6(dbDir, dbFile);
      let db;
      try {
         db = new Database(dbPath, { readonly: true });
      } catch {
         continue;
      }
      try {
         const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
         const tableNames = tables.map((t) => t.name);
         const msgTable = tableNames.find((t) => t === "messages" || t === "thread_messages" || t.includes("message"));
         if (!msgTable) {
            db.close();
            continue;
         }
         const columns = db.prepare(`PRAGMA table_info("${msgTable}")`).all();
         const colNames = columns.map((c2) => c2.name);
         const hasRole = colNames.includes("role");
         if (!hasRole) {
            db.close();
            continue;
         }
         const contentCol = colNames.includes("content") ? "content" : colNames.includes("body") ? "body" : "text";
         const query = `SELECT "${contentCol}" as text FROM "${msgTable}" WHERE role = 'user'`;
         const rows = db.prepare(query).all();
         for (const row of rows) {
            if (!row.text?.trim()) continue;
            yield { text: row.text };
         }
      } catch {
      } finally {
         db.close();
      }
   }
}

// src/adapters/pi.ts
var PI_SESSIONS_DIR = join2(homedir2(), ".pi", "agent", "sessions");
function piAdapter() {
   return {
      name: "pi",
      async *messages(options) {
         yield* walkPiSessions(PI_SESSIONS_DIR, options);
      }
   };
}
async function* walkPiSessions(dir, options, project) {
   let entries;
   try {
      entries = await readdir2(dir);
   } catch {
      return;
   }
   for (const entry of entries) {
      const fullPath = join2(dir, entry);
      const entryStat = await stat(fullPath).catch(() => null);
      if (!entryStat) continue;
      if (entryStat.isDirectory()) {
         yield* walkPiSessions(fullPath, options, project ?? entry);
      } else if (entry.endsWith(".jsonl")) {
         const session = entry.replace(".jsonl", "");
         yield* parsePiJsonl(fullPath, { session, project, since: options?.since });
      }
   }
}
async function* parsePiJsonl(filePath, context) {
   const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity
   });
   let project = context.project;
   for await (const line of rl) {
      if (!line.trim()) continue;
      try {
         const entry = JSON.parse(line);
         if (entry.type === "session") {
            project = entry.cwd ?? project;
            continue;
         }
         if (entry.type !== "message") continue;
         const message = entry.message;
         if (message?.role !== "user") continue;
         const text = piContentToString(message.content);
         if (!text) continue;
         const timestamp =
            typeof entry.timestamp === "string"
               ? entry.timestamp
               : typeof message.timestamp === "number"
                 ? new Date(message.timestamp).toISOString()
                 : void 0;
         if (context.since && timestamp) {
            const ts = new Date(timestamp);
            if (ts < context.since) continue;
         }
         yield {
            text,
            timestamp,
            session: context.session,
            project
         };
      } catch {}
   }
}
function piContentToString(content) {
   if (typeof content === "string") return content;
   if (Array.isArray(content)) {
      const parts = content
         .filter((p) => typeof p === "object" && p !== null && p.type === "text" && typeof p.text === "string")
         .map((p) => p.text);
      return parts.length > 0 ? parts.join(" ") : null;
   }
   return null;
}

// src/adapters/index.ts
var ADAPTERS = {
   claude: claudeAdapter,
   codex: codexAdapter,
   opencode: opencodeAdapter,
   amp: ampAdapter,
   cline: clineAdapter,
   zed: zedAdapter,
   pi: piAdapter
};
function createAdapter(name) {
   const factory = ADAPTERS[name];
   if (!factory) {
      throw new Error(`unknown adapter: ${name} (available: ${Object.keys(ADAPTERS).join(", ")})`);
   }
   return factory();
}
function allAdapters() {
   return Object.values(ADAPTERS).map((f) => f());
}

// src/detector/index.ts
var WORDLIST = [
   // === FUCK family (strong) ===
   // Canonical forms
   { word: "fuck", severity: "strong", group: "fuck" },
   { word: "fucking", severity: "strong", group: "fuck" },
   { word: "fucked", severity: "strong", group: "fuck" },
   { word: "fucker", severity: "strong", group: "fuck" },
   { word: "fuckin", severity: "strong", group: "fuck" },
   { word: "fucks", severity: "strong", group: "fuck" },
   // Compound words
   { word: "motherfucker", severity: "strong", group: "fuck" },
   { word: "motherfucking", severity: "strong", group: "fuck" },
   { word: "mothafucka", severity: "strong", group: "fuck" },
   { word: "fuckup", severity: "strong", group: "fuck" },
   { word: "fuckoff", severity: "strong", group: "fuck" },
   { word: "clusterfuck", severity: "strong", group: "fuck" },
   { word: "fuckwit", severity: "strong", group: "fuck" },
   { word: "fucktard", severity: "strong", group: "fuck" },
   { word: "fuckface", severity: "strong", group: "fuck" },
   { word: "fuckhead", severity: "strong", group: "fuck" },
   // Typos — transpositions
   { word: "fukc", severity: "strong", group: "fuck" },
   { word: "fukcing", severity: "strong", group: "fuck" },
   { word: "fukced", severity: "strong", group: "fuck" },
   { word: "fukcer", severity: "strong", group: "fuck" },
   { word: "fcuk", severity: "strong", group: "fuck" },
   { word: "fcuking", severity: "strong", group: "fuck" },
   { word: "fcuked", severity: "strong", group: "fuck" },
   { word: "fuk", severity: "strong", group: "fuck" },
   { word: "fuking", severity: "strong", group: "fuck" },
   { word: "fuked", severity: "strong", group: "fuck" },
   { word: "fuker", severity: "strong", group: "fuck" },
   { word: "fuxk", severity: "strong", group: "fuck" },
   { word: "fuxking", severity: "strong", group: "fuck" },
   // === SHIT family (strong) ===
   { word: "shit", severity: "strong", group: "shit" },
   { word: "shitty", severity: "strong", group: "shit" },
   { word: "shitting", severity: "strong", group: "shit" },
   { word: "shits", severity: "strong", group: "shit" },
   { word: "shitted", severity: "strong", group: "shit" },
   // Compound words
   { word: "bullshit", severity: "strong", group: "shit" },
   { word: "horseshit", severity: "strong", group: "shit" },
   { word: "dipshit", severity: "strong", group: "shit" },
   { word: "shitshow", severity: "strong", group: "shit" },
   { word: "shithead", severity: "strong", group: "shit" },
   { word: "shithole", severity: "strong", group: "shit" },
   { word: "shitface", severity: "strong", group: "shit" },
   { word: "shitfaced", severity: "strong", group: "shit" },
   { word: "shitstain", severity: "strong", group: "shit" },
   { word: "shitbag", severity: "strong", group: "shit" },
   // Typos
   { word: "hsit", severity: "strong", group: "shit" },
   { word: "siht", severity: "strong", group: "shit" },
   { word: "shti", severity: "strong", group: "shit" },
   { word: "sjit", severity: "strong", group: "shit" },
   { word: "shjt", severity: "strong", group: "shit" },
   { word: "bulshit", severity: "strong", group: "shit" },
   { word: "bullsht", severity: "strong", group: "shit" },
   // === ASS family (moderate) ===
   { word: "ass", severity: "moderate", group: "ass" },
   { word: "asses", severity: "moderate", group: "ass" },
   // Compound words (these are strong)
   { word: "asshole", severity: "strong", group: "ass" },
   { word: "assholes", severity: "strong", group: "ass" },
   { word: "jackass", severity: "strong", group: "ass" },
   { word: "dumbass", severity: "strong", group: "ass" },
   { word: "fatass", severity: "moderate", group: "ass" },
   { word: "asshat", severity: "strong", group: "ass" },
   { word: "asswipe", severity: "strong", group: "ass" },
   { word: "badass", severity: "mild", group: "ass" },
   // === DAMN family (moderate) ===
   { word: "damn", severity: "moderate", group: "damn" },
   { word: "damned", severity: "moderate", group: "damn" },
   { word: "damnit", severity: "moderate", group: "damn" },
   { word: "dammit", severity: "moderate", group: "damn" },
   { word: "goddamn", severity: "moderate", group: "damn" },
   { word: "goddamnit", severity: "moderate", group: "damn" },
   { word: "goddammit", severity: "moderate", group: "damn" },
   // === BITCH family (strong) ===
   { word: "bitch", severity: "strong", group: "bitch" },
   { word: "bitches", severity: "strong", group: "bitch" },
   { word: "bitching", severity: "strong", group: "bitch" },
   { word: "bitchy", severity: "strong", group: "bitch" },
   { word: "bitchass", severity: "strong", group: "bitch" },
   // === BASTARD (strong) ===
   { word: "bastard", severity: "strong", group: "bastard" },
   { word: "bastards", severity: "strong", group: "bastard" },
   // === PISS family (moderate) ===
   { word: "piss", severity: "moderate", group: "piss" },
   { word: "pissed", severity: "moderate", group: "piss" },
   { word: "pissing", severity: "moderate", group: "piss" },
   { word: "pissoff", severity: "moderate", group: "piss" },
   // === DICK (moderate) ===
   { word: "dick", severity: "moderate", group: "dick" },
   { word: "dickhead", severity: "strong", group: "dick" },
   // === CRAP (moderate) ===
   { word: "crap", severity: "moderate", group: "crap" },
   { word: "crappy", severity: "moderate", group: "crap" },
   { word: "crapping", severity: "moderate", group: "crap" },
   // === HELL (mild) ===
   { word: "hell", severity: "mild", group: "hell" },
   // === Abbreviations (mild) ===
   { word: "wtf", severity: "mild", group: "wtf" },
   { word: "stfu", severity: "mild", group: "stfu" },
   { word: "lmfao", severity: "mild", group: "lmfao" },
   { word: "lmao", severity: "mild", group: "lmao" },
   // === CUNT (strong) ===
   { word: "cunt", severity: "strong", group: "cunt" },
   { word: "cunts", severity: "strong", group: "cunt" }
];
function collapseRepeats(text) {
   return text.replace(/(.)\1+/g, "$1");
}
function buildPattern(words) {
   const sorted = [...words].sort((a, b) => b.word.length - a.word.length);
   const pattern = sorted.map((w) => w.word).join("|");
   return new RegExp(`\\b(${pattern})\\b`, "gi");
}
var DEFAULT_PATTERN = buildPattern(WORDLIST);
var WORD_MAP = new Map(WORDLIST.map((w) => [w.word.toLowerCase(), w]));
function detect(text) {
   const matches = [];
   const seen = /* @__PURE__ */ new Set();
   runPattern(text, text.toLowerCase(), matches, seen);
   const collapsed = collapseRepeats(text.toLowerCase());
   if (collapsed !== text.toLowerCase()) {
      runPattern(text, collapsed, matches, seen);
   }
   return { count: matches.length, matches };
}
function runPattern(_originalText, searchText, matches, seen) {
   DEFAULT_PATTERN.lastIndex = 0;
   let match;
   while ((match = DEFAULT_PATTERN.exec(searchText)) !== null) {
      if (seen.has(match.index)) continue;
      const word = match[0].toLowerCase();
      const entry = WORD_MAP.get(word);
      if (!entry) continue;
      seen.add(match.index);
      matches.push({
         word,
         index: match.index,
         severity: entry.severity,
         group: entry.group
      });
   }
}

// src/commands/scan.ts
var c = {
   reset: "\x1B[0m",
   bold: "\x1B[1m",
   dim: "\x1B[2m",
   red: "\x1B[31m",
   green: "\x1B[32m",
   yellow: "\x1B[33m",
   blue: "\x1B[34m",
   magenta: "\x1B[35m",
   cyan: "\x1B[36m",
   white: "\x1B[37m",
   gray: "\x1B[90m"
};
var SPINNER_MESSAGES = [
   "Tallying the damage",
   "Reviewing your outbursts",
   "Judging your vocabulary",
   "Computing your shame",
   "Cataloging the profanity",
   "Measuring your frustration",
   "Assessing the verbal carnage",
   "Quantifying your displeasure",
   "Auditing your language",
   "Tabulating regrets"
];
function createSpinner() {
   let messageIdx = 0;
   let dotCount = 0;
   let timer = null;
   return {
      start() {
         messageIdx = Math.floor(Math.random() * SPINNER_MESSAGES.length);
         timer = setInterval(() => {
            dotCount = (dotCount + 1) % 4;
            const msg = SPINNER_MESSAGES[messageIdx % SPINNER_MESSAGES.length];
            const dots = ".".repeat(dotCount || 1);
            process.stdout.write(`\r  ${c.dim}${msg}${dots}${c.reset}   `);
         }, 300);
      },
      update() {
         messageIdx++;
      },
      stop() {
         if (timer) {
            clearInterval(timer);
            timer = null;
         }
         process.stdout.write(`\r${" ".repeat(60)}\r`);
      }
   };
}
function parseArgs(args) {
   const options = {};
   for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--agent" || arg === "-a") {
         options.agent = args[++i];
      } else if (arg === "--since" || arg === "-s") {
         const val = args[++i];
         if (val) {
            options.since = new Date(val);
            if (Number.isNaN(options.since.getTime())) {
               console.error(`invalid date: ${val}`);
               process.exit(1);
            }
         }
      } else if (arg === "--help" || arg === "-h") {
         console.log(`devrage scan \u2014 scan sessions for profanity
Options:
  --agent, -a <name>   Scan only a specific agent (claude, codex, opencode, amp, cline, zed, pi)
  --since, -s <date>   Only scan messages after this date (ISO 8601)
  --help, -h           Show this help`);
         process.exit(0);
      }
   }
   return options;
}
async function scan(args) {
   const options = parseArgs(args);
   const adapters = options.agent ? [createAdapter(options.agent)] : allAdapters();
   const spinner = createSpinner();
   spinner.start();
   const groupTally = {};
   const variantTally = {};
   let totalMessages = 0;
   let totalSwears = 0;
   const perAgent = {};
   for (const adapter of adapters) {
      let agentMessages = 0;
      let agentSwears = 0;
      spinner.update();
      for await (const message of adapter.messages({ since: options.since })) {
         totalMessages++;
         agentMessages++;
         const result = detect(message.text);
         if (result.count > 0) {
            totalSwears += result.count;
            agentSwears += result.count;
            for (const match of result.matches) {
               groupTally[match.group] = (groupTally[match.group] ?? 0) + 1;
               const variants = (variantTally[match.group] ??= {});
               variants[match.word] = (variants[match.word] ?? 0) + 1;
            }
         }
      }
      if (agentMessages > 0) {
         perAgent[adapter.name] = { messages: agentMessages, swears: agentSwears };
      }
   }
   spinner.stop();
   console.log("");
   console.log(`  ${c.bold}${c.red}devrage${c.reset} ${c.dim}report${c.reset}`);
   console.log(`  ${c.dim}${"\u2500".repeat(30)}${c.reset}`);
   console.log("");
   console.log(`  ${c.dim}messages scanned${c.reset}  ${c.bold}${totalMessages}${c.reset}`);
   console.log(`  ${c.dim}total swears${c.reset}      ${c.bold}${c.red}${totalSwears}${c.reset}`);
   const activeAgents = Object.entries(perAgent);
   if (activeAgents.length > 1) {
      console.log("");
      console.log(`  ${c.bold}by agent${c.reset}`);
      for (const [name, stats] of activeAgents) {
         const rate = ((stats.swears / stats.messages) * 100).toFixed(1);
         console.log(
            `    ${c.cyan}${name.padEnd(10)}${c.reset} ${c.bold}${String(stats.swears).padStart(4)}${c.reset} ${c.dim}in ${stats.messages} messages (${rate}%)${c.reset}`
         );
      }
   }
   if (totalSwears > 0) {
      const sorted = Object.entries(groupTally).sort(([, a], [, b]) => b - a);
      console.log("");
      console.log(`  ${c.bold}top words${c.reset}`);
      for (const [group, count] of sorted.slice(0, 10)) {
         const variants = variantTally[group] ?? {};
         const variantList = Object.entries(variants)
            .sort(([, a], [, b]) => b - a)
            .filter(([v]) => v !== group)
            .slice(0, 15)
            .map(([v, cnt]) => `${c.dim}${v}${c.reset} ${String(cnt)}`)
            .join(`${c.dim},${c.reset} `);
         const suffix = variantList ? ` ${c.dim}(${c.reset}${variantList}${c.dim})${c.reset}` : "";
         console.log(
            `    ${c.yellow}${group.padEnd(12)}${c.reset} ${c.bold}${String(count).padStart(4)}${c.reset}${suffix}`
         );
      }
   }
   console.log("");
   if (totalSwears === 0) {
      console.log(`  ${c.green}squeaky clean! not a single swear found.${c.reset}`);
      console.log("");
   }
}

// src/cli.ts
var COMMANDS = {
   scan
};
function usage() {
   console.log(`devrage \u2014 count how many times you swear at your coding agents
Usage:
  devrage <command> [options]
Commands:
  scan          Scan sessions for profanity
Options:
  --help, -h    Show this help message
  --version     Show version
Examples:
  devrage scan
  devrage scan --agent claude
  devrage scan --since 2025-01-01`);
}
async function main() {
   const args = process.argv.slice(2);
   const command = args[0];
   if (command === "--help" || command === "-h") {
      usage();
      process.exit(0);
   }
   if (command === "--version") {
      console.log("0.0.3");
      process.exit(0);
   }
   const handler = command ? COMMANDS[command] : void 0;
   if (handler) {
      await handler(args.slice(1));
   } else {
      await scan(args);
   }
}
main().catch((err) => {
   console.error(err);
   process.exit(1);
});
//# sourceMappingURL=cli.js.map
