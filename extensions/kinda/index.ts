import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
            id: "ae/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            input: ["text"],
            cost: {
               input: 0.14,
               output: 0.28,
               cacheRead: 0.0028,
               cacheWrite: 0,
            },
            contextWindow: 1000000,
            maxTokens: 384000,
            compat: {
               requiresReasoningContentOnAssistantMessages: true,
               thinkingFormat: "deepseek",
            },
         },
         {
            id: "ae/deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            reasoning: true,
            input: ["text"],
            cost: {
               input: 0.435,
               output: 0.87,
               cacheRead: 0.003625,
               cacheWrite: 0,
            },
            contextWindow: 1000000,
            maxTokens: 384000,
            compat: {
               requiresReasoningContentOnAssistantMessages: true,
               thinkingFormat: "deepseek",
            },
         },
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
            maxTokens: 128000,
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
            contextWindow: 272000,
            maxTokens: 128000,
         },
         {
            id: "cx/gpt-5.5",
            name: "GPT-5.5",
            reasoning: true,
            input: ["text", "image"],
            cost: {
               input: 5,
               output: 30,
               cacheRead: 0.5,
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
         },
      ],
   });

   pi.registerProvider("cline", {
      baseUrl: "https://api.cline.bot/api/v1",
      apiKey: "CLINE_API_KEY",
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

   pi.registerProvider("xiaomi-token-plan-sgp", {
      api: "anthropic-messages",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
      apiKey: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
      models: [
         {
            id: "mimo-v2.5-pro",
            name: "MiMo-V2.5-Pro",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 131072,
            cost: {
               input: 1,
               output: 3,
               cacheRead: 0.2,
               cacheWrite: 0,
            },
         },
         {
            id: "mimo-v2.5",
            name: "MiMo-V2.5",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 131072,
            cost: {
               input: 0.4,
               output: 2,
               cacheRead: 0.08,
               cacheWrite: 0,
            },
         },
      ],
   });

   pi.registerProvider("blazeai", {
      baseUrl: "https://blazeai.boxu.dev/api/v1",
      apiKey: "BLAZEAI_API_KEY",
      api: "openai-completions",
      models: [
         {
            id: "DeepSeek-V4-Flash-TEST",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            input: ["text"],
            cost: {
               input: 0.2,
               output: 0.4,
               cacheRead: 0.04,
               cacheWrite: 0,
            },
            contextWindow: 256000,
            maxTokens: 65536,
         },
         {
            id: "kimi-k2.6-TEST",
            name: "Kimi K2.6",
            reasoning: true,
            input: ["text"],
            cost: {
               input: 0.2,
               output: 0.4,
               cacheRead: 0.04,
               cacheWrite: 0,
            },
            contextWindow: 256000,
            maxTokens: 65536,
         },
         {
            id: "claude-opus-4.7",
            name: "Claude Opus 4.7",
            reasoning: true,
            input: ["text", "image"],
            cost: {
               input: 0.2,
               output: 0.4,
               cacheRead: 0.04,
               cacheWrite: 0,
            },
            contextWindow: 256000,
            maxTokens: 65536,
         },
      ],
   });

   pi.registerProvider("freemodel", {
      baseUrl: "https://api.freemodel.dev/v1",
      api: "openai-responses",
      apiKey: "FREEMODEL_API_KEY",
      models: [
         {
            id: "gpt-5.5",
            name: "GPT-5.5",
            reasoning: true,
            thinkingLevelMap: {
               xhigh: "xhigh",
               minimal: "low",
            },
            input: ["text", "image"],
            contextWindow: 272000,
            maxTokens: 128000,
            cost: {
               input: 5,
               output: 30,
               cacheRead: 0.5,
               cacheWrite: 0,
            },
            // compat: {
            // 	supportsReasoningEffort: true,
            // 	supportsStore: false,
            // },
         },
      ],
   });

   // pi.registerProvider("cmd", {
   // 	baseUrl: "http://localhost:3100/v1",
   // 	apiKey: "COMMANDCODE_API_KEY",
   // 	api: "openai-completions",
   // 	models: [
   // 		{
   // 			id: "deepseek/deepseek-v4-flash",
   // 			name: "DeepSeek V4 Flash",
   // 			reasoning: true,
   // 			input: ["text"],
   // 			cost: {
   // 				input: 0.14,
   // 				output: 0.28,
   // 				cacheRead: 0.0028,
   // 				cacheWrite: 0,
   // 			},
   // 			contextWindow: 1000000,
   // 			maxTokens: 384000,
   // 		},
   // 		{
   // 			id: "deepseek/deepseek-v4-pro",
   // 			name: "DeepSeek V4 Pro",
   // 			reasoning: true,
   // 			input: ["text"],
   // 			cost: {
   // 				input: 0.435,
   // 				output: 0.87,
   // 				cacheRead: 0.003625,
   // 				cacheWrite: 0,
   // 			},
   // 			contextWindow: 1000000,
   // 			maxTokens: 384000,
   // 		},
   // 		{
   // 			id: "moonshotai/Kimi-K2.6",
   // 			name: "Kimi K2.6",
   // 			reasoning: true,
   // 			input: ["text", "image"],
   // 			cost: {
   // 				input: 0.95,
   // 				output: 4,
   // 				cacheRead: 0.16,
   // 				cacheWrite: 0,
   // 			},
   // 			contextWindow: 262144,
   // 			maxTokens: 262144,
   // 		},
   // 	],
   // });
}
