/**
 * Re-apply Windows spawn fix for pi-magic-context historian.
 * Run with: node patches/apply-spawn-fix.mjs
 *
 * Fixes: ENOENT, ENAMETOOLONG, EINVAL errors when historian tries to spawn pi on Windows.
 *
 * What it does:
 * 1. Resolves pi.cmd to node.exe + cli.js (avoids shell mode)
 * 2. For large system prompts (>4KB), uses in-process import wrapper
 *    to bypass CreateProcess 32767-char command line limit
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

const pnpmPath = join(
   process.cwd(),
   "node_modules/.pnpm/@cortexkit+pi-magic-context@0.26.0/node_modules/@cortexkit/pi-magic-context/dist/index.js"
);
const npmPath = join(process.cwd(), "npm/node_modules/@cortexkit/pi-magic-context/dist/index.js");

const targets = [pnpmPath, npmPath].filter(existsSync);

if (targets.length === 0) {
   console.error("Could not find pi-magic-context dist/index.js");
   process.exit(1);
}

// Check if already patched
const sample = readFileSync(targets[0], "utf8");
if (sample.includes("useWrapper") && sample.includes("__VIA_WRAPPER__")) {
   console.log("Already patched, skipping.");
   process.exit(0);
}

for (const filePath of targets) {
   let code = readFileSync(filePath, "utf8");

   // 1. Fix constructor to resolve pi.cmd -> node.exe + cli.js on Windows
   const oldConstructor = `      if (bundled) {
        this.piBinary = bundled;
      } else {
        this.piBinary = "pi";
      }`;

   const newConstructor = `      if (bundled) {
        this.piBinary = bundled;
      } else if (process.platform === "win32") {
        try {
          const piCmdPath = childProcess.execSync("where pi.cmd", { encoding: "utf8", timeout: 5000 }).trim().split(/\\r?\\n/)[0].trim();
          const require_ = createRequire2(import.meta.url);
          const { readFileSync } = require_("node:fs");
          const cmdContent = readFileSync(piCmdPath, "utf8");
          const match = cmdContent.match(/node\\s+"([^"]+)"/);
          if (match) {
            let cliPath = match[1].replace(/%~dp0/g, dirname3(piCmdPath) + "\\\\");
            cliPath = resolvePath(cliPath);
            if (existsSync6(cliPath)) {
              this.piBinary = process.execPath;
              this._piCliArgs = [cliPath];
            } else {
              this.piBinary = "pi.cmd";
            }
          } else {
            this.piBinary = "pi.cmd";
          }
        } catch {
          this.piBinary = "pi.cmd";
        }
      } else {
        this.piBinary = "pi";
      }`;

   // 2. Fix system prompt to use placeholder on Windows
   const oldSysPrompt = `  if (options.systemPrompt && options.systemPrompt.length > 0) {
    args.push("--system-prompt", options.systemPrompt);
  }`;

   const newSysPrompt = `  if (options.systemPrompt && options.systemPrompt.length > 0) {
    if (process.platform === "win32" && options.systemPrompt.length > 4000) {
      args.push("--system-prompt", "__VIA_WRAPPER__");
    } else {
      args.push("--system-prompt", options.systemPrompt);
    }
  }`;

   // 3. Fix spawn to use wrapper for large prompts
   const oldSpawn = `      let child;
      const spawnArgs = this._piCliArgs ? [...this._piCliArgs, ...args] : args;
      try {
        child = this.spawnImpl(this.piBinary, spawnArgs, {
          cwd: options.cwd,
          env: process.env,
          stdio: [deliverViaStdin ? "pipe" : "ignore", "pipe", "pipe"]
        });`;

   const newSpawn = `      let child;
      const spawnArgs = this._piCliArgs ? [...this._piCliArgs, ...args] : args;
      const useWrapper = process.platform === "win32" && options.systemPrompt && options.systemPrompt.length > 4000;
      try {
        if (useWrapper) {
          const { writeFileSync, mkdtempSync } = createRequire2(import.meta.url)("node:fs");
          const { join: joinTmp } = createRequire2(import.meta.url)("node:path");
          const { tmpdir } = createRequire2(import.meta.url)("node:os");
          const { pathToFileURL } = createRequire2(import.meta.url)("node:url");
          const tmpDir = mkdtempSync(joinTmp(tmpdir(), "pi-"));
          const wrapperScript = joinTmp(tmpDir, "wrapper.mjs");
          const finalArgs = spawnArgs.map(a => a === "__VIA_WRAPPER__" ? options.systemPrompt : a);
          const cliPath = this._piCliArgs?.[0] || this.piBinary;
          writeFileSync(wrapperScript, \`
import { pathToFileURL } from 'node:url';
process.chdir(\${JSON.stringify(options.cwd || process.cwd())});
process.argv = [process.execPath, \${JSON.stringify(cliPath)}, ...\${JSON.stringify(finalArgs)}];
const cliUrl = pathToFileURL(\${JSON.stringify(cliPath)}).href;
await import(cliUrl);
\`, "utf8");
          child = childProcess.spawn(process.execPath, [wrapperScript], {
            cwd: options.cwd,
            env: process.env,
            stdio: [deliverViaStdin ? "pipe" : "ignore", "pipe", "pipe"]
          });
        } else {
          child = this.spawnImpl(this.piBinary, spawnArgs, {
            cwd: options.cwd,
            env: process.env,
            stdio: [deliverViaStdin ? "pipe" : "ignore", "pipe", "pipe"]
          });
        }`;

   // 4. Fix stdin to not double-send when using wrapper
   const oldStdin = `      if (deliverViaStdin && child.stdin) {`;
   const newStdin = `      if (deliverViaStdin && !useWrapper && child.stdin) {`;

   // Apply patches
   code = code.replace(oldConstructor, newConstructor);
   code = code.replace(oldSysPrompt, newSysPrompt);
   code = code.replace(oldSpawn, newSpawn);
   code = code.replace(oldStdin, newStdin);

   writeFileSync(filePath, code, "utf8");
   console.log(`Patched: ${filePath}`);
}

console.log("Done. Restart Pi to apply.");
