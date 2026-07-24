# @nielpattin/pi-reference

## 0.2.1

### Patch Changes

- 36eebc9: Rework git sync reliability, autocomplete UX, and system prompt guidance.

   - **Bounded concurrency + retry**: Git references sync through a worker pool (3 at a time) with network-error retry (2 retries, backoff). Fixes random `getaddrinfo() thread failed to start` failures on Windows from spawning too many git processes at once.
   - **Same-target+branch deduplication**: Two aliases pointing at the same repo+branch trigger only one git operation.
   - **Footer sync status**: Sync progress moved from an above-editor widget to the extension status bar. Shows `⠧ Syncing references... 2/15` (animated spinner + counter) during sync, reverts to `refs: N` when idle.
   - **Batched error summary**: Network errors collected across all repos, shown as a single warning toast at the end of sync instead of one per repo.
   - **System prompt guidance restored**: `@alias/path` tokens stay as literal text in the message. The system prompt instructs the agent to split on the first `/`, map the alias to its path, and append the rest (may be a file or directory).
   - **`@alias` autocomplete**: Tab on an alias inserts `@alias/` (slash, no space) so the dropdown stays open and lists root contents. Labels show just filenames in cyan. Built-in file suggestions no longer leak after a completed reference token. Alias resolution uses prefix matching so aliases containing `/` work correctly.

## 0.2.0

### Minor Changes

- 0514ff7: Add pi-reference package: project references for Pi. Declare local directories and Git repos as accessible to the agent via system prompt guidance and permission auto-allow.

   Features:

   - Config in settings.json `references` block (global + project, string/object entry forms)
   - Git repos cloned into ~/.cache/checkouts (reuses librarian cache path), refreshed on session start with 5-min throttle
   - @alias autocomplete: type @ to browse reference aliases (cyan), @alias/ to browse files, drill into directories
   - @alias/path tokens in submitted prompts are expanded to file content (or directory listings)
   - System prompt XML guidance for references with descriptions
   - Permission auto-allow via external_directory session rules
   - Footer status bar shows "refs: N"
   - Transient widget above editor shows "cloning owner/repo..." during git operations

   Extend PermissionsService with approveSessionRule() for cross-extension session-level allow rules.

## 0.1.0

### Initial release

Project references for the Pi coding agent. Declare local directories and Git repositories as accessible to the agent outside the current project.

**Configuration**

Add a `references` block to Pi settings (`~/.pi/agent/settings.json` global, `<project>/.pi/settings.json` project override):

```jsonc
{
   "references": {
      "docs": {
         "path": "../product-docs",
         "description": "Product documentation",
      },
      "sdk": {
         "repository": "anomalyco/opencode-sdk-js",
         "branch": "main",
         "description": "SDK source",
      },
      "effect": "Effect-TS/effect",
   },
}
```

Three entry forms: string shorthand (local if starts with `.`/`/`/`~`, otherwise git), local object (`path`/`description`/`hidden`), git object (`repository`/`branch`/`description`/`hidden`).

**Features**

- `@alias` autocomplete: type `@` to browse all reference aliases (cyan), `@alias/` to list files inside a reference, drill into subdirectories. Selecting a file inserts `@alias/path/to/file.ts` into the editor.
- `@alias/path` token expansion: on prompt submission, `@alias/path/to/file.ts` tokens are resolved to the reference's cache path and replaced with file content. Directory tokens get a listing. Large files (>100KB) get a placeholder.
- System prompt guidance: references with descriptions are injected as an XML block so the agent knows about them.
- Permission auto-allow: reference directories are pre-approved on the `external_directory` surface via `approveSessionRule()`, so the agent can read/grep/find/ls without prompts.
- Git materialization: repos cloned into `~/.cache/checkouts/<host>/<org>/<repo>` (reuses librarian cache path), refreshed on session start with a 5-minute throttle.
- Footer status bar: shows `refs: N` persistently.
- Clone widget: shows `cloning owner/repo...` above the editor during git operations, cleared when done.

**Changes to pi-permission-system**

- Added `approveSessionRule(surface, pattern)` to `PermissionsService` interface for cross-extension session-level allow rules.
