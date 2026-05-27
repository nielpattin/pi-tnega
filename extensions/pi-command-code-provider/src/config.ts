import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const COMMAND_CODE_API = "command-code-alpha" as const;

type ThinkingLevelKey = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<ThinkingLevelKey, string | null>>;
type OutputModality = "text" | "image" | "audio" | "video";
type CapabilityFlags = Record<string, boolean>;

export type CommandCodeProviderModelConfig = ProviderModelConfig & {
   baseUrl?: string;
   thinkingLevelMap?: ThinkingLevelMap;
   output?: OutputModality[];
   capabilities?: CapabilityFlags;
   isFree?: boolean;
   importOwnership?: string;
};

export interface ExtensionConfig {
   enabled: boolean;
   debug: boolean;
   providerId: string;
   displayName: string;
   upstreamUrl: string;
   apiKey: string;
   commandCodeVersion: string;
   commandCodeProvider: string;
   requestTimeoutMs: number;
   memory: string;
   headers: Record<string, string>;
   models: CommandCodeProviderModelConfig[];
}

export interface ConfigLoadResult {
   config: ExtensionConfig;
   warnings: string[];
}

const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const DEFAULT_MODEL_DEFAULTS = {
   reasoning: false,
   input: ["text"] as Array<"text" | "image">,
   contextWindow: 128_000,
   maxTokens: 8_192,
   cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
   }
} satisfies Omit<ProviderModelConfig, "id" | "name">;

const OPENAI_REASONING_MAP = {
   off: "none",
   minimal: "minimal",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: null
} satisfies ThinkingLevelMap;
const ANTHROPIC_REASONING_MAP = {
   off: "disabled",
   minimal: "low",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: null
} satisfies ThinkingLevelMap;
const ANTHROPIC_OPUS_4_7_REASONING_MAP = { ...ANTHROPIC_REASONING_MAP, xhigh: "xhigh" } satisfies ThinkingLevelMap;
const ANTHROPIC_OPUS_4_6_REASONING_MAP = { ...ANTHROPIC_REASONING_MAP, xhigh: "max" } satisfies ThinkingLevelMap;
const COMMAND_CODE_AUTO_REASONING_MAP = {
   off: null,
   minimal: null,
   low: null,
   medium: null,
   high: "high",
   xhigh: "max"
} satisfies ThinkingLevelMap;

const DEFAULT_RAW_MODELS: Record<string, unknown>[] = [
   {
      id: "moonshotai/Kimi-K2.5",
      name: "Kimi K2.5",
      description: "multimodal frontend coding",
      reasoning: false,
      contextWindow: 256000,
      maxTokens: 262144,
      cost: { input: 0.6, output: 3, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "moonshotai/Kimi-K2.6",
      name: "Kimi K2.6",
      description: "long-horizon coding with vision",
      reasoning: false,
      contextWindow: 256000,
      maxTokens: 262144,
      cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 }
   },
   {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      description: "hybrid-attention long-context reasoning",
      reasoning: true,
      thinkingLevelMap: COMMAND_CODE_AUTO_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 393216,
      cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 }
   },
   {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      description: "fast hybrid-attention reasoning",
      reasoning: true,
      thinkingLevelMap: COMMAND_CODE_AUTO_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 384000,
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 }
   },
   {
      id: "Qwen/Qwen3.6-Plus",
      name: "Qwen 3.6 Plus",
      description: "agentic coding & reasoning",
      reasoning: true,
      thinkingLevelMap: COMMAND_CODE_AUTO_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 65536,
      cost: { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 }
   },
   {
      id: "Qwen/Qwen3.6-Max-Preview",
      name: "Qwen 3.6 Max Preview",
      description: "vibe coding & efficient agent execution",
      reasoning: true,
      thinkingLevelMap: COMMAND_CODE_AUTO_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 65536,
      cost: { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 }
   },
   {
      id: "stepfun/Step-3.5-Flash",
      name: "Step 3.5 Flash",
      description: "fast sparse-MoE agentic reasoning",
      reasoning: true,
      thinkingLevelMap: COMMAND_CODE_AUTO_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "zai-org/GLM-5",
      name: "GLM 5",
      description: "multi-mode thinking & long-range planning",
      reasoning: false,
      contextWindow: 200000,
      maxTokens: 131072,
      cost: { input: 0.95, output: 3.15, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "zai-org/GLM-5.1",
      name: "GLM 5.1",
      description: "long-horizon autonomous coding agent",
      reasoning: false,
      contextWindow: 200000,
      maxTokens: 131072,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }
   },
   {
      id: "MiniMaxAI/MiniMax-M2.5",
      name: "MiniMax M2.5",
      description: "cross-platform full-stack agentic dev",
      reasoning: false,
      contextWindow: 200000,
      maxTokens: 131072,
      cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "MiniMaxAI/MiniMax-M2.7",
      name: "MiniMax M2.7",
      description: "end-to-end software engineering agent",
      reasoning: false,
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "gpt-5.5",
      name: "GPT 5.5",
      description: "latest frontier model for general complex work",
      reasoning: true,
      thinkingLevelMap: OPENAI_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 128000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
   },
   {
      id: "gpt-5.4",
      name: "GPT 5.4",
      description: "frontier model for general complex work",
      reasoning: true,
      thinkingLevelMap: OPENAI_REASONING_MAP,
      contextWindow: 400000,
      maxTokens: 128000,
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }
   },
   {
      id: "gpt-5.3-codex",
      name: "GPT 5.3 Codex",
      description: "frontier coding model",
      reasoning: true,
      thinkingLevelMap: OPENAI_REASONING_MAP,
      contextWindow: 400000,
      maxTokens: 128000,
      cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }
   },
   {
      id: "gpt-5.4-mini",
      name: "GPT 5.4 Mini",
      description: "fast, cost-effective model for everyday tasks",
      reasoning: true,
      thinkingLevelMap: OPENAI_REASONING_MAP,
      contextWindow: 400000,
      maxTokens: 128000,
      cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 }
   },
   {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      description: "best combo of speed & intelligence (recommended)",
      reasoning: true,
      thinkingLevelMap: ANTHROPIC_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 64000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
   },
   {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      description: "most intelligent for agents and coding",
      reasoning: true,
      thinkingLevelMap: ANTHROPIC_OPUS_4_7_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 128000,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
   },
   {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      description: "most capable for complex work",
      reasoning: true,
      thinkingLevelMap: ANTHROPIC_OPUS_4_6_REASONING_MAP,
      contextWindow: 200000,
      maxTokens: 128000,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
   },
   {
      id: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      description: "fastest & most compact, great for quick tasks",
      reasoning: false,
      thinkingLevelMap: ANTHROPIC_REASONING_MAP,
      contextWindow: 200000,
      maxTokens: 64000,
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
   }
];

