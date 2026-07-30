import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { deriveChildSessionDirectory } from "../src/utils/child-session-dir.js";

describe("deriveChildSessionDirectory", () => {
   const isWindows = process.platform === "win32";
   const sessionRoot = isWindows ? "C:\\users\\niel\\.pi\\agent\\sessions" : "/users/niel/.pi/agent/sessions";
   const baseName = "2026-01-15T123456Z_parent-session-id";
   const expectedDir = path.join(sessionRoot, baseName);

   it("derives a sibling directory from a native-style parent session file", () => {
      const parentFile = isWindows
         ? `C:\\users\\niel\\.pi\\agent\\sessions\\${baseName}.jsonl`
         : `/users/niel/.pi/agent/sessions/${baseName}.jsonl`;
      expect(deriveChildSessionDirectory(parentFile)).toBe(expectedDir);
   });

   it("derives the same sibling directory from POSIX-style separators", () => {
      const parentFile = `/users/niel/.pi/agent/sessions/${baseName}.jsonl`;
      const thisExpectedDir = isWindows
         ? path.join("C:\\users\\niel\\.pi\\agent\\sessions", baseName)
         : expectedDir;
      expect(deriveChildSessionDirectory(parentFile)).toBe(thisExpectedDir);
   });

   it("handles mixed Windows and POSIX separators", () => {
      if (!isWindows) return;
      const mixed = "C:\\users/niel\\.pi/agent\\sessions/2026-01-15T123456Z_parent-session-id.jsonl";
      expect(deriveChildSessionDirectory(mixed)).toBe(expectedDir);
   });

   it("handles unusual but safe basenames", () => {
      const cases = [
         "my task name (copy).jsonl",
         "session_v1.2.3.jsonl",
         "2026-01-15T123456Z_日本語-id.jsonl",
         "2026-01-15T123456Z_ id with spaces.jsonl"
      ];

      for (const fileName of cases) {
         const parentFile = path.join(sessionRoot, fileName);
         const result = deriveChildSessionDirectory(parentFile);
         const expectedBase = fileName.slice(0, -".jsonl".length);
         expect(result).toBe(path.join(sessionRoot, expectedBase));
      }
   });

   it("returns undefined for missing or non-JSONL files", () => {
      expect(deriveChildSessionDirectory(undefined)).toBeUndefined();
      expect(deriveChildSessionDirectory(null)).toBeUndefined();
      expect(deriveChildSessionDirectory("")).toBeUndefined();
      expect(deriveChildSessionDirectory(path.join(sessionRoot, "notes.txt"))).toBeUndefined();
      expect(deriveChildSessionDirectory(path.join(sessionRoot, ".jsonl"))).toBeUndefined();
   });

   it("returns the same directory for multiple children of the same parent", () => {
      const parentFile = path.join(sessionRoot, `${baseName}.jsonl`);
      const first = deriveChildSessionDirectory(parentFile);
      const second = deriveChildSessionDirectory(parentFile);
      expect(first).toBe(second);
      expect(first).toBeDefined();
      expect(path.dirname(first!)).toBe(sessionRoot);
      expect(path.basename(first!)).toBe(baseName);
   });
});
