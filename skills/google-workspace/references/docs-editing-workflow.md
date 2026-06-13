# Docs Editing Workflow

Full editing workflow using `gws` and `gws-docs-task.mjs`. Follow these phases in order.

## Phase 1: Read

```bash
node .google-workspace/scripts/gws-docs-task.mjs get <documentId> .google-workspace/tasks/<slug>
```

This calls `gws docs documents get` with `includeTabsContent=true` and saves to `before.document.json` in the task directory.

Capture these values from the output:
- `documentId` — the doc you are editing
- `revisionId` — for `writeControl.requiredRevisionId` in batch updates
- `tabId` — from the tab object if the document has tabs (check `doc.tabs[0].tabProperties.tabId`)

## Phase 2: Inspect

Open `before.document.json` and find the target content. Key techniques:

**Find text with jq:**
```bash
# For tabbed documents (includeTabsContent=true):
jq -r '.tabs[0].documentTab.body.content[] | .. | .textRun?.content? // empty' before.document.json | grep -n "pattern"

# Fallback for non-tabbed documents:
# jq -r '.body.content[] | .. | .textRun?.content? // empty' before.document.json | grep -n "pattern"
```

**Find table by startIndex:**
```bash
# For tabbed documents (includeTabsContent=true):
jq '[.tabs[0].documentTab.body.content[] | select(.table != null) | {startIndex, rows: (.table.tableRows | length)}]' before.document.json

# Fallback for non-tabbed documents:
# jq '[.body.content[] | select(.table != null) | {startIndex, rows: (.table.tableRows | length)}]' before.document.json
```

**Inspect a table:**
```bash
node skills/google-workspace/scripts/inspect-table.mjs \
  .google-workspace/tasks/<slug>/before.document.json \
  <tableStartIndex>
```
Reads from the saved JSON file, no API call needed.

For table edits, note every affected cell:
- `rowSpan` and `columnSpan` from `tableCellStyle`
- Text content (exact string, not `.trim()`)
- Text styling (bold, fontSize, fontFamily, foregroundColor from `textStyle`)
- Cell content range (start/end indices from `startIndex`/`endIndex` on structural elements inside the cell)

## Phase 3: Plan

Write a `notes.md` in the task workspace with:
- The exact expected final state
- Affected cell coordinates and their new expected spans and text
- The revision ID captured in Phase 1
- The tab ID if the document has tabs

If the user's instructions are ambiguous (could produce two different final states), stop and present both options as mini-tables. Do not guess. Do not ask which is "better." Ask which state they want.

## Phase 4: Build requests

Write `requests.json` in the task workspace. Use the recipes in `references/docs-request-recipes.md` as starting points.

File format:
```json
{
  "requests": [
    {
      "updateTextStyle": { "range": { "startIndex": 1, "endIndex": 5 }, "textStyle": { "bold": true }, "fields": "bold" }
    }
  ],
  "writeControl": {
    "requiredRevisionId": "ALBJ4LvMO..."
  }
}
```

Rules:
- Sort index-based requests in descending order (largest indices first)
- Include `writeControl.requiredRevisionId` with the revision ID from Phase 1
- Include `tabId` in location objects if the document has tabs
- For table structural edits, use `tableStartLocation` with `index` and `tabId`

## Phase 5: Preview

```bash
node .google-workspace/scripts/gws-docs-task.mjs preview <documentId> .google-workspace/tasks/<slug>
```

This reads `requests.json` and passes it to `gws docs documents batchUpdate --dry-run`. Verify the preview matches your intent. Check:
- Correct table start index
- Correct row/column indices
- Correct text ranges (no off-by-one on UTF-16 indices)
- Correct tab ID

If the preview shows wrong indices or structure, fix `requests.json` and preview again. Do not apply until preview is clean.

## Phase 6: Apply

```bash
node .google-workspace/scripts/gws-docs-task.mjs apply <documentId> .google-workspace/tasks/<slug>
```

## Phase 7: Verify

After every `batchUpdate` that changes document structure:

```bash
node .google-workspace/scripts/gws-docs-task.mjs get <documentId> .google-workspace/tasks/<slug>
```

This saves to `after.document.json`. Compare the fresh read against your expected final state from `notes.md`:
- Do not verify from previous terminal output or cached files
- Compare raw text (the actual `textRun.content` string, not `.trim()`)  
- Compare `rowSpan` and `columnSpan` values
- Compare text styling fields

If the result does not match, re-read, re-plan, and re-apply.

## Multi-phase edits

Some edits need multiple `batchUpdate` calls (e.g. unmerge + edit text). After each `batchUpdate`:

1. Re-read (Phase 7)
2. Inspect the fresh data (Phase 2)
3. Build new requests using fresh indices (Phase 4)
4. Preview (Phase 5)
5. Apply (Phase 6)

Never reuse indices from a previous phase across a `batchUpdate`. Indices shift after structural changes.
