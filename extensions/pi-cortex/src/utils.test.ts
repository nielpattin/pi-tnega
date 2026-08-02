import { describe, expect, it } from "vitest";
import { detectKeywordWeight, fmtBytes, fmtTime } from "./utils.js";

describe("fmtBytes", () => {
   it("formats bytes, KB, and MB", () => {
      expect(fmtBytes(512)).toBe("512 B");
      expect(fmtBytes(1024)).toBe("1.0 KB");
      expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
      expect(fmtBytes(111104 * 1024)).toBe("108.5 MB");
   });
});

describe("fmtTime", () => {
   it("formats ms and seconds", () => {
      expect(fmtTime(0.5)).toBe("500ms");
      expect(fmtTime(12.34)).toBe("12.3s");
   });
});

describe("detectKeywordWeight", () => {
   it("routes standalone identifiers to lexical search", () => {
      expect(detectKeywordWeight("login")).toBe(1);
      expect(detectKeywordWeight("validateCredentials")).toBe(1);
   });

   it("keeps natural-language queries semantic-heavy", () => {
      expect(detectKeywordWeight("how does login work")).toBeLessThan(1);
   });
});
