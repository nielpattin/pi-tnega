import { afterEach, describe, expect, it, vi } from "vitest";
import { readChildToolAllowlist } from "../src/core/child-tool-allowlist.js";

afterEach(() => vi.unstubAllEnvs());

describe("child optional tool allowlist", () => {
  it("leaves the host unrestricted and fails closed for malformed inherited authority", () => {
    vi.stubEnv("PI_RAFT_TOOL_ALLOWLIST", undefined);
    expect(readChildToolAllowlist()).toBeUndefined();
    for (const value of ["", "null", "{}", "not json", '["read", 1]']) {
      expect([...readChildToolAllowlist(value)!]).toEqual([]);
    }
    expect([...readChildToolAllowlist('["read", "raft_exec"]')!]).toEqual(["read"]);
  });
});
