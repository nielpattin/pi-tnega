import { describe, it, expect } from "vitest";
import { referenceExists } from "../resolve.js";
import type { ReferenceInfo } from "../types.js";
import { existsSync } from "fs";

describe("referenceExists", () => {
   it("returns true for existing paths", () => {
      const ref: ReferenceInfo = {
         name: "test",
         path: process.cwd(),
         source: { type: "local", path: process.cwd() },
      };
      expect(referenceExists(ref)).toBe(true);
   });

   it("returns false for non-existent paths", () => {
      const ref: ReferenceInfo = {
         name: "test",
         path: "/nonexistent/path/that/should/not/exist",
         source: { type: "local", path: "/nonexistent/path/that/should/not/exist" },
      };
      expect(referenceExists(ref)).toBe(false);
   });
});
