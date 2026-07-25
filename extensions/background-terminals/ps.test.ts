import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/ps.ts";
import {
  buildOutputLines,
  createOutputLineCache,
  sanitizeText,
} from "./src/ui/output-view.ts";

test("dashboard selection follows its terminal id and falls back by row", () => {
  const selection: DashboardSelection = { id: "bt-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "bt-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `bt-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "bt-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `bt-${index + 1}` })),
    { id: "bt-8" },
    { id: "bt-9" },
  ]);
  assert.deepEqual(selection, { id: "bt-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "bt-1" }, { id: "bt-2" }]);
  assert.deepEqual(selection, { id: "bt-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("sanitizeText strips ANSI, tabs, and control characters", () => {
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeText("\u001b[12345Cshifted"), "shifted");
  assert.equal(sanitizeText("\u001b]0;window title\u0007output"), "output");
  assert.equal(
    sanitizeText("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\"),
    "link",
  );
  assert.equal(sanitizeText("\u001b]0;title\u009coutput"), "output");
  assert.equal(sanitizeText("\u009d0;title\u0007output"), "output");
  assert.equal(sanitizeText("a\u0085b"), "ab");
  assert.equal(sanitizeText("a\tb"), "a  b");
  assert.equal(sanitizeText("a\u0007b\u0000c"), "abc");
});

test("output line cache reuses a version/width key and invalidates either dimension", () => {
  const cache = createOutputLineCache();
  const first = cache.get("first", 1, 80);
  const sameKey = cache.get("different text is intentionally ignored", 1, 80);
  assert.equal(sameKey, first);
  assert.deepEqual(sameKey, ["first"]);

  const newVersion = cache.get("second", 2, 80);
  assert.notEqual(newVersion, first);
  assert.deepEqual(newVersion, ["second"]);

  const newWidth = cache.get("x".repeat(25), 2, 10);
  assert.notEqual(newWidth, newVersion);
  assert.ok(newWidth.length > 1);
});

test("buildOutputLines wraps long lines and keeps only the final CR segment", () => {
  const lines = buildOutputLines("progress 1\rprogress 2\rdone\nnext", 80);
  assert.deepEqual(lines, ["done", "next"]);
  assert.deepEqual(buildOutputLines("progress 1\rprogress 2\r", 80), [
    "progress 2",
  ]);

  const wrapped = buildOutputLines("x".repeat(25), 10);
  assert.ok(wrapped.length > 1);
  assert.equal(wrapped.join(""), "x".repeat(25));
});

test("buildOutputLines drops one trailing empty line from a trailing newline", () => {
  assert.deepEqual(buildOutputLines("a\nb\n", 80), ["a", "b"]);
  assert.deepEqual(buildOutputLines("a\n\n", 80), ["a", ""]);
});

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  calculateViewportHeight,
  wrapCommandLines,
  wrapDetailHeaderLines,
  wrapHintLines,
} from "./src/ui/ps.ts";
import { formatElapsed, formatExit } from "./src/domain.ts";

test("wrapCommandLines wraps a long command without ellipsis, starting with '$ ' and 2-col indentation on continuation lines", () => {
  const longCommand = "npm run test -- --grep 'some long test suite name that keeps going and going'";
  const sanitized = sanitizeText(longCommand.replace(/\s+/g, " "));
  const width = 30;

  const lines = wrapCommandLines(sanitized, width);

  assert.ok(lines.length > 1, "should wrap into multiple lines");
  for (const line of lines) {
    assert.ok(!line.includes("..."), "no ellipsis should be inserted");
    assert.ok(visibleWidth(line) <= width, `visible width ${visibleWidth(line)} should be <= ${width}`);
  }

  // Check prefix and indentation
  assert.ok(lines[0].startsWith("$ "), "first line starts with '$ '");
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i].startsWith("  "), `continuation line ${i} must start with 2-space indentation`);
  }

  // Reconstructed visible text matches sanitized original command (accounting for word wrap breaks)
  const reconstructed = lines
    .map((l) => l.slice(2).trim())
    .join(" ");
  assert.equal(reconstructed, sanitized);
});

test("wrapDetailHeaderLines wraps a long ANSI-styled header across multiple lines without ellipsis", () => {
  const fakeSnap = {
    id: "bt-1",
    title: "npm run dev server for background terminals UI",
    command: "npm run dev",
    status: "running" as const,
    startTime: Date.now() - 12000,
    createdAt: Date.now() - 12000,
    pid: 12345,
    cwd: "C:\\Users\\niel\\.pi\\agent\\extensions\\background-terminals\\very\\long\\nested\\directory\\path\\that\\exceeds\\normal\\terminal\\width",
    stdout: { totalBytes: 0, truncatedBytes: 0, text: "" },
    stderr: { totalBytes: 0, truncatedBytes: 0, text: "" },
  };
  const fakeTheme = {
    fg: (_color: string, str: string) => `\u001b[32m${str}\u001b[0m`,
    bold: (str: string) => `\u001b[1m${str}\u001b[0m`,
  };

  const header =
    `■ ` +
    fakeTheme.fg("accent", fakeTheme.bold(`${fakeSnap.id} · ${sanitizeText(fakeSnap.title)}`)) +
    fakeTheme.fg("muted", ` · ${fakeSnap.status} · ${formatElapsed(fakeSnap)} · pid ${fakeSnap.pid ?? "?"}`) +
    fakeTheme.fg("dim", ` · ${fakeSnap.cwd}`);

  const width = 40;
  const lines = wrapDetailHeaderLines(header, width);

  assert.ok(lines.length > 1, "should wrap header into multiple lines");
  for (const line of lines) {
    assert.ok(!line.includes("..."), "no ellipsis should be inserted in wrapped detail header");
    assert.ok(
      visibleWidth(line) <= width,
      `visible width ${visibleWidth(line)} should be <= ${width}`,
    );
  }

  const expectedVisibleText = sanitizeText(header);
  // Compare characters with all whitespace removed or verify exact substring presence of full cwd
  assert.equal(
    lines.map((l) => sanitizeText(l)).join("").replace(/\s+/g, ""),
    expectedVisibleText.replace(/\s+/g, ""),
  );
  assert.ok(lines.map((l) => sanitizeText(l)).join("").includes(fakeSnap.cwd));
});

test("wrapHintLines wraps full shortcut hint without ellipsis and keeps visibleWidth <= width", () => {
  const hintText = "esc/ctrl+c back · t stdout/stderr · x kill · up/down/jk scroll · pgup/pgdn page · g/G top/bottom";
  const width = 40;

  const lines = wrapHintLines(hintText, width);

  assert.ok(lines.length > 1, "should wrap into multiple lines");
  for (const line of lines) {
    assert.ok(!line.includes("..."), "no ellipsis should be inserted");
    assert.ok(visibleWidth(line) <= width, `visible width ${visibleWidth(line)} should be <= ${width}`);
  }

  const reconstructed = lines.join(" ");
  assert.equal(reconstructed, hintText);
});

test("calculateViewportHeight subtracts extra wrapped command, hint, and header rows from available terminal height", () => {
  const baseTerminalRows = 30;
  // Standard 1 command line, 1 hint line, 1 header line
  assert.equal(calculateViewportHeight(baseTerminalRows, 1, 1, 1), 30 - 9);

  // 3 command lines (+2 extra), 2 hint lines (+1 extra), 3 header lines (+2 extra) -> total chrome increases by 5
  assert.equal(calculateViewportHeight(baseTerminalRows, 3, 2, 3), 30 - 9 - 5);

  // Short terminal bounded to minimum viewport height 6
  assert.equal(calculateViewportHeight(10, 5, 5, 5), 6);
});


