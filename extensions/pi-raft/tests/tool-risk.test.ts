import { describe, expect, it } from "vitest";
import { CHILD_CORE_TOOLS } from "../src/agents/child-tools.js";
import {
  RAFT_FALLBACK_RISK,
  defaultToolRisk,
  isRaftRisk,
  normalizeToolRiskRef,
  resolveToolRisk,
} from "../src/core/tool-risk.js";

describe("tool risk defaults", () => {
  const expected: Record<string, string> = {
    read: "read",
    grep: "read",
    find: "read",
    ls: "read",
    write: "write",
    edit: "write",
    bash: "execute",
    powershell: "execute",
  };

  it("declares a class for every grantable core tool", () => {
    // Drift guard: a core tool added without a class would silently fall back to
    // execute instead of the class it actually belongs to.
    expect(Object.keys(expected).sort()).toEqual([...CHILD_CORE_TOOLS].sort());
    for (const name of CHILD_CORE_TOOLS) {
      expect(defaultToolRisk(`pi.${name}`)).toBe(expected[name]);
    }
  });

  it("falls back to execute for refs that declare nothing", () => {
    expect(defaultToolRisk("extensions.browser")).toBe(RAFT_FALLBACK_RISK);
    expect(defaultToolRisk("mcp.github.search")).toBe(RAFT_FALLBACK_RISK);
    expect(defaultToolRisk("pi.unknown")).toBe(RAFT_FALLBACK_RISK);
    expect(defaultToolRisk("nonsense")).toBe(RAFT_FALLBACK_RISK);
    expect(RAFT_FALLBACK_RISK).toBe("execute");
  });

  it("lets an override win over the built-in class", () => {
    expect(resolveToolRisk("pi.read", defaultToolRisk("pi.read"), {})).toBe("read");
    expect(resolveToolRisk("pi.read", defaultToolRisk("pi.read"), { "pi.read": "network" })).toBe(
      "network",
    );
    expect(resolveToolRisk("extensions.browser", defaultToolRisk("extensions.browser"), {})).toBe(
      "execute",
    );
    expect(resolveToolRisk("pi.bash", "execute", { "pi.bash": "not-a-risk" as never })).toBe(
      "execute",
    );
  });

  it("keeps the ref shape the registry and overrides agree on", () => {
    expect(normalizeToolRiskRef(" mcp.github.search ")).toBe("mcp.github.search");
    expect(normalizeToolRiskRef("pi.read")).toBe("pi.read");
    expect(normalizeToolRiskRef("noseparator")).toBeUndefined();
    expect(normalizeToolRiskRef("trailing.")).toBeUndefined();
    expect(normalizeToolRiskRef(".leading")).toBeUndefined();
    expect(normalizeToolRiskRef("two words")).toBeUndefined();
    expect(normalizeToolRiskRef("a=b")).toBeUndefined();
    expect(normalizeToolRiskRef(7)).toBeUndefined();
    expect(isRaftRisk("agent")).toBe(true);
    expect(isRaftRisk("danger")).toBe(false);
  });
});
