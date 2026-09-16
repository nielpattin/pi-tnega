import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("compiled package layout", () => {
  it("uses dist artifacts with pnpm scripts", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      main?: string;
      types?: string;
      exports?: Record<string, { import?: string; types?: string }>;
      files?: string[];
      packageManager?: string;
      pi?: { extensions?: string[] };
      scripts?: Record<string, string>;
    };

    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(packageJson.pi?.extensions).toEqual(["./dist/index.js"]);
    expect(packageJson.files).toContain("dist/");
    expect(packageJson.files).not.toContain("src/");
    expect(packageJson.packageManager).toMatch(/^pnpm@/);
    expect(Object.values(packageJson.scripts ?? {}).join("\n")).not.toMatch(/\bbun\b/);
    expect(fs.existsSync("pnpm-lock.yaml")).toBe(true);
    expect(fs.existsSync("bun.lock")).toBe(false);
    const buildConfig = JSON.parse(fs.readFileSync("tsconfig.build.json", "utf8")) as {
      compilerOptions?: { noEmit?: boolean };
    };

    expect(buildConfig.compilerOptions?.noEmit).toBe(false);
    expect(fs.existsSync("scripts/test-dirty.mjs")).toBe(true);
    expect(fs.existsSync("scripts/test-dirty.ts")).toBe(false);
  });
});
