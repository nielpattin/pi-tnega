import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SearchProviderId } from "./domain.ts";

export interface WebAccessConfigFile {
   defaultProvider?: SearchProviderId;
   maxBytes?: number;
   timeoutMs?: number;
   userAgent?: string;
   userLocation?: string;
   exaApiKey?: string;
   braveApiKey?: string;
   tavilyApiKey?: string;
   geminiApiKey?: string;
   firecrawlApiKey?: string;
}

export interface WebAccessConfig {
   readonly defaultProvider?: SearchProviderId;
   readonly maxBytes: number;
   readonly timeoutMs: number;
   readonly userAgent: string;
   readonly userLocation?: string;
   readonly exaApiKey?: string;
   readonly braveApiKey?: string;
   readonly tavilyApiKey?: string;
   readonly geminiApiKey?: string;
   readonly firecrawlApiKey?: string;
}

export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_USER_AGENT =
   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 PiWebAccess/0.1.0";

export function getWebAccessConfigDir(): string {
   return join(getAgentDir(), ".ext-config");
}

export function getWebAccessConfigPath(): string {
   return join(getWebAccessConfigDir(), "pi-web-access.json");
}

export function getAuthFilePath(): string {
   return join(getAgentDir(), "auth.json");
}

function readAuthJson(): Record<string, unknown> {
   const authPath = getAuthFilePath();
   try {
      if (existsSync(authPath)) {
         return JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      }
   } catch {}
   return {};
}

function extractApiKey(authData: Record<string, unknown>, providerName: string): string | undefined {
   const entry = authData[providerName];
   if (entry && typeof entry === "object") {
      const cred = entry as { type?: string; key?: string };
      if (cred.type === "api_key" && typeof cred.key === "string" && cred.key.length > 0) {
         return cred.key;
      }
   }
   return undefined;
}

export function readWebAccessConfigFile(): WebAccessConfigFile {
   const configPath = getWebAccessConfigPath();
   try {
      if (existsSync(configPath)) {
         return JSON.parse(readFileSync(configPath, "utf8")) as WebAccessConfigFile;
      }
   } catch {}
   return {};
}

export async function readWebAccessConfigFileAsync(): Promise<WebAccessConfigFile> {
   const configPath = getWebAccessConfigPath();
   try {
      const data = await readFile(configPath, "utf8");
      return JSON.parse(data) as WebAccessConfigFile;
   } catch {
      return {};
   }
}

export function writeWebAccessConfigFile(config: WebAccessConfigFile): void {
   const configPath = getWebAccessConfigPath();
   mkdirSync(dirname(configPath), { recursive: true });
   writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function writeWebAccessConfigFileAsync(config: WebAccessConfigFile): Promise<void> {
   const configPath = getWebAccessConfigPath();
   await mkdir(dirname(configPath), { recursive: true });
   await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function getWebAccessConfig(): WebAccessConfig {
   const env = process.env;
   const fileConfig = readWebAccessConfigFile();
   const authData = readAuthJson();

   const parsedMaxBytes = Number.parseInt(env.PI_WEB_ACCESS_DEFAULT_MAX_BYTES ?? String(fileConfig.maxBytes ?? ""), 10);
   const parsedTimeout = Number.parseInt(env.PI_WEB_ACCESS_TIMEOUT_MS ?? String(fileConfig.timeoutMs ?? ""), 10);

   const geminiKey =
      env.GEMINI_API_KEY ||
      env.GOOGLE_API_KEY ||
      env.GOOGLE_GENERATIVE_AI_API_KEY ||
      fileConfig.geminiApiKey ||
      extractApiKey(authData, "google") ||
      extractApiKey(authData, "gemini");

   const exaKey = env.EXA_API_KEY || fileConfig.exaApiKey || extractApiKey(authData, "exa");

   const braveKey = env.BRAVE_API_KEY || fileConfig.braveApiKey || extractApiKey(authData, "brave");

   const tavilyKey = env.TAVILY_API_KEY || fileConfig.tavilyApiKey || extractApiKey(authData, "tavily");

   const firecrawlKey = env.FIRECRAWL_API_KEY || fileConfig.firecrawlApiKey || extractApiKey(authData, "firecrawl");

   return {
      defaultProvider: (env.PI_WEB_SEARCH_DEFAULT_PROVIDER || fileConfig.defaultProvider) as
         | SearchProviderId
         | undefined,
      maxBytes: Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0 ? parsedMaxBytes : DEFAULT_MAX_BYTES,
      timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
      userAgent: env.PI_WEB_ACCESS_USER_AGENT || fileConfig.userAgent || DEFAULT_USER_AGENT,
      userLocation: env.PI_WEB_ACCESS_USER_LOCATION || fileConfig.userLocation,
      exaApiKey: exaKey,
      braveApiKey: braveKey,
      tavilyApiKey: tavilyKey,
      geminiApiKey: geminiKey,
      firecrawlApiKey: firecrawlKey
   };
}
