import { describe, it, expect } from "vitest";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

describe("gws-docs-task.mjs (smoke)", () => {
  const scriptPath = join(
    import.meta.dirname,
    "..",
    "..",
    "skills",
    "google-workspace",
    "scripts",
    "gws-docs-task.mjs",
  );

  it("script file exists and is valid JS", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("script has required command handlers", async () => {
    const content = await readFile(scriptPath, "utf8");
    expect(content).toContain('cmd === "get"');
    expect(content).toContain('cmd === "preview"');
    expect(content).toContain('cmd === "apply"');
    expect(content).toContain("GWS_TIMEOUT_MS");
    expect(content).toContain("setTimeout");
    expect(content).toContain("clearTimeout");
  });

  it("script has no credential handling code", async () => {
    const content = await readFile(scriptPath, "utf8");
    expect(content).not.toMatch(/refresh_token/);
    expect(content).not.toMatch(/client_secret/);
    expect(content).not.toMatch(/apiFetch/);
    expect(content).not.toMatch(/credentials\/default\.json/);
  });

  it("script passes Node syntax check", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("node", ["--check", scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("inspect-table.mjs (smoke)", () => {
  const scriptPath = join(
    import.meta.dirname,
    "..",
    "..",
    "skills",
    "google-workspace",
    "scripts",
    "inspect-table.mjs",
  );

  it("script file exists and is valid JS", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("script reads from JSON file, not API", async () => {
    const content = await readFile(scriptPath, "utf8");
    // Should read from a file, not call gws or fetch
    expect(content).not.toMatch(/refresh_token/);
    expect(content).not.toMatch(/client_secret/);
    expect(content).not.toMatch(/gws docs/);
    expect(content).not.toMatch(/apiFetch/);
    expect(content).toContain("readFile");
    expect(content).toContain("DOC_FILE");
  });

  it("script passes Node syntax check", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("node", ["--check", scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
