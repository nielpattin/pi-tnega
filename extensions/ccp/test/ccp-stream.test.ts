// @ts-nocheck
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { createCCPStream } from "../src/ccp-stream";
import { PROVIDER_DEFAULTS, PROVIDER_MODELS } from "../src/models";
import { DebugLogger } from "../src/debug-logger";

function tempExtensionRoot(): string {
   return mkdtempSync(join(tmpdir(), "ccp-"));
}

async function waitFor(condition: () => boolean): Promise<void> {
   for (let attempt = 0; attempt < 20; attempt++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
   }
   throw new Error("timed out waiting for async request");
}

test("default config mirrors 0.40.0 model catalog", () => {
   const modelsById = new Map(PROVIDER_MODELS.map((model) => [model.id, model]));

   expect(PROVIDER_DEFAULTS.apiVersion).toBe("0.40.0");
   expect(PROVIDER_MODELS).toHaveLength(33);

   expect(modelsById.get("claude-opus-4-8")?.name).toBe("Claude Opus 4.8");
   expect(modelsById.get("claude-opus-4-8")?.thinkingLevelMap?.xhigh).toBe("xhigh");
   expect(modelsById.get("stepfun/Step-3.7-Flash")?.contextWindow).toBe(256000);
   expect(modelsById.get("xiaomi/mimo-v2.5-pro")?.contextWindow).toBe(1000000);
   expect(modelsById.get("xiaomi/mimo-v2.5")?.contextWindow).toBe(1000000);

   expect(modelsById.get("deepseek/deepseek-v4-pro")?.thinkingLevelMap?.high).toBe("high");
   expect(modelsById.get("deepseek/deepseek-v4-pro")?.thinkingLevelMap?.xhigh).toBe("max");

   expect(modelsById.get("claude-fable-5")?.name).toBe("Claude Fable 5");
   expect(modelsById.get("claude-fable-5")?.contextWindow).toBe(1000000);
   expect(modelsById.get("claude-fable-5")?.reasoning).toBe(true);

   expect(modelsById.get("moonshotai/Kimi-K2.7-Code")?.name).toBe("Kimi K2.7 Code");
   expect(modelsById.get("moonshotai/Kimi-K2.7-Code")?.contextWindow).toBe(256000);

   expect(modelsById.get("moonshotai/Kimi-K2.7-Code-Highspeed")?.name).toBe("Kimi K2.7 Code Highspeed");
   expect(modelsById.get("moonshotai/Kimi-K2.7-Code-Highspeed")?.contextWindow).toBe(262000);

   expect(modelsById.get("nvidia/nemotron-3-ultra-550b-a55b")?.name).toBe("Nemotron 3 Ultra");
   expect(modelsById.get("nvidia/nemotron-3-ultra-550b-a55b")?.contextWindow).toBe(1000000);

   expect(modelsById.get("MiniMaxAI/MiniMax-M3")?.name).toBe("MiniMax M3");
   expect(modelsById.get("MiniMaxAI/MiniMax-M3")?.contextWindow).toBe(1000000);
   expect(modelsById.get("MiniMaxAI/MiniMax-M3")?.reasoning).toBe(true);

   expect(modelsById.get("MiniMaxAI/MiniMax-M3-Free")?.name).toBe("MiniMax M3 Free");
   expect(modelsById.get("MiniMaxAI/MiniMax-M3-Free")?.isFree).toBe(true);

   expect(modelsById.get("zai-org/GLM-5.2")?.name).toBe("GLM 5.2");
   expect(modelsById.get("zai-org/GLM-5.2")?.isFree).toBe(true);
   expect(modelsById.get("zai-org/GLM-5.2")?.contextWindow).toBe(1000000);
});

