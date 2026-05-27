import { describe, it, expect } from "vitest";
import { matchesWildcard, ruleMatches, evaluate, evaluatePatterns } from "./evaluator.ts";
import { normalizeConfig, mergeAllRulesets } from "./merge.ts";
import type { Rule, Ruleset } from "./types.ts";

// ── Wildcard matching ───────────────────────────────────────────────

describe("matchesWildcard", () => {
   it("matches exact strings", () => {
      expect(matchesWildcard("git status", "git status")).toBe(true);
      expect(matchesWildcard("git status", "git log")).toBe(false);
   });

   it("matches * wildcard", () => {
      expect(matchesWildcard("git *", "git status")).toBe(true);
      expect(matchesWildcard("git *", "git log --oneline")).toBe(true);
      expect(matchesWildcard("git *", "npm install")).toBe(false);
   });

   it("matches ** wildcard (globstar)", () => {
      expect(matchesWildcard("**/env", "/home/user/env")).toBe(true);
      expect(matchesWildcard("**/*.env", "path/to/.env")).toBe(true);
   });

   it("matches ? wildcard (single char)", () => {
      expect(matchesWildcard("file?.ts", "file1.ts")).toBe(true);
      expect(matchesWildcard("file?.ts", "file12.ts")).toBe(false);
   });

   it("matches wildcard patterns", () => {
      expect(matchesWildcard("*", "anything")).toBe(true);
      expect(matchesWildcard("*.env", "config.env")).toBe(true);
      expect(matchesWildcard("*.env", "config.ts")).toBe(false);
      expect(matchesWildcard("*.env.*", "config.env.local")).toBe(true);
      expect(matchesWildcard("*.env.example", "config.env.example")).toBe(true);
   });

   it("is case insensitive", () => {
      expect(matchesWildcard("Git *", "git status")).toBe(true);
      expect(matchesWildcard("git *", "GIT status")).toBe(true);
   });
});

// ── Rule matching ───────────────────────────────────────────────────

describe("ruleMatches", () => {
   it("matches on both permission and pattern", () => {
      const rule: Rule = { permission: "bash", pattern: "git *", action: "ask" };
      expect(ruleMatches(rule, "bash", "git status")).toBe(true);
      expect(ruleMatches(rule, "bash", "npm install")).toBe(false);
      expect(ruleMatches(rule, "edit", "git status")).toBe(false);
   });

   it("supports wildcard permission", () => {
      const rule: Rule = { permission: "*", pattern: "*", action: "allow" };
      expect(ruleMatches(rule, "bash", "anything")).toBe(true);
      expect(ruleMatches(rule, "edit", "file.ts")).toBe(true);
   });
});

// ── Evaluator defaults ──────────────────────────────────────────────

describe("evaluate", () => {
   it("returns 'ask' when no rules match (default behavior)", () => {
      const ruleset: Ruleset = [];
      expect(evaluate(ruleset, "bash", "git status")).toBe("ask");
   });

   it("returns 'ask' when no rules match the permission", () => {
      const ruleset: Ruleset = [
         { permission: "edit", pattern: "*", action: "allow" },
      ];
      expect(evaluate(ruleset, "bash", "git status")).toBe("ask");
   });

   it("returns matching rule action", () => {
      const ruleset: Ruleset = [
         { permission: "bash", pattern: "git *", action: "ask" },
      ];
      expect(evaluate(ruleset, "bash", "git status")).toBe("ask");
      expect(evaluate(ruleset, "bash", "npm install")).toBe("ask"); // no match -> default
   });

   it("applies last-match-wins semantics", () => {
      const ruleset: Ruleset = [
         { permission: "*", pattern: "*", action: "deny" },
         { permission: "bash", pattern: "git *", action: "allow" },
      ];
      expect(evaluate(ruleset, "bash", "git status")).toBe("allow");
      expect(evaluate(ruleset, "bash", "npm install")).toBe("deny");
      expect(evaluate(ruleset, "edit", "file.ts")).toBe("deny");
   });

   it("later specific rule overrides earlier wildcard", () => {
      const ruleset: Ruleset = [
         { permission: "*", pattern: "*.env*", action: "deny" },
         { permission: "*", pattern: "*.env.example", action: "allow" },
      ];
      expect(evaluate(ruleset, "read", "config.env")).toBe("deny");
      expect(evaluate(ruleset, "read", "config.env.example")).toBe("allow");
      expect(evaluate(ruleset, "read", "config.env.local")).toBe("deny");
   });

   it("evaluates config-normalized rules correctly", () => {
      const config = {
         "*": "allow" as const,
         bash: {
            "git *": "ask" as const,
            "git status": "allow" as const,
         },
         external_directory: "ask" as const,
      };
      const ruleset = normalizeConfig(config);

      expect(evaluate(ruleset, "bash", "git status")).toBe("allow");
      expect(evaluate(ruleset, "bash", "git log")).toBe("ask");
      expect(evaluate(ruleset, "bash", "npm install")).toBe("allow"); // falls through to *:allow
      expect(evaluate(ruleset, "external_directory", "/some/path")).toBe("ask");
   });
});

