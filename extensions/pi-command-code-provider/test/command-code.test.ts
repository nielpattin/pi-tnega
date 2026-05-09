import test from "node:test";
import assert from "node:assert/strict";

import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

import { createCommandCodeStream } from "../src/command-code.ts";
import { COMMAND_CODE_API, type ExtensionConfig } from "../src/config.ts";
import type { DebugLogger } from "../src/debug-logger.ts";

const model: Model<Api> = {
   id: "test-model",
   name: "Test Model",
   api: COMMAND_CODE_API,
   provider: "command-code",
   baseUrl: "https://api.commandcode.ai",
   reasoning: true,
   input: ["text"],
   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
   contextWindow: 1000,
   maxTokens: 100,
};

const config: ExtensionConfig = {
   enabled: true,
   debug: false,
   providerId: "command-code",
   displayName: "CommandCode",
   upstreamUrl: "https://api.commandcode.ai",
   apiKey: "COMMAND_CODE_TOKEN",
   commandCodeVersion: "0.25.1",
   commandCodeProvider: "command-code",
   requestTimeoutMs: 1000,
   memory: "",
   headers: {},
   models: [],
};

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
   const events: AssistantMessageEvent[] = [];
   for await (const event of stream) events.push(event);
   return events;
}

function createTestLogger(): DebugLogger {
   return { debug() {}, warn() {}, error() {} } as DebugLogger;
}

