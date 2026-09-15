import assert from "node:assert/strict";
import test from "node:test";
import { loadExtension } from "../_bootstrap.mjs";

const { createFastModeProvider } = await loadExtension("extensions/pi-codex-usage/fast-transport.ts");

const model = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.4",
  input: ["text"],
  output: ["text"],
  reasoning: true,
  contextWindow: 272000,
  maxOutputTokens: 100000,
  cost: { input: 0, output: 0 },
  baseUrl: "https://chatgpt.example/backend-api",
};

const context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
};

const apiKey = [
  "header",
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }),
  ).toString("base64url"),
  "signature",
].join(".");

function sseResponse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function collect(stream) {
  return (async () => {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
}

test("Fast Mode compresses SSE request bodies like the stock Codex provider", async () => {
  const zlib = process.getBuiltinModule("node:zlib");
  assert.equal(typeof zlib.zstdDecompressSync, "function");

  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = init;
    return sseResponse([
      { type: "response.created", response: { id: "resp_compressed" } },
      {
        type: "response.completed",
        response: {
          id: "resp_compressed",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
  };

  try {
    const provider = createFastModeProvider(
      { id: "openai-codex", stream() {}, streamSimple() {} },
      { isFastMode: () => true },
    );
    const events = await collect(
      provider.stream(model, context, {
        apiKey,
        transport: "sse",
        sessionId: "compression-session",
      }),
    );

    assert.equal(events.at(-1)?.type, "done");
    assert.equal(new Headers(request.headers).get("content-encoding"), "zstd");
    assert.ok(request.body instanceof Uint8Array);
    const body = JSON.parse(zlib.zstdDecompressSync(request.body).toString("utf8"));
    assert.equal(body.service_tier, "priority");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
