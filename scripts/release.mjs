#!/usr/bin/env node

/**
 * Per-package release script for pi-packages.
 *
 * Usage:
 *   node scripts/release.mjs <package> <major|minor|patch>
 *   node scripts/release.mjs <package> <x.y.z>
 *
 * Before running:
 *   1. Draft [Unreleased] entries in packages/<pkg>/CHANGELOG.md
 *   2. Commit or stash any uncommitted changes
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const PKG = process.argv[2];
const TARGET = process.argv[3];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!PKG || !TARGET || (!BUMP_TYPES.has(TARGET) && !SEMVER_RE.test(TARGET))) {
   console.error("Usage: node scripts/release.mjs <package> <major|minor|patch|x.y.z>");
   console.error("  e.g.  node scripts/release.mjs pi-station patch");
   process.exit(1);
}

const PKG_DIR = join(PACKAGES_DIR, PKG);
const PKG_JSON_PATH = join(PKG_DIR, "package.json");
const CHANGELOG_PATH = join(PKG_DIR, "CHANGELOG.md");

if (!existsSync(PKG_JSON_PATH)) {
   console.error(`Error: package not found: ${PKG}`);
   process.exit(1);
}

function shouldUseShell(command) {
   return process.platform === "win32" && command === "pnpm";
}

function quoteShellArg(arg) {
   return `"${arg.replaceAll('"', '\\"')}"`;
}

function run(command, args, opts = {}) {
   console.log(`  $ ${[command, ...args].join(" ")}`);
   const useShell = shouldUseShell(command);
   const result = useShell
      ? spawnSync(`${command} ${args.map(quoteShellArg).join(" ")}`, {
           cwd: opts.cwd ?? ROOT,
           encoding: "utf8",
           shell: true,
           stdio: opts.silent ? "pipe" : "inherit"
        })
      : spawnSync(command, args, {
           cwd: opts.cwd ?? ROOT,
           encoding: "utf8",
           stdio: opts.silent ? "pipe" : "inherit"
        });
   if (result.status !== 0 && !opts.ignoreError) {
      console.error(`Command failed: ${[command, ...args].join(" ")}`);
      if (result.error) {
         console.error(result.error.message);
      }
      process.exit(result.status ?? 1);
   }
   return result.stdout ?? "";
}

function getVersion() {
   return JSON.parse(readFileSync(PKG_JSON_PATH, "utf8")).version;
}

function compareVersions(a, b) {
   const aParts = a.split(".").map(Number);
   const bParts = b.split(".").map(Number);
   for (let i = 0; i < 3; i++) {
      const diff = (aParts[i] || 0) - (bParts[i] || 0);
      if (diff !== 0) {
         return diff;
      }
   }
   return 0;
}

function stageChangedFiles() {
   const output = run("git", ["ls-files", "-m", "-o", "-d", "--exclude-standard"], { silent: true });
   const paths = [
      ...new Set(
         output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
      )
   ];
   if (paths.length === 0) {
      return;
   }
   run("git", ["add", "--", ...paths]);
}

function validateChangelog() {
   if (!existsSync(CHANGELOG_PATH)) {
      console.error(`Error: missing changelog: packages/${PKG}/CHANGELOG.md`);
      process.exit(1);
   }

   const content = readFileSync(CHANGELOG_PATH, "utf8");
   const unreleasedMatch = content.match(/^## \[Unreleased\]\s*$(?<body>[\s\S]*?)(?=^## \[|$(?![\s\S]))/m);
   if (!unreleasedMatch?.groups) {
      console.error(`Error: packages/${PKG}/CHANGELOG.md must contain ## [Unreleased]`);
      process.exit(1);
   }

   if (!/^\s*-\s+\S/m.test(unreleasedMatch.groups.body)) {
      console.warn(`Warning: packages/${PKG}/CHANGELOG.md [Unreleased] has no bullet entries.`);
   }
}

console.log(`\n=== Release: ${PKG} ===\n`);

console.log("Checking for uncommitted changes...");
const status = run("git", ["status", "--porcelain"], { silent: true });
if (status.trim()) {
   console.error("Error: uncommitted changes detected. Commit or stash first.");
   console.error(status);
   process.exit(1);
}
console.log("  Clean\n");

console.log("Validating changelog...");
validateChangelog();
console.log("  Changelog valid\n");

console.log("Running pre-release gates...");
run("pnpm", ["check"]);
run("pnpm", ["test"]);
run("pnpm", ["coverage"]);
run("pnpm", ["--dir", join("packages", PKG), "pack", "--dry-run"]);
console.log("  Gates pass\n");

const OLD_VERSION = getVersion();
const newVersion = (() => {
   if (BUMP_TYPES.has(TARGET)) {
      console.log(`Bumping ${TARGET}...`);
      run("pnpm", ["--filter", PKG, "version", TARGET, "--no-git-checks", "--no-commit-hooks"]);
      return getVersion();
   }
   if (compareVersions(TARGET, OLD_VERSION) <= 0) {
      console.error(`Error: version ${TARGET} must be > current ${OLD_VERSION}`);
      process.exit(1);
   }
   console.log(`Setting version ${TARGET}...`);
   run("pnpm", ["--filter", PKG, "version", TARGET, "--no-git-checks", "--no-commit-hooks"]);
   return getVersion();
})();

console.log(`  ${OLD_VERSION} → ${newVersion}\n`);

const DATE = new Date().toISOString().split("T")[0];
const changelog = readFileSync(CHANGELOG_PATH, "utf8");
writeFileSync(CHANGELOG_PATH, changelog.replace("## [Unreleased]", `## [${newVersion}] - ${DATE}`));
console.log("  CHANGELOG promoted\n");

const releaseTag = `${PKG}@${newVersion}`;

console.log("Committing and tagging...");
stageChangedFiles();
run("git", ["commit", "-m", `chore: release ${PKG} ${newVersion}`]);
run("git", ["tag", releaseTag]);
console.log("  Done\n");

const promotedChangelog = readFileSync(CHANGELOG_PATH, "utf8");
writeFileSync(CHANGELOG_PATH, promotedChangelog.replace(/^(## \[)/m, "## [Unreleased]\n\n$1"));
console.log("Re-instated [Unreleased] section...\n");

console.log("Committing changelog reset...");
stageChangedFiles();
run("git", ["commit", "-m", `chore: add [Unreleased] section for ${PKG}`]);
console.log("  Done\n");

console.log("Pushing to origin...");
run("git", ["push", "origin", "main", releaseTag]);
console.log("  Done\n");

console.log(`=== Released ${PKG} ${newVersion} ===`);
console.log("Run 'bash publish.sh <package>' to trigger npm publish via GitHub Actions.");
