#!/usr/bin/env node
/**
 * Inspect a table from a saved document JSON file.
 * No API calls, no credentials. Reads from a file saved by gws-docs-task.mjs.
 *
 * Usage:
 *   node inspect-table.mjs <documentJson> <tableStartIndex>
 *
 * Example:
 *   node inspect-table.mjs before.document.json 1070
 */

import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const DOC_FILE = args[0];
const TABLE_START_INDEX = args[1] ? Number(args[1]) : null;

if (!DOC_FILE || TABLE_START_INDEX === null || isNaN(TABLE_START_INDEX)) {
  console.error("Usage: node inspect-table.mjs <documentJson> <tableStartIndex>");
  process.exit(1);
}

const doc = JSON.parse(await readFile(DOC_FILE, "utf8"));
const tabs = doc.tabs || [];
const tab = tabs[0];
const body = tab?.documentTab?.body || doc.body;

function walkElements(content, visit) {
  for (const el of content || []) {
    visit(el);
    if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          walkElements(cell.content || [], visit);
        }
      }
    }
  }
}

let found = false;
walkElements(body.content, (el) => {
  if (!el.table || el.startIndex !== TABLE_START_INDEX) return;
  found = true;
  console.log(`Table at index ${el.startIndex}`);
  console.log(`Rows: ${el.table.tableRows.length}`);
  console.log(`Table endIndex: ${el.endIndex}\n`);

  for (let r = 0; r < el.table.tableRows.length; r++) {
    const row = el.table.tableRows[r];
    console.log(`Row ${r}:`);
    for (let c = 0; c < row.tableCells.length; c++) {
      const cell = row.tableCells[c];
      const cs = cell.tableCellStyle || {};
      const rowSpan = cs.rowSpan || 1;
      const colSpan = cs.columnSpan || 1;

      const texts = [];
      const textRuns = [];
      walkElements(cell.content || [], (cel) => {
        for (const pe of cel.paragraph?.elements || []) {
          if (pe.textRun) {
            texts.push(pe.textRun.content);
            textRuns.push({
              startIndex: pe.startIndex,
              endIndex: pe.endIndex,
              text: pe.textRun.content,
              bold: pe.textRun.textStyle?.bold || false,
              fontSize: pe.textRun.textStyle?.fontSize?.magnitude || null,
              fontFamily: pe.textRun.textStyle?.weightedFontFamily?.fontFamily || null,
            });
          }
        }
      });

      const raw = texts.join("");
      console.log(`  [${r}][${c}] rowSpan=${rowSpan} colSpan=${colSpan} text=${JSON.stringify(raw)}`);

      if (textRuns.length > 1 || (textRuns.length === 1 && textRuns[0].text !== "\n")) {
        console.log(`    textRuns:`);
        for (const tr of textRuns) {
          console.log(`      [${tr.startIndex}-${tr.endIndex}] ${tr.bold ? "BOLD " : ""}${tr.fontSize ? tr.fontSize + "pt " : ""}${tr.fontFamily || ""} ${JSON.stringify(tr.text)}`);
        }
      }
    }
  }

  // Print cell-level styling summary
  console.log(`\nCell borders and background:`);
  for (let r = 0; r < el.table.tableRows.length; r++) {
    const row = el.table.tableRows[r];
    for (let c = 0; c < row.tableCells.length; c++) {
      const cs = row.tableCells[c].tableCellStyle || {};
      const bg = cs.backgroundColor?.color?.rgbColor;
      if (bg) {
        console.log(`  [${r}][${c}] bg=rgb(${bg.red},${bg.green},${bg.blue})`);
      }
    }
  }
});

if (!found) {
  console.error(`Table at index ${TABLE_START_INDEX} not found in ${DOC_FILE}`);
  process.exit(1);
}
