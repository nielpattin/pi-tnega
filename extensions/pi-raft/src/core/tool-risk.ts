import type { RaftRisk } from "../protocol.js";

const RAFT_RISKS = new Set<RaftRisk>(["read", "write", "execute", "network", "agent"]);

export const isRaftRisk = (value: unknown): value is RaftRisk =>
  typeof value === "string" && RAFT_RISKS.has(value as RaftRisk);

/**
 * Canonical exact-ref shape for a tool risk override: `provider.action` on a
 * single line. Rejects whitespace and `=`, which the settings add-flow uses as
 * its ref/class separator.
 */
export const normalizeToolRiskRef = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const ref = value.trim();
  if (ref.length === 0 || ref.length > 256 || /\s/.test(ref) || ref.includes("=")) {
    return undefined;
  }
  const separator = ref.indexOf(".");
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return ref;
};

/**
 * Built-in class per Pi core tool. Pi exposes no risk metadata for tools, so
 * this table is the only declaration that exists for `pi.*` refs.
 */
const PI_CORE_TOOL_RISKS: Readonly<Record<string, RaftRisk>> = {
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  write: "write",
  edit: "write",
  bash: "execute",
  powershell: "execute",
};

/**
 * Class for refs with no declaration of their own. Extension tools and MCP
 * actions ship none, and `execute` is the class whose default policy is the
 * most restrictive, so guessing a weaker class would silently widen access.
 */
export const RAFT_FALLBACK_RISK: RaftRisk = "execute";

export const defaultToolRisk = (ref: string): RaftRisk => {
  const separator = ref.indexOf(".");
  const provider = separator === -1 ? ref : ref.slice(0, separator);
  const name = separator === -1 ? "" : ref.slice(separator + 1);
  return provider === "pi" ? (PI_CORE_TOOL_RISKS[name] ?? RAFT_FALLBACK_RISK) : RAFT_FALLBACK_RISK;
};
export const resolveToolRisk = (
  ref: string,
  declaredRisk: RaftRisk,
  overrides: Readonly<Record<string, RaftRisk>>,
): RaftRisk => {
  const override = Object.hasOwn(overrides, ref) ? overrides[ref] : undefined;
  return isRaftRisk(override) ? override : declaredRisk;
};
