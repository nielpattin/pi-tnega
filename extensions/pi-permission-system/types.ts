/** Permission system types, schemas, and validation helpers. */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ── Core enums ──────────────────────────────────────────────────────

export const ActionSchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]);
export type Action = Static<typeof ActionSchema>;

// ── Rule model ──────────────────────────────────────────────────────

export const RuleSchema = Type.Object({
   /** Permission domain key (e.g. "bash", "edit", "read", "external_directory", "*" for global). */
   permission: Type.String(),
   /** Glob pattern matched against the tool-specific target (command, file path, etc.). */
   pattern: Type.String(),
   /** Action to take when this rule matches. */
   action: ActionSchema
});
export type Rule = Static<typeof RuleSchema>;

export type Ruleset = Rule[];

// ── Request / Reply payloads ────────────────────────────────────────

export interface PermissionRequest {
   /** Unique request identifier. */
   id: string;
   /** Session that owns this request. */
   sessionId: string;
   /** Permission domain (e.g. "bash", "edit", "read"). */
   permission: string;
   /** Patterns to evaluate against the ruleset. */
   patterns: string[];
   /** Tool-specific metadata (command, diff, file paths, etc.). */
   metadata: Record<string, unknown>;
   /** Timestamp when the request was created. */
   createdAt: number;
}

export interface PermissionReply {
   /** Request id being replied to. */
   requestId: string;
   /** Reply decision. */
   decision: "once" | "always" | "reject";
   /** Optional human-readable rejection message. */
   message?: string;
}

export interface PermissionEvent {
   type: "permission-requested" | "permission-resolved";
   request: PermissionRequest;
   action?: Action;
   reply?: PermissionReply;
}

// ── Config shorthand types ──────────────────────────────────────────

/** A config value can be a flat action string or a nested object of patterns. */
export type ConfigValue = Action | { [key: string]: ConfigValue };

/** Normalized config permission block. */
export interface PermissionConfig {
   [key: string]: ConfigValue;
}

// ── Validation helpers ──────────────────────────────────────────────

export function isValidAction(value: unknown): value is Action {
   return Value.Check(ActionSchema, value);
}

export function isValidRule(value: unknown): value is Rule {
   return Value.Check(RuleSchema, value);
}

export function isValidRuleset(value: unknown): value is Ruleset {
   if (!Array.isArray(value)) return false;
   return value.every(isValidRule);
}

/** Validate and return a parsed rule, or throw on invalid input. */
export function parseRule(input: unknown): Rule {
   if (!isValidRule(input)) {
      throw new Error(`Invalid rule: ${JSON.stringify(input)}`);
   }
   return input;
}

/** Validate and return a parsed ruleset, or throw on invalid input. */
export function parseRuleset(input: unknown): Ruleset {
   if (!isValidRuleset(input)) {
      throw new Error(`Invalid ruleset: ${JSON.stringify(input)}`);
   }
   return input;
}

// ── ID generation ───────────────────────────────────────────────────

let requestCounter = 0;

/** Generate a unique permission request ID. */
export function generateRequestId(): string {
   return `perm-${Date.now()}-${++requestCounter}`;
}
