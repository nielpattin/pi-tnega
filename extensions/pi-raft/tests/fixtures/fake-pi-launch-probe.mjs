#!/usr/bin/env node

import readline from "node:readline";

// Launch-surface probe: reports the argv/env surface the Raft worker gave
// this child Pi without running any model. Speaks the same RPC handshake as
// fake-pi-rpc.mjs.
const send = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const surface = {
  cwd: process.cwd(),
  trustFlags: argv.filter((arg) => ["--approve", "--no-approve", "-a", "-na"].includes(arg)),
  projectRoot: process.env.PI_RAFT_PROJECT_ROOT,
  meshRoot: process.env.PI_RAFT_MESH_ROOT,
  kernel: process.env.PI_RAFT_KERNEL,
  pythonRuntime: process.env.PI_RAFT_PYTHON_RUNTIME,
  depth: process.env.PI_RAFT_DEPTH,
  mainAgentId: process.env.PI_RAFT_MAIN_AGENT_ID,
  capabilityRequirements: JSON.parse(process.env.PI_RAFT_CAPABILITY_REQUIREMENTS ?? "[]"),
  extensions: !argv.includes("--no-extensions"),
  extensionPath: flag("-e"),
  tools: flag("--tools")?.split(",") ?? [],
  fullCodeModeEnv: process.env.PI_RAFT_FULL_CODE_MODE,
  excludeCoreToolsEnv: process.env.PI_RAFT_EXCLUDE_CORE_TOOLS
    ? JSON.parse(process.env.PI_RAFT_EXCLUDE_CORE_TOOLS)
    : undefined,
  toolAllowlistEnv: process.env.PI_RAFT_TOOL_ALLOWLIST
    ? JSON.parse(process.env.PI_RAFT_TOOL_ALLOWLIST)
    : undefined,
  grantedRisksEnv: (process.env.PI_RAFT_GRANTED_RISKS ?? "")
    .split(",")
    .filter((risk) => risk.length > 0),
};
const text = JSON.stringify(surface);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const message = {
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "fake",
  model: "fake-model",
  usage,
  stopReason: "stop",
};

let started = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (started || !line.trim()) return;
  started = true;
  send({ type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", messages: [message], willRetry: false });
  send({ type: "agent_settled" });
});

process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 5);
});
process.stdin.resume();
