import { describe, expect, it } from "vitest";
import {
   checkCutover,
   pathFrom,
   hasForceExclude,
   NAME_COLLISION_TOOLS,
   NAME_COLLISION_COMMANDS
} from "../src/cutover.js";

describe("Cutover Fail-Closed Gate", () => {
   it("pathFrom extracts path safely", () => {
      expect(pathFrom({ sourceInfo: { path: "extensions/tasks/index.ts" } })).toBe("extensions/tasks/index.ts");
      expect(pathFrom({})).toBe("");
      expect(pathFrom({ sourceInfo: {} })).toBe("");
   });

   it("hasForceExclude detects '-extensions/tasks/index.ts' and '-extensions/background-terminals/index.ts'", () => {
      const settings = ["+index.ts", "-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
      expect(hasForceExclude(settings, "extensions/tasks/index.ts")).toBe(true);
      expect(hasForceExclude(settings, "extensions/background-terminals/index.ts")).toBe(true);
      expect(hasForceExclude(settings, "extensions/other/index.ts")).toBe(false);
   });

   it("passes when settings force-exclude both legacy extensions", () => {
      const res = checkCutover({
         tools: [{ name: "task", sourceInfo: { path: "extensions/tasks/index.ts" } }],
         commands: [{ name: "/ps", sourceInfo: { path: "extensions/background-terminals/index.ts" } }],
         settingsExtensions: ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"]
      });
      expect(res.ok).toBe(true);
   });

   it("fails when tool path matches extensions/tasks without force-exclude", () => {
      const res = checkCutover({
         tools: [{ name: "task", sourceInfo: { path: "extensions/tasks/index.ts" } }],
         commands: [],
         settingsExtensions: []
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
         expect(res.error).toContain("extensions/tasks");
      }
   });

   it("fails when tool path matches extensions/background-terminals without force-exclude", () => {
      const res = checkCutover({
         tools: [{ name: "bg_start", sourceInfo: { path: "extensions/background-terminals/index.ts" } }],
         commands: [],
         settingsExtensions: ["-extensions/tasks/index.ts"]
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
         expect(res.error).toContain("extensions/background-terminals");
      }
   });

   it("fails when force-excludes are missing even with no live collisions", () => {
      const res = checkCutover({
         tools: [{ name: "custom_tool" }],
         commands: [{ name: "/custom" }],
         settingsExtensions: []
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
         expect(res.error).toContain("Force-exclude");
         expect(res.error).toContain("-extensions/tasks/index.ts");
         expect(res.error).toContain("-extensions/background-terminals/index.ts");
      }
   });

   it("fails when only one of the two force-excludes is present", () => {
      const res = checkCutover({
         tools: [],
         commands: [],
         settingsExtensions: ["-extensions/tasks/index.ts"]
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
         expect(res.error).toContain("-extensions/background-terminals/index.ts");
      }
   });

   it("passes with force-excludes and no live collisions", () => {
      const res = checkCutover({
         tools: [{ name: "custom_tool" }],
         commands: [{ name: "/custom" }],
         settingsExtensions: ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"]
      });
      expect(res.ok).toBe(true);
   });
});
