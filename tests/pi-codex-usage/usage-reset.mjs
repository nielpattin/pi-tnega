import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const usage = await loadExtension("extensions/pi-codex-usage/usage.ts");
const screen = await loadExtension("extensions/pi-codex-usage/usage-screen.ts");

const fakeTheme = { bold: (s) => s, fg: (_, s) => s };

test("reset-credit parser normalizes the standalone API payload", () => {
  const credits = usage.parseCodexRateLimitResetCreditsPayload({
    available_count: "1",
    credits: [{
      id: "RateLimitResetCredit_1",
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: "2026-06-12T01:31:33.351888Z",
      expires_at: "2026-07-12T01:31:33.351888Z",
      redeem_started_at: null,
      redeemed_at: null,
      title: "One free rate limit reset",
      description: "Thanks for using Codex!",
    }],
  });
  assert.ok(credits);
  assert.equal(credits.availableCount, 1);
  assert.equal(credits.credits[0].id, "RateLimitResetCredit_1");
});

test("consume payload maps known outcomes and unknown fallback", () => {
  assert.equal(usage.parseCodexRateLimitResetConsumePayload({ code: "reset" }).outcome, "reset");
  assert.equal(usage.parseCodexRateLimitResetConsumePayload({ code: "already_redeemed" }).outcome, "already_redeemed");
  assert.equal(usage.parseCodexRateLimitResetConsumePayload({ code: "nothing_to_reset" }).outcome, "nothing_to_reset");
  assert.equal(usage.parseCodexRateLimitResetConsumePayload({ code: "no_credit" }).outcome, "no_credit");
  assert.equal(usage.parseCodexRateLimitResetConsumePayload({ code: "bogus" }).outcome, "unknown");
});

test("usage payload carries reset summary and weekly reserve mapping", () => {
  const snapshot = usage.parseCodexUsagePayload({
    plan_type: "pro",
    rate_limit_reset_credits: { available_count: 2 },
    rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1800000000 } },
    additional_rate_limits: [{
      metered_feature: "base_model_inference", limit_name: "gpt-reserve",
      rate_limit: { primary_window: { used_percent: 48, limit_window_seconds: 604800 } },
    }],
  });
  assert.equal(snapshot.resetCredits?.availableCount, 2);
  assert.equal(snapshot.limits.length, 2);
  const text = usage.formatCodexUsage(snapshot);
  assert.match(text, /resets available: 2/);
  assert.match(text, /Luna Reserve/);
});

test("fetch merges detailed reset credits and consume posts redeem id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    if (String(url).endsWith("/wham/rate-limit-reset-credits/consume")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.ok(body.redeem_request_id);
      return new Response(JSON.stringify({ code: "reset", windows_reset: 1 }), { status: 200 });
    }
    if (String(url).endsWith("/wham/rate-limit-reset-credits")) {
      return new Response(JSON.stringify({ available_count: 1, credits: [] }), { status: 200 });
    }
    if (String(url).endsWith("/wham/usage")) {
      return new Response(JSON.stringify({
        plan_type: "pro",
        rate_limit_reset_credits: { available_count: 1 },
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1900000000 } },
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  const model = { provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", headers: {} };
  const ctx = {
    model,
    signal: undefined,
    modelRegistry: {
      find: () => model,
      getAvailable: () => [model],
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "tok", headers: {} }),
    },
  };
  const snapshot = await usage.fetchCodexUsage(ctx, { fetchImpl, retryDelayMs: 1 });
  assert.equal(snapshot.planType, "pro");
  assert.equal(snapshot.resetCredits?.availableCount, 1);
  const result = await usage.consumeCodexRateLimitResetCredit(ctx, "req-1", { fetchImpl });
  assert.equal(result.outcome, "reset");
  assert.ok(calls.some((c) => c.url.endsWith("/wham/usage")));
  assert.ok(calls.some((c) => c.url.endsWith("/wham/rate-limit-reset-credits/consume")));
});

test("usage screen renders banked resets with consume hint", () => {
  const snapshot = usage.parseCodexUsagePayload({
    plan_type: "pro",
    rate_limit_reset_credits: { available_count: 2 },
    rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: 1900000000 } },
  });
  const lines = screen.formatUsageLines(fakeTheme, snapshot, false, 100).join("\n");
  assert.match(lines, /Banked resets: 2/);
  assert.match(lines, /Ctrl\+R/);
});

test("usage screen locks reset until refresh and surfaces messages", () => {
  const snapshot = usage.parseCodexUsagePayload({
    plan_type: "pro",
    rate_limit_reset_credits: { available_count: 1 },
    rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: 1900000000 } },
  });
  const locked = screen.formatUsageLines(fakeTheme, snapshot, false, 100, {
    resetLockedUntilRefresh: true,
    resetMessage: { kind: "info", text: "Codex rate limits reset." },
  }).join("\n");
  assert.match(locked, /R to refresh before another reset/);
  assert.match(locked, /Codex rate limits reset\./);
});
