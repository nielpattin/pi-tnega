# Changelog

This file summarizes the latest package changelog entries. Package changelogs remain the source of truth for package-specific history.

<!-- package-changelog-summary -->

### @nielpattin/pi-permission-system

## 0.2.2

### Patch Changes

- 69ce847: Edit permission dialog no longer renders the diff (it lives in the chat
  transcript via the edit tool's own renderCall) and the session-approval
  option now shows an absolute directory path.
    - Removed the edit diff from the permission dialog message. The dialog
      (rendered as a bold accent title by Pi's ExtensionSelectorComponent)
      now carries only the ask text + options. The diff is shown in the chat
      by the edit tool's renderCall, mirroring OpenCode where the diff lives
      in the chat/body, not the status header.
    - `formatEditInputForPrompt` returns path-only (no replacement-count
      summary); the diff carries all detail.
    - `deriveApprovalPattern` now resolves the path to an absolute,
      case-preserving form before deriving the glob, so the "for this session"
      option reads `Yes, allow edit "C:/Users/.../proj/*" for this session`
      instead of the bare relative `./*`. Same directory-scoped scope (narrower
      than OpenCode's catch-all `*`), clearer label.

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

### @nielpattin/pi-station

## 0.9.0

### Minor Changes

- 69ce847: Add esbuild build pipeline (dist/) and show edit diff in chat transcript.
    - pi-station is now a built package: `pnpm build` bundles index.ts and
      features/hashline/edit-tool.ts to dist/ via esbuild, with Pi/typebox/node
      builtins marked external. `pi.extensions` points at `./dist/index.js`.
      dist/ is gitignored and rebuilt locally + in CI (publish.yml gained a
      "Build package" step). After editing pi-station source, run
      `/reload` after source edits.
    - The edit tool's renderCall now computes its diff preview synchronously
      (new `computeEditPreviewSync`) whenever a renderable edit input is
      present, so the diff appears in the chat the moment the permission
      dialog opens. The previous gate on argsComplete/executionStarted never
      became true on the visible render frames during the permission prompt,
      so the diff was never shown.

<!-- /package-changelog-summary -->
