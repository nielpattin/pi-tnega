import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCommandCodeStream } from "./command-code";
import { COMMAND_CODE_API, COMMAND_CODE_DEFAULTS, COMMAND_CODE_MODELS } from "./models";
import { DebugLogger } from "./debug-logger";

const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_PROVIDER_REGISTRATION_EVENT = "pi-multi-auth:runtime-provider-registration";

export default function commandCodeProviderExtension(pi: ExtensionAPI): void {
   const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: false });
   const provider = {
      ...COMMAND_CODE_DEFAULTS,
      models: COMMAND_CODE_MODELS
   };

   const runtime: { cwd?: string; sessionId?: string } = {};
   runtime.sessionId = randomUUID();
   const streamSimple = createCommandCodeStream(provider, runtime, logger);
   const emitRuntimeProviderRegistration = (): void => {
      pi.events?.emit(RUNTIME_PROVIDER_REGISTRATION_EVENT, {
         provider: provider.providerId,
         displayName: provider.displayName,
         baseUrl: provider.upstreamUrl,
         api: COMMAND_CODE_API,
         headers: { ...provider.headers },
         models: provider.models.map((model) => ({ ...model })),
         streamSimple
      });
      logger.debug("runtime_provider_registration_emitted", {
         providerId: provider.providerId,
         api: COMMAND_CODE_API,
         modelCount: provider.models.length
      });
   };

   pi.on("session_start", (_event, ctx) => {
      runtime.cwd = ctx.cwd;
      runtime.sessionId = randomUUID();
      emitRuntimeProviderRegistration();
   });

   pi.on("before_agent_start", (_event, ctx) => {
      runtime.cwd = ctx.cwd;
      runtime.sessionId = randomUUID();
      emitRuntimeProviderRegistration();
      return {};
   });

   pi.registerProvider(provider.providerId, {
      name: provider.displayName,
      baseUrl: provider.upstreamUrl,
      apiKey: provider.apiKey,
      api: COMMAND_CODE_API,
      streamSimple,
      headers: provider.headers,
      models: provider.models
   });
   emitRuntimeProviderRegistration();

   logger.debug("provider_registered", {
      providerId: provider.providerId,
      api: COMMAND_CODE_API,
      upstreamUrl: provider.upstreamUrl,
      modelCount: provider.models.length
   });
}
