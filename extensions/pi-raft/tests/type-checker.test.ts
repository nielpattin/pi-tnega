import { describe, expect, it } from "vitest";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { normalizeTypeScriptPath, typeCheckRaftCode } from "../src/runtime/type-checker.js";

describe("Raft guest type checker", () => {
  it("normalizes Windows paths for TypeScript compiler host comparisons", () => {
    expect(normalizeTypeScriptPath("C:\\work\\__pi_raft_guest_1.ts")).toBe(
      "C:/work/__pi_raft_guest_1.ts",
    );
  });

  it("accepts typed Raft code with top-level return", () => {
    const result = typeCheckRaftCode(
      'const result = await tools.call({ ref: "mcp.demo.echo", args: { value: "ok" } });\nreturn result;',
      guestTypeDeclarations(),
    );
    expect(result.errors).toEqual([]);
    expect(result.javascript).toContain("async function __piRaftMain()");
    expect(result.javascript).not.toContain("path: string");
  });

  it("types cwd through one-shot agents helpers", () => {
    const result = typeCheckRaftCode(
      'await agents.run({ task: "run elsewhere", cwd: "../other", recursive: true }); return "done";',
      guestTypeDeclarations(),
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts dynamic MCP namespaces and orchestration helpers", () => {
    const result = typeCheckRaftCode(
      `
const mcpResult = await mcp.context7.resolve_library_id({ libraryName: "react" });
const review = await agents.run({ task: "Review it", transport: "localterm" });
console.log(review.status);
return { mcpResult, review };
`,
      guestTypeDeclarations(),
    );
    expect(result.errors).toEqual([]);
  });

  it("rejects unknown memory arguments", () => {
    const result = typeCheckRaftCode(
      'return memory.expand({ session: "session-id", befroe: 2 });',
      guestTypeDeclarations(),
    );
    expect(result.errors.map((error) => error.message).join(" ")).toMatch(
      /befroe|known properties/i,
    );
  });

  it("accepts typed recall, expand, and tools.call providers", () => {
    const result = typeCheckRaftCode(
      'const recalled = await memory.recall({ query: "proxy" }); return await memory.expand({ session: "session-id", entryOffset: 0 });',
      guestTypeDeclarations(),
    );
    expect(result.errors).toEqual([]);
  });
  it("rejects misspelled first-class provider argument keys", () => {
    const result = typeCheckRaftCode(
      'return memory.recall({ qurey: "context pressure" });',
      guestTypeDeclarations(),
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/qurey|known properties/i);
  });

  it("names the accepted properties when a caller guesses an agent argument key", () => {
    const result = typeCheckRaftCode(
      'const h = await agents.spawn({ task: "t" });\nreturn agents.wait({ handle: h });',
      guestTypeDeclarations(),
    );
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toContain("does not exist in type 'RaftAgentTargetArgs'");
    expect(result.errors[0]?.message).toContain("Accepted properties: id, agentId, agent_id.");
  });

  it("leaves approximate core-tool surfaces free of accepted-property suffixes", () => {
    const result = typeCheckRaftCode(
      'return await tools.call({ ref: "mcp.demo.echo", nope: 1 });',
      guestTypeDeclarations(),
    );
    expect(result.errors.every((error) => !error.message.includes("Accepted properties"))).toBe(
      true,
    );
  });

  it("keeps first-class Raft providers typed in orchestration-only mode", () => {
    const declarations = guestTypeDeclarations();
    expect(declarations).not.toContain("declare const pi: PiToolsApi");
    expect(declarations).not.toContain("declare const extensions: RaftExtensionsApi");

    const result = typeCheckRaftCode(
      'const matches = await memory.recall({ query: "x" }); return { matches };',
      guestTypeDeclarations(),
    );
    expect(result.errors).toEqual([]);
  });

  it("excludes globals for unavailable providers", () => {
    const declarations = guestTypeDeclarations({ excludeGlobals: ["memory"] });
    expect(declarations).not.toContain("declare const memory: RaftMemoryApi;");
    expect(declarations).not.toContain("declare const pi: PiToolsApi;");
    expect(declarations).not.toContain("declare const extensions: RaftExtensionsApi;");

    const typed = typeCheckRaftCode('return memory.recall({ query: "x" });', declarations);
    expect(typed.errors.some((error) => /Cannot find name 'memory'/.test(error.message))).toBe(
      true,
    );
  });

  it("reports user-facing line numbers for functional errors", () => {
    // Wrong arg type (path: 42) is now deferred to runtime (functional-errors-only);
    // an undefined name is a genuine breakage still caught at type-check.
    const result = typeCheckRaftCode(
      'return await tools.call({ ref: "mcp.demo.echo", args: { value: missingFile } });',
      guestTypeDeclarations(),
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.line).toBe(1);
    expect(result.errors[0]?.message).toContain("Cannot find name");
  });
});
