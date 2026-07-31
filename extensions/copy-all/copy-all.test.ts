import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit } from "effect";
import { resolveClipboardCommand, copyToClipboard } from "./index.ts";

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

