import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
const wrapperScript = join(tmpDir, "wrapper.mjs");
const debugScript = join(tmpDir, "debug-cli.mjs");

const systemPrompt = "A".repeat(36000);
const userMessage = "say hello";

const finalArgs = [
   "--print",
   "--mode",
   "json",
   "--no-session",
   "--no-extensions",
   "--no-skills",
   "--no-prompt-templates",
   "--system-prompt",
   systemPrompt,
   "--model",
   "xiaomi-token-plan-sgp/mimo-v2.5",
   "--thinking",
   "high",
   userMessage
];

// Create a debug CLI that just prints what it receives
writeFileSync(
   debugScript,
   `
console.log('DEBUG_CLI: argv length:', process.argv.length);
const sysPromptIdx = process.argv.indexOf('--system-prompt');
if (sysPromptIdx !== -1 && sysPromptIdx + 1 < process.argv.length) {
  const sp = process.argv[sysPromptIdx + 1];
  console.log('DEBUG_CLI: system-prompt length:', sp.length);
  console.log('DEBUG_CLI: system-prompt starts:', sp.slice(0, 100));
  console.log('DEBUG_CLI: system-prompt ends:', sp.slice(-100));
} else {
  console.log('DEBUG_CLI: NO --system-prompt found');
}
console.log('DEBUG_CLI: last arg (user message):', process.argv[process.argv.length - 1].slice(0, 100));
process.exit(0);
`,
   "utf8"
);

writeFileSync(
   wrapperScript,
   `
import { pathToFileURL } from 'node:url';
process.chdir(${JSON.stringify(process.cwd())});
process.argv = [process.execPath, ${JSON.stringify(debugScript)}, ...${JSON.stringify(finalArgs)}];
const cliUrl = pathToFileURL(${JSON.stringify(debugScript)}).href;
await import(cliUrl);
`,
   "utf8"
);

console.log("Testing wrapper with 36K system prompt...");
console.log("Expected system prompt length:", systemPrompt.length);

const child = spawn(process.execPath, [wrapperScript], {
   cwd: process.cwd(),
   env: process.env,
   stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (data) => process.stdout.write(data));
child.stderr.on("data", (data) => process.stderr.write(data));
child.on("exit", (code) => {
   console.log("Exit code:", code);
   process.exit(code || 0);
});
