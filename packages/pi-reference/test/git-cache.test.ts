import { describe, it, expect } from "vitest";
import { parseRepo, cachePath } from "../git-cache.js";
import path from "path";
import os from "os";

describe("parseRepo", () => {
   it("parses owner/repo shorthand", () => {
      const result = parseRepo("anomalyco/opencode");
      expect(result).toEqual({
         host: "github.com",
         org: "anomalyco",
         repo: "opencode",
         remote: "https://github.com/anomalyco/opencode.git",
      });
   });

   it("parses owner/repo with .git suffix", () => {
      const result = parseRepo("anomalyco/opencode.git");
      expect(result?.repo).toBe("opencode");
   });

   it("parses full HTTPS URL", () => {
      const result = parseRepo("https://github.com/anomalyco/opencode");
      expect(result).toEqual({
         host: "github.com",
         org: "anomalyco",
         repo: "opencode",
         remote: "https://github.com/anomalyco/opencode",
      });
   });

   it("parses HTTPS URL with .git suffix", () => {
      const result = parseRepo("https://github.com/anomalyco/opencode.git");
      expect(result?.repo).toBe("opencode");
      expect(result?.host).toBe("github.com");
   });

   it("parses SSH URL", () => {
      const result = parseRepo("git@github.com:anomalyco/opencode.git");
      expect(result).toEqual({
         host: "github.com",
         org: "anomalyco",
         repo: "opencode",
         remote: "git@github.com:anomalyco/opencode.git",
      });
   });

   it("parses host/owner/repo form", () => {
      const result = parseRepo("gitlab.com/myorg/myrepo");
      expect(result).toEqual({
         host: "gitlab.com",
         org: "myorg",
         repo: "myrepo",
         remote: "https://gitlab.com/myorg/myrepo.git",
      });
   });

   it("handles nested org paths", () => {
      const result = parseRepo("gitlab.com/group/subgroup/repo");
      expect(result?.org).toBe("group/subgroup");
      expect(result?.repo).toBe("repo");
   });

   it("returns null for invalid input", () => {
      expect(parseRepo("")).toBeNull();
      expect(parseRepo("justoneword")).toBeNull();
   });
});

describe("cachePath", () => {
   it("computes cache path from parsed repo", () => {
      const repo = parseRepo("anomalyco/opencode")!;
      const result = cachePath(repo);
      expect(result).toBe(path.join(os.homedir(), ".cache", "checkouts", "github.com", "anomalyco", "opencode"));
   });

   it("computes cache path for non-github host", () => {
      const repo = parseRepo("gitlab.com/myorg/myrepo")!;
      const result = cachePath(repo);
      expect(result).toBe(path.join(os.homedir(), ".cache", "checkouts", "gitlab.com", "myorg", "myrepo"));
   });
});
