import { describe, expect, it } from "vitest";
import {
  CHILD_CORE_TOOLS,
  childToolPickerCandidates,
  extensionToolCandidates,
  shadowedCoreTools,
  isChildToolEnabled,
  resolveChildTools,
  selectionFromChecked,
} from "../src/agents/child-tools.js";

describe("extensionToolCandidates", () => {
  it("drops core names and raft_exec, then sorts", () => {
    expect(
      extensionToolCandidates(["write", "pi-acks", "raft_exec", "browser", "pi-acks", ""]),
    ).toEqual(["browser", "pi-acks"]);
  });
});

describe("shadowedCoreTools", () => {
  it("keeps only extension names that shadow a core tool, sorted", () => {
    expect(shadowedCoreTools(["browser", "read", "read", "raft_exec", ""])).toEqual(["read"]);
  });
});
describe("childToolPickerCandidates", () => {
  it("lists core tools plus loaded extension tools and currently enabled extras", () => {
    expect(childToolPickerCandidates(["browser", "read"], ["gone-ext"])).toEqual([
      ...CHILD_CORE_TOOLS,
      "browser",
      "gone-ext",
    ]);
  });
});

describe("resolveChildTools", () => {
  it("uses the enable list as the allowlist", () => {
    expect(resolveChildTools({ defaultTools: ["read", "bash", "browser"] })).toEqual([
      "read",
      "bash",
      "browser",
    ]);
  });

  it("omits raft_exec from the enable list and appends it only when requested", () => {
    expect(
      resolveChildTools({ defaultTools: ["read", "raft_exec", "browser"], includeRaftExec: true }),
    ).toEqual(["read", "browser", "raft_exec"]);
  });

  it("enables loaded extension tools by default and honors exclusions", () => {
    expect(
      resolveChildTools({
        defaultTools: ["read"],
        extensionTools: ["browser", "bash", "raft_exec"],
        excludeTools: ["browser"],
      }),
    ).toEqual(["read", "bash"]);
  });

  it("checks extension tools by default in the picker", () => {
    expect(
      isChildToolEnabled("browser", ["browser"], { defaultTools: ["read"], excludeTools: [] }),
    ).toBe(true);
  });

  it("persists an unchecked extension tool as an exclusion", () => {
    const selection = selectionFromChecked(CHILD_CORE_TOOLS, ["browser"], {
      defaultTools: [...CHILD_CORE_TOOLS],
      excludeTools: [],
    });
    expect(selection.defaultTools).toEqual([...CHILD_CORE_TOOLS]);
    expect(selection.excludeTools).toEqual(["browser"]);
  });
  it("intersects with an inherited allowlist", () => {
    expect(
      resolveChildTools({
        defaultTools: ["read", "bash", "browser"],
        inheritedAllowlist: new Set(["read", "browser"]),
      }),
    ).toEqual(["read", "browser"]);
  });
});
