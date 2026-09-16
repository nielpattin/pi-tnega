import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const raftRoot = process.cwd();
const projectRoot = path.resolve(raftRoot, "../..");
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const readText = (file: string) => fs.readFileSync(file, "utf8");

describe("Raft workspace configuration", () => {
  it("uses the monorepo base TypeScript configuration", () => {
    const config = readJson(path.join(raftRoot, "tsconfig.json"));

    expect(config.extends).toBe("../../tsconfig.base.json");
  });

  it("is covered by the root lint and format configurations", () => {
    const lint = readText(path.join(projectRoot, "oxlint.config.ts"));
    const format = readText(path.join(projectRoot, "oxfmt.config.ts"));

    expect(lint).not.toContain('"pi-raft/**"');
    expect(format).not.toContain('"pi-raft/**"');
  });

  it("passes Raft through the root lint and format commands", () => {
    const scripts = readJson(path.join(projectRoot, "package.json")).scripts as Record<
      string,
      string
    >;

    // Both commands scan the repository root; the extension needs no dedicated
    // path argument because the root configs keep it unignored.
    const rootTargets = (script: string | undefined): string[] =>
      (script ?? "")
        .replace(/-c\s+\S+/, "")
        .trim()
        .split(/\s+/)
        .slice(1);

    expect(rootTargets(scripts.lint)).toEqual(["."]);
    expect(rootTargets(scripts.fmt)).toEqual(["."]);
  });

  it("is discovered by the pnpm workspace", () => {
    expect(readText(path.join(projectRoot, "pnpm-workspace.yaml"))).toContain('  - "extensions/*"');
  });
});
