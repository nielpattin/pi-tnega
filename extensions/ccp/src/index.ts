import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCCPStream } from "./ccp-stream";
import { PROVIDER_API, PROVIDER_DEFAULTS, PROVIDER_MODELS } from "./models";
import { DebugLogger } from "./debug-logger";

const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_PROVIDER_REGISTRATION_EVENT = "pi-multi-auth:runtime-provider-registration";

// Stable session ID generated once per extension load (mirrors npm package behavior).
// Upstream uses this for caching — regenerating on every event breaks it.
function generateSessionId(): string {
   return `sess_${randomUUID().replace(/-/g, "").substring(0, 16)}`;
}

export default function alphaProviderExtension(pi: ExtensionAPI): void {
   const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: false });
   const provider = {
      ...PROVIDER_DEFAULTS,
      models: PROVIDER_MODELS
   };

   const runtime: { cwd?: string; sessionId?: string; threadId?: string } = {
      sessionId: generateSessionId(),
      threadId: randomUUID()
   };
   const streamSimple = createCCPStream(provider, runtime, logger);
   const emitRuntimeProviderRegistration = (): void => {
      pi.events?.emit(RUNTIME_PROVIDER_REGISTRATION_EVENT, {
         provider: provider.providerId,
         displayName: provider.displayName,
         baseUrl: provider.upstreamUrl,
         api: PROVIDER_API,
         headers: { ...provider.headers },
         models: provider.models.map((model) => ({ ...model })),
         streamSimple
      });
      logger.debug("runtime_provider_registration_emitted", {
         providerId: provider.providerId,
         api: PROVIDER_API,
         modelCount: provider.models.length
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

   pi.registerProvider(provider.providerId, {
      name: provider.displayName,
      baseUrl: provider.upstreamUrl,
      apiKey: provider.apiKey,
      api: PROVIDER_API,
      streamSimple,
      headers: provider.headers,
      models: provider.models
   });
   emitRuntimeProviderRegistration();

   logger.debug("provider_registered", {
      providerId: provider.providerId,
      api: PROVIDER_API,
      upstreamUrl: provider.upstreamUrl,
      modelCount: provider.models.length
   });
}
