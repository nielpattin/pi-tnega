# Google Docs API Reference

Use this reference after reading `../SKILL.md`. Prefer `gws` for all API calls. The REST endpoints and request shapes below map to `gws` commands.

## gws-first approach

Read the document:

```bash
gws docs documents get --params '{"documentId":"DOC_ID","includeTabsContent":true}'
```

Batch update:

```bash
gws docs documents batchUpdate \
  --params '{"documentId":"DOC_ID"}' \
  --json '{"requests":[...],"writeControl":{"requiredRevisionId":"REV_ID"}}'
```

Use `gws schema docs.documents.batchUpdate` to inspect request/response shapes.

The REST endpoints below are for reference and for the rare case when `gws` is unavailable. When using direct REST, export credentials with `gws auth export --unmasked` and use the `read-doc.mjs` and `batch-update.mjs` fallback scripts.

## Required APIs

Enable these Google Cloud APIs in the OAuth project:

- Google Docs API
- Google Drive API, if you will check permissions/capabilities, inspect file metadata, copy files, list files, or manage sharing

Important: OAuth scopes and API enablement are separate. A token can have the right scopes while the Cloud project still rejects requests because the API is disabled.

For auth setup and credential export, see `../SKILL.md`.


## Endpoints

Read a document:

```text
GET https://docs.googleapis.com/v1/documents/{documentId}?includeTabsContent=true
```

Write document updates:

```text
POST https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate
```

Check Drive capabilities before writing. Do not check `capabilities.canRead`; reading is established by successful `files.get` or `documents.get`. For writes, require `capabilities.canEdit === true`.

```text
GET https://www.googleapis.com/drive/v3/files/{fileId}?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canEdit,canComment,canCopy,canDownload,canShare),owners(emailAddress,displayName),ownedByMe,shared
```

## Structure rules to respect

Google Docs edits are structure-sensitive. Fetch the document JSON with `includeTabsContent=true` once per phase, keep that JSON for calculations, and re-fetch after each `batchUpdate` that changes structure.

Key concepts:

- Indices are UTF-16 code-unit indices in the document model.
- Use `includeTabsContent=true` for documents with tabs.
- Many requests now accept `tabId`; include it when editing a specific tab.
- Body content uses an empty `segmentId` or omits `segmentId`.
- Headers, footers, and footnotes are separate segments with their own `segmentId`.
- Tables have a `tableStartLocation` using the table structural element's `startIndex` and usually `tabId`.
- Text insertion must be inside an existing paragraph, not directly at a table start index.
- Page breaks, section breaks, and footnote references cannot be inserted inside tables, headers, footers, footnotes, or equations.
- Deleting the last newline of a body/header/footer/footnote/table cell is invalid.
- Deleting individual table cells is invalid; use table row/column delete requests or delete content inside cells.
- When multiple edits affect indices, prefer requests from later indices to earlier indices, or re-read between phases.
- Do not fetch the same document repeatedly inside one phase. Reuse the current JSON until a write changes the structure.
- Do not use stale indices after any table insert/delete/merge/unmerge. Re-read, then recalculate.
- Verify writes from a fresh API read after the write. Do not use previous terminal output, temp files, cached JSON dumps, or old script logs as proof.
- `rowSpan` and `columnSpan` are inspectable fields in `tableCellStyle`, not editable fields for `updateTableCellStyle`. Use table structural requests such as `mergeTableCells` or `unmergeTableCells`.

## Read a document: always read styling before editing

Before any edit, read the document fully including textRun style properties. The document JSON returned by the API includes `textRun.textStyle` fields (`bold`, `fontSize`, `weightedFontFamily`, `foregroundColor`, `italic`, `underline`, `strikethrough`, `link`) and `paragraph.paragraphStyle` fields (`namedStyleType`, `alignment`, `spaceAbove`, `spaceBelow`, `lineSpacing`, `indentStart`, `indentEnd`). Use these to see the style before every change.

Without reading styling first, reinserted text or new table cells will inherit default or wrong styling (bold when it should be normal, wrong font size). In the document JSON, check these fields:

```text
paragraph.paragraphElements[].textRun.textStyle.bold
paragraph.paragraphElements[].textRun.textStyle.fontSize.magnitude
paragraph.paragraphElements[].textRun.textStyle.weightedFontFamily.fontFamily
paragraph.paragraphElements[].textRun.textStyle.foregroundColor
paragraph.paragraphStyle.namedStyleType
```

When inserting new content into a cell that had no content before, the new paragraph inherits the document default style. Apply the correct style explicitly with `updateTextStyle` in the same batchUpdate.

## REST fallback (when gws is unavailable)

If `gws` is not available, use the pre-built REST scripts in `skills/google-workspace/scripts/`. Copy them into `.google-workspace/scripts/`, export credentials, then adapt and run the project-local copies.

