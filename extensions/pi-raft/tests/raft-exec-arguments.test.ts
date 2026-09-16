import { describe, expect, it } from "vitest";
import { prepareRaftExecArguments } from "../src/raft-exec-arguments.js";

describe("prepareRaftExecArguments", () => {
  it("keeps canonical arguments unchanged", () => {
    const input = { code: "return 1;", tokenBudget: 10 };
    expect(prepareRaftExecArguments(input)).toBe(input);
    const withPayloads = { code: "return 1;", payloads: { body: "ok" } };
    expect(prepareRaftExecArguments(withPayloads)).toBe(withPayloads);
  });

  it("wraps a root code string before schema validation", () => {
    expect(prepareRaftExecArguments("return 1;")).toEqual({ code: "return 1;" });
  });

  it("joins all-string code arrays and leaves malformed arrays invalid", () => {
    expect(prepareRaftExecArguments({ code: ["const x = 1;", "return x;"] })).toEqual({
      code: "const x = 1;\nreturn x;",
    });
    const malformed = { code: ["return ", 1] };
    expect(prepareRaftExecArguments(malformed)).toBe(malformed);
  });

  it("omits null optional fields but preserves a null required code", () => {
    expect(
      prepareRaftExecArguments({
        code: null,
        payloads: null,
        strings: null,
        resultFormat: null,
        tokenBudget: null,
        agentBudget: undefined,
        display: null,
      }),
    ).toEqual({ code: null });
  });

  it("canonicalizes display shorthands before execution", () => {
    expect(prepareRaftExecArguments({ code: "return 1;", display: "Probe" })).toEqual({
      code: "return 1;",
      display: { name: "Probe" },
    });
    expect(
      prepareRaftExecArguments({
        code: "return 1;",
        display: '{"name":"Probe","description":"check"}',
      }),
    ).toEqual({ code: "return 1;", display: { name: "Probe", description: "check" } });
  });

  it("remaps the strings alias onto payloads", () => {
    expect(prepareRaftExecArguments({ code: "return π.body;", strings: { body: "ok" } })).toEqual({
      code: "return π.body;",
      payloads: { body: "ok" },
    });
    expect(
      prepareRaftExecArguments({
        code: "return π.body;",
        payloads: { body: "canonical" },
        strings: { body: "alias" },
      }),
    ).toEqual({ code: "return π.body;", payloads: { body: "canonical" } });
  });

  it("parses JSON-object payload maps before schema validation", () => {
    const payload = { lifecycle: "#!/bin/sh\n# inventory" };
    expect(
      prepareRaftExecArguments({ code: "return π.lifecycle;", payloads: JSON.stringify(payload) }),
    ).toEqual({ code: "return π.lifecycle;", payloads: payload });
    expect(
      prepareRaftExecArguments({
        code: "return π.body;",
        strings: JSON.stringify(JSON.stringify({ body: "ok" })),
      }),
    ).toEqual({ code: "return π.body;", payloads: { body: "ok" } });
  });

  it("leaves malformed payload maps invalid on the canonical key", () => {
    expect(prepareRaftExecArguments({ code: "return 1;", strings: "not-json" })).toEqual({
      code: "return 1;",
      payloads: "not-json",
    });
    expect(prepareRaftExecArguments({ code: "return 1;", payloads: '["lifecycle"]' })).toEqual({
      code: "return 1;",
      payloads: '["lifecycle"]',
    });
    expect(prepareRaftExecArguments({ code: "return 1;", strings: '{"n":1}' })).toEqual({
      code: "return 1;",
      payloads: '{"n":1}',
    });
  });
});