test("stream requests send compatible headers", async () => {
   const originalFetch = globalThis.fetch;
   const originalCmdZdr = process.env.CMD_ZDR;
   process.env.CMD_ZDR = "1";

   try {
      let capturedHeaders: Record<string, string> | undefined;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
         capturedHeaders = init?.headers as Record<string, string>;
         return new Response(
            JSON.stringify({
               content: "ok",
               usage: { input_tokens: 1, output_tokens: 1 },
               stop_reason: "stop"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
         );
      }) as typeof fetch;

      const config = { ...PROVIDER_DEFAULTS, models: PROVIDER_MODELS };
      const model = config.models.find((model) => model.id === "deepseek/deepseek-v4-pro") as Model<Api>;
      const runtime = { cwd: "C:\\work\\demo-project", sessionId: "session-123" };
      const logger = { debug() {}, warn() {}, error() {}, trace() {} };
      const context = {
         messages: [{ role: "user", content: "hello" }],
         tools: [],
         systemPrompt: ""
      } as Context;
      const options = { apiKey: "test-token" } as SimpleStreamOptions;

      createCCPStream(config, runtime, logger)(model, context, options);
      await waitFor(() => capturedHeaders !== undefined);

      expect(capturedHeaders?.Authorization).toBe("Bearer test-token");
      expect(capturedHeaders?.["x-command-code-version"]).toBe("0.40.0");
      expect(capturedHeaders?.["x-cli-environment"]).toBe("production");
      expect(capturedHeaders?.["x-session-id"]).toBe("session-123");
      expect(capturedHeaders?.["x-project-slug"]).toBe("demo-project");
      expect(capturedHeaders?.["x-taste-learning"]).toBe("false");
      expect(capturedHeaders?.["x-cmd-zdr"]).toBe("1");
   } finally {
      globalThis.fetch = originalFetch;
      if (originalCmdZdr === undefined) delete process.env.CMD_ZDR;
      else process.env.CMD_ZDR = originalCmdZdr;
   }
});

test("temperature payload override is sent inside params", async () => {
   const originalFetch = globalThis.fetch;

   try {
      let capturedBody: Record<string, unknown> | undefined;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
         capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
         return new Response(
            JSON.stringify({
               content: "ok",
               usage: { input_tokens: 1, output_tokens: 1 },
               stop_reason: "stop"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
         );
      }) as typeof fetch;

      const config = { ...PROVIDER_DEFAULTS, models: PROVIDER_MODELS };
      const model = config.models.find((model) => model.id === "deepseek/deepseek-v4-flash") as Model<Api>;
      const runtime = { cwd: "C:\\work\\demo-project", sessionId: "session-temperature" };
      const logger = { debug() {}, warn() {}, error() {}, trace() {} };
      const context = {
         messages: [{ role: "user", content: "hello" }],
         tools: [],
         systemPrompt: ""
      } as Context;
      const options = {
         apiKey: "test-token",
         onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), temperature: 0.7 })
      } as SimpleStreamOptions;

      createCCPStream(config, runtime, logger)(model, context, options);
      await waitFor(() => capturedBody !== undefined);

      expect(capturedBody?.temperature).toBeUndefined();
      expect((capturedBody?.params as Record<string, unknown>).temperature).toBe(0.7);
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("stream requests write provider traffic log", async () => {
   const originalFetch = globalThis.fetch;

   try {
      let requestCompleted = false;
      globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
         requestCompleted = true;
         return new Response(
            JSON.stringify({
               content: "provider answer",
               usage: { input_tokens: 2, output_tokens: 3 },
               stop_reason: "stop"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
         );
      }) as typeof fetch;

      const extensionRoot = tempExtensionRoot();
      const config = { ...PROVIDER_DEFAULTS, models: PROVIDER_MODELS };
      const model = config.models.find((model) => model.id === "deepseek/deepseek-v4-flash") as Model<Api>;
      const runtime = { cwd: "C:\\work\\demo-project", sessionId: "session-traffic" };
      const logger = new DebugLogger({ extensionRoot, debug: false });
      const context = {
         messages: [{ role: "user", content: "log this prompt" }],
         tools: [],
         systemPrompt: ""
      } as Context;
      const options = { apiKey: "super-secret-token" } as SimpleStreamOptions;

      createCCPStream(config, runtime, logger)(model, context, options);
      await waitFor(() => requestCompleted);
      await waitFor(() => {
         try {
            return readFileSync(join(extensionRoot, "debug", "provider-traffic.log"), "utf-8").includes(
               "agent_response"
            );
         } catch {
            return false;
         }
      });

      const log = readFileSync(join(extensionRoot, "debug", "provider-traffic.log"), "utf-8");
      expect(log).toMatch(/provider_request/);
      expect(log).toMatch(/log this prompt/);
      expect(log).toMatch(/\"max_tokens\":64000/);
      expect(log).toMatch(/provider_response_body/);
      expect(log).toMatch(/provider answer/);
      expect(log).toMatch(/agent_response/);
      expect(log).not.toMatch(/super-secret-token/);
      expect(log).toMatch(/\[REDACTED\]/);
   } finally {
      globalThis.fetch = originalFetch;
   }
});
