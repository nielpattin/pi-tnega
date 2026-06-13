#!/usr/bin/env node
/**
 * Send a batchUpdate request to a Google Doc from a JSON file.
 * Template note: copy this file into `.google-workspace/scripts/` before editing or running it.
 *
 * Usage:
 *   node .google-workspace/scripts/batch-update.mjs <documentId> <requestsFile> [--credential <path>] [--preview]
 *
 * The requestsFile should contain a JSON array of request objects.
 * Example:
 *   [
 *     {
 *       "insertText": {
 *         "location": { "index": 100, "tabId": "..." },
 *         "text": "Hello"
 *       }
 *     }
 *   ]
 *
 * Use --preview to print the requests without sending them.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const DOCUMENT_ID = args[0];
const REQUESTS_FILE = args[1];
const credentialPath =
  args.includes("--credential")
    ? args[args.indexOf("--credential") + 1]
    : join(".google-workspace", "credentials", "default.json");

const PREVIEW = args.includes("--preview");

if (!DOCUMENT_ID || !REQUESTS_FILE) {
  console.error("Usage: node batch-update.mjs <documentId> <requestsFile> [--credential <path>] [--preview]");
  process.exit(1);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function refreshAccessToken() {
  const credential = await readJson(credentialPath);
  if (!credential.refresh_token) {
    throw new Error(
      `No refresh_token in ${credentialPath}. Re-run: gws auth login && gws auth export --unmasked > ${credentialPath}`
    );
  }
  const body = new URLSearchParams({
    client_id: credential.client_id,
    grant_type: "refresh_token",
    refresh_token: credential.refresh_token,
  });
  if (credential.client_secret) body.set("client_secret", credential.client_secret);

  const res = await fetch(
    credential.token_uri || "https://oauth2.googleapis.com/token",
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed with status ${res.status}`);
  const now = Math.floor(Date.now() / 1000);
  const updated = {
    ...credential, ...json, refresh_token: credential.refresh_token,
    obtained_at: now, expires_at: now + Number(json.expires_in || 3600),
  };
  await writeJson(credentialPath, updated);
  return updated.access_token;
}

async function apiFetch(url, options = {}) {
  const accessToken = await refreshAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// --- Main ---

try {
  const requests = JSON.parse(await readFile(REQUESTS_FILE, "utf8"));

  if (!Array.isArray(requests)) {
    throw new Error(`Requests file must contain a JSON array, got ${typeof requests}`);
  }

  if (PREVIEW) {
    console.log(JSON.stringify(requests, null, 2));
    console.log(`\nPreview: ${requests.length} request(s) ready. Run again without --preview to send.`);
    process.exit(0);
  }

  console.log(`Sending ${requests.length} request(s) to document ${DOCUMENT_ID}...`);

  const docsBase = "https://docs.googleapis.com/v1/documents";
  const result = await apiFetch(`${docsBase}/${DOCUMENT_ID}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });

  const replies = result.replies || [];
  console.log(`Success: ${replies.length} reply/replies`);
  for (let i = 0; i < replies.length; i++) {
    const keys = Object.keys(replies[i]);
    console.log(`  Request ${i}: ${keys.join(", ") || "(no reply data)"}`);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
