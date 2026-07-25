#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const baseRef = process.argv[2] ?? "origin/main";

if (process.env.SKIP_HOOKS === "1" || process.env.SKIP_CHANGESET_CHECK === "1") {
   console.log("changeset check skipped");
   process.exit(0);
}

function git(args) {
   return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function changedFiles(ref) {
   try {
      git(["rev-parse", "--verify", ref]);
   } catch {
      console.warn(`changeset check skipped: base ref not found: ${ref}`);
      return [];
   }

   const mergeBase = git(["merge-base", ref, "HEAD"]);
   const output = git(["diff", "--name-only", `${mergeBase}...HEAD`]);
   return output ? output.split("\n") : [];
}

const files = changedFiles(baseRef);
const packageChanges = files.filter((file) => {
   if (!file.startsWith("packages/")) return false;
   if (file.endsWith("/CHANGELOG.md")) return false;
   if (file.endsWith("/README.md")) return false;
   return true;
});
const changesets = files.filter(
   (file) => file.startsWith(".changeset/") && file.endsWith(".md") && file !== ".changeset/README.md"
);

if (packageChanges.length === 0) {
   process.exit(0);
}

if (changesets.length > 0) {
   process.exit(0);
}

console.error("Package-impacting changes require a changeset.");
console.error(`Base ref: ${baseRef}`);
console.error("Changed package files:");
for (const file of packageChanges) {
   console.error(`- ${file}`);
}
console.error("\nRun `pnpm changeset`, or set SKIP_CHANGESET_CHECK=1 for an intentional skip.");
process.exit(1);