test("rewrites CommandCode-native tool aliases to Pi tool names", async () => {
   const originalFetch = globalThis.fetch;
   globalThis.fetch = async (): Promise<Response> => {
      return new Response(
         '{"type":"start"}\n{"type":"tool-call","toolCallId":"read-1","toolName":"read_file","input":{"absolutePath":"C:/tmp/a.txt","limit":1}}\n{"type":"tool-call","toolCallId":"shell-1","toolName":"shell_command","input":{"command":"pwd"}}\n{"type":"finish","finishReason":"tool-calls"}\n',
         { status: 200, headers: { "content-type": "text/event-stream" } },
      );
   };

   try {
      const context: Context = {
         messages: [{ role: "user", content: "Use tools", timestamp: Date.now() }],
         tools: [
            { name: "read", description: "Read", parameters: { type: "object" } as never },
            { name: "bash", description: "Run shell", parameters: { type: "object" } as never },
         ],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      const events = await collect(stream);
      const toolCallEnds = events.filter((event) => event.type === "toolcall_end");

      assert.equal(toolCallEnds[0]?.type, "toolcall_end");
      assert.equal(toolCallEnds[0].toolCall.name, "read");
      assert.deepEqual(toolCallEnds[0].toolCall.arguments, { path: "C:/tmp/a.txt", limit: 1 });
      assert.equal(toolCallEnds[1]?.type, "toolcall_end");
      assert.equal(toolCallEnds[1].toolCall.name, "bash");
      assert.deepEqual(toolCallEnds[1].toolCall.arguments, { command: "pwd" });
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("rewrites CommandCode glob tool aliases and filePattern grep arguments", async () => {
   const originalFetch = globalThis.fetch;
   globalThis.fetch = async (): Promise<Response> => {
      return new Response(
         '{"type":"start"}\n{"type":"tool-call","toolCallId":"glob-1","toolName":"glob","input":{"pattern":"**/*.ts","path":"src"}}\n{"type":"tool-call","toolCallId":"grep-1","toolName":"grep","input":{"pattern":"test","filePattern":"*.ts"}}\n{"type":"finish","finishReason":"tool-calls"}\n',
         { status: 200, headers: { "content-type": "text/event-stream" } },
      );
   };

   try {
      const context: Context = {
         messages: [{ role: "user", content: "Use tools", timestamp: Date.now() }],
         tools: [
            { name: "find", description: "Find", parameters: { type: "object" } as never },
            { name: "grep", description: "Grep", parameters: { type: "object" } as never },
         ],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      const events = await collect(stream);
      const toolCallEnds = events.filter((event) => event.type === "toolcall_end");

      assert.equal(toolCallEnds[0]?.type, "toolcall_end");
      assert.equal(toolCallEnds[0].toolCall.name, "find");
      assert.deepEqual(toolCallEnds[0].toolCall.arguments, { pattern: "**/*.ts", path: "src" });
      assert.equal(toolCallEnds[1]?.type, "toolcall_end");
      assert.equal(toolCallEnds[1].toolCall.name, "grep");
      assert.deepEqual(toolCallEnds[1].toolCall.arguments, { pattern: "test", glob: "*.ts" });
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("sanitizes glob terminology from outbound prompt and tool descriptions", async () => {
   const originalFetch = globalThis.fetch;
   let outboundBody: unknown;
   globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      outboundBody = JSON.parse(String(init?.body));
      return new Response('{"type":"start"}\n{"type":"finish","finishReason":"stop"}\n', {
         status: 200,
         headers: { "content-type": "text/event-stream" },
      });
   };

   try {
      const context: Context = {
         systemPrompt: "Available tools:\n- find: Find files by glob pattern.",
         messages: [{ role: "user", content: "Find configs", timestamp: Date.now() }],
         tools: [
            {
               name: "find",
               description: "Search for files by glob pattern.",
               parameters: {
                  type: "object",
                  properties: { pattern: { type: "string", description: "Glob pattern to match files" } },
               } as never,
            },
         ],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      await collect(stream);
      const request = outboundBody as {
         params: { system?: string; tools?: Array<{ description?: string; input_schema?: unknown }> };
      };

      assert.doesNotMatch(JSON.stringify(request), /\bglob\b/i);
      assert.match(request.params.system ?? "", /file pattern/);
      assert.match(request.params.tools?.[0].description ?? "", /file pattern/);
      assert.match(JSON.stringify(request.params.tools?.[0].input_schema), /File pattern/i);
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("sends native CommandCode stream request with tool schemas and emits text deltas", async () => {
   const originalFetch = globalThis.fetch;
   let outboundBody: unknown;
   globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      outboundBody = JSON.parse(String(init?.body));
      return new Response(
         '{"type":"start"}\n{"type":"start-step","request":{"body":{}}}\n{"type":"text-start","id":"txt-0"}\n{"type":"text-delta","id":"txt-0","text":"Hel"}\n{"type":"text-delta","id":"txt-0","text":"lo"}\n{"type":"text-end","id":"txt-0"}\n{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":2,"cachedInputTokens":3}}\n',
         { status: 200, headers: { "content-type": "text/event-stream" } },
      );
   };

   try {
      const context: Context = {
         systemPrompt: "You are a coding agent.",
         messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
         tools: [
            {
               name: "read",
               description: "Read a file",
               parameters: { type: "object", properties: { path: { type: "string" } } } as never,
            },
         ],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      const events = await collect(stream);
      const request = outboundBody as {
         memory?: string;
         params: {
            stream?: boolean;
            model?: string;
            system?: string;
            tools?: Array<Record<string, unknown>>;
            messages?: Array<Record<string, unknown>>;
         };
      };

      assert.equal(request.params.stream, true);
      assert.equal(request.params.model, "test-model");
      assert.equal(request.params.tools?.[0].name, "read");
      assert.deepEqual(request.params.tools?.[0].input_schema, {
         type: "object",
         properties: { path: { type: "string" } },
      });
      assert.deepEqual(request.params.messages, [{ role: "user", content: "Say hello" }]);
      assert.equal(request.memory, "");
      assert.equal(request.params.system, "You are a coding agent.");
      assert.doesNotMatch(JSON.stringify(request), /Available Pi tools/);
      assert.deepEqual(
         events.filter((event) => event.type === "text_delta").map((event) => event.delta),
         ["Hel", "lo"],
      );
      const done = events.find((event) => event.type === "done");
      assert.equal(done?.type, "done");
      assert.equal(done.message.usage.input, 10);
      assert.equal(done.message.usage.output, 2);
      assert.equal(done.message.usage.cacheRead, 3);
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("sends native CommandCode tools and still parses XML tool calls from fallback JSON", async () => {
   const originalFetch = globalThis.fetch;
   let outboundBody: unknown;
   globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      outboundBody = JSON.parse(String(init?.body));
      return new Response(
         JSON.stringify({
            id: "msg_tool",
            content: [
               {
                  type: "text",
                  text: 'I will inspect the file.\n<tool_calls>\n<tool_call name="read">\n<parameter name="path">package.json</parameter>\n</tool_call>\n</tool_calls>',
               },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
         }),
         { status: 200, headers: { "content-type": "application/json" } },
      );
   };

   try {
      const context: Context = {
         systemPrompt: "You are a coding agent.",
         messages: [{ role: "user", content: "Read package.json", timestamp: Date.now() }],
         tools: [
            {
               name: "read",
               description: "Read a file",
               parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
               } as never,
            },
         ],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      const events = await collect(stream);

      const request = outboundBody as {
         params: { tools?: Array<Record<string, unknown>>; messages: Array<{ content: string }> };
      };
      assert.equal(request.params.tools?.[0].name, "read");
      assert.deepEqual(request.params.messages[0], { role: "user", content: "Read package.json" });
      assert.doesNotMatch(JSON.stringify(request), /Available Pi tools/);

      const toolCallEnd = events.find((event) => event.type === "toolcall_end");
      assert.equal(toolCallEnd?.type, "toolcall_end");
      assert.equal(toolCallEnd.toolCall.name, "read");
      assert.deepEqual(toolCallEnd.toolCall.arguments, { path: "package.json" });
      const done = events.find((event) => event.type === "done");
      assert.equal(done?.type, "done");
      assert.equal(done.reason, "toolUse");
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("parses DeepSeek DSML tool calls emitted as text", async () => {
   const originalFetch = globalThis.fetch;
   globalThis.fetch = async (): Promise<Response> => {
      return new Response(
         JSON.stringify({
            id: "msg_dsml_tool",
            content: [
               {
                  type: "text",
                  text: 'Use grep.\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="grep">\n<｜｜DSML｜｜parameter name="pattern" string="true">node</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="literal" string="false">true</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="limit" string="false">5</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
               },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
         }),
         { status: 200, headers: { "content-type": "application/json" } },
      );
   };

   try {
      const context: Context = {
         messages: [{ role: "user", content: "Use grep", timestamp: Date.now() }],
         tools: [{ name: "grep", description: "Search", parameters: { type: "object" } as never }],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      const events = await collect(stream);

      const toolCallEnd = events.find((event) => event.type === "toolcall_end");
      assert.equal(toolCallEnd?.type, "toolcall_end");
      assert.equal(toolCallEnd.toolCall.name, "grep");
      assert.deepEqual(toolCallEnd.toolCall.arguments, { pattern: "node", literal: true, limit: 5 });
      const done = events.find((event) => event.type === "done");
      assert.equal(done?.type, "done");
      assert.equal(done.reason, "toolUse");
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("serializes Pi tool results into CommandCode native tool-result content blocks", async () => {
   const originalFetch = globalThis.fetch;
   let outboundBody: unknown;
   globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      outboundBody = JSON.parse(String(init?.body));
      return new Response(
         JSON.stringify({
            id: "msg_after_tool",
            content: [{ type: "text", text: "The file was read." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
         }),
         { status: 200, headers: { "content-type": "application/json" } },
      );
   };

   try {
      const context: Context = {
         messages: [
            { role: "user", content: "Read package.json", timestamp: Date.now() },
            {
               role: "assistant",
               api: COMMAND_CODE_API,
               provider: "command-code",
               model: "test-model",
               content: [
                  { type: "toolCall", id: "command-code-tool-1", name: "read", arguments: { path: "package.json" } },
               ],
               usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
               },
               stopReason: "toolUse",
               timestamp: Date.now(),
            },
            {
               role: "toolResult",
               toolCallId: "command-code-tool-1",
               toolName: "read",
               content: [{ type: "text", text: "package contents" }],
               isError: false,
               timestamp: Date.now(),
            },
         ],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      await collect(stream);

      const request = outboundBody as {
         params: { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
      };
      const toolResultMessage = request.params.messages.at(-1);
      assert.equal(toolResultMessage?.role, "tool");
      assert.deepEqual(request.params.messages.at(-2)?.content[0], {
         type: "tool-call",
         toolCallId: "command-code-tool-1",
         toolName: "read",
         input: { path: "package.json" },
      });
      assert.deepEqual(toolResultMessage?.content[0], {
         type: "tool-result",
         toolCallId: "command-code-tool-1",
         toolName: "read",
         output: { type: "text", value: "package contents" },
      });
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("parses native CommandCode reasoning and tool-call content blocks", async () => {
   const originalFetch = globalThis.fetch;
   globalThis.fetch = async (): Promise<Response> => {
      return new Response(
         JSON.stringify({
            id: "msg_native_blocks",
            content: [
               { type: "reasoning", text: "Need a file read." },
               { type: "tool-call", toolCallId: "native-tool-1", toolName: "read", input: { path: "package.json" } },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
         }),
         { status: 200, headers: { "content-type": "application/json" } },
      );
   };

   try {
      const context: Context = {
         messages: [{ role: "user", content: "Read package.json", timestamp: Date.now() }],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
      });
      const events = await collect(stream);

      const thinkingEnd = events.find((event) => event.type === "thinking_end");
      assert.equal(thinkingEnd?.type, "thinking_end");
      assert.equal(thinkingEnd.content, "Need a file read.");
      const toolCallEnd = events.find((event) => event.type === "toolcall_end");
      assert.equal(toolCallEnd?.type, "toolcall_end");
      assert.equal(toolCallEnd.toolCall.id, "native-tool-1");
      assert.equal(toolCallEnd.toolCall.name, "read");
      assert.deepEqual(toolCallEnd.toolCall.arguments, { path: "package.json" });
      const done = events.find((event) => event.type === "done");
      assert.equal(done?.type, "done");
      assert.equal(done.reason, "toolUse");
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("does not inject fake reasoning instructions but still parses thinking blocks if upstream returns them", async () => {
   const originalFetch = globalThis.fetch;
   let outboundBody: unknown;
   globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      outboundBody = JSON.parse(String(init?.body));
      return new Response(
         JSON.stringify({
            id: "msg_thinking",
            content: [{ type: "text", text: "<thinking>Need inspect first.</thinking>Visible answer." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
         }),
         { status: 200, headers: { "content-type": "application/json" } },
      );
   };

   try {
      const context: Context = {
         systemPrompt: "You are a coding agent.",
         messages: [{ role: "user", content: "Think then answer", timestamp: Date.now() }],
      };
      const logger = createTestLogger();
      const stream = createCommandCodeStream(config, { cwd: process.cwd() }, logger)(model, context, {
         apiKey: "token",
         reasoning: "high",
      });
      const events = await collect(stream);

      const request = outboundBody as { params: { messages: Array<{ content: string }> } };
      assert.doesNotMatch(request.params.messages[0].content, /Reasoning level: high/);
      assert.doesNotMatch(request.params.messages[0].content, /<thinking>/);

      const thinkingEnd = events.find((event) => event.type === "thinking_end");
      assert.equal(thinkingEnd?.type, "thinking_end");
      assert.equal(thinkingEnd.content, "Need inspect first.");
      const textEnd = events.find((event) => event.type === "text_end");
      assert.equal(textEnd?.type, "text_end");
      assert.equal(textEnd.content, "Visible answer.");
   } finally {
      globalThis.fetch = originalFetch;
   }
});
