---
name: google-workspace
description: Use Google Workspace REST APIs via gws CLI. Authentication handled by gws; no credential boilerplate in scripts. Covers Docs, Drive, Sheets, Gmail, Calendar.
---

# Google Workspace

Use `gws` as the primary API transport. `gws` handles authentication, token refresh, and scopes. When this skill is invoked, follow this workflow over unrelated prior context unless the user explicitly asks for something else.

## Auth

```bash
gws auth status
```

If not authenticated: `gws auth setup --login` (first time) or `gws auth login` (subsequent).

If you need the REST fallback scripts (gws unavailable or raw JSON inspection needed), export credentials once:

```bash
mkdir -p .google-workspace/credentials
gws auth export --unmasked > .google-workspace/credentials/default.json
```

## Docs task workflow

Ensure your working directory is the project root (where `.google-workspace/` lives). Then, for any Docs edit, follow these steps in order. Do not skip.

0. Confirm cwd is the project root: `test -d .google-workspace || echo "NOT IN PROJECT ROOT"`
1. Read `references/docs-editing-workflow.md`.
2. If the task involves a table, read `references/docs-table-operations.md`.
3. Create a task workspace:
   ```bash
   mkdir -p .google-workspace/tasks/<task-slug>
   ```
4. Copy the task runner once per project (skip if already present):
   ```bash
   cp skills/google-workspace/scripts/gws-docs-task.mjs .google-workspace/scripts/
   ```
5. Read the document and save to the task workspace:
   ```bash
   node .google-workspace/scripts/gws-docs-task.mjs get <documentId> .google-workspace/tasks/<task-slug>
   ```
   This calls `gws docs documents get` with `includeTabsContent=true` and saves to `before.document.json`.

6. Inspect the saved JSON. If a table edit, read the table structure, capture `revisionId`, and note every affected cell's `rowSpan`, `columnSpan`, and text styling. Use `jq` on the saved JSON, or write a short inspection script under the task workspace.

7. Determine the exact final state. If the requested edit could produce more than one final state (e.g. splitting a cell and the user says both "one with text, one empty" and "one with first word, one with second word"), stop and ask which state the user wants. Present both options as a mini-table.

8. Write the request JSON to `.google-workspace/tasks/<task-slug>/requests.json`. Use the recipes in `references/docs-request-recipes.md` as a starting point. Include `writeControl.requiredRevisionId` when possible.

9. Preview:
   ```bash
   node .google-workspace/scripts/gws-docs-task.mjs preview <documentId> .google-workspace/tasks/<task-slug>
   ```
   Verify the preview output matches your intent. Never preview inside `node -e`.

10. Apply:
    ```bash
    node .google-workspace/scripts/gws-docs-task.mjs apply <documentId> .google-workspace/tasks/<task-slug>
    ```

11. Re-read and verify:
    ```bash
    node .google-workspace/scripts/gws-docs-task.mjs get <documentId> .google-workspace/tasks/<task-slug>
    ```
    This saves to `after.document.json`. Compare raw spans and raw text (no `.trim()`) against your expected final state. Verify only from this fresh read, never from cached output or old terminal logs.

## Hard rules

- Never use `node -e`, here-doc, or inline shell-embedded JavaScript for Google Workspace API calls. Write a `.mjs` file under `.google-workspace/tasks/<slug>/` and run it.
- Never handle OAuth tokens or credentials in scripts. `gws` does that.
- Never delete and recreate an existing table. Use targeted requests.
- Always preview structural edits before applying.
- Re-read the document after every `batchUpdate` that changes structure.
- Verify only from a fresh API read. Old output is stale.
- If user text could be split, deleted, or moved, ask before applying.
- Inspect `rowSpan` and `columnSpan` before any table structural edit.
- Edit backwards when multiple index-based edits go in one `batchUpdate`.
- Specify `tabId` in requests when the document has tabs.

## References

| File | Content |
|------|---------|
| `references/gws.md` | gws CLI usage, flags, schema |
| `references/docs-editing-workflow.md` | Full editing workflow with phases |
| `references/docs-table-operations.md` | Table operation patterns (unmerge, split, insert column, etc.) |
| `references/docs-request-recipes.md` | Copyable request JSON for common operations |
| `references/docs.md` | Docs API general reference, endpoints, structure rules |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/gws-docs-task.mjs` | Primary task runner. Copy to `.google-workspace/scripts/`. |
| `scripts/inspect-table.mjs` | Table inspector. Reads saved document JSON, not the API. |

Source scripts under `skills/google-workspace/scripts/` are read-only templates. Copy into `.google-workspace/scripts/` before using. Project-local copies can be freely adapted.

## Other APIs

| API | Reference |
|-----|-----------|
| Google Drive | `references/drive.md` |
| Google Sheets | `references/sheets.md` |
| Gmail | `references/gmail.md` |
| Google Calendar | `references/calendar.md` |
