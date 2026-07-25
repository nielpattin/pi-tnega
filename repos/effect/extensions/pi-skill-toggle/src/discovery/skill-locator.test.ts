import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, dirname, basename } from "node:path";
import type { FileSystem } from "../ports/fs.ts";
import { DefaultSkillLocator } from "./skill-locator.ts";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

describe("DefaultSkillLocator", () => {
  beforeEach(() => {
    const testHome = resolve("/home/tester");
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    process.env.PI_CODING_AGENT_DIR = resolve("/home/tester/.pi/agent");
  });

  afterEach(() => {
    restoreEnv("HOME", ORIGINAL_HOME);
    restoreEnv("USERPROFILE", ORIGINAL_USERPROFILE);
    restoreEnv("PI_CODING_AGENT_DIR", ORIGINAL_PI_CODING_AGENT_DIR);
  });

  it("finds global, user, and project skills with Pi root markdown discovery rules", async () => {
    const fs = new MemoryTreeFileSystem([
      "/home/tester/.pi/agent/skills/user-root.md",
      "/home/tester/.agents/skills/ignored-global-root.md",
      "/home/tester/.agents/skills/global-skill/SKILL.md",
      "/repo/.pi/skills/project-root.md",
      "/repo/.agents/skills/ignored-project-legacy-root.md",
      "/repo/.agents/skills/project-legacy-skill/SKILL.md",
    ]);
    const locator = new DefaultSkillLocator(fs);

    const repoPath = resolve("/repo");
    const files = await locator.findSkillFiles(repoPath);
    const byPath = new Map(files.map((file) => [file.filePath, file]));

    assert.equal(byPath.get(resolve("/home/tester/.pi/agent/skills/user-root.md"))?.source.kind, "user");
    assert.equal(byPath.get(resolve("/home/tester/.agents/skills/global-skill/SKILL.md"))?.source.kind, "global");
    assert.equal(byPath.get(resolve("/repo/.pi/skills/project-root.md"))?.source.kind, "project");
    assert.equal(byPath.get(resolve("/repo/.agents/skills/project-legacy-skill/SKILL.md"))?.source.kind, "project-legacy");
    assert.equal(byPath.has(resolve("/home/tester/.agents/skills/ignored-global-root.md")), false);
    assert.equal(byPath.has(resolve("/repo/.agents/skills/ignored-project-legacy-root.md")), false);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

class MemoryTreeFileSystem implements FileSystem {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>([resolve("/")]);

  constructor(paths: string[]) {
    for (const path of paths) this.addFile(path);
  }

  async readFile(path: string): Promise<string> {
    const p = resolve(path);
    if (!this.files.has(p)) throw new Error(`missing file: ${p}`);
    return "---\nname: test\ndescription: Test skill.\n---\n";
  }

  async writeFileAtomic(): Promise<void> {}

  async access(path: string): Promise<boolean> {
    const p = resolve(path);
    return this.files.has(p) || this.dirs.has(p);
  }

  async readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>> {
    const p = resolve(path);
    if (!this.dirs.has(p)) throw new Error(`missing dir: ${p}`);
    const names = new Set<string>();
    for (const dir of this.dirs) {
      if (dir === p) continue;
      if (dirname(dir) === p) {
        names.add(basename(dir));
      }
    }
    for (const file of this.files) {
      if (dirname(file) === p) {
        names.add(basename(file));
      }
    }
    return [...names].sort().map((name) => {
      const fullPath = join(p, name);
      return {
        name,
        isDirectory: this.dirs.has(fullPath),
        isFile: this.files.has(fullPath),
        isSymbolicLink: false,
      };
    });
  }

  async stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; mode: number }> {
    const p = resolve(path);
    return { isDirectory: this.dirs.has(p), isFile: this.files.has(p), mode: 0o644 };
  }

  private addFile(path: string): void {
    const p = resolve(path);
    this.files.add(p);
    let current = dirname(p);
    while (current && !this.dirs.has(current)) {
      this.dirs.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}
