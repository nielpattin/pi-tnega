import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAST_TRANSPORT_REV, createFastModeProvider, fastDebug } from "./fast-transport";
import type { CodexUsageConfig } from "./config";

type ProviderConfigInput = Parameters<ExtensionAPI["registerProvider"]>[1];

export interface FastProviderRegistry {
  getRegisteredNativeProvider(id: string): unknown;
  getProvider(id: string): unknown;
  getRegisteredProviderConfig?(id: string): ProviderConfigInput | undefined;
}

export interface FastProviderHost {
  registerProvider(provider: Provider): void;
  registerProvider(name: string, config: ProviderConfigInput): void;
}

const CODEX_PROVIDER_ID = "openai-codex";

let registrarState = "pending";
let registrarSettled = false;
let savedOverlayConfig: ProviderConfigInput | undefined;

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

export function getFastProviderState(): string {
  return registrarState;
}

export function resetFastProviderRegistrar(): void {
  registrarState = "pending";
  registrarSettled = false;
  savedOverlayConfig = undefined;
}

export function ensureFastProvider(
  host: FastProviderHost,
  registry: FastProviderRegistry,
  getConfig: () => CodexUsageConfig,
): void {
  if (registrarSettled) {
    if (registry.getRegisteredNativeProvider(CODEX_PROVIDER_ID)) return;
    // Our native registration was removed from underneath us (e.g. a sibling
    // extension unregistered the provider); fall through and register again.
    registrarSettled = false;
    fastDebug("provider registration lost; re-registering");
  }
  try {
    if (registry.getRegisteredNativeProvider(CODEX_PROVIDER_ID)) {
      if (savedOverlayConfig !== undefined) {
        restoreOverlayConfig(host);
      }
      registrarState = "skipped: a native openai-codex provider is already registered";
      fastDebug("provider registration skipped: native openai-codex already registered");
      registrarSettled = true;
      return;
    }
    const provider = registry.getProvider(CODEX_PROVIDER_ID) as Provider | undefined;
    if (!provider) {
      registrarState = "pending: openai-codex provider not available yet";
      fastDebug("provider registration pending: openai-codex provider not available yet");
      return;
    }
    const current = registry.getRegisteredProviderConfig?.(CODEX_PROVIDER_ID);
    if (isNonEmptyRecord(current)) {
      // A sibling extension (e.g. pi-acks' auth overlay) owns an extension
      // config for this provider. Native registration removes it, so save it
      // here and restore it below; otherwise its owner sees its config
      // vanish and fail-closes the next turn.
      savedOverlayConfig = current as ProviderConfigInput;
      fastDebug("provider registration: preserving existing openai-codex extension config");
    }
    host.registerProvider(
      createFastModeProvider(provider, {
        isFastMode: () => getConfig().fast,
        getVerbosity: () => getConfig().verbosity,
      }),
    );
    fastDebug("provider registration: fast wrapper registered (" + FAST_TRANSPORT_REV + ")");
    restoreOverlayConfig(host);
    registrarSettled = true;
    registrarState = "registered (transport " + FAST_TRANSPORT_REV + ")";
  } catch (error) {
    registrarState = "failed: " + (error instanceof Error ? error.message : String(error));
    fastDebug("provider registration failed: " + registrarState);
  }
}

function restoreOverlayConfig(host: FastProviderHost): void {
  if (savedOverlayConfig === undefined) return;
  try {
    host.registerProvider(CODEX_PROVIDER_ID, savedOverlayConfig);
    fastDebug("provider registration: pre-existing extension config restored on top");
    savedOverlayConfig = undefined;
  } catch (error) {
    fastDebug(
      "provider registration: extension config restore failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

let codexHookCalls = 0;
let lastCodexHookAt: string | undefined;

export function recordCodexHookCall(): void {
  codexHookCalls += 1;
  lastCodexHookAt = new Date().toISOString();
  fastDebug("codex hook call #" + codexHookCalls);
}

export function resetCodexHookStats(): void {
  codexHookCalls = 0;
  lastCodexHookAt = undefined;
}

export function formatCodexHookStats(): string {
  if (codexHookCalls === 0) return "none yet";
  return "#" + codexHookCalls + " last at " + (lastCodexHookAt ?? "?");
}
