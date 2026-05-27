/**
 * Persistence layer for approved "always" rules.
 *
 * Stores approved rules in a JSON file so they survive restarts.
 * Also provides config normalization for shorthand forms.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { Rule, Ruleset, PermissionConfig, ConfigValue } from "./types.ts";
import { normalizeConfig } from "./merge.ts";

// ── Storage paths ───────────────────────────────────────────────────

const STORAGE_DIR = join(homedir(), ".pi/agent/permissions");
const APPROVED_RULES_PATH = join(STORAGE_DIR, "approved-rules.json");

// ── Approved rules persistence ──────────────────────────────────────

/**
 * Load persisted approved rules from storage.
 * Returns empty array if no persisted rules exist.
 */
export function loadApprovedRules(): Ruleset {
   if (!existsSync(APPROVED_RULES_PATH)) {
      return [];
   }

   try {
      const raw = readFileSync(APPROVED_RULES_PATH, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
         return [];
      }

      // Validate each rule has required fields
      return parsed.filter(
         (r): r is Rule =>
            typeof r === "object" &&
            r !== null &&
            typeof (r as Rule).permission === "string" &&
            typeof (r as Rule).pattern === "string" &&
            ((r as Rule).action === "allow" || (r as Rule).action === "ask" || (r as Rule).action === "deny")
      );
   } catch {
      return [];
   }
}

/**
 * Persist approved rules to storage.
 */
export function saveApprovedRules(rules: Ruleset): void {
   const dir = dirname(APPROVED_RULES_PATH);
   if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
   }

   writeFileSync(APPROVED_RULES_PATH, JSON.stringify(rules, null, 2), "utf-8");
}

/**
 * Add new approved rules to existing persisted rules.
 * Deduplicates by (permission, pattern) key, keeping the latest.
 */
export function appendApprovedRules(newRules: Rule[]): void {
   const existing = loadApprovedRules();
   const merged = [...existing, ...newRules];

   // Deduplicate keeping last occurrence
   const seen = new Map<string, Rule>();
   for (const rule of merged) {
      const key = `${rule.permission}\0${rule.pattern}`;
      seen.set(key, rule);
   }

   saveApprovedRules(Array.from(seen.values()));
}

/**
 * Clear all persisted approved rules.
 */
export function clearApprovedRules(): void {
   if (existsSync(APPROVED_RULES_PATH)) {
      writeFileSync(APPROVED_RULES_PATH, "[]", "utf-8");
   }
}

// ── Config loading ──────────────────────────────────────────────────

/**
 * Load and normalize the permission config from the extension's config.json.
 *
 * @param configPath - Path to the config.json file.
 * @returns Normalized ruleset from config, or empty array if file doesn't exist.
 */
export function loadConfigRules(configPath: string): Ruleset {
   if (!existsSync(configPath)) {
      return [];
   }

   try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
         return [];
      }

      const config = parsed as Record<string, unknown>;

      // Extract the "permission" block from config
      const permissionBlock = config.permission;
      if (typeof permissionBlock !== "object" || permissionBlock === null) {
         return [];
      }

      return normalizeConfig(permissionBlock as PermissionConfig);
   } catch {
      return [];
   }
}

/**
 * Normalize a permission config value from shorthand to canonical rules.
 *
 * Handles:
 * - `"bash": "allow"` -> flat wildcard rule
 * - `"bash": { "git *": "ask" }` -> pattern rules
 * - Deeply nested structures
 *
 * @param key - The top-level permission key.
 * @param value - The config value (string or nested object).
 * @returns Normalized rules.
 */
export function normalizeShorthand(key: string, value: ConfigValue): Ruleset {
   if (typeof value === "string") {
      return [{ permission: key, pattern: "*", action: value as import("./types.ts").Action }];
   }

   const rules: Rule[] = [];
   for (const [pattern, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue === "string") {
         rules.push({ permission: key, pattern, action: nestedValue as import("./types.ts").Action });
      } else {
         // Deep nesting - recurse with dotted permission
         rules.push(...normalizeShorthand(`${key}.${pattern}`, nestedValue));
      }
   }

   return rules;
}