function isRecord(value: unknown): value is Record<string, unknown> {
   return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringOr(value: unknown, fallback: string): string {
   return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
   return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
   return typeof value === "boolean" ? value : fallback;
}

function optionalBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined {
   return typeof value === "boolean" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
   return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringRecordOr(value: unknown, fallback?: Record<string, string>): Record<string, string> | undefined {
   if (!isRecord(value)) return fallback ? { ...fallback } : undefined;
   const parsed = Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
   );
   return Object.keys(parsed).length > 0 ? parsed : fallback ? { ...fallback } : undefined;
}

function recordOr(value: unknown, fallback?: Record<string, unknown>): Record<string, unknown> | undefined {
   if (isRecord(value)) return { ...value };
   return fallback ? { ...fallback } : undefined;
}

function capabilitiesOr(value: unknown, fallback?: CapabilityFlags): CapabilityFlags | undefined {
   if (!isRecord(value)) return fallback ? { ...fallback } : undefined;
   const parsed = Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
   );
   return Object.keys(parsed).length > 0 ? parsed : fallback ? { ...fallback } : undefined;
}

function inputOr(value: unknown, fallback: Array<"text" | "image">): Array<"text" | "image"> {
   if (!Array.isArray(value)) return [...fallback];
   const parsed = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
   return parsed.length > 0 ? parsed : [...fallback];
}

function outputOr(value: unknown, fallback?: OutputModality[]): OutputModality[] | undefined {
   if (!Array.isArray(value)) return fallback ? [...fallback] : undefined;
   const parsed = value.filter(
      (entry): entry is OutputModality =>
         entry === "text" || entry === "image" || entry === "audio" || entry === "video"
   );
   return parsed.length > 0 ? parsed : fallback ? [...fallback] : undefined;
}

function costOr(value: unknown, fallback: ProviderModelConfig["cost"]): ProviderModelConfig["cost"] {
   if (!isRecord(value)) return { ...fallback };
   return {
      input: typeof value.input === "number" ? value.input : fallback.input,
      output: typeof value.output === "number" ? value.output : fallback.output,
      cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : fallback.cacheRead,
      cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : fallback.cacheWrite
   };
}

function thinkingLevelMapOr(value: unknown, fallback?: ThinkingLevelMap): ThinkingLevelMap | undefined {
   if (!isRecord(value)) return fallback ? { ...fallback } : undefined;
   const parsed: ThinkingLevelMap = {};
   for (const key of THINKING_LEVEL_KEYS) {
      if (typeof value[key] === "string" || value[key] === null) {
         parsed[key] = value[key];
      }
   }
   return Object.keys(parsed).length > 0 ? parsed : fallback ? { ...fallback } : undefined;
}

