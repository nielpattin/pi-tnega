#!/usr/bin/env node
/**
 * Build pi-station to dist/.
 *
 * Strategy:
 *   Bundle entry points with esbuild (ESM, Node platform) into dist/.
 *   All @earendil-works/* peer packages, typebox, and node: builtins are
 *   marked external — they resolve at runtime from Pi's environment.
 *
 *   Entry points:
 *     1. index.ts                       -> dist/index.js  (main extension)
 *     2. features/hashline/edit-tool.ts -> dist/features/hashline/edit-tool.js
 *        (consumed by pi-permission-system for edit diff previews)
 *
 *   After building, package.json is updated to point main/exports/files/
 *   pi.extensions at dist/.
 */
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_JSON = resolve(ROOT, "package.json");

// esbuild is a workspace-root devDependency; resolve it from there so this
// script works without esbuild installed locally in pi-station.
const require = createRequire(import.meta.url);
const { build: esbuildBuild } = require("esbuild");

function readJson(path) {
   return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
   writeFileSync(path, JSON.stringify(obj, null, 3) + "\n", "utf8");
}

const pkg = readJson(PKG_JSON);
const origState = {
   main: pkg.main,
   exports: pkg.exports,
   files: pkg.files ? [...pkg.files] : undefined,
   extensions: pkg.pi?.extensions ? [...pkg.pi.extensions] : undefined
};

// ── Bundle entry points with esbuild ────────────────────────────────────

console.log("[build] bundling entry points with esbuild -> dist/...");

// Clean dist first.
rmSync(resolve(ROOT, "dist"), { recursive: true, force: true });

const ENTRY_POINTS = ["index.ts", "features/hashline/edit-tool.ts"];

try {
   await esbuildBuild({
      entryPoints: ENTRY_POINTS,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      outbase: ".",
      outdir: "dist",
      sourcemap: true,
      alias: { "#src": "./src" },
      external: ["@earendil-works/*", "@sinclair/typebox", "typebox", "node:*", "xxhashjs", "file-type"],
      logLevel: "info"
   });
} catch (error) {
   console.error("[build] esbuild failed:", error?.message ?? error);
   process.exit(1);
}

// ── Copy runtime assets (prompt markdown files loaded via new URL) ──────

// edit-tool.ts and read-tool.ts read ./prompts/*.md at runtime relative to
// import.meta.url. When bundled, import.meta.url points at the output file,
// so prompts must sit next to EACH bundled entry that references them:
//   - dist/index.js                      -> dist/prompts/
//   - dist/features/hashline/edit-tool.js -> dist/features/hashline/prompts/
const PROMPTS_SRC = resolve(ROOT, "features/hashline/prompts");
for (const dest of [resolve(ROOT, "dist/prompts"), resolve(ROOT, "dist/features/hashline/prompts")]) {
   mkdirSync(dest, { recursive: true });
   cpSync(PROMPTS_SRC, dest, { recursive: true });
}
console.log("[build] copied prompts -> dist/prompts + dist/features/hashline/prompts");

// ── Update package.json for dist/ runtime ───────────────────────────────

pkg.main = "./dist/index.js";
pkg.exports = {
   ".": {
      default: "./dist/index.js"
   },
   "./features/hashline/edit-tool": {
      default: "./dist/features/hashline/edit-tool.js"
   },
   "./package.json": "./package.json"
};
pkg.files = ["dist", ".pi/agents", "theme.example.json", "README.md", "CHANGELOG.md", "LICENSE"];
pkg.pi = pkg.pi || {};
pkg.pi.extensions = ["./dist/index.js"];

writeJson(PKG_JSON, pkg);

console.log("[build] finished — package.json updated for dist/ runtime");
console.log("[build]   main:         %s  ->  %s", origState.main, pkg.main);
console.log("[build]   exports:      . + ./features/hashline/edit-tool");
console.log("[build]   pi.extensions: %s", pkg.pi.extensions.join(", "));
