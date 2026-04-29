import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // pi.registerProvider("openai-codex", {
  //   baseUrl: "https://chatgpt.com/backend-api",
  //   apiKey: "OPENAI_CODEX_API_KEY",
  //   api: "openai-codex-responses",
  //   models: [
  //     {
  //       id: "gpt-5.4-mini",
  //       name: "GPT-5.4 Mini",
  //       reasoning: true,
  //       input: ["text", "image"],
  //       cost: {
  //         input: 0.75,
  //         output: 4.5,
  //         cacheRead: 0.075,
  //         cacheWrite: 0,
  //       },
  //       contextWindow: 272000,
  //       maxTokens: 128000,
  //     },
  //     {
  //       id: "gpt-5.5",
  //       name: "GPT-5.5",
  //       reasoning: true,
  //       input: ["text", "image"],
  //       cost: {
  //         input: 5,
  //         output: 30,
  //         cacheRead: 0.5,
  //         cacheWrite: 0,
  //       },
  //       contextWindow: 272000,
  //       maxTokens: 128000,
  //     },
  //     {
  //       id: "gpt-5.4",
  //       name: "GPT-5.4",
  //       reasoning: true,
  //       input: ["text", "image"],
  //       cost: {
  //         input: 2.5,
  //         output: 15,
  //         cacheRead: 0.25,
  //         cacheWrite: 0,
  //       },
  //       contextWindow: 272000,
  //       maxTokens: 128000,
  //     },
  //   ],
  // });

  pi.registerProvider("kinda", {
    baseUrl: "http://localhost:20129/v1",
    apiKey: "KINDA_API_KEY",
    api: "openai-responses",
    models: [
      {
        id: "cx/gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 0.75,
          output: 4.5,
          cacheRead: 0.075,
          cacheWrite: 0,
        },
        contextWindow: 272000,
        maxTokens: 64000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
      },
      {
        id: "cx/gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 2.5,
          output: 15,
          cacheRead: 0.25,
          cacheWrite: 0,
        },
        contextWindow: 1000000,
        maxTokens: 128000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
      },
      {
        id: "cx/gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 5,
          output: 30,
          cacheRead: 0.50,
          cacheWrite: 0,
        },
        contextWindow: 400000,
        maxTokens: 130000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
      },
      {
        id: "cf/@cf/moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
      }
    ],
  });

  pi.registerProvider("cline", {
    baseUrl: "https://api.cline.bot/api/v1",
    apiKey: "sk_124d35a163519c2cc37f988c32f667766a6eee91e5cad639e315e2cf68f5527e",
    api: "openai-completions",
    models: [
      {
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  });
}