```bash
gws auth export --unmasked > .google-workspace/credentials/default.json
cp skills/google-workspace/scripts/read-doc.mjs .google-workspace/scripts/
cp skills/google-workspace/scripts/batch-update.mjs .google-workspace/scripts/
node .google-workspace/scripts/read-doc.mjs <documentId>
```

The fallback scripts use a shared credential-based `apiFetch` helper. See the script source for the full pattern. Do not paste credential handling code into `node -e`.

## Extract text runs with styling

Always extract styling alongside text content before any edit. This script helper reads text and style properties into an array so you can see what the document looks like before changing it:

```js
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
```

Print the runs to see what the document actually looks like:

```js
// Example: print all text runs with styling in a tab
const runs = extractStyledRuns(tab.body);
for (const r of runs) {
  console.log(`[${r.startIndex}-${r.endIndex}] ${r.bold ? 'BOLD ' : ''}${r.fontSize ? r.fontSize+'pt ' : ''}${r.namedStyleType}: ${JSON.stringify(r.text)}`);
}
```

## Finding tab IDs and content

A document can have top-level body content or tab content. Prefer tabs when present.

```js
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
```

## Finding text ranges

Use document JSON to find exact ranges. Avoid global replace for targeted edits.

```js
function findTextRuns(body, needle) {
  const matches = [];
  walkStructuralElements(body?.content || [], (element) => {
    const elements = element.paragraph?.elements || [];
    for (const paragraphElement of elements) {
      const text = paragraphElement.textRun?.content || "";
      const offset = text.indexOf(needle);
      if (offset >= 0) {
        matches.push({
          startIndex: paragraphElement.startIndex + offset,
          endIndex: paragraphElement.startIndex + offset + needle.length,
          fullRunStart: paragraphElement.startIndex,
          fullRunEnd: paragraphElement.endIndex,
          text,
        });
      }
    }
  });
  return matches;
}
```

## Set a paragraph heading

Use `updateParagraphStyle` with `namedStyleType`.

Valid common values:

- `NORMAL_TEXT`
- `TITLE`
- `SUBTITLE`
- `HEADING_1`
- `HEADING_2`
- `HEADING_3`
- `HEADING_4`
- `HEADING_5`
- `HEADING_6`

Request:

```js
const requests = [
  {
    updateParagraphStyle: {
      range: { startIndex, endIndex, tabId },
      paragraphStyle: { namedStyleType: "HEADING_2" },
      fields: "namedStyleType",
    },
  },
];
```

Notes:

- The range only needs to overlap the paragraph; using the paragraph's full range is simplest.
- To change how all `HEADING_2` paragraphs look, use `updateNamedStyle`, not repeated paragraph edits.
- To make generated or native TOC entries detect headings, use named heading styles rather than just bold/large text.

## Update heading appearance globally

Use `updateNamedStyle` to change the named style definition.

```js
const requests = [
  {
    updateNamedStyle: {
      namedStyle: {
        namedStyleType: "HEADING_2",
        textStyle: {
          bold: true,
          foregroundColor: { color: { rgbColor: { red: 0.1, green: 0.2, blue: 0.5 } } },
          fontSize: { magnitude: 14, unit: "PT" },
        },
        paragraphStyle: {
          spaceAbove: { magnitude: 12, unit: "PT" },
          spaceBelow: { magnitude: 6, unit: "PT" },
        },
      },
      fields: "textStyle,paragraphStyle",
      tabId,
    },
  },
];
```

## Insert a page break

Use `insertPageBreak`.

```js
const requests = [
  {
    insertPageBreak: {
      location: { index, tabId },
    },
  },
];
```

Rules:

- Insert inside an existing body paragraph.
- Do not insert inside tables, equations, headers, footers, or footnotes.
- If the goal is "page break before heading", find the heading paragraph start and insert immediately before or inside the paragraph boundary where valid. If the API rejects the exact boundary, insert a newline before the heading first, re-read, then insert the page break in that paragraph.

## Insert a section break

Use section breaks when headers, footers, margins, or page setup should differ by section.

```js
const requests = [
  {
    insertSectionBreak: {
      sectionType: "NEXT_PAGE",
      location: { index, tabId },
    },
  },
];
```

Common section types include `NEXT_PAGE` and `CONTINUOUS`.

## Create a header

Creating a header returns a new `headerId`. Because later requests cannot refer to a reply value inside the same JSON body, use two phases.

Phase 1:

```js
const created = await batchUpdate(documentId, [
  {
    createHeader: {
      type: "DEFAULT",
    },
  },
]);
const headerId = created.replies?.[0]?.createHeader?.headerId;
if (!headerId) throw new Error("createHeader did not return headerId");
```

