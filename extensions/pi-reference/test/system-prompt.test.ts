import { describe, it, expect } from "vitest";
import { buildReferenceGuidance } from "../system-prompt.js";
import type { ReferenceInfo } from "../types.js";

function makeRef(overrides: Partial<ReferenceInfo> & { name: string }): ReferenceInfo {
   return {
      path: `/path/to/${overrides.name}`,
      source: { type: "local", path: `/path/to/${overrides.name}` },
      ...overrides,
   };
}

describe("buildReferenceGuidance", () => {
   it("returns empty string for empty references", () => {
      expect(buildReferenceGuidance([])).toBe("");
   });

   it("returns empty string when no references have descriptions", () => {
      const refs = [makeRef({ name: "docs" }), makeRef({ name: "sdk" })];
      expect(buildReferenceGuidance(refs)).toBe("");
   });

   it("includes only references with descriptions", () => {
      const refs = [
         makeRef({ name: "docs", description: "Product docs" }),
         makeRef({ name: "sdk" }), // no description
      ];
      const result = buildReferenceGuidance(refs);
      expect(result).toContain("<name>docs</name>");
      expect(result).toContain("Product docs");
      expect(result).not.toContain("<name>sdk</name>");
   });

   it("includes hidden references that have descriptions", () => {
      const refs = [
         makeRef({ name: "docs", description: "Product docs" }),
         makeRef({ name: "internal", description: "Hidden", hidden: true }),
      ];
      const result = buildReferenceGuidance(refs);
      expect(result).toContain("<name>docs</name>");
      expect(result).toContain("<name>internal</name>");
      expect(result).toContain("Hidden");
   });

   it("sorts references alphabetically by name", () => {
      const refs = [
         makeRef({ name: "zookeeper", description: "Z" }),
         makeRef({ name: "alpha", description: "A" }),
         makeRef({ name: "middle", description: "M" }),
      ];
      const result = buildReferenceGuidance(refs);
      const alphaIdx = result.indexOf("<name>alpha</name>");
      const middleIdx = result.indexOf("<name>middle</name>");
      const zooIdx = result.indexOf("<name>zookeeper</name>");
      expect(alphaIdx).toBeLessThan(middleIdx);
      expect(middleIdx).toBeLessThan(zooIdx);
   });

   it("wraps in project_references tag", () => {
      const refs = [makeRef({ name: "docs", description: "Product docs" })];
      const result = buildReferenceGuidance(refs);
      expect(result).toContain("<project_references>");
      expect(result).toContain("</project_references>");
   });

   it("includes path for each reference", () => {
      const refs = [makeRef({ name: "docs", description: "Product docs", path: "/custom/path" })];
      const result = buildReferenceGuidance(refs);
      expect(result).toContain("<path>/custom/path</path>");
   });

   it("handles multiple references with descriptions", () => {
      const refs = [
         makeRef({ name: "docs", description: "Product docs" }),
         makeRef({ name: "sdk", description: "SDK source" }),
      ];
      const result = buildReferenceGuidance(refs);
      expect(result).toContain("<name>docs</name>");
      expect(result).toContain("<name>sdk</name>");
      expect(result).toContain("Product docs");
      expect(result).toContain("SDK source");
   });

   it("escapes XML special characters", () => {
      const refs = [makeRef({ name: "docs", description: "A & B < C > D" })];
      const result = buildReferenceGuidance(refs);
      expect(result).toContain("A &amp; B &lt; C &gt; D");
      expect(result).not.toContain("A & B < C > D");
   });
});
