import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckRaftCode } from "../src/runtime/type-checker.js";

const check = (code: string) => typeCheckRaftCode(code, GUEST_TYPE_DECLARATIONS);

describe("raft action argument strictness", () => {
  it("catches an unknown property before dispatch", () => {
    const code = 'const r = await memory.expand({ ref: "test" });';
    const checked = check(code);
    expect(checked.errors.length).toBeGreaterThan(0);
  });

  it("catches a missing required argument before dispatch", () => {
    const code = "const r = await memory.expand({});";
    const checked = check(code);
    expect(checked.errors.length).toBeGreaterThan(0);
  });

  it("catches a non-object argument before dispatch", () => {
    expect(check('const r = await memory.expand("abc");').errors.length).toBeGreaterThan(0);
  });

  it("catches a wrong value type before dispatch", () => {
    expect(check("const r = await memory.expand({ session: 5 });").errors.length).toBeGreaterThan(
      0,
    );
  });
});