Phase 2:

```js
await batchUpdate(documentId, [
  {
    insertText: {
      endOfSegmentLocation: { segmentId: headerId, tabId },
      text: "Document header\n",
    },
  },
  {
    updateTextStyle: {
      range: { segmentId: headerId, startIndex: 0, endIndex: "Document header".length, tabId },
      textStyle: { bold: true },
      fields: "bold",
    },
  },
]);
```

If a default header already exists, `createHeader` returns an error. Re-read the document and inspect:

- `documentStyle.defaultHeaderId`
- section `sectionStyle.defaultHeaderId`
- `headers` map

Then update the existing header segment instead of creating a new one.

## Update an existing header or footer

Headers and footers are separate segments. To replace content safely:

1. Read the segment content from `doc.headers[headerId].content` or `doc.footers[footerId].content`.
2. Preserve the final newline.
3. Delete from the first content index through the index before the final newline.
4. Insert new text into that segment.

Example shape:

```js
const requests = [
  {
    deleteContentRange: {
      range: { segmentId: headerId, startIndex: contentStart, endIndex: contentEndBeforeFinalNewline, tabId },
    },
  },
  {
    insertText: {
      location: { segmentId: headerId, index: contentStart, tabId },
      text: "New header text",
    },
  },
];
```

## Create a footer

Use the same two-phase pattern as headers:

```js
const created = await batchUpdate(documentId, [
  {
    createFooter: {
      type: "DEFAULT",
    },
  },
]);
const footerId = created.replies?.[0]?.createFooter?.footerId;
```

Then insert text into `segmentId: footerId`.

## Clarify ambiguous table edits

If a user asks to split, move, or delete table text and the target text would be partly removed or redistributed, ask a short clarification before writing. Examples:

- "Split `Quản lý` into `Quản` and `lý`" means two non-empty cells.
- "Split `Quản lý` into one cell with the text and one empty cell" means keep the full `Quản lý` text in the first cell and create an empty adjacent cell.
- "Split into `Quản` and empty" means delete `lý`, so confirm before doing it.

Never delete part of a user's text because a split instruction is ambiguous.

## Insert a table column

Use `insertTableColumn` with a `tableCellLocation`.

```js
const requests = [
  {
    insertTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: tableStartIndex, tabId },
        rowIndex: 0,
        columnIndex: 1,
      },
      insertRight: true,
    },
  },
];
```

Notes:

- `tableStartIndex` is the structural element's `startIndex`, not the first cell's text index.
- If the reference cell is merged, the new column is inserted relative to the merged cell span.
- Re-read the document after insertion before writing text into the new column; table cell content indices change.

## Resize table columns

Use `updateTableColumnProperties`.

```js
const requests = [
  {
    updateTableColumnProperties: {
      tableStartLocation: { index: tableStartIndex, tabId },
      columnIndices: [0, 1],
      tableColumnProperties: {
        widthType: "FIXED_WIDTH",
        width: { magnitude: 72, unit: "PT" },
      },
      fields: "widthType,width",
    },
  },
];
```

## Delete a table column

Use `deleteTableColumn`. Provide any cell in the column to delete as the reference location. The column containing that cell is removed.

```js
const requests = [
  {
    deleteTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: tableStartIndex, tabId },
        rowIndex: 0,
        columnIndex: 1,
      },
    },
  },
];
```

Important: Before deleting a column, inspect the full table structure. Check every row for merged cells (`tableCell.tableCellStyle?.rowSpan` and `columnSpan`). A column containing part of a merged cell cannot be deleted directly — unmerge first or use a different approach.

## Merge table cells

```js
const requests = [
  {
    mergeTableCells: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStartIndex, tabId },
          rowIndex: 0,
          columnIndex: 0,
        },
        rowSpan: 1,
        columnSpan: 2,
      },
    },
  },
];
```

## Unmerge table cells

A merged cell is a single cell spanning multiple rows or columns. To split it back into individual cells, use the dedicated `unmergeTableCells` request. Do not try to unmerge by sending `mergeTableCells` with `rowSpan: 1` and `columnSpan: 1`; that is a no-op for existing merged cells.

```js
const requests = [
  {
    unmergeTableCells: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStartIndex, tabId },
          rowIndex: 0,
          columnIndex: 0,
        },
        // Use the merged cell's current span, or a 1x1 range pointing at the merged head cell.
        rowSpan: 1,
        columnSpan: 1,
      },
    },
  },
];
```

Notes:

- `unmergeTableCells` keeps the merged cell's text in the head cell and creates empty cells for the split area.
- `columnSpan` and `rowSpan` are reported under `tableCellStyle`, but they are not allowed fields for `updateTableCellStyle`. Do not attempt to set them directly.
- After unmerge, re-read the document and verify the affected row from the fresh JSON.

