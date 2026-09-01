import assert from "node:assert/strict";
import test from "node:test";
import { loadExtension } from "../_bootstrap.mjs";

const { copyAllFromContext } = await loadExtension("extensions/copy-all/index.ts");

const entries = [
	{
		type: "message",
		message: { role: "user", content: "First request" },
	},
	{
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
	},
];

test("does not use the command context after clipboard copying starts", async () => {
	const notifications = [];
	let contextStale = false;
	const ctx = {
		waitForIdle: async () => {},
		sessionManager: { buildContextEntries: () => entries },
		ui: {
			notify(message, level) {
				if (contextStale) throw new Error("stale context");
				notifications.push([message, level]);
			},
		},
		signal: undefined,
	};

	await copyAllFromContext(ctx, async () => {
		contextStale = true;
	});

	assert.deepEqual(notifications, [["Copying 2 sections to clipboard", "info"]]);
});
