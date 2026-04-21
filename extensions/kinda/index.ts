import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
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
				contextWindow: 400000,
				maxTokens: 128000,
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
				contextWindow: 272000,
				maxTokens: 64000,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
				},
			},
		],
	});
}
