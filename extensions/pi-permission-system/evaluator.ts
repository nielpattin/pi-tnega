/**
 * Permission evaluator with wildcard matching and last-match-wins semantics.
 *
 * Pure, stateless module: given a ruleset and a permission+pattern pair,
 * returns the resolved action.
 */

import type { Action, Rule, Ruleset } from "./types.ts";

// ── Wildcard matching ───────────────────────────────────────────────

/**
 * Test whether `value` matches a glob-like `pattern`.
 *
 * Supported wildcards:
 * - `*` matches any sequence of characters (including path separators)
 * - `**` matches any sequence including separators (same as *)
 * - `?` matches exactly one character
 *
 * For simplicity and OpenCode parity, `*` matches any character sequence.
 */
export function matchesWildcard(pattern: string, value: string): boolean {
   // Normalize backslashes to forward slashes (OpenCode parity)
   const normalizedInput = value.replaceAll("\\", "/");
   let escaped = pattern
      .replaceAll("\\", "/")
      // Escape regex special chars (except * and ?)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      // Handle ** and * (both match any sequence of characters)
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, ".*")
      // Handle ? (single character)
      .replace(/\?/g, ".");

   // "git *" should also match bare "git" (optional space+args)
   if (escaped.endsWith(" .*")) {
      escaped = escaped.slice(0, -3) + "( .*)?";
   }

   const regex = new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s");
   return regex.test(normalizedInput);
}

// ── Rule matching ───────────────────────────────────────────────────

/**
 * Check if a rule matches the given permission domain and target value.
 * Supports wildcard matching on both `permission` and `pattern` fields.
 */
export function ruleMatches(rule: Rule, permission: string, value: string): boolean {
   const permissionMatch = matchesWildcard(rule.permission, permission);
   if (!permissionMatch) return false;
   return matchesWildcard(rule.pattern, value);
}

// ── Evaluator ───────────────────────────────────────────────────────

/** Default action when no rules match. */
const DEFAULT_ACTION: Action = "ask";

/**
 * Evaluate a permission request against a ruleset.
 *
 * Uses last-match-wins semantics: the last rule in the array that matches
 * determines the action. If no rule matches, returns "ask".
 *
 * @param ruleset - Ordered array of rules to evaluate against.
 * @param permission - Permission domain being checked (e.g. "bash", "edit").
 * @param value - Target value to match against rule patterns (e.g. command string, file path).
 * @returns The resolved action.
 */
export function evaluate(ruleset: Ruleset, permission: string, value: string): Action {
   let result: Action = DEFAULT_ACTION;

   for (const rule of ruleset) {
      if (ruleMatches(rule, permission, value)) {
         result = rule.action;
      }
   }

   return result;
}

/**
 * Evaluate multiple patterns against a ruleset.
 *
 * Returns the most restrictive action across all patterns:
 * - If any pattern resolves to "deny", returns "deny".
 * - If any pattern resolves to "ask", returns "ask".
 * - Only returns "allow" if all patterns resolve to "allow".
 *
 * @param ruleset - Ordered array of rules.
 * @param permission - Permission domain.
 * @param patterns - Array of target values to evaluate.
 * @returns The most restrictive resolved action.
 */
export function evaluatePatterns(ruleset: Ruleset, permission: string, patterns: string[]): Action {
   let result: Action = DEFAULT_ACTION;

   for (const rule of ruleset) {
      const permissionMatch = matchesWildcard(rule.permission, permission);
      if (!permissionMatch) continue;
      const patternMatch = patterns.some((pattern) => matchesWildcard(rule.pattern, pattern));
      if (patternMatch) result = rule.action;
   }

   return result;
}

/**
 * Check if a tool is completely disabled (pattern "*" with action "deny").
 * OpenCode parity: used to hide/disable tools from the tool list.
 *
 * @param tools - List of tool names to check.
 * @param ruleset - The ruleset to evaluate against.
 * @returns Set of tool names that are disabled.
 */
export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
   const EDIT_TOOLS = ["edit", "write", "apply_patch"];
   return new Set(
      tools.filter((tool) => {
         const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool;
         const rule = [...ruleset].reverse().find((r) => matchesWildcard(r.permission, permission));
         return rule?.pattern === "*" && rule.action === "deny";
      })
   );
}
