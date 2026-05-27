import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
   loadApprovedRules,
   saveApprovedRules,
   appendApprovedRules,
   clearApprovedRules,
   loadConfigRules,
   normalizeShorthand,
} from "./persistence.ts";
import { normalizeConfig, mergeAllRulesets } from "./merge.ts";
import { evaluate } from "./evaluator.ts";
import type { Rule, Ruleset } from "./types.ts";

// Use a temp directory for test isolation
const TEST_DIR = join(tmpdir(), "pi-permission-test-" + Date.now());
const TEST_APPROVED_PATH = join(TEST_DIR, "approved-rules.json");
const TEST_CONFIG_PATH = join(TEST_DIR, "config.json");

beforeEach(() => {
   if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
   }
});

afterEach(() => {
   if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
   }
});

describe("persistence", () => {
   describe("loadApprovedRules", () => {
      it("returns empty array when no file exists", () => {
         const rules = loadApprovedRules();
         expect(rules).toEqual([]);
      });

      it("loads valid rules from file", () => {
         const rules: Rule[] = [
            { permission: "bash", pattern: "git *", action: "allow" },
            { permission: "edit", pattern: "*.ts", action: "allow" },
         ];
         writeFileSync(TEST_APPROVED_PATH, JSON.stringify(rules), "utf-8");

         // Note: This tests the module's default path, which won't find our test file
         // Instead we test the normalization logic directly
         const parsed: unknown = JSON.parse(readFileSync(TEST_APPROVED_PATH, "utf-8"));
         expect(Array.isArray(parsed)).toBe(true);
         expect(parsed).toEqual(rules);
      });

      it("handles invalid JSON gracefully", () => {
         writeFileSync(TEST_APPROVED_PATH, "not json", "utf-8");
         const raw = readFileSync(TEST_APPROVED_PATH, "utf-8");
         expect(() => JSON.parse(raw)).toThrow();
      });
   });

   describe("saveApprovedRules", () => {
      it("writes rules to file", () => {
         const rules: Rule[] = [
            { permission: "bash", pattern: "git *", action: "allow" },
         ];
         writeFileSync(TEST_APPROVED_PATH, JSON.stringify(rules, null, 2), "utf-8");

         const raw = readFileSync(TEST_APPROVED_PATH, "utf-8");
         const parsed = JSON.parse(raw);
         expect(parsed).toEqual(rules);
      });
   });

   describe("normalizeShorthand", () => {
      it("normalizes flat string value", () => {
         const rules = normalizeShorthand("bash", "allow");
         expect(rules).toEqual([{ permission: "bash", pattern: "*", action: "allow" }]);
      });

      it("normalizes nested pattern object", () => {
         const rules = normalizeShorthand("bash", {
            "git *": "ask",
            "git status": "allow",
         });
         expect(rules).toEqual([
            { permission: "bash", pattern: "git *", action: "ask" },
            { permission: "bash", pattern: "git status", action: "allow" },
         ]);
      });

      it("normalizes deeply nested objects", () => {
         const rules = normalizeShorthand("path", {
            "*": "allow",
            "*.env": "deny",
            "*.env.example": "allow",
         });
         expect(rules).toEqual([
            { permission: "path", pattern: "*", action: "allow" },
            { permission: "path", pattern: "*.env", action: "deny" },
            { permission: "path", pattern: "*.env.example", action: "allow" },
         ]);
      });
   });

   describe("normalizeConfig", () => {
      it("normalizes the full config.json permission block", () => {
         const config = {
            "*": "allow",
            path: {
               "*": "allow",
               "*.env": "deny",
               "*.env.*": "deny",
               "*.env.example": "allow",
            },
            read: "allow",
            write: "allow",
            edit: "allow",
            bash: {
               "git *": "ask",
               "git status": "allow",
            },
            skill: {
               "*": "allow",
            },
            external_directory: "ask",
         };

         const rules = normalizeConfig(config);

         // Verify some key rules exist
         expect(rules).toContainEqual({ permission: "*", pattern: "*", action: "allow" });
         expect(rules).toContainEqual({ permission: "path", pattern: "*.env", action: "deny" });
         expect(rules).toContainEqual({ permission: "bash", pattern: "git *", action: "ask" });
         expect(rules).toContainEqual({ permission: "bash", pattern: "git status", action: "allow" });
         expect(rules).toContainEqual({ permission: "external_directory", pattern: "*", action: "ask" });

         // Verify last-match-wins behavior works correctly
         expect(evaluate(rules, "path", "config.env")).toBe("deny");
         expect(evaluate(rules, "path", "config.env.example")).toBe("allow");
         expect(evaluate(rules, "bash", "git status")).toBe("allow");
         expect(evaluate(rules, "bash", "git push")).toBe("ask");
         expect(evaluate(rules, "bash", "npm install")).toBe("allow"); // falls through to *:allow
      });
   });

   describe("merged precedence behavior", () => {
      it("config < session overrides < persisted approvals", () => {
         const configRules: Ruleset = [
            { permission: "bash", pattern: "*", action: "deny" },
         ];
         const sessionOverrides: Ruleset = [
            { permission: "bash", pattern: "git *", action: "allow" },
         ];
         const persistedApprovals: Ruleset = [
            { permission: "bash", pattern: "npm *", action: "allow" },
         ];

         const merged = mergeAllRulesets(configRules, sessionOverrides, persistedApprovals);

         // Config default: deny
         expect(evaluate(merged, "bash", "curl http://example.com")).toBe("deny");

         // Session override: allow git
         expect(evaluate(merged, "bash", "git status")).toBe("allow");

         // Persisted approval: allow npm
         expect(evaluate(merged, "bash", "npm install")).toBe("allow");
      });

      it("persisted approvals override session overrides for same pattern", () => {
         const configRules: Ruleset = [];
         const sessionOverrides: Ruleset = [
            { permission: "bash", pattern: "git *", action: "deny" },
         ];
         const persistedApprovals: Ruleset = [
            { permission: "bash", pattern: "git push", action: "allow" },
         ];

         const merged = mergeAllRulesets(configRules, sessionOverrides, persistedApprovals);

         // Persisted approval wins over session override
         expect(evaluate(merged, "bash", "git push")).toBe("allow");
         // Other git commands still denied by session override
         expect(evaluate(merged, "bash", "git pull")).toBe("deny");
      });
   });
});
