#!/usr/bin/env node
/**
 * Replace text in a Google Doc using targeted range operations.
 * Template note: copy this file into `.google-workspace/scripts/` before editing or running it.
 *
 * Usage:
 *   node .google-workspace/scripts/replace-text.mjs <documentId> <oldText> <newText> [--credential <path>]
 *
 * Without --once, uses replaceAllText for all matching occurrences.
 * With --once, reads the document, finds the first occurrence in one textRun,
 * then uses deleteContentRange + insertText and reapplies the original text style.
 *
 * Supports:
 *   --once         Only replace the first occurrence
 *   --match-case   Case-sensitive matching (default: case-insensitive)
 *   --tab-id <id>  Restrict to a specific tab
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const DOCUMENT_ID = args[0];
const OLD_TEXT = args[1];
const NEW_TEXT = args[2];
const credentialPath =
  args.includes("--credential")
    ? args[args.indexOf("--credential") + 1]
    : join(".google-workspace", "credentials", "default.json");

const ONCE = args.includes("--once");
const MATCH_CASE = args.includes("--match-case");
const TAB_ID = args.includes("--tab-id") ? args[args.indexOf("--tab-id") + 1] : null;

if (!DOCUMENT_ID || !OLD_TEXT) {
  console.error("Usage: node replace-text.mjs <documentId> <oldText> [newText] [--once] [--match-case] [--tab-id <id>] [--credential <path>]");
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

function copyTextStyle(textStyle = {}) {
  const copied = {};
  for (const key of ["bold", "italic", "underline", "strikethrough", "fontSize", "weightedFontFamily", "foregroundColor", "backgroundColor"]) {
    if (textStyle[key] !== undefined) copied[key] = textStyle[key];
  }
  return copied;
}

function styleFields(textStyle = {}) {
  return ["bold", "italic", "underline", "strikethrough", "fontSize", "weightedFontFamily", "foregroundColor", "backgroundColor"]
    .filter(key => textStyle[key] !== undefined)
    .join(",");
}

function findFirstTextRunMatch(body, needle, matchCase) {
  const searchNeedle = matchCase ? needle : needle.toLowerCase();
  let match = null;
  walkStructuralElements(body?.content || [], (element) => {
    if (match) return;
    for (const el of element.paragraph?.elements || []) {
      const text = el.textRun?.content || "";
      const haystack = matchCase ? text : text.toLowerCase();
      const offset = haystack.indexOf(searchNeedle);
      if (offset >= 0) {
        match = {
          startIndex: el.startIndex + offset,
          endIndex: el.startIndex + offset + needle.length,
          textStyle: copyTextStyle(el.textRun?.textStyle || {}),
        };
        return;
      }
    }
  });
  return match;
}

// --- Main ---

try {
  const docsBase = "https://docs.googleapis.com/v1/documents";

  if (ONCE) {
    const doc = await apiFetch(`${docsBase}/${DOCUMENT_ID}?includeTabsContent=true`);
    const tabs = getDocumentTabs(doc).filter(tab => !TAB_ID || tab.tabId === TAB_ID);
    let match = null;
    let matchTabId = null;
    for (const tab of tabs) {
      match = findFirstTextRunMatch(tab.body, OLD_TEXT, MATCH_CASE);
      if (match) {
        matchTabId = tab.tabId;
        break;
      }
    }

    if (!match) {
      console.log(`No occurrence found for ${JSON.stringify(OLD_TEXT)}`);
      process.exit(0);
    }

    const requests = [
      { deleteContentRange: { range: { startIndex: match.startIndex, endIndex: match.endIndex, tabId: matchTabId } } },
      { insertText: { location: { index: match.startIndex, tabId: matchTabId }, text: NEW_TEXT || "" } },
    ];
    const fields = styleFields(match.textStyle);
    if ((NEW_TEXT || "").length > 0 && fields) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: match.startIndex, endIndex: match.startIndex + (NEW_TEXT || "").length, tabId: matchTabId },
          textStyle: match.textStyle,
          fields,
        },
      });
    }

    await apiFetch(`${docsBase}/${DOCUMENT_ID}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
    console.log(`Replaced first occurrence of ${JSON.stringify(OLD_TEXT)} with ${JSON.stringify(NEW_TEXT || "")}`);
  } else {
    const request = {
      replaceAllText: {
        replaceText: NEW_TEXT || "",
        containsText: {
          text: OLD_TEXT,
          matchCase: MATCH_CASE,
        },
      },
    };

    if (TAB_ID) {
      request.replaceAllText.tabsCriteria = { tabIds: [TAB_ID] };
    }

    const result = await apiFetch(`${docsBase}/${DOCUMENT_ID}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [request] }),
    });

    const count = result.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
    console.log(`Replaced ${count} occurrence(s) of ${JSON.stringify(OLD_TEXT)} with ${JSON.stringify(NEW_TEXT || "")}`);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
