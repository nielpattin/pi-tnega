import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCommandCodeStream } from "./command-code.js";
import { COMMAND_CODE_API, loadConfig } from "./config.js";
import { DebugLogger } from "./debug-logger.js";

const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_PROVIDER_REGISTRATION_EVENT = "pi-multi-auth:runtime-provider-registration";

export default function commandCodeProviderExtension(pi: ExtensionAPI): void {
	const { config, warnings } = loadConfig(EXTENSION_ROOT);
	const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: config.debug });
	for (const warning of warnings) {
		logger.warn("config_warning", { warning });
	}

	if (!config.enabled) {
		logger.debug("extension_disabled", { providerId: config.providerId });
		return;
	}

	const runtime: { cwd?: string } = {};
	const streamSimple = createCommandCodeStream(config, runtime, logger);
	const emitRuntimeProviderRegistration = (): void => {
		pi.events?.emit(RUNTIME_PROVIDER_REGISTRATION_EVENT, {
			provider: config.providerId,
			displayName: config.displayName,
			baseUrl: config.upstreamUrl,
			api: COMMAND_CODE_API,
			headers: { ...config.headers },
			models: config.models.map((model) => ({ ...model })),
			streamSimple,
		});
		logger.debug("runtime_provider_registration_emitted", {
			providerId: config.providerId,
			api: COMMAND_CODE_API,
			modelCount: config.models.length,
		});
	};

	pi.on("session_start", (_event, ctx) => {
		runtime.cwd = ctx.cwd;
		emitRuntimeProviderRegistration();
	});

	pi.on("before_agent_start", (_event, ctx) => {
		runtime.cwd = ctx.cwd;
		emitRuntimeProviderRegistration();
		return {};
	});

	pi.registerProvider(config.providerId, {
		name: config.displayName,
		baseUrl: config.upstreamUrl,
		apiKey: config.apiKey,
		api: COMMAND_CODE_API,
		streamSimple,
		headers: config.headers,
		models: config.models,
	});
	emitRuntimeProviderRegistration();

	logger.debug("provider_registered", {
		providerId: config.providerId,
		api: COMMAND_CODE_API,
		upstreamUrl: config.upstreamUrl,
		modelCount: config.models.length,
	});
}
