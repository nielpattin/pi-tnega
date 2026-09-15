import assert from "node:assert/strict";
import test from "node:test";
import { loadExtension } from "../_bootstrap.mjs";

const {
  assertWebSocketOpen,
  buildFastModeHeaders,
  createFastModeProvider,
  closeFastModeWebSocketSessions,
  fastDebug,
  formatLastFastResult,
  getLastFastResult,
} = await loadExtension("extensions/pi-codex-usage/fast-transport.ts");

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
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url"),
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

function baseProvider() {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    stream() {
      throw new Error("base stream should not be used in fast mode");
    },
    streamSimple() {
      throw new Error("base simple stream should not be used in fast mode");
    },
  };
}

test("Fast Mode builds the Codex CLI identity and priority routing headers", () => {
  const headers = buildFastModeHeaders(new Headers({ "x-client-request-id": "req_1" }), {
    accountId: "acct_1",
    token: apiKey,
    requestId: "req_1",
    modelId: "gpt-5.4",
  });

  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.equal(headers.get("x-codex-routing-hint"), "model=gpt-5.4;tier=priority");
  assert.equal(headers.get("chatgpt-account-id"), "acct_1");
  assert.equal(headers.get("x-client-request-id"), "req_1");
  assert.equal(headers.get("thread-id"), "req_1");
});

test("Fast Mode sends priority SSE requests with final wire headers", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = init;
    return sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]);
  };

  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, {
      apiKey,
      transport: "sse",
      sessionId: "session_1",
    }));

    assert.equal(events.at(-1)?.type, "done");
    const headers = new Headers(request.headers);
    assert.equal(headers.get("originator"), "codex_cli_rs");
    assert.equal(headers.get("x-codex-routing-hint"), "model=gpt-5.4;tier=priority");
    assert.equal(headers.get("thread-id"), "session_1");
    assert.equal(headers.get("content-encoding"), "zstd");
    const zlib = await import("node:zlib");
    const wireBody = request.body instanceof Uint8Array ? request.body : new TextEncoder().encode(request.body);
    const bodyJson = zlib.zstdDecompressSync(wireBody).toString("utf8");
    const body = JSON.parse(bodyJson);
    assert.equal(body.service_tier, "priority");
    assert.deepEqual(body.client_metadata, { session_id: "session_1", thread_id: "session_1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Fast Mode sends the same priority identity over WebSocket", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sent = [];
  class FakeWebSocket {
    static headers;
    readyState = 0;
    listeners = new Map();

    constructor(_url, options) {
      FakeWebSocket.headers = options.headers;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    send(frame) {
      sent.push(JSON.parse(frame));
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "resp_ws" } }) });
        this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: "resp_ws", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }) });
      });
    }

    close() {
      this.readyState = 3;
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, {
      apiKey,
      transport: "websocket",
      sessionId: "ws-identity",
    }));

    assert.equal(events.at(-1)?.type, "done");
    assert.equal(new Headers(FakeWebSocket.headers).get("originator"), "codex_cli_rs");
    assert.equal(new Headers(FakeWebSocket.headers).get("x-codex-routing-hint"), "model=gpt-5.4;tier=priority");
    // Stock Pi and pi-codex-conversion both strip OpenAI-Beta from the WS handshake.
    assert.equal(new Headers(FakeWebSocket.headers).get("openai-beta"), null);
    assert.equal(sent[0].type, "response.create");
    assert.equal(sent[0].service_tier, "priority");
    assert.deepEqual(sent[0].client_metadata, { session_id: "ws-identity", thread_id: "ws-identity" });
  } finally {
    closeFastModeWebSocketSessions("ws-identity");
    globalThis.WebSocket = originalWebSocket;
  }
});
test("Fast Mode reuses a session WebSocket and sends the continuation delta", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sent = [];
  let connections = 0;
  class ReusableWebSocket {
    readyState = 0;
    listeners = new Map();

    constructor() {
      connections++;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    send(frame) {
      const request = JSON.parse(frame);
      sent.push(request);
      const responseId = `resp_cache_${sent.length}`;
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({ type: "response.output_text.delta", delta: "ok" }) });
        this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: responseId } }) });
        this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: responseId, status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }) });
      });
    }

    close() {
      this.readyState = 3;
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  globalThis.WebSocket = ReusableWebSocket;
  const secondContext = {
    ...context,
    messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "Again" }],
  };
  const secondApiKey = [
    "header",
    Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_2" } })).toString("base64url"),
    "signature",
  ].join(".");
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    await collect(provider.stream(model, context, { apiKey, sessionId: "cache-session" }));
    await collect(provider.stream(model, secondContext, { apiKey, sessionId: "cache-session" }));
    await collect(provider.stream(model, secondContext, { apiKey: secondApiKey, sessionId: "cache-session" }));

    assert.equal(connections, 2);
    assert.equal(sent.length, 3);
    assert.equal(sent[1].previous_response_id, "resp_cache_1");
    assert.equal("previous_response_id" in sent[2], false);
  } finally {
    closeFastModeWebSocketSessions("cache-session");
    globalThis.WebSocket = originalWebSocket;
  }
});


