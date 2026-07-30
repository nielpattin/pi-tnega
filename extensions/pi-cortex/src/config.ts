import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, DEFAULT_CONFIG } from "./types.js";

// ── Module-level ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _configDir: string | null = null;
let _activeCwd: string = process.cwd();

export function setActiveCwd(cwd: string) {
   _activeCwd = cwd;
}

export function getActiveCwd(): string {
   return _activeCwd;
}

// ── Paths ──

function getRepoRoot(): string {
   // Walk up to find .pi directory
   let dir = _activeCwd;
   while (dir.length > 3) {
      if (existsSync(join(dir, ".pi"))) return dir;
      dir = dirname(dir);
   }
   return _activeCwd;
}

export function getProjectDir(): string {
   if (_configDir) return _configDir;
   _configDir = join(getRepoRoot(), ".pi", "cortex");
   return _configDir;
}

export function getDbPath(): string {
   return join(getProjectDir(), "index.db");
}

export function getLogPath(): string {
   const dir = getProjectDir();
   mkdirSync(dir, { recursive: true });
   return join(dir, "pi-cortex.log");
}

export function getModelsDir(): string {
   const dir = join(getRepoRoot(), ".pi", "cortex", "models");
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
   const projectDir = getProjectDir();
   mkdirSync(projectDir, { recursive: true });

   const configPath = join(projectDir, "config.json");
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
