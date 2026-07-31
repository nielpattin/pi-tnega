import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionConfigs = [
   "tsconfig.json",
   ...(await readdir(join(root, "extensions"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("extensions", entry.name, "tsconfig.json"))
];

const existingConfigs = await Promise.all(
   extensionConfigs.map(async (configPath) => {
      await access(resolve(root, configPath));
      return configPath;
   })
);

function run(configPath) {
   return new Promise((resolvePromise) => {
      const child = spawn(
         process.execPath,
         [resolve(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", configPath],
         {
            cwd: root,
            stdio: "inherit"
         }
      );
      child.once("error", (error) => {
         console.error(`Failed to start tsc for ${configPath}: ${error.message}`);
         resolvePromise(1);
      });
      child.once("exit", (code, signal) => {
         if (signal) {
            console.error(`tsc terminated by ${signal} for ${configPath}`);
         }
         resolvePromise(code ?? 1);
      });
   });
}

const results = await Promise.all(existingConfigs.map((configPath) => run(configPath)));
if (results.some((code) => code !== 0)) {
   process.exitCode = 1;
}

console.log(`tsc checked ${existingConfigs.length} project configs with --noEmit.`);