test("Fast Mode retries a WebSocket connection-limit error", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  let connections = 0;
  let fetchCalls = 0;
  const sent = [];
  class LimitedWebSocket {
    readyState = 0;
    listeners = new Map();

    constructor() {
      connections++;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    send(frame) {
      sent.push(JSON.parse(frame));
      queueMicrotask(() => {
        if (connections === 1) {
          this.emit("message", { data: JSON.stringify({ type: "error", code: "websocket_connection_limit_reached", message: "busy" }) });
          return;
        }
        this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "resp_limit" } }) });
        this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: "resp_limit", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }) });
      });
    }

    close() {
      this.readyState = 3;
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  globalThis.WebSocket = LimitedWebSocket;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("SSE fallback was not expected");
  };
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, { apiKey, sessionId: "ws-limit", transport: "auto" }));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(connections, 2);
    assert.equal(sent.length, 2);
    assert.equal(fetchCalls, 0);
  } finally {
    closeFastModeWebSocketSessions("ws-limit");
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});

test("Fast Mode retries a missing WebSocket continuation with the full body", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  let connections = 0;
  let fetchCalls = 0;
  const sent = [];
  class StaleContinuationWebSocket {
    readyState = 0;
    listeners = new Map();

    constructor() {
      connections++;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    send(frame) {
      const request = JSON.parse(frame);
      sent.push(request);
      queueMicrotask(() => {
        if (request.previous_response_id) {
          this.emit("message", { data: JSON.stringify({ type: "error", code: "previous_response_not_found", message: "gone" }) });
          return;
        }
        const responseId = `resp_stale_${sent.length}`;
        this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: responseId } }) });
        this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: responseId, status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }) });
      });
    }

    close() {
      this.readyState = 3;
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  globalThis.WebSocket = StaleContinuationWebSocket;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("SSE fallback was not expected");
  };
  const secondContext = {
    ...context,
    messages: [{ role: "user", content: "Hello" }, { role: "user", content: "Again" }],
  };
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    await collect(provider.stream(model, context, { apiKey, sessionId: "ws-stale", transport: "auto" }));
    const events = await collect(provider.stream(model, secondContext, { apiKey, sessionId: "ws-stale", transport: "auto" }));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(connections, 2);
    assert.equal(sent.length, 3);
    assert.equal(sent[1].previous_response_id, "resp_stale_1");
    assert.equal("previous_response_id" in sent[2], false);
    assert.equal(fetchCalls, 0);
  } finally {
    closeFastModeWebSocketSessions("ws-stale");
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});


