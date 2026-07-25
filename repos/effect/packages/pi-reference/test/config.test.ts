import { describe, it, expect } from "vitest";
import { validAlias, isLocalShorthand, parseEntry, resolveLocalPath, expandHome } from "../config.js";
import path from "path";
import os from "os";

describe("validAlias", () => {
   it("accepts simple aliases", () => {
      expect(validAlias("docs")).toBe(true);
      expect(validAlias("sdk")).toBe(true);
      expect(validAlias("design-system")).toBe(true);
      expect(validAlias("my_ref")).toBe(true);
   });

   it("rejects empty", () => {
      expect(validAlias("")).toBe(false);
   });

   it("rejects slashes", () => {
      expect(validAlias("a/b")).toBe(false);
      expect(validAlias("a/b/c")).toBe(false);
   });

   it("rejects whitespace", () => {
      expect(validAlias("a b")).toBe(false);
      expect(validAlias("a\tb")).toBe(false);
   });

   it("rejects backticks", () => {
      expect(validAlias("a`b")).toBe(false);
   });

   it("rejects commas", () => {
      expect(validAlias("a,b")).toBe(false);
   });
});

describe("isLocalShorthand", () => {
   it("returns true for relative paths", () => {
      expect(isLocalShorthand("../docs")).toBe(true);
      expect(isLocalShorthand("./src")).toBe(true);
      expect(isLocalShorthand(".")).toBe(true);
   });

   it("returns true for absolute paths", () => {
      expect(isLocalShorthand("/home/user/docs")).toBe(true);
      expect(isLocalShorthand("C:/Users")).toBe(false); // Windows drive letter doesn't start with /
   });

   it("returns true for home paths", () => {
      expect(isLocalShorthand("~/docs")).toBe(true);
      expect(isLocalShorthand("~")).toBe(true);
   });

   it("returns false for git shorthand", () => {
      expect(isLocalShorthand("owner/repo")).toBe(false);
      expect(isLocalShorthand("Effect-TS/effect")).toBe(false);
   });
});

describe("parseEntry", () => {
   const baseDir = "/project";

   it("parses string shorthand as local for relative paths", () => {
      const result = parseEntry("docs", "../docs", baseDir);
      expect(result).toEqual({
         type: "local",
         path: path.resolve(baseDir, "../docs"),
      });
   });

   it("parses string shorthand as git for owner/repo", () => {
      const result = parseEntry("sdk", "anomalyco/opencode-sdk-js", baseDir);
      expect(result).toEqual({
         type: "git",
         repository: "anomalyco/opencode-sdk-js",
      });
   });

   it("parses local object", () => {
      const result = parseEntry(
         "docs",
         {
            path: "../docs",
            description: "Product docs",
            hidden: false,
         },
         baseDir,
      );
      expect(result).toEqual({
         type: "local",
         path: path.resolve(baseDir, "../docs"),
         description: "Product docs",
         hidden: false,
      });
   });

   it("parses git object", () => {
      const result = parseEntry(
         "sdk",
         {
            repository: "anomalyco/opencode-sdk-js",
            branch: "main",
            description: "SDK source",
         },
         baseDir,
      );
      expect(result).toEqual({
         type: "git",
         repository: "anomalyco/opencode-sdk-js",
         branch: "main",
         description: "SDK source",
      });
   });

   it("returns null for invalid entry", () => {
      expect(parseEntry("bad", 42 as never, baseDir)).toBeNull();
      expect(parseEntry("bad", null as never, baseDir)).toBeNull();
   });
});

describe("resolveLocalPath", () => {
   it("resolves relative to base dir", () => {
      expect(resolveLocalPath("../docs", "/project")).toBe(path.resolve("/project", "../docs"));
   });

   it("expands ~ to home", () => {
      expect(resolveLocalPath("~/docs", "/project")).toBe(path.join(os.homedir(), "docs"));
   });

   it("passes through absolute paths", () => {
      expect(resolveLocalPath("/abs/path", "/project")).toBe(path.resolve("/abs/path"));
   });
});

describe("expandHome", () => {
   it("expands ~ alone to home", () => {
      expect(expandHome("~")).toBe(os.homedir());
   });

   it("expands ~/path", () => {
      expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
   });

   it("passes through non-home paths", () => {
      expect(expandHome("/abs/path")).toBe("/abs/path");
      expect(expandHome("../relative")).toBe("../relative");
   });
});
