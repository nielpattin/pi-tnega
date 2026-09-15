import assert from "node:assert/strict";
import test from "node:test";
import { loadExtension } from "../_bootstrap.mjs";

const {
  ensureFastProvider,
  getFastProviderState,
  resetFastProviderRegistrar,
} = await loadExtension("extensions/pi-codex-usage/provider-registration.ts");

const DEFAULT_PROVIDER = { id: "openai-codex" };

function host(initialNative = undefined) {
  const box = { native: initialNative };
  return {
    registered: [],
    overlays: [],
    box,
    registerProvider(a, b) {
      if (typeof a === "string") this.overlays.push([a, b]);
      else {
        this.registered.push(a);
        box.native = a;
      }
    },
    registry({ provider = DEFAULT_PROVIDER, overlay = "absent" } = {}) {
      const fake = {
        getRegisteredNativeProvider: () => box.native,
        getProvider: () => provider,
      };
      if (overlay !== "absent") fake.getRegisteredProviderConfig = () => overlay;
      return fake;
    },
  };
}
const getConfig = () => ({ fast: true, verbosity: "low" });

test("registers the fast wrapper once it is available", () => {
  resetFastProviderRegistrar();
  const h = host();
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 1);
  assert.equal(h.registered[0].id, "openai-codex");
  assert.equal(typeof h.registered[0].stream, "function");
  assert.equal(typeof h.registered[0].streamSimple, "function");
  assert.match(getFastProviderState(), /^registered/);
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 1);
});

test("waits when the provider is not available yet, then registers", () => {
  resetFastProviderRegistrar();
  const h = host();
  ensureFastProvider(h, h.registry({ provider: null }), getConfig);
  assert.equal(h.registered.length, 0);
  assert.match(getFastProviderState(), /^pending/);
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 1);
  assert.match(getFastProviderState(), /^registered/);
});

test("skips when a native provider is already registered", () => {
  resetFastProviderRegistrar();
  const h = host({ id: "openai-codex" });
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 0);
  assert.match(getFastProviderState(), /^skipped/);
});

test("records registration failures and retries later", () => {
  resetFastProviderRegistrar();
  const failing = host();
  failing.registerProvider = () => { throw new Error("boom"); };
  ensureFastProvider(failing, failing.registry(), getConfig);
  assert.match(getFastProviderState(), /^failed: boom/);
  const h = host();
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 1);
  assert.match(getFastProviderState(), /^registered/);
});

test("registered wrapper delegates to base when fast mode is off", async () => {
  resetFastProviderRegistrar();
  let baseCalls = 0;
  const base = {
    id: "openai-codex",
    stream() { baseCalls++; return "base-stream"; },
    streamSimple() { baseCalls++; return "base-simple"; },
  };
  const h = host();
  ensureFastProvider(h, h.registry({ provider: base }), () => ({ fast: false, verbosity: "low" }));
  const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" };
  assert.equal(h.registered[0].stream(model, {}, {}), "base-stream");
  assert.equal(h.registered[0].streamSimple(model, {}, {}), "base-simple");
  assert.equal(baseCalls, 2);
});

test("preserves a pre-existing extension config across native registration", () => {
  resetFastProviderRegistrar();
  const h = host();
  const overlay = { apiKey: "bridge-key" };
  ensureFastProvider(h, h.registry({ overlay }), getConfig);
  assert.equal(h.registered.length, 1);
  assert.equal(h.overlays.length, 1);
  assert.equal(h.overlays[0][0], "openai-codex");
  assert.equal(h.overlays[0][1], overlay);
  assert.match(getFastProviderState(), /^registered/);
  ensureFastProvider(h, h.registry({ overlay }), getConfig);
  assert.equal(h.registered.length, 1);
  assert.equal(h.overlays.length, 1);
});

test("skips overlay restore when none exists", () => {
  resetFastProviderRegistrar();
  const h = host();
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 1);
  assert.equal(h.overlays.length, 0);
});

test("re-registers when the native registration disappears", () => {
  resetFastProviderRegistrar();
  const h = host();
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 1);
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 1);
  h.box.native = undefined;
  ensureFastProvider(h, h.registry(), getConfig);
  assert.equal(h.registered.length, 2);
  assert.match(getFastProviderState(), /^registered/);
});

test("codex hook stats count calls", async () => {
  const { formatCodexHookStats, recordCodexHookCall, resetCodexHookStats } =
    await loadExtension("extensions/pi-codex-usage/provider-registration.ts");
  resetCodexHookStats();
  assert.equal(formatCodexHookStats(), "none yet");
  recordCodexHookCall();
  recordCodexHookCall();
  assert.match(formatCodexHookStats(), /^#2 last at /);
  resetCodexHookStats();
  assert.equal(formatCodexHookStats(), "none yet");
});
