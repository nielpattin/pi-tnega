# Changelog

This file summarizes the latest package changelog entries. Package changelogs remain the source of truth for package-specific history.

<!-- package-changelog-summary -->

### @nielpattin/pi-reference

## 0.2.1

### Patch Changes

- 36eebc9: Rework git sync reliability, autocomplete UX, and system prompt guidance.
    - **Bounded concurrency + retry**: Git references sync through a worker pool (3 at a time) with network-error retry (2 retries, backoff). Fixes random `getaddrinfo() thread failed to start` failures on Windows from spawning too many git processes at once.
    - **Same-target+branch deduplication**: Two aliases pointing at the same repo+branch trigger only one git operation.
    - **Footer sync status**: Sync progress moved from an above-editor widget to the extension status bar. Shows `⠧ Syncing references... 2/15` (animated spinner + counter) during sync, reverts to `refs: N` when idle.
    - **Batched error summary**: Network errors collected across all repos, shown as a single warning toast at the end of sync instead of one per repo.
    - **System prompt guidance restored**: `@alias/path` tokens stay as literal text in the message. The system prompt instructs the agent to split on the first `/`, map the alias to its path, and append the rest (may be a file or directory).
    - **`@alias` autocomplete**: Tab on an alias inserts `@alias/` (slash, no space) so the dropdown stays open and lists root contents. Labels show just filenames in cyan. Built-in file suggestions no longer leak after a completed reference token. Alias resolution uses prefix matching so aliases containing `/` work correctly.

<!-- /package-changelog-summary -->
