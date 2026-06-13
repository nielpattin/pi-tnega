# Google Workspace Skill

Uses `gws` as the primary API transport. No credential handling in scripts — `gws` manages OAuth and token refresh.

## Quick start

```bash
# Check auth
gws auth status

# First time: set up OAuth project and authenticate
gws auth setup --login

# Subsequent: re-authenticate or change scopes
gws auth login
```

## Docs editing workflow

1. Read `references/gws.md` for gws CLI usage.
2. Read `references/docs-editing-workflow.md` for the full editing workflow.
3. If the task involves a table, read `references/docs-table-operations.md`.
4. Create a task workspace: `.google-workspace/tasks/<slug>/`
5. Copy the task runner: `cp skills/google-workspace/scripts/gws-docs-task.mjs .google-workspace/scripts/`
6. Read: `node .google-workspace/scripts/gws-docs-task.mjs get <docId> .google-workspace/tasks/<slug>`
7. Inspect, plan, write requests, preview, apply, verify.

See `SKILL.md` for the full mandatory steps.

## Layout

```text
skills/google-workspace/
  SKILL.md                              Main skill (workflow, rules)
  README.md                             This file
  scripts/
    gws-docs-task.mjs                   Primary task runner (copy to project)
    inspect-table.mjs                   Table inspector (reads saved JSON)
    read-doc.mjs                        REST fallback: read document via direct API
    batch-update.mjs                    REST fallback: batch update via direct API
    find-text.mjs                       REST fallback: text search
    replace-text.mjs                    REST fallback: text replacement
  references/
    gws.md                              gws CLI reference
    docs-editing-workflow.md            Full editing workflow with phases
    docs-table-operations.md            Table operation patterns
    docs-request-recipes.md             Copyable request JSON recipes
    docs.md                             Docs API general reference
    drive.md                            Drive API reference
    sheets.md                           Sheets API reference
    gmail.md                            Gmail API reference
    calendar.md                         Calendar API reference
```

```text
.google-workspace/                      Project-local (in .gitignore)
  scripts/                              Copied runner scripts
  tasks/                                Per-task workspaces
    <task-slug>/
      before.document.json
      after.document.json
      requests.json
      notes.md
```

## gws vs direct REST

gws is the primary path. It handles auth, supports `--dry-run`, and produces structured JSON output.

The REST fallback scripts (`read-doc.mjs`, `batch-update.mjs`, etc.) require exported credentials at `.google-workspace/credentials/default.json`. Use them only when gws is unavailable.

Export credentials for REST fallback:
```bash
mkdir -p .google-workspace/credentials .google-workspace/scripts
gws auth export --unmasked > .google-workspace/credentials/default.json
test -s .google-workspace/credentials/default.json
```

## Privacy

`.google-workspace/` must be in `.gitignore`. Agents may check credential file existence and inspect top-level JSON keys for shape validation, but must never print or expose secret values.
