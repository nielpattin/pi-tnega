import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FetchProviderId, ResearchDepth, SearchProviderId } from "./domain.ts";

export interface SearchConfig {
   readonly defaultProvider?: SearchProviderId;
   readonly userLocation?: string;
   readonly limit?: number;
}

export interface ResearchConfig {
   readonly provider?: "llm" | "exa";
   readonly model?: string;
   readonly modelFallbacks?: ReadonlyArray<string>;
   readonly depth?: ResearchDepth;
   readonly searchProvider?: SearchProviderId | "auto";
   readonly fetchProvider?: FetchProviderId;
}

export interface FetchConfig {
   readonly provider?: FetchProviderId;
   readonly maxBytes?: number;
   readonly timeoutMs?: number;
   readonly userAgent?: string;
}

export interface KeysConfig {
   readonly firecrawl?: string;
   readonly exa?: string;
   readonly tavily?: string;
}

export interface WebAccessConfigFile {
   // Namespaced object sections
   search?: {
      defaultProvider?: SearchProviderId;
      userLocation?: string;
      limit?: number;
   };
   research?: {
      provider?: "llm" | "exa";
      model?: string;
      modelFallbacks?: string[];
      depth?: ResearchDepth;
      searchProvider?: SearchProviderId | "auto";
      fetchProvider?: FetchProviderId;
   };
   fetch?: {
      provider?: FetchProviderId;
      maxBytes?: number;
      timeoutMs?: number;
      userAgent?: string;
   };
   keys?: {
      firecrawl?: string;
      exa?: string;
      tavily?: string;
   };

   // Backwards-compatible legacy flat properties
   defaultProvider?: SearchProviderId;
   researchProvider?: "llm" | "exa";
   researchModel?: string;
   researchModelFallbacks?: string[];
   maxBytes?: number;
   timeoutMs?: number;
   userAgent?: string;
   userLocation?: string;
   firecrawlApiKey?: string;
   exaApiKey?: string;
   tavilyApiKey?: string;
}

export interface WebAccessConfig {
   // Namespaced sections
   readonly search: SearchConfig;
   readonly research: ResearchConfig;
   readonly fetch: FetchConfig;
   readonly keys: KeysConfig;

   // Flat getters for convenience & backwards compatibility
   readonly defaultProvider?: SearchProviderId;
   readonly researchProvider?: "llm" | "exa";
   readonly researchModel?: string;
   readonly researchModelFallbacks?: ReadonlyArray<string>;
   readonly maxBytes: number;
   readonly timeoutMs: number;
   readonly userAgent: string;
   readonly userLocation?: string;
   readonly firecrawlApiKey?: string;
   readonly exaApiKey?: string;
   readonly tavilyApiKey?: string;
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

   const parsedMaxBytes = Number.parseInt(
      env.PI_WEB_ACCESS_DEFAULT_MAX_BYTES ?? String(fileConfig.fetch?.maxBytes ?? fileConfig.maxBytes ?? ""),
      10
   );
   const parsedTimeout = Number.parseInt(
      env.PI_WEB_ACCESS_TIMEOUT_MS ?? String(fileConfig.fetch?.timeoutMs ?? fileConfig.timeoutMs ?? ""),
      10
   );

   const firecrawlKey =
      env.FIRECRAWL_API_KEY ||
      fileConfig.keys?.firecrawl ||
      fileConfig.firecrawlApiKey ||
      extractApiKey(authData, "firecrawl");

   const exaKey = env.EXA_API_KEY || fileConfig.keys?.exa || fileConfig.exaApiKey || extractApiKey(authData, "exa");

   const tavilyKey =
      env.TAVILY_API_KEY || fileConfig.keys?.tavily || fileConfig.tavilyApiKey || extractApiKey(authData, "tavily");

   const defaultSearchProvider = (env.PI_WEB_SEARCH_DEFAULT_PROVIDER ||
      fileConfig.search?.defaultProvider ||
      fileConfig.defaultProvider ||
      "firecrawl") as SearchProviderId | undefined;

   const userLocation = env.PI_WEB_ACCESS_USER_LOCATION || fileConfig.search?.userLocation || fileConfig.userLocation;

   const researchProvider =
      (env.PI_WEB_RESEARCH_PROVIDER as "llm" | "exa" | undefined) ||
      fileConfig.research?.provider ||
      fileConfig.researchProvider ||
      "llm";

   const researchModel = env.PI_WEB_RESEARCH_MODEL || fileConfig.research?.model || fileConfig.researchModel;
   const researchModelFallbacks = fileConfig.research?.modelFallbacks || fileConfig.researchModelFallbacks;
   const researchDepth = fileConfig.research?.depth;
   const researchSearchProvider = fileConfig.research?.searchProvider;
   const researchFetchProvider = fileConfig.research?.fetchProvider;

   const fetchProvider = fileConfig.fetch?.provider;
   const maxBytes = Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0 ? parsedMaxBytes : DEFAULT_MAX_BYTES;
   const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
   const userAgent =
      env.PI_WEB_ACCESS_USER_AGENT || fileConfig.fetch?.userAgent || fileConfig.userAgent || DEFAULT_USER_AGENT;

   const search: SearchConfig = {
      defaultProvider: defaultSearchProvider,
      userLocation,
      limit: fileConfig.search?.limit
   };

   const research: ResearchConfig = {
      provider: researchProvider,
      model: researchModel,
      modelFallbacks: researchModelFallbacks,
      depth: researchDepth,
      searchProvider: researchSearchProvider,
      fetchProvider: researchFetchProvider
   };

   const fetch: FetchConfig = {
      provider: fetchProvider,
      maxBytes,
      timeoutMs,
      userAgent
   };

   const keys: KeysConfig = {
      firecrawl: firecrawlKey,
      exa: exaKey,
      tavily: tavilyKey
   };

   return {
      search,
      research,
      fetch,
      keys,

      defaultProvider: defaultSearchProvider,
      researchProvider,
      researchModel,
      researchModelFallbacks,
      maxBytes,
      timeoutMs,
      userAgent,
      userLocation,
      firecrawlApiKey: firecrawlKey,
      exaApiKey: exaKey,
      tavilyApiKey: tavilyKey
   };
}
