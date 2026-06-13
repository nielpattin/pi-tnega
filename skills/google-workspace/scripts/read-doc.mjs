#!/usr/bin/env node
/**
 * Read a Google Doc and print its text content with full styling.
 * Template note: copy this file into `.google-workspace/scripts/` before editing or running it.
 *
 * Usage:
 *   node .google-workspace/scripts/read-doc.mjs <documentId> [--credential <path>]
 *
 * Prints:
 *   - Document title, revision ID, tabs
 *   - Per textRun: text, bold, fontSize, fontFamily, namedStyleType
 *   - Table structure: rows, cells, spans, cell text, cell styling
 *   - Structural summary (paragraphs, tables, list items)
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";


const args = process.argv.slice(2);
const DOCUMENT_ID = args[0];
const credentialPath =
  args.includes("--credential")
    ? args[args.indexOf("--credential") + 1]
    : join(".google-workspace", "credentials", "default.json");

if (!DOCUMENT_ID || DOCUMENT_ID.startsWith("--")) {
  console.error("Usage: node read-doc.mjs <documentId> [--credential <path>]");
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

function extractStyledRuns(body) {
  const runs = [];
  walkStructuralElements(body?.content || [], (element) => {
    const els = element.paragraph?.elements || [];
    for (const el of els) {
      if (el.textRun) {
        const ts = el.textRun.textStyle || {};
        const ps = element.paragraph?.paragraphStyle || {};
        runs.push({
          startIndex: el.startIndex,
          endIndex: el.endIndex,
          text: el.textRun.content,
          bold: ts.bold || false,
          fontSize: ts.fontSize?.magnitude || null,
          fontFamily: ts.weightedFontFamily?.fontFamily || null,
          italic: ts.italic || false,
          underline: ts.underline || false,
          foregroundColor: ts.foregroundColor || null,
          link: ts.link || null,
          namedStyleType: ps.namedStyleType || "NORMAL_TEXT",
        });
      }
    }
  });
  return runs;
}

function getDocumentTabs(doc) {
  if (Array.isArray(doc.tabs) && doc.tabs.length) {
    return doc.tabs.map((tab) => ({
      tabId: tab.tabProperties?.tabId,
      title: tab.tabProperties?.title,
      body: tab.documentTab?.body,
      documentTab: tab.documentTab,
    }));
  }
  return [{ tabId: undefined, title: doc.title, body: doc.body, documentTab: doc }];
}

function inspectTable(docBody, tableStartIndex) {
  walkStructuralElements(docBody?.content || [], (element) => {
    if (!element.table || element.startIndex !== tableStartIndex) return;
    console.log(`\nTable at index ${element.startIndex}`);
    console.log(`Rows: ${element.table.tableRows.length}`);
    for (let r = 0; r < element.table.tableRows.length; r++) {
      const row = element.table.tableRows[r];
      for (let c = 0; c < row.tableCells.length; c++) {
        const cell = row.tableCells[c];
        const cs = cell.tableCellStyle;
        const span = cs?.columnSpan && cs?.rowSpan
          ? `${cs.columnSpan}x${cs.rowSpan}`
          : "1x1";
        const cellTexts = [];
        walkStructuralElements(cell.content || [], (el) => {
          for (const pe of el.paragraph?.elements || []) {
            if (pe.textRun) cellTexts.push(pe.textRun.content);
          }
        });
        console.log(`  [${r}][${c}] span=${span} text=${JSON.stringify(cellTexts.join("").trim())}`);
      }
    }
  });
}

function inspectTableStyling(docBody, tableStartIndex) {
  walkStructuralElements(docBody?.content || [], (element) => {
    if (!element.table || element.startIndex !== tableStartIndex) return;
    for (const row of element.table.tableRows) {
      for (const cell of row.tableCells) {
        walkStructuralElements(cell.content || [], (el) => {
          for (const pe of el.paragraph?.elements || []) {
            if (pe.textRun) {
              const ts = pe.textRun.textStyle || {};
              console.log(
                `Cell text: ${JSON.stringify(pe.textRun.content.trim())} ` +
                `bold=${ts.bold} fontSize=${ts.fontSize?.magnitude || "default"} ` +
                `font=${ts.weightedFontFamily?.fontFamily || "default"}`
              );
            }
          }
        });
      }
    }
  });
}

// --- Main ---

try {
  // Check capabilities
  console.log("Checking Drive capabilities...");
  const docsBase = "https://docs.googleapis.com/v1/documents";
  const driveBase = "https://www.googleapis.com/drive/v3/files";
  const fields =
    "id,name,mimeType,ownedByMe,shared,capabilities(canEdit,canComment,canCopy,canDownload,canShare),owners(emailAddress,displayName)";
  const file = await apiFetch(
    `${driveBase}/${DOCUMENT_ID}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`
  );
  console.log(`Document: "${file.name}"`);
  console.log(`Owned by me: ${file.ownedByMe}`);
  console.log(`Shared: ${file.shared}`);
  console.log(`Can edit: ${file.capabilities?.canEdit}`);
  console.log("");

  // Fetch document
  console.log("Fetching document...");
  const doc = await apiFetch(`${docsBase}/${DOCUMENT_ID}?includeTabsContent=true`);
  const tabs = getDocumentTabs(doc);

  console.log(`\nTitle: ${doc.title}`);
  console.log(`Revision ID: ${doc.revisionId}`);
  console.log(`Tabs: ${tabs.length}\n`);

  // Print each tab with styling
  for (const tab of tabs) {
    console.log(`=== Tab: "${tab.title}" (tabId: ${tab.tabId || "none"}) ===`);
    const runs = extractStyledRuns(tab.body);
    for (const r of runs) {
      const style = [
        r.bold ? "B" : "",
        r.italic ? "I" : "",
        r.underline ? "U" : "",
        r.fontSize ? `${r.fontSize}pt` : "",
        r.fontFamily || "",
        r.namedStyleType !== "NORMAL_TEXT" ? r.namedStyleType : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`[${r.startIndex}-${r.endIndex}] ${style ? `(${style}) ` : ""}${JSON.stringify(r.text)}`);
    }

    // Print tables
    let tableIdx = 0;
    walkStructuralElements(tab.body?.content || [], (element) => {
      if (!element.table) return;
      tableIdx++;
      console.log(`\n--- Table ${tableIdx} at index ${element.startIndex} ---`);
      inspectTable(tab.body, element.startIndex);
      inspectTableStyling(tab.body, element.startIndex);
    });
  }

  // Structural summary
  console.log("\n--- Summary ---");
  let paraCount = 0, tableCount = 0, listCount = 0;
  for (const tab of tabs) {
    walkStructuralElements(tab.body?.content || [], (element) => {
      if (element.paragraph) paraCount++;
      if (element.table) tableCount++;
      if (element.paragraph?.bullet) listCount++;
    });
  }
  console.log(`Paragraphs: ${paraCount}, Tables: ${tableCount}, List items: ${listCount}`);
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