// ── Multiple pattern evaluation ─────────────────────────────────────

describe("evaluatePatterns", () => {
   it("uses last matching rule across request pattern alternatives", () => {
      const ruleset: Ruleset = [
         { permission: "*", pattern: "*", action: "allow" },
      ];
      expect(evaluatePatterns(ruleset, "bash", ["git status", "git *", "*"])).toBe("allow");
   });

   it("lets specific later deny override broad allow", () => {
      const ruleset: Ruleset = [
         { permission: "*", pattern: "*", action: "allow" },
         { permission: "bash", pattern: "rm *", action: "deny" },
      ];
      expect(evaluatePatterns(ruleset, "bash", ["rm -rf /", "rm *", "*"])).toBe("deny");
   });

   it("lets persisted exact allow override broad ask fallback", () => {
      const ruleset: Ruleset = [
         { permission: "*", pattern: "*", action: "ask" },
         { permission: "read", pattern: "C:/repo/README.md", action: "allow" },
      ];
      expect(evaluatePatterns(ruleset, "read", ["C:/repo/README.md", "*.md", "C:/repo/**", "*"])).toBe("allow");
   });

   it("returns ask when broad ask is the last matching rule", () => {
      const ruleset: Ruleset = [
         { permission: "*", pattern: "*", action: "allow" },
         { permission: "bash", pattern: "git *", action: "ask" },
      ];
      expect(evaluatePatterns(ruleset, "bash", ["git status", "git *", "*"])).toBe("ask");
   });
});

// ── Merge helpers ───────────────────────────────────────────────────

describe("mergeAllRulesets", () => {
   it("preserves precedence order with last-match-wins", () => {
      const configRules: Ruleset = [
         { permission: "*", pattern: "*", action: "deny" },
      ];
      const sessionOverrides: Ruleset = [
         { permission: "bash", pattern: "git *", action: "allow" },
      ];
      const persistedApprovals: Ruleset = [
         { permission: "bash", pattern: "npm *", action: "allow" },
      ];

      const merged = mergeAllRulesets(configRules, sessionOverrides, persistedApprovals);

      expect(evaluate(merged, "bash", "git status")).toBe("allow");
      expect(evaluate(merged, "bash", "npm install")).toBe("allow");
      expect(evaluate(merged, "edit", "file.ts")).toBe("deny");
   });

   it("empty overrides and approvals preserves config behavior", () => {
      const configRules: Ruleset = [
         { permission: "bash", pattern: "git *", action: "ask" },
      ];

      const merged = mergeAllRulesets(configRules, [], []);

      expect(evaluate(merged, "bash", "git status")).toBe("ask");
      expect(evaluate(merged, "bash", "npm install")).toBe("ask"); // default
   });
});

// ── Config normalization ────────────────────────────────────────────

describe("normalizeConfig", () => {
   it("normalizes flat action strings", () => {
      const config = { read: "allow" as const };
      const rules = normalizeConfig(config);
      expect(rules).toEqual([{ permission: "read", pattern: "*", action: "allow" }]);
   });

   it("normalizes nested patterns", () => {
      const config = {
         bash: {
            "git *": "ask" as const,
            "git status": "allow" as const,
         },
      };
      const rules = normalizeConfig(config);
      expect(rules).toEqual([
         { permission: "bash", pattern: "git *", action: "ask" },
         { permission: "bash", pattern: "git status", action: "allow" },
      ]);
   });

   it("normalizes deeply nested permissions", () => {
      const config = {
         path: {
            "*": "allow" as const,
            "*.env": "deny" as const,
            "*.env.example": "allow" as const,
         },
      };
      const rules = normalizeConfig(config);
      expect(rules).toEqual([
         { permission: "path", pattern: "*", action: "allow" },
         { permission: "path", pattern: "*.env", action: "deny" },
         { permission: "path", pattern: "*.env.example", action: "allow" },
      ]);
   });
});
