#!/usr/bin/env node
/**
 * gws-docs-task.mjs — gws-powered Docs task runner.
 * Template note: copy into `.google-workspace/scripts/` before use.
 *
 * No credentials. No token refresh. gws handles auth.
 *
 * Usage:
 *   node gws-docs-task.mjs get <documentId> <taskDir>
 *     Reads the document via gws and saves to taskDir/before.document.json.
 *     If taskDir/before.document.json already exists, saves to after.document.json.
 *
 *   node gws-docs-task.mjs preview <documentId> <taskDir>
 *     Reads taskDir/requests.json and prints the request body via gws --dry-run.
 *
 *   node gws-docs-task.mjs apply <documentId> <taskDir>
 *     Reads taskDir/requests.json and sends the batchUpdate via gws.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

// ---- helpers ----

const GWS_TIMEOUT_MS = 60_000;

function gws(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gws", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      reject(new Error(
        "gws timed out after 60s. Run `gws auth status` to check authentication. " +
        "If this is a large document, the read may need more time — retry."
      ));
    }, GWS_TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) reject(new Error(stderr || stdout || `gws exited ${code}`));
      else resolve(stdout.trim());
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// ---- commands ----

const cmd = process.argv[2];
const documentId = process.argv[3];
const taskDir = process.argv[4];

function usage() {
  console.error("Usage: node gws-docs-task.mjs <get|preview|apply> <documentId> <taskDir>");
  process.exit(1);
}

if (!cmd || !documentId || !taskDir) usage();

await mkdir(taskDir, { recursive: true });

if (cmd === "get") {
  // Determine output filename
  let outFile;
  try {
    await stat(join(taskDir, "before.document.json"));
    outFile = join(taskDir, "after.document.json");
  } catch {
    outFile = join(taskDir, "before.document.json");
  }

  const params = JSON.stringify({ documentId, includeTabsContent: true });
  const result = await gws(["docs", "documents", "get", "--params", params]);
  const doc = JSON.parse(result);

  // Write raw JSON
  await writeFile(outFile, JSON.stringify(doc, null, 2), "utf8");

  // Print summary
  const tabs = doc.tabs?.map((t) => t.tabProperties?.tabId).filter(Boolean) || [];
  console.log(`Saved to ${outFile}`);
  console.log(`Title: ${doc.title}`);
  console.log(`Revision ID: ${doc.revisionId}`);
  console.log(`Tabs: ${tabs.length > 0 ? tabs.join(", ") : "none"}`);

} else if (cmd === "preview") {
  const requestsFile = join(taskDir, "requests.json");
  const wrapper = await readJson(requestsFile);

  // Accept both raw array and {requests: [...]} wrapper
  const requests = Array.isArray(wrapper) ? wrapper : wrapper.requests;
  if (!Array.isArray(requests)) {
    throw new Error("requests.json must contain a JSON array or {requests: [...]}");
  }

  const body = JSON.stringify({
    requests,
    ...(wrapper.writeControl ? { writeControl: wrapper.writeControl } : {}),
  });

  const params = JSON.stringify({ documentId });
  const result = await gws([
    "docs", "documents", "batchUpdate",
    "--params", params,
    "--json", body,
    "--dry-run",
  ]);
  console.log(result);

} else if (cmd === "apply") {
  const requestsFile = join(taskDir, "requests.json");
  const wrapper = await readJson(requestsFile);

  const requests = Array.isArray(wrapper) ? wrapper : wrapper.requests;
  if (!Array.isArray(requests)) {
    throw new Error("requests.json must contain a JSON array or {requests: [...]}");
  }

  const body = JSON.stringify({
    requests,
    ...(wrapper.writeControl ? { writeControl: wrapper.writeControl } : {}),
  });

  const params = JSON.stringify({ documentId });
  console.log(`Sending ${requests.length} request(s) to document ${documentId}...`);
  const result = await gws([
    "docs", "documents", "batchUpdate",
    "--params", params,
    "--json", body,
  ]);
  console.log(result);

} else {
  usage();
}
