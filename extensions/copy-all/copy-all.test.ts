import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit } from "effect";
import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveClipboardCommand, copyToClipboard, formatCopySections } from "./index.ts";

type Parented = SessionEntry;

function messageEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant" | "toolResult",
	content: string
): Parented {
	if (role === "toolResult") {
		return {
			type: "message",
			id,
			parentId,
			timestamp: "2024-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: content }],
				isError: false,
				timestamp: 0
			}
		} as SessionEntry;
	}

	return {
		type: "message",
		id,
		parentId,
		timestamp: "2024-01-01T00:00:00.000Z",
		message: {
			role,
			content: role === "user" ? content : [{ type: "text", text: content }],
			timestamp: 0,
			...(role === "assistant"
				? {
						api: "test",
						provider: "test",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
						},
						stopReason: "stop" as const
				  }
				: {})
		}
	} as SessionEntry;
}

function compactionEntry(
	id: string,
	parentId: string | null,
	summary: string,
	firstKeptEntryId: string
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2024-01-01T00:00:00.000Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000
	};
}

function sectionsFromBranch(entries: SessionEntry[], leafId: string): string[] {
	return formatCopySections(buildContextEntries(entries, leafId));
}

const WIN32_POWERSHELL_CLIPBOARD =
  "$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8); $text = $reader.ReadToEnd(); $reader.Close(); Set-Clipboard -Value $text";

void test("resolveClipboardCommand - win32 preferred powershell Set-Clipboard", () => {
  const cmd = resolveClipboardCommand("win32", {}, (command) => command === "powershell");
  assert.equal(cmd.command, "powershell");
  assert.deepEqual(cmd.args, [
    "-NoProfile",
    "-Command",
    WIN32_POWERSHELL_CLIPBOARD,
  ]);
});

void test("resolveClipboardCommand - win32 fallback clip.exe", () => {
  const cmd = resolveClipboardCommand("win32", {}, (command) => command === "clip");
  assert.equal(cmd.command, "clip");
  assert.deepEqual(cmd.args, []);
});

void test("resolveClipboardCommand - darwin uses pbcopy", () => {
  const cmd = resolveClipboardCommand("darwin", {});
  assert.equal(cmd.command, "pbcopy");
  assert.deepEqual(cmd.args, []);
});

void test("resolveClipboardCommand - linux prefers wl-copy, fallback xclip, xsel", () => {
  const cmdWl = resolveClipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" }, (c) => c === "wl-copy");
  assert.equal(cmdWl.command, "wl-copy");

  const cmdXclip = resolveClipboardCommand("linux", {}, (c) => c === "xclip");
  assert.equal(cmdXclip.command, "xclip");
  assert.deepEqual(cmdXclip.args, ["-selection", "clipboard"]);

  const cmdXsel = resolveClipboardCommand("linux", {}, (c) => c === "xsel");
  assert.equal(cmdXsel.command, "xsel");
  assert.deepEqual(cmdXsel.args, ["-b"]);
});

void test("copyToClipboard - failure returns ClipboardError readable error", async () => {
  const mockSpawn = () => {
    const listeners: Record<string, Function[]> = {};
    const child: any = {
      stderr: {
        on: (event: string, fn: Function) => {
          listeners[`stderr_${event}`] = listeners[`stderr_${event}`] || [];
          listeners[`stderr_${event}`].push(fn);
        },
      },
      on: (event: string, fn: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
      },
      stdin: {
        end: () => {
          setTimeout(() => {
            listeners["stderr_data"]?.forEach((fn) => fn("command not found"));
            listeners["close"]?.forEach((fn) => fn(1));
          }, 5);
        },
      },
      kill: () => {},
      exitCode: null,
    };
    return child;
  };

  const exit = await Effect.runPromiseExit(copyToClipboard("test", "darwin", {}, undefined, mockSpawn as any));
  assert.equal(Exit.isFailure(exit), true);
});

void test(
  "copyToClipboard - Windows preserves Vietnamese and multi-language Unicode",
  { skip: process.platform !== "win32" },
  async () => {
    const text =
      "ăâêôơư đ ĂÂÊÔƠƯ Đ\n日本語 한국어 emoji 🎉";

    const exit = await Effect.runPromiseExit(copyToClipboard(text));
    assert.equal(Exit.isSuccess(exit), true);

    const { execFileSync } = await import("node:child_process");
    const got = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Get-Clipboard -Raw"],
      { encoding: "utf8" },
    ).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");

    assert.equal(got, text);
  },
);

void test("formatCopySections - no compaction copies full active branch user/assistant messages", () => {
	const m1 = messageEntry("m1", null, "user", "hello");
	const m2 = messageEntry("m2", "m1", "assistant", "hi");
	const m3 = messageEntry("m3", "m2", "toolResult", "ignored");
	const m4 = messageEntry("m4", "m3", "user", "next");

	assert.deepEqual(sectionsFromBranch([m1, m2, m3, m4], "m4"), [
		"USER:\nhello",
		"ASSISTANT:\nhi",
		"USER:\nnext"
	]);
});

void test("formatCopySections - after compaction includes summary and drops pre-firstKept messages", () => {
	const old1 = messageEntry("old1", null, "user", "old request");
	const old2 = messageEntry("old2", "old1", "assistant", "old reply");
	const kept = messageEntry("kept", "old2", "user", "kept request");
	const keptReply = messageEntry("keptR", "kept", "assistant", "kept reply");
	const cmp = compactionEntry("cmp1", "keptR", "Earlier work on auth", "kept");
	const after = messageEntry("after", "cmp1", "user", "continue");

	assert.deepEqual(sectionsFromBranch([old1, old2, kept, keptReply, cmp, after], "after"), [
		"COMPACTION:\nEarlier work on auth",
		"USER:\nkept request",
		"ASSISTANT:\nkept reply",
		"USER:\ncontinue"
	]);
});

void test("formatCopySections - repeated compaction uses only the latest window", () => {
	const a = messageEntry("a", null, "user", "first");
	const b = messageEntry("b", "a", "assistant", "first reply");
	const c = messageEntry("c", "b", "user", "second");
	const cmp1 = compactionEntry("cmp1", "c", "First summary", "c");
	const d = messageEntry("d", "cmp1", "assistant", "second reply");
	const e = messageEntry("e", "d", "user", "third");
	const cmp2 = compactionEntry("cmp2", "e", "Latest summary", "e");
	const f = messageEntry("f", "cmp2", "assistant", "third reply");

	assert.deepEqual(sectionsFromBranch([a, b, c, cmp1, d, e, cmp2, f], "f"), [
		"COMPACTION:\nLatest summary",
		"USER:\nthird",
		"ASSISTANT:\nthird reply"
	]);
});

void test("formatCopySections - empty messages and blank compaction are skipped", () => {
	const emptyUser = messageEntry("u1", null, "user", "   ");
	const blankCmp = compactionEntry("cmp", "u1", "  ", "u1");
	const real = messageEntry("u2", "cmp", "user", "real");

	assert.deepEqual(sectionsFromBranch([emptyUser, blankCmp, real], "u2"), ["USER:\nreal"]);
});

