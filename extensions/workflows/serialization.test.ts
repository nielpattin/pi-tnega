import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { safeStringify, shouldFallbackRenameError, writeFileAtomic } from "./serialization.ts";

void test("safeStringify handles cycles, bigint, depth, and size", () => {
  const value: Record<string, unknown> = {
    bigint: 42n,
    nested: { deeper: { deepest: true } },
    large: "x".repeat(20_000),
  };
  value.self = value;

  const text = safeStringify(value, {
    maxBytes: 2_048,
    maxDepth: 2,
    maxStringBytes: 512,
  });
  assert.ok(Buffer.byteLength(text, "utf8") <= 2_048);
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed && typeof parsed === "object");
  assert.match(text, /42n/);
  assert.match(text, /circular/);
  assert.match(text, /truncated/);
});

void test("shouldFallbackRenameError detects Windows EPERM/EEXIST/EACCES", () => {
  if (process.platform === "win32") {
    assert.equal(shouldFallbackRenameError({ code: "EPERM" }), true);
    assert.equal(shouldFallbackRenameError({ code: "EEXIST" }), true);
    assert.equal(shouldFallbackRenameError({ code: "EACCES" }), true);
    assert.equal(shouldFallbackRenameError({ code: "ENOENT" }), false);
  } else {
    assert.equal(shouldFallbackRenameError({ code: "EPERM" }), false);
  }
});

void test("atomic writes leave complete readable content", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  try {
    const file = join(directory, "artifact.json");
    writeFileAtomic(file, '{"value":1}');
    writeFileAtomic(file, '{"value":2}');
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { value: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("atomic writes fallback on rename EPERM/EACCES/EEXIST on Windows", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  try {
    const file = join(directory, "artifact.json");
    writeFileAtomic(file, '{"value":1}');

    let renameAttempted = false;
    const customRename = () => {
      renameAttempted = true;
      const err = new Error("permission denied") as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };

    if (process.platform === "win32") {
      writeFileAtomic(file, '{"value":2}', { renameFn: customRename });
      assert.equal(renameAttempted, true);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { value: 2 });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});




