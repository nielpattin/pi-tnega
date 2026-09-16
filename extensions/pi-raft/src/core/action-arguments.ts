import { Value } from "typebox/value";
import { truncateString } from "./action-result.js";

const MAX_VALIDATION_MESSAGE_CHARS = 2_000;

// TypeBox reports additionalProperties failures against the object root
// without naming the offending keys; name them so a rejected near-miss call
// is actionable (e.g. a before/after guess on memory.expand surfaces as
// "/before: must not have additional properties").
const unexpectedKeys = (
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] => {
  if ((schema as { type?: unknown }).type !== "object") return [];
  if ((schema as { additionalProperties?: unknown }).additionalProperties !== false) return [];
  if ((schema as { patternProperties?: unknown }).patternProperties !== undefined) return [];
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties) return [];
  return Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
};

export const validationMessage = (
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): string | undefined => {
  try {
    if (Value.Check(schema, value)) return undefined;
    const messages = [...Value.Errors(schema, value)].slice(0, 5).map((error) => {
      // Prefix nested failures with their property path.
      const at = (error as { path?: unknown }).path;
      return typeof at === "string" && at !== "" && at !== "/"
        ? `${at}: ${error.message}`
        : error.message;
    });
    for (const key of unexpectedKeys(schema, value).slice(0, 5)) {
      messages.push(`/${key}: must not have additional properties`);
    }
    return truncateString(
      messages.join("; ") || "Schema validation failed",
      MAX_VALIDATION_MESSAGE_CHARS,
    );
  } catch {
    return "Schema validator failed";
  }
};

export const repairCatalogInput = (
  _ref: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; observedUnexpected: string | undefined } => {
  const extras = unexpectedKeys(schema, args).sort();
  const observedUnexpected = extras.length > 0 ? extras.join("\0") : undefined;
  return { args, observedUnexpected };
};

export const validateCatalogArgs = (
  _ref: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
  _observedUnexpected?: string,
): { args: Record<string, unknown>; invalid?: string } => {
  const invalid = validationMessage(schema, args);
  return invalid === undefined ? { args } : { args, invalid };
};