function modelDefaultsFrom(raw: Record<string, unknown>): Omit<CommandCodeProviderModelConfig, "id" | "name"> {
   const defaults = isRecord(raw.modelDefaults) ? raw.modelDefaults : {};
   return {
      api: COMMAND_CODE_API,
      baseUrl: optionalString(defaults.baseUrl),
      reasoning: booleanOr(defaults.reasoning, DEFAULT_MODEL_DEFAULTS.reasoning),
      thinkingLevelMap: thinkingLevelMapOr(defaults.thinkingLevelMap),
      input: inputOr(defaults.input, DEFAULT_MODEL_DEFAULTS.input),
      output: outputOr(defaults.output),
      capabilities: capabilitiesOr(defaults.capabilities),
      contextWindow: numberOr(defaults.contextWindow, DEFAULT_MODEL_DEFAULTS.contextWindow),
      maxTokens: numberOr(defaults.maxTokens, DEFAULT_MODEL_DEFAULTS.maxTokens),
      cost: costOr(defaults.cost, DEFAULT_MODEL_DEFAULTS.cost),
      headers: stringRecordOr(defaults.headers),
      compat: recordOr(defaults.compat) as ProviderModelConfig["compat"],
      isFree: optionalBoolean(defaults.isFree, undefined),
      importOwnership: optionalString(defaults.importOwnership)
   };
}

function normalizeModel(
   rawModel: unknown,
   defaults: Omit<CommandCodeProviderModelConfig, "id" | "name">
): CommandCodeProviderModelConfig | null {
   if (!isRecord(rawModel)) return null;
   const id = stringOr(rawModel.id, "");
   if (!id) return null;
   const model: CommandCodeProviderModelConfig = {
      id,
      name: stringOr(rawModel.name, id),
      api: COMMAND_CODE_API,
      baseUrl: optionalString(rawModel.baseUrl) ?? defaults.baseUrl,
      reasoning: booleanOr(rawModel.reasoning, defaults.reasoning),
      thinkingLevelMap: thinkingLevelMapOr(rawModel.thinkingLevelMap, defaults.thinkingLevelMap),
      input: inputOr(rawModel.input, defaults.input),
      output: outputOr(rawModel.output, defaults.output),
      capabilities: capabilitiesOr(rawModel.capabilities, defaults.capabilities),
      contextWindow: numberOr(rawModel.contextWindow, defaults.contextWindow),
      maxTokens: numberOr(rawModel.maxTokens, defaults.maxTokens),
      cost: costOr(rawModel.cost, defaults.cost),
      headers: stringRecordOr(rawModel.headers, defaults.headers),
      compat: recordOr(
         rawModel.compat,
         isRecord(defaults.compat) ? defaults.compat : undefined
      ) as ProviderModelConfig["compat"],
      isFree: optionalBoolean(rawModel.isFree, defaults.isFree),
      importOwnership: optionalString(rawModel.importOwnership) ?? defaults.importOwnership
   };

   for (const key of [
      "baseUrl",
      "thinkingLevelMap",
      "output",
      "capabilities",
      "headers",
      "compat",
      "isFree",
      "importOwnership"
   ] as const) {
      if (model[key] === undefined) delete model[key];
   }
   return model;
}

function readRawConfig(extensionRoot: string, warnings: string[]): Record<string, unknown> {
   try {
      const parsed = JSON.parse(readFileSync(join(extensionRoot, "config.json"), "utf-8"));
      if (isRecord(parsed)) return parsed;
      warnings.push("config.json root must be an object; using defaults.");
   } catch (error) {
      warnings.push(
         `Unable to read config.json; using defaults: ${error instanceof Error ? error.message : "unknown error"}`
      );
   }
   return {};
}

function normalizeModelList(
   rawModels: unknown,
   defaults: Omit<CommandCodeProviderModelConfig, "id" | "name">
): CommandCodeProviderModelConfig[] {
   if (!Array.isArray(rawModels)) return [];
   return rawModels
      .map((model) => normalizeModel(model, defaults))
      .filter((model): model is CommandCodeProviderModelConfig => model !== null);
}

export function loadConfig(extensionRoot: string): ConfigLoadResult {
   const warnings: string[] = [];
   const raw = readRawConfig(extensionRoot, warnings);
   const providerId = stringOr(raw.providerId, "command-code");
   const defaults = modelDefaultsFrom(raw);
   const configModels = normalizeModelList(Array.isArray(raw.models) ? raw.models : DEFAULT_RAW_MODELS, defaults);
   const models = configModels.length > 0 ? configModels : normalizeModelList(DEFAULT_RAW_MODELS, defaults);

   if (models.length === 0) {
      warnings.push("No valid models configured.");
   }

   return {
      config: {
         enabled: booleanOr(raw.enabled, true),
         debug: booleanOr(raw.debug, false),
         providerId,
         displayName: stringOr(raw.displayName, "CommandCode"),
         upstreamUrl: stringOr(raw.upstreamUrl, "https://api.commandcode.ai"),
         apiKey: stringOr(raw.apiKey, "COMMAND_CODE_TOKEN"),
         commandCodeVersion: stringOr(raw.commandCodeVersion, "0.26.25"),
         commandCodeProvider: stringOr(raw.commandCodeProvider, "command-code"),
         requestTimeoutMs: numberOr(raw.requestTimeoutMs, 300_000),
         memory: typeof raw.memory === "string" ? raw.memory : "",
         headers: stringRecordOr(raw.headers) ?? {},
         models
      },
      warnings
   };
}
