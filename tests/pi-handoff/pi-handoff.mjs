import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadExtension } from "../_bootstrap.mjs";

const { exportHandoff, formatHandoffDocument, loadHandoffFile, writeHandoffFile, default: installExtension } =
   await loadExtension("extensions/pi-handoff/index.ts");

const entries = [
	{
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: "Inspect the project" }
	},
	{
		type: "message",
		id: "assistant-1",
		parentId: "user-1",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: {
			role: "assistant",
			provider: "anthropic",
			model: "claude-opus",
			usage: { input: 100, output: 20 },
			thinkingSignature: "secret-signature",
			content: [
 				{ type: "thinking", thinking: "private reasoning", thinkingSignature: "secret-signature" },
				{ type: "text", text: "I will inspect it." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pnpm test" } }
			]
		}
	},
	{
		type: "message",
		id: "tool-1",
		parentId: "assistant-1",
		timestamp: "2026-01-01T00:00:02.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "README contents" }],
			isError: false
		}
	},
   {
      type: "message",
      id: "assistant-read",
      parentId: "tool-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
         role: "assistant",
         content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/index.ts" } }]
      }
   },
   {
      type: "message",
      id: "tool-read",
      parentId: "assistant-read",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: {
         role: "toolResult",
         toolCallId: "read-1",
         toolName: "read",
         content: [{ type: "text", text: "TOP SECRET FILE CONTENT" }],
         isError: false
      }
   },
   {
      type: "message",
      id: "assistant-write",
      parentId: "tool-read",
      timestamp: "2026-01-01T00:00:05.000Z",
      message: {
         role: "assistant",
         content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "src/index.ts", content: "TOP SECRET WRITE CONTENT" } }]
      }
   },
   {
      type: "message",
      id: "tool-write",
      parentId: "assistant-write",
      timestamp: "2026-01-01T00:00:06.000Z",
      message: {
         role: "toolResult",
         toolCallId: "write-1",
         toolName: "write",
         content: [{ type: "text", text: "TOP SECRET WRITE RESULT" }],
         isError: false
      }
   },
	{
		type: "compaction",
		id: "compact-1",
		parentId: "tool-1",
		timestamp: "2026-01-01T00:00:03.000Z",
		summary: "The project uses Pi extensions.",
		firstKeptEntryId: "tool-1",
		tokensBefore: 100
	}
,
   {
      type: "model_change",
      id: "model-1",
      parentId: "compact-1",
      timestamp: "2026-01-01T00:00:04.000Z",
      provider: "openai",
      modelId: "gpt-5"
   }
];