test("Fast Mode falls back to SSE when WebSocket fails before first event", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  class FailingWebSocket {
    readyState = 0;
    listeners = new Map();
    constructor(_url, _options) {
      // Connect succeeds, then the server drops the connection before any
      // response event. Previously `started` was already true here (set
      // before send), so this failure was fatal instead of falling back.
      queueMicrotask(() => {
        this.readyState = 1;
        for (const listener of this.listeners.get("open") ?? []) listener({});
        setTimeout(() => {
          this.readyState = 3;
          for (const listener of this.listeners.get("close") ?? []) listener({ reason: "dropped" });
        }, 0);
      });
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FailingWebSocket;
  globalThis.fetch = async () => {
    fetchCalls++;
    return sseResponse([
      { type: "response.created", response: { id: "resp_fallback" } },
      { type: "response.output_text.delta", delta: "recovered" },
      { type: "response.completed", response: { id: "resp_fallback", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]);
  };
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, {
      apiKey,
      sessionId: "ws-fallback",
    }));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(fetchCalls, 1);
  } finally {
    closeFastModeWebSocketSessions("ws-fallback");
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});

test("assertWebSocketOpen rejects already-closed sockets", () => {
  assertWebSocketOpen({ readyState: 1 });
  assertWebSocketOpen({});
  assert.throws(() => assertWebSocketOpen({ readyState: 3 }), /readyState=3/);
});

test("fastDebug logs metadata without secrets", async () => {
  const { tmpdir } = await import("node:os");
  const { unlinkSync, readFileSync } = await import("node:fs");
  const file = `${tmpdir()}/pi-codex-fast-debug.log`;
  try { unlinkSync(file); } catch {}
  fastDebug("marker-line");
  assert.match(readFileSync(file, "utf8"), /marker-line/);
  try { unlinkSync(file); } catch {}
});

test("Fast Mode falls back when the socket is already closed after open", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  class AlreadyClosedWebSocket {
    readyState = 3;
    listeners = new Map();
    constructor(_url, _options) {
      queueMicrotask(() => {
        for (const listener of this.listeners.get("open") ?? []) listener({});
      });
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }
    send() {}
    close() {}
  }
  globalThis.WebSocket = AlreadyClosedWebSocket;
  globalThis.fetch = async () => {
    fetchCalls++;
    return sseResponse([
      { type: "response.created", response: { id: "resp_guard" } },
      { type: "response.completed", response: { id: "resp_guard", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ]);
  };
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, {
      apiKey,
      sessionId: "ws-closed",
      timeoutMs: 20_000,
    }));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(fetchCalls, 1);
  } finally {
    closeFastModeWebSocketSessions("ws-closed");
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});

test("last fast result records success and failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    { type: "response.created", response: { id: "resp_last" } },
    { type: "response.completed", response: { id: "resp_last", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, {
      apiKey,
      transport: "sse",
    }));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(getLastFastResult()?.outcome, "done");
    assert.match(formatLastFastResult(), /^done /);
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    const bad = await collect(provider.stream(model, context, {
      apiKey,
      transport: "sse",
    }));
    assert.equal(bad.at(-1)?.type, "error");
    assert.equal(getLastFastResult()?.outcome, "error");
    assert.match(formatLastFastResult(), /^error /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Fast Mode retries transient SSE responses", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) return new Response("temporarily unavailable", { status: 503, headers: { "retry-after-ms": "0" } });
    return sseResponse([
      { type: "response.created", response: { id: "resp_retry" } },
      { type: "response.completed", response: { id: "resp_retry", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ]);
  };
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, { apiKey, transport: "sse", maxRetries: 1 }));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Fast Mode reports usage-limit errors clearly", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(JSON.stringify({ error: { code: "usage_limit_reached", plan_type: "Plus", resets_at: Math.floor(Date.now() / 1000) + 60 } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const provider = createFastModeProvider(baseProvider(), { isFastMode: () => true });
    const events = await collect(provider.stream(model, context, { apiKey, transport: "sse", maxRetries: 1 }));
    assert.equal(events.at(-1)?.type, "error");
    assert.match(events.at(-1)?.error?.errorMessage ?? "", /hit your ChatGPT usage limit/);
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
