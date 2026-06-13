# Docs Table Operations

Copyable patterns for common table edits. All requests go into `requests.json` in the task workspace. Use `gws-docs-task.mjs preview` before applying.

## Prerequisites

Every table operation needs:
- `tableStartIndex` — the `startIndex` of the table structural element
- `tabId` — from `doc.tabs[0].tabProperties.tabId` (if the document has tabs)
- `revisionId` — from `doc.revisionId`

## Inspect a table

Read the document first (`gws-docs-task.mjs get`). Then inspect the saved JSON:

```js
// write to .google-workspace/tasks/<slug>/inspect.mjs
import { readFile } from "node:fs/promises";

const doc = JSON.parse(await readFile("before.document.json", "utf8"));
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

// Find all tables
walkElements(body.content, (el) => {
  if (!el.table) return;
  console.log(`Table at index ${el.startIndex}, ${el.table.tableRows.length} rows, ${el.table.tableRows[0]?.tableCells.length} cols`);
});

// Print a specific table with spans and raw text
const TABLE_IDX = 1070; // change to your table's startIndex
walkElements(body.content, (el) => {
  if (!el.table || el.startIndex !== TABLE_IDX) return;
  for (let r = 0; r < el.table.tableRows.length; r++) {
    const row = el.table.tableRows[r];
    for (let c = 0; c < row.tableCells.length; c++) {
      const cell = row.tableCells[c];
      const cs = cell.tableCellStyle || {};
      const rowSpan = cs.rowSpan || 1;
      const colSpan = cs.columnSpan || 1;
      const texts = [];
      walkElements(cell.content || [], (cel) => {
        for (const pe of cel.paragraph?.elements || []) {
          if (pe.textRun) texts.push(pe.textRun.content);
        }
      });
      const raw = texts.join(""); // do NOT .trim()
      console.log(`[${r}][${c}] rowSpan=${rowSpan} colSpan=${colSpan} text=${JSON.stringify(raw)}`);
    }
  }
});
```

Run: `node inspect.mjs`

## Operation: Unmerge a cell

Unmerging leaves all text in the "head" cell (upper-left). The spanned cells become empty.

**Before:**
```
[3][0] colSpan=2 text="Quản lý"
[3][1] colSpan=1 text=""  (spanned)
```

**Request:**
```json
{
  "requests": [
    {
      "unmergeTableCells": {
        "tableRange": {
          "tableCellLocation": {
            "tableStartLocation": { "index": 1070, "tabId": "t.xxx" },
            "rowIndex": 3,
            "columnIndex": 0
          },
          "rowSpan": 1,
          "columnSpan": 2
        }
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "ALBJ4LvMO..." }
}
```

**After:**
```
[3][0] colSpan=1 text="Quản lý"
[3][1] colSpan=1 text=""
```

## Operation: Split merged cell — keep all text in first cell (no text deletion)

When the user says: "split this cell, one with the text, one empty."

This is just unmerge (see above). Unmerging leaves all text in the head cell, and the previously-spanned cells become empty. No text edits needed. No `deleteContentRange`.

Common mistake: unmerging and then deleting text from the head cell. Do not delete text unless the user explicitly asks to change the text content. Unmerging alone produces "text in first cell, empty in second."

## Operation: Split merged cell and move suffix to second cell

When the user explicitly says both words/pieces should go into separate cells (e.g. "Quản" in one, "lý" in the other).

This requires two phases.

**Phase 1 — Unmerge:**
Same unmerge request as above. After unmerge, all text stays in the head cell.

**Phase 2 — Move suffix (after re-reading the document):**

Read the document again to get fresh indices. Find the exact text ranges for the suffix to cut from the head cell and insert into the second cell.

```json
{
  "requests": [
    {
      "deleteContentRange": {
        "range": {
          "startIndex": 1345,
          "endIndex": 1347
        }
      }
    },
    {
      "insertText": {
        "location": { "index": 1349, "tabId": "t.xxx" },
        "text": "lý"
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "NEW_REVISION_ID" }
}
```

Important:
- Re-read the document between phases. Indices shift after unmerge.
- Use `writeControl.requiredRevisionId` with the fresh revision ID.
- Apply text styling to the inserted text if the original had styling.

**After Phase 2:**
```
[3][0] colSpan=1 text="Quản "
[3][1] colSpan=1 text="lý"
```

## Operation: Insert a column

Inserting a column adds a new empty column at the specified position. Existing cells in that column position shift right. Merged cells that span across the insertion point may need attention.

```json
{
  "requests": [
    {
      "insertTableColumn": {
        "tableCellLocation": {
          "tableStartLocation": { "index": 1070, "tabId": "t.xxx" },
          "rowIndex": 0,
          "columnIndex": 1
        },
        "insertRight": true
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "ALBJ4LvMO..." }
}
```

Set `"insertRight": false` to insert to the left.

After inserting a column, re-read and verify cell spans. Cells that previously spanned the insertion point may now have different structure.

## Operation: Delete content inside a cell

Delete text within a cell by its index range. The cell remains; only the text is removed.

```json
{
  "requests": [
    {
      "deleteContentRange": {
        "range": {
          "startIndex": 1340,
          "endIndex": 1347,
          "tabId": "t.xxx"
        }
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "ALBJ4LvMO..." }
}
```

## Operation: Insert text into a cell

```json
{
  "requests": [
    {
      "insertText": {
        "location": { "index": 1349, "tabId": "t.xxx" },
        "text": "New text"
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "ALBJ4LvMO..." }
}
```

The index is the position within the cell's content, not the table index. Find it by inspecting the cell's content structure in `before.document.json`.

## Operation: Apply text style to a cell

```json
{
  "requests": [
    {
      "updateTextStyle": {
        "range": {
          "startIndex": 1340,
          "endIndex": 1347,
          "tabId": "t.xxx"
        },
        "textStyle": {
          "bold": true,
          "fontSize": { "magnitude": 11, "unit": "PT" },
          "weightedFontFamily": { "fontFamily": "Arial" }
        },
        "fields": "bold,fontSize,weightedFontFamily"
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "ALBJ4LvMO..." }
}
```

## Operation: Update cell borders or background

```json
{
  "requests": [
    {
      "updateTableCellStyle": {
        "tableRange": {
          "tableCellLocation": {
            "tableStartLocation": { "index": 1070, "tabId": "t.xxx" },
            "rowIndex": 3,
            "columnIndex": 0
          },
          "rowSpan": 1,
          "columnSpan": 1
        },
        "tableCellStyle": {
          "backgroundColor": {
            "color": { "rgbColor": { "red": 0.9, "green": 0.9, "blue": 0.9 } }
          }
        },
        "fields": "backgroundColor"
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "ALBJ4LvMO..." }
}
```

## Edit backwards rule

When one `batchUpdate` contains multiple index-based edits (insert, delete, updateTextStyle on different ranges), sort requests in descending order by startIndex. Edits at higher indices do not affect the positions of edits at lower indices. This avoids index recalculation.

Example — correct order:
```json
{
  "requests": [
    { "deleteContentRange": { "range": { "startIndex": 500, "endIndex": 510 } } },
    { "deleteContentRange": { "range": { "startIndex": 200, "endIndex": 210 } } }
  ]
}
```

The edit at index 200 does not change index 500 because the edit at 500 comes first.

## Verification

After any structural edit, re-read the document and inspect the table using the inspect script above. Compare:

1. Raw text (the actual `textRun.content` string, not `.trim()`)
2. `rowSpan` and `columnSpan` values for every affected cell
3. Text styling (bold, fontSize, fontFamily)

Do not verify from old output. Fresh read only.
