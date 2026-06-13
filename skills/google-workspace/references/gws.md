# gws CLI Reference

`gws` is the primary transport for all Google Workspace API calls. It handles OAuth, token refresh, and scopes automatically.

Documentation: https://github.com/googleworkspace/cli

## Auth

```bash
gws auth status           # check current state
gws auth setup --login    # first-time: create project, enable APIs, OAuth
gws auth login            # re-authenticate or change scopes
gws auth export --unmasked > path/to/creds.json  # portable credentials (rarely needed)
```

gws stores encrypted credentials at `~/.config/gws/`. API scripts should never read or write tokens directly.

## Syntax

```bash
gws <service> <resource> <method> [flags]
```

## Key flags

| Flag | Purpose |
|------|---------|
| `--params '<JSON>'` | URL/query parameters |
| `--json '<JSON>'` | Request body (POST/PUT/PATCH) |
| `--dry-run` | Validate without calling the API |
| `--format <json\|table\|yaml\|csv>` | Output format (default: json) |
| `--page-all` | Auto-paginate through all results |
| `--sanitize <TEMPLATE>` | Screen responses through Model Armor |

## Inspect a method

```bash
gws schema docs.documents.batchUpdate
gws schema drive.files.list
```

Use `gws schema` output to build `--params` and `--json` values.

## Docs examples

```bash
# Read a document
gws docs documents get --params '{"documentId":"DOC_ID","includeTabsContent":true}'

# Batch update
gws docs documents batchUpdate \
  --params '{"documentId":"DOC_ID"}' \
  --json '{"requests":[{"insertText":{"location":{"index":1},"text":"Hello"}}]}'

# Dry-run a batch update
gws docs documents batchUpdate \
  --params '{"documentId":"DOC_ID"}' \
  --json '{"requests":[...]}' \
  --dry-run
```

## Drive examples

```bash
gws drive files get --params '{"fileId":"DOC_ID","supportsAllDrives":true,"fields":"id,name,capabilities(canEdit)"}'
```

## gws vs direct REST

gws is preferred over direct REST scripts because:
- No credential file reading or token refresh code
- No manual `fetch()` with bearer tokens
- `--dry-run` for safe previews
- Structured output with multiple formats
- `gws schema` for request/response shapes

If you must use direct REST (gws unavailable), export credentials with `gws auth export --unmasked` and use the REST endpoint URLs from `references/docs.md`. This is a fallback path.
