import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, DEFAULT_CONFIG } from "./types.js";

// ── Module-level ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _agentDir: string | null = null;
let _activeCwd: string = process.cwd();

export function setActiveCwd(cwd: string, sessionDir?: string): void {
   _activeCwd = cwd;
   if (sessionDir) {
      // Sessions live at <agentDir>/sessions/<encoded-cwd>, so the agent dir
      // is two levels up from the session dir.
      _agentDir = dirname(dirname(sessionDir));
   }
}

export function getActiveCwd(): string {
   return _activeCwd;
}

// ── Paths ──

/** The pi agent dir (e.g. ~/.pi/agent), resolved the same way pi does. */
export function getAgentDir(): string {
   if (_agentDir) return _agentDir;
   const envDir = process.env.PI_CODING_AGENT_DIR ?? process.env.TAU_CODING_AGENT_DIR;
   return envDir ? resolve(envDir) : join(homedir(), ".pi", "agent");
}

/**
 * Encode a cwd the same way pi names its session folders:
 * `--` + absolute path with `/`, `\`, `:` flattened to `-` + `--`
 * (e.g. `C:\Users\niel\.pi\agent` → `--C--Users-niel-.pi-agent--`).
 */
export function encodeCwd(cwd: string): string {
   const resolved = resolve(cwd);
   return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Per-project index dir: the current cwd's pi session folder, so the DB
 * lives exactly where pi's sessions for this project live and never inside
 * the project itself.
 */
export function getProjectDir(): string {
   return join(getAgentDir(), "sessions", encodeCwd(_activeCwd));
}

/** Global config dir (config.json, models, log) under the agent dir. */
function getGlobalDir(): string {
   return join(getAgentDir(), ".pi", "cortex");
}

export function getDbPath(): string {
   return join(getProjectDir(), "pi-cortex.db");
}

export function getLogPath(): string {
   const dir = getGlobalDir();
   mkdirSync(dir, { recursive: true });
   return join(dir, "pi-cortex.log");
}

/** Global model cache, shared by every project's index. */
export function getModelsDir(): string {
   const dir = join(getGlobalDir(), "models");
   mkdirSync(dir, { recursive: true });
   return dir;
}

export interface ProjectPaths {
   base: string;
   dbPath: string;
}

export function resolveProjectPaths(projectPath: string | undefined, cwd: string): ProjectPaths {
   if (!projectPath) {
      const saved = _activeCwd;
      return { base: saved, dbPath: getDbPath() };
   }
   const base = join(cwd, projectPath);
   const old = _activeCwd;
   _activeCwd = base;
   const dp = getDbPath();
   _activeCwd = old;
   return { base, dbPath: dp };
}

export function expandEnvVars(val: string): string {
   return val.replace(/\$(\w+|\{(\w+)\})/g, (_match, p1) => {
      const key = p1.startsWith("{") ? p1.slice(1, -1) : p1;
      return process.env[key] ?? "";
   });
}

// ── Config loading ──

export function loadConfig(): Config {
   const configDir = getGlobalDir();
   mkdirSync(configDir, { recursive: true });

   const configPath = join(configDir, "config.json");
   let config: Config;

   if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
   } else {
      config = { ...DEFAULT_CONFIG };
      writeFileSync(configPath, JSON.stringify(config, null, 3));
   }

   // Expand env vars
   config.model = expandEnvVars(config.model);
   config.baseUrl = expandEnvVars(config.baseUrl);
   config.apiKey = expandEnvVars(config.apiKey);
   return config;
}
