/**
 * Merge helpers for combining rulesets from different sources.
 *
 * Preserves deterministic ordering and last-match-wins semantics by
 * concatenating rulesets in a defined precedence order.
 */

import type { Action, Rule, Ruleset, ConfigValue, PermissionConfig } from "./types.ts";
import { homedir } from "os";

// ── Config normalization ────────────────────────────────────────────

/**
 * Normalize a shorthand config value into an array of canonical rules.
 *
 * Handles:
 * - Flat action string: `"bash": "allow"` -> `[{ permission: "bash", pattern: "*", action: "allow" }]`
 * - Nested patterns: `"bash": { "git *": "ask" }` -> `[{ permission: "bash", pattern: "git *", action: "ask" }]`
 * - Deeply nested: `"path": { "*.env": "deny" }` -> `[{ permission: "path", pattern: "*.env", action: "deny" }]`
 *
 * @param permission - The permission domain key.
 * @param value - The config value (string or nested object).
 * @param parentPermission - Internal use for recursive calls (accumulates permission path).
 * @returns Normalized array of rules.
 */
/**
 * Expand ~/, ~, $HOME/ in patterns (OpenCode parity).
 */
export function expandPattern(pattern: string): string {
   const home = homedir();
   if (pattern.startsWith("~/")) return home + pattern.slice(1);
   if (pattern === "~") return home;
   if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
   if (pattern === "$HOME") return home;
   return pattern;
}

export function normalizeConfigValue(permission: string, value: ConfigValue, parentPermission?: string): Rule[] {
   const fullPermission = parentPermission ? `${parentPermission}.${permission}` : permission;

   if (typeof value === "string") {
      return [{ permission: fullPermission, pattern: "*", action: value as Action }];
   }

   const rules: Rule[] = [];
   for (const [key, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue === "string") {
         rules.push({ permission: fullPermission, pattern: expandPattern(key), action: nestedValue as Action });
      } else {
         rules.push(...normalizeConfigValue(key, nestedValue, fullPermission));
      }
   }

   return rules;
}

/**
 * Normalize a full permission config object into a flat ruleset.
 *
 * @param config - The permission config block from config.json.
 * @returns Flat, ordered ruleset.
 */
export function normalizeConfig(config: PermissionConfig): Ruleset {
   const rules: Rule[] = [];

   for (const [key, value] of Object.entries(config)) {
      rules.push(...normalizeConfigValue(key, value));
   }

   return rules;
}

// ── Merge strategies ────────────────────────────────────────────────

/**
 * Merge multiple rulesets preserving deterministic order.
 *
 * Precedence (last match wins in the merged array):
 * 1. Base config rules (lowest priority)
 * 2. Session/agent override rules
 * 3. Persisted approval rules (highest priority)
 *
 * @param sources - Ordered array of rulesets to merge, lowest to highest priority.
 * @returns Merged ruleset preserving all rules in precedence order.
 */
export function mergeRulesets(...sources: Ruleset[]): Ruleset {
   return sources.flat();
}

/**
 * Merge config rules with session overrides and persisted approvals.
 *
 * @param configRules - Rules from normalized config.
 * @param sessionOverrides - Rules from session/agent overrides (may be empty).
 * @param persistedApprovals - Rules from persisted "always" approvals (may be empty).
 * @returns Merged ruleset ready for evaluation.
 */
export function mergeAllRulesets(
   configRules: Ruleset,
   sessionOverrides: Ruleset,
   persistedApprovals: Ruleset
): Ruleset {
   return mergeRulesets(configRules, sessionOverrides, persistedApprovals);
}

// ── Deduplication ───────────────────────────────────────────────────

/**
 * Deduplicate rules keeping the last occurrence of each (permission, pattern) pair.
 * Useful for cleaning up persisted approvals that may overlap with config rules.
 *
 * @param rules - Input ruleset that may contain duplicates.
 * @returns Deduplicated ruleset preserving last-match semantics.
 */
export function deduplicateRules(rules: Ruleset): Ruleset {
   const seen = new Map<string, Rule>();

   for (const rule of rules) {
      const key = `${rule.permission}\0${rule.pattern}`;
      seen.set(key, rule);
   }

   return Array.from(seen.values());
}