Fallback when unmerge fails:

1. Stop making structural requests and re-read the table JSON from the API.
2. Print every row and cell with `rowSpan`, `columnSpan`, and text. Confirm which cell is still merged.
3. Check that you used `unmergeTableCells`, not `mergeTableCells` and not `updateTableCellStyle` with `columnSpan`.
4. Do not delete and recreate the whole table. If the API refuses the unmerge request, preserve the table by using targeted alternatives: clear or move content with `deleteContentRange` and `insertText`, insert/delete columns with table requests, or ask for confirmation before any destructive fallback.
5. If a merged cell spans multiple logical columns, avoid additional merges until you can prove the requested range maps to the intended rows and columns from the re-read JSON.


## Inserting text into multiple table cells

When inserting text into multiple cells in one batchUpdate, order requests from the highest index to the lowest index (back to front). Inserting text shifts all subsequent indices forward. Front-to-back insertion requires recalculating indices after each insert, which is error-prone.

Correct pattern:

```js
// Collect text inserts for each cell, sorted by index descending
const cells = [
  { index: 1200, text: "Bottom cell" },
  { index: 1150, text: "Middle cell" },
  { index: 1070, text: "Top cell" },
];
cells.sort((a, b) => b.index - a.index); // descending: highest first

const requests = cells.map(c => ({
  insertText: {
    location: { index: c.index, tabId },
    text: c.text,
  },
}));
await batchUpdate(documentId, requests);
```

## Updating cell text style after insert

New text inserted into a table cell inherits the style of the paragraph it was inserted into. When inserting into an empty cell (a cell whose paragraph has no textRun), the new text may get the document default style (normal weight, 11 PT). To ensure the correct style, include `updateTextStyle` in the same batchUpdate.

```js
const requests = [
  {
    insertText: {
      location: { index: cellStart, tabId },
      text: "Cell value",
    },
  },
  {
    updateTextStyle: {
      range: { startIndex: cellStart, endIndex: cellStart + "Cell value".length, tabId },
      textStyle: { bold: false, fontSize: { magnitude: 11, unit: "PT" } },
      fields: "bold,fontSize",
    },
  },
];
```

## Do not delete and recreate tables

Do not delete an existing table and recreate it with `insertTable` to change its structure. This loses all existing cell formatting (bold, font size, alignment, background color, borders). Use targeted structural requests instead:

- `deleteTableColumn` / `insertTableColumn` for column operations
- `mergeTableCells` / `unmergeTableCells` for merge changes
- `updateTableCellStyle` for style-only changes
- `deleteContentRange` to clear cell text without removing the cell

Read the existing table structure carefully. Check every row's `rowSpan` and `columnSpan` values before making structural changes. Merged cells cannot be individually deleted -- work at the column/row level.

If a targeted request fails, do not escalate to table deletion. Re-read the table, explain the failed request, and either choose another targeted request or ask for confirmation.

## Inspecting a table before editing

Before any table edit, print the full table structure including cell spans:

```js
function inspectTable(docBody, tableStartIndex) {
  walkStructuralElements(docBody?.content || [], (element) => {
    if (!element.table) return;
    const table = element.table;
    // Find this specific table by checking if its structural startIndex matches
    if (element.startIndex !== tableStartIndex) return;

    console.log(`Table at index ${element.startIndex}`);
    console.log(`Rows: ${table.tableRows.length}, Cols: ${table.columns}`);
    for (let r = 0; r < table.tableRows.length; r++) {
      const row = table.tableRows[r];
      for (let c = 0; c < row.tableCells.length; c++) {
        const cell = row.tableCells[c];
        const cs = cell.tableCellStyle;
        const span = cs?.columnSpan && cs?.rowSpan
          ? `${cs.columnSpan}x${cs.rowSpan}`
          : "1x1";
        // Extract text from cell
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
```

Read table styling (bold, font size) for each cell textRun before editing:

```js
function inspectTableStyling(docBody, tableStartIndex) {
  walkStructuralElements(docBody?.content || [], (element) => {
    if (!element.table) return;
    if (element.startIndex !== tableStartIndex) return;
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
```

## Known limitations

- The Docs API does not reliably create or refresh native auto-generated TOC. Avoid relying on it.
- Page numbers rendered in headers/footers cannot be set or controlled via the API.
- Content cannot be inserted directly into a placeholder (e.g., `{{TOC}}`).
- After complex structural edits (especially table column insertions/deletions and cell merges), re-read the document JSON to recalculate indices before the next batchUpdate.
- The `documents.get` response may omit empty trailing paragraphs. Always account for the structural newline paragraph at the end of each section, table cell, and segment.
