import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const COMMAND_CODE_API = "command-code-alpha" as const;

type ThinkingLevelKey = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<ThinkingLevelKey, string | null>>;
type OutputModality = "text" | "image" | "audio" | "video";
type CapabilityFlags = Record<string, boolean>;

export type CommandCodeProviderModelConfig = ProviderModelConfig & {
   baseUrl?: string;
   description?: string;
   thinkingLevelMap?: ThinkingLevelMap;
   output?: OutputModality[];
   capabilities?: CapabilityFlags;
   isFree?: boolean;
   importOwnership?: string;
};

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
const COMMAND_CODE_AUTO_REASONING_MAP = {
   off: null,
   minimal: null,
   low: null,
   medium: null,
   high: "high",
   xhigh: "max"
} satisfies ThinkingLevelMap;

const GEMINI_REASONING_MAP = {
   off: null,
   minimal: null,
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: null
} satisfies ThinkingLevelMap;

const RAW_MODELS = [
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
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      description: "most intelligent for agents and coding",
      reasoning: true,
      thinkingLevelMap: ANTHROPIC_OPUS_4_7_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 128000,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
   },
   {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      description: "prev flagship, still strong for agents and coding",
      reasoning: true,
      thinkingLevelMap: ANTHROPIC_OPUS_4_7_REASONING_MAP,
      contextWindow: 1000000,
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
      id: "moonshotai/Kimi-K2.6",
      name: "Kimi K2.6",
      description: "long-horizon coding with vision",
      reasoning: false,
      contextWindow: 256000,
      maxTokens: 262144,
      cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 }
   },
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
      id: "zai-org/GLM-5.1",
      name: "GLM 5.1",
      description: "long-horizon autonomous coding agent",
      reasoning: false,
      contextWindow: 200000,
      maxTokens: 131072,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }
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
      id: "MiniMaxAI/MiniMax-M2.7",
      name: "MiniMax M2.7",
      description: "end-to-end software engineering agent",
      reasoning: false,
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 }
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
      id: "Qwen/Qwen3.7-Max",
      name: "Qwen 3.7 Max",
      description: "frontier coding & long-horizon agent execution",
      reasoning: true,
      thinkingLevelMap: COMMAND_CODE_AUTO_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 65536,
      cost: { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 }
   },
   {
      id: "stepfun/Step-3.7-Flash",
      name: "Step 3.7 Flash",
      description: "multimodal sparse-MoE reasoning",
      reasoning: true,
      thinkingLevelMap: COMMAND_CODE_AUTO_REASONING_MAP,
      contextWindow: 256000,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
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
      id: "xiaomi/mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      description: "high-capability long-context agentic coding",
      reasoning: false,
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "xiaomi/mimo-v2.5",
      name: "MiMo V2.5",
      description: "efficient long-context agentic coding",
      reasoning: false,
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "google/gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      description: "Pro-level coding proficiency, parallel agentic execution",
      reasoning: true,
      thinkingLevelMap: GEMINI_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
   },
   {
      id: "google/gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      description: "high-volume workhorse model with implicit caching",
      reasoning: true,
      thinkingLevelMap: GEMINI_REASONING_MAP,
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
   }
] satisfies Array<Omit<CommandCodeProviderModelConfig, "api" | "input">>;

export const COMMAND_CODE_DEFAULTS = {
   providerId: "command-code",
   displayName: "CommandCode",
   upstreamUrl: "https://api.commandcode.ai",
   apiKey: "$COMMAND_CODE_TOKEN",
   commandCodeVersion: "0.30.1",
   requestTimeoutMs: 300_000,
   memory: "",
   headers: {} as Record<string, string>
};

export const COMMAND_CODE_MODELS: CommandCodeProviderModelConfig[] = RAW_MODELS.map((model) => ({
   ...DEFAULT_MODEL_DEFAULTS,
   ...model,
   api: COMMAND_CODE_API,
   cost: { ...DEFAULT_MODEL_DEFAULTS.cost, ...model.cost }
}));
