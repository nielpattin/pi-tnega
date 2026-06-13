#!/usr/bin/env node
/**
 * Find text occurrences in a Google Doc and print their indices, context, and styling.
 * Template note: copy this file into `.google-workspace/scripts/` before editing or running it.
 *
 * Usage:
 *   node .google-workspace/scripts/find-text.mjs <documentId> <searchText> [--credential <path>]
 *
 * Prints each occurrence with:
 *   - startIndex and endIndex in the document model
 *   - full textRun content (context)
 *   - textRun styling (bold, fontSize, fontFamily)
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const DOCUMENT_ID = args[0];
const SEARCH_TEXT = args[1];
const credentialPath =
  args.includes("--credential")
    ? args[args.indexOf("--credential") + 1]
    : join(".google-workspace", "credentials", "default.json");

if (!DOCUMENT_ID || !SEARCH_TEXT) {
  console.error("Usage: node find-text.mjs <documentId> <searchText> [--credential <path>]");
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

// --- Helpers ---

function walkStructuralElements(content, visit) {
  for (const element of content || []) {
    visit(element);
    if (element.table) {
      for (const row of element.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          walkStructuralElements(cell.content || [], visit);
        }
      }
    }
    if (element.tableOfContents) {
      walkStructuralElements(element.tableOfContents.content || [], visit);
    }
  }
}

function getDocumentTabs(doc) {
  if (Array.isArray(doc.tabs) && doc.tabs.length) {
    return doc.tabs.map(tab => ({
      tabId: tab.tabProperties?.tabId,
      title: tab.tabProperties?.title,
      body: tab.documentTab?.body,
    }));
  }
  return [{ tabId: undefined, title: doc.title, body: doc.body }];
}

function findText(body, needle) {
  const matches = [];
  walkStructuralElements(body?.content || [], (element) => {
    const els = element.paragraph?.elements || [];
    for (const el of els) {
      const text = el.textRun?.content || "";
      let idx = 0;
      while ((idx = text.indexOf(needle, idx)) >= 0) {
        const ts = el.textRun?.textStyle || {};
        matches.push({
          startIndex: el.startIndex + idx,
          endIndex: el.startIndex + idx + needle.length,
          context: text,
          bold: ts.bold || false,
          fontSize: ts.fontSize?.magnitude || null,
          fontFamily: ts.weightedFontFamily?.fontFamily || null,
        });
        idx += needle.length;
      }
    }
  });
  return matches;
}

// --- Main ---

try {
  const docsBase = "https://docs.googleapis.com/v1/documents";
  const doc = await apiFetch(`${docsBase}/${DOCUMENT_ID}?includeTabsContent=true`);
  const tabs = getDocumentTabs(doc);

  console.log(`Document: "${doc.title}"`);
  console.log(`Searching for: ${JSON.stringify(SEARCH_TEXT)}\n`);

  let totalMatches = 0;
  for (const tab of tabs) {
    const matches = findText(tab.body, SEARCH_TEXT);
    if (matches.length === 0) continue;
    console.log(`Tab: "${tab.title}" (tabId: ${tab.tabId || "none"})`);
    for (const m of matches) {
      const style = [
        m.bold ? "B" : "",
        m.fontSize ? `${m.fontSize}pt` : "",
        m.fontFamily || "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`  [${m.startIndex}-${m.endIndex}] ${style ? `(${style}) ` : ""}context=${JSON.stringify(m.context)}`);
      totalMatches++;
    }
  }

  console.log(`\nTotal: ${totalMatches} occurrence(s)`);
  if (totalMatches === 0) {
    console.log("No matches found. Note: text is case-sensitive.");
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