function context(overrides = {}) {
	return {
		waitForIdle: async () => {},
		sessionManager: {
			buildContextEntries: () => entries,
			getHeader: () => ({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" }),
			getSessionId: () => "session-1",
			getSessionFile: () => "/sessions/session-1.jsonl",
			getCwd: () => "/project",
			getLeafId: () => "compact-1"
		},
		ui: { notify: () => {} },
		...overrides
	};
}

test("formats useful branch context and omits provider and reasoning metadata", () => {
	const document = formatHandoffDocument(entries, {
		header: { type: "session", id: "session-1", cwd: "/project" },
		sessionId: "session-1",
		cwd: "/project",
		leafId: "compact-1"
	});

	assert.match(document, /^# Pi handoff/m);
	assert.match(document, /### Tool call: `bash`/);
	assert.doesNotMatch(document, /### Tool result/);
	assert.match(document, /### Tool call: `read`\n\nPath: src\/index\.ts/);
 	assert.match(document, /### Tool call: `write`\n\nPath: src\/index\.ts/);
	assert.doesNotMatch(document, /README contents/);
	assert.doesNotMatch(document, /### Assistant\n\n### Tool call/);
	assert.doesNotMatch(document, /\"id\"|toolCallId|arguments|```json|private reasoning|thinkingSignature|secret-signature|TOP SECRET/);
	assert.match(document, /The project uses Pi extensions\./);
	assert.doesNotMatch(document, /claude-opus|gpt-5|model_change|usage/);
	assert.ok(document.indexOf("Inspect the project") < document.indexOf("I will inspect it."));
	assert.ok(document.indexOf("I will inspect it.") < document.indexOf("### Tool call: `read`"));
});

test("exports useful active-branch context and gives a usable continuation command", async () => {
	const notifications = [];
	let writtenDocument;
	const result = await exportHandoff(
		context({ ui: { notify: (message, level) => notifications.push([message, level]) } }),
		async (document) => {
			writtenDocument = document;
			return "/tmp/handoff-abc123.md";
		}
	);

	assert.equal(result.path, "/tmp/handoff-abc123.md");
	assert.equal(writtenDocument, result.document);
	assert.match(writtenDocument, /The project uses Pi extensions/);
	assert.match(writtenDocument, /### Compaction summary/);
	assert.doesNotMatch(writtenDocument, /Finish the handoff test/);
	assert.deepEqual(notifications, [["use /handoff /tmp/handoff-abc123.md in new session to continue", "info"]]);
});

test("exports the resolved active LLM context instead of raw tree entries", async () => {
	const result = await exportHandoff(
		context({
			sessionManager: {
				waitForIdle: async () => {},
				getCwd: () => "/project",
				buildContextEntries: () => [
 					{
 						type: "compaction",
 						id: "active-summary",
 						parentId: null,
 						timestamp: "2026-01-01T00:00:01.000Z",
 						summary: "Only the active summary",
 						firstKeptEntryId: "latest-request",
 						tokensBefore: 100
 					},
 					{
 						type: "message",
 						id: "latest-request",
 						parentId: "active-summary",
 						timestamp: "2026-01-01T00:00:02.000Z",
 						message: { role: "user", content: "Latest request", timestamp: 2 }
 					},
 					{
 						type: "message",
 						id: "latest-response",
 						parentId: "latest-request",
 						timestamp: "2026-01-01T00:00:03.000Z",
 						message: { role: "assistant", content: [{ type: "text", text: "Latest response" }], timestamp: 3 }
 					}
 				]
			}
		}),
		async (value) => value
	);

	assert.match(result.document, /Only the active summary/);
	assert.match(result.document, /Latest request/);
	assert.doesNotMatch(result.document, /raw tree entry/);
});

test("writes a private UTF-8 handoff file with a hash-based name", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-handoff-test-"));
	const path = await writeHandoffFile("# Pi handoff\n\n日本語 and emoji: ✅\n", directory);
	const file = await stat(path);

	assert.match(path, new RegExp(`^${directory}/handoff-[a-f0-9]{12}\\.md$`));
	assert.equal(await readFile(path, "utf8"), "# Pi handoff\n\n日本語 and emoji: ✅\n");
	assert.equal(file.mode & 0o777, 0o600);
});

test("loads a handoff file as a user message without dispatching its contents", async () => {
	const sent = [];
	const result = await loadHandoffFile(
		"/tmp/handoff-abc123.md",
		async (content, options) => sent.push({ content, options }),
		async () => "# Pi handoff\n\n/handoff should remain text\n"
	);

	assert.equal(result.path, "/tmp/handoff-abc123.md");
	assert.deepEqual(sent, [
		{
			content:
				"Continue from this Pi handoff. Treat it as prior session context and continue from the latest state.\n\n# Pi handoff\n\n/handoff should remain text\n",
			options: { expandPromptTemplates: false }
		}
	]);
});

test("rejects an empty handoff file", async () => {
	await assert.rejects(
		() => loadHandoffFile("/tmp/empty.md", async () => {}, async () => "   \n"),
		/Handoff file is empty/
	);
});

test("registers /handoff instead of the old clipboard command", () => {
   let registered;
   const pi = {
      registerCommand(name, options) {
         registered = { name, options };
      }
   };
   installExtension(pi);

   assert.equal(registered.name, "handoff");
   assert.match(registered.options.description, /useful session context/);
});
