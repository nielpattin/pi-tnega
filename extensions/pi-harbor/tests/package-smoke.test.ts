import { describe, it, expect } from "vitest";
import packageJson from "../package.json";

describe("Package Smoke Test", () => {
  it("has valid manifest pi.extensions declaration", () => {
    expect(packageJson.name).toBe("@nielpattin/pi-harbor");
    expect(packageJson.pi).toBeDefined();
    expect(packageJson.pi.extensions).toEqual(["./index.ts"]);
  });

  it("exports a valid extension entry point", async () => {
    const entry = await import("../index.js");
    expect(entry.default).toBeDefined();
  });
});
