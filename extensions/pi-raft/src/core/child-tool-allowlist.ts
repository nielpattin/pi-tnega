/** Worker-owned optional-tool allowlist; absence leaves the host unrestricted. */
const parseChildToolAllowlist = (raw: string | undefined): ReadonlySet<string> | undefined => {
  if (raw === undefined) return undefined;
  try {
    const names: unknown = JSON.parse(raw);
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) {
      return new Set(names.filter((name) => name !== "raft_exec"));
    }
  } catch {
    // Malformed inherited authority must fail closed, never widen the surface.
  }
  return new Set();
};

export function readChildToolAllowlist(
  raw = process.env.PI_RAFT_TOOL_ALLOWLIST,
): ReadonlySet<string> | undefined {
  return parseChildToolAllowlist(raw);
}
