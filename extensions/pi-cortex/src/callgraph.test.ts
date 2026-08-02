import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { toCallGraphHits } from "./callgraph.js";

const rel = (...parts: string[]) => parts.join(sep);

describe("toCallGraphHits", () => {
   it("maps sidecar rows (file_path/callee/caller) to render-friendly hits", () => {
      const hits = toCallGraphHits(
         [{ file_path: "C:/proj/extensions/a/index.ts", line: 42, callee: "runTool", caller: "" }],
         "C:/proj"
      );
      expect(hits).toEqual([
         {
            callerPath: rel("extensions", "a", "index.ts"),
            callerSymbol: "",
            calleePath: rel("extensions", "a", "index.ts"),
            calleeSymbol: "runTool"
         }
      ]);
   });

   it("preserves the caller symbol and falls back to absolute path when relative yields empty", () => {
      const hits = toCallGraphHits(
         [{ file_path: "C:/proj/a.ts", line: 7, callee: "validateCredentials", caller: "login" }],
         "C:/proj"
      );
      expect(hits[0].callerPath).toBe("a.ts");
      expect(hits[0].callerSymbol).toBe("login");
      expect(hits[0].calleeSymbol).toBe("validateCredentials");
   });

   it("keeps the absolute path when the file is outside the cwd", () => {
      const hits = toCallGraphHits(
         [{ file_path: "D:/other/lib.ts", line: 3, callee: "runTool", caller: "" }],
         "C:/proj"
      );
      expect(hits[0].callerPath).toMatch(/D:/);
   });

   it("never throws on rows the old protocol shape would have left undefined", () => {
      const hits = toCallGraphHits(
         [{ file_path: "src/a.ts", line: 1, callee: "x", caller: "y" }],
         "C:/proj"
      );
      expect(hits).toHaveLength(1);
   });
});
