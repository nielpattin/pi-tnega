# Changelog

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

## 0.2.1

### Patch Changes

- 8b63e09: Fix session-approval suggestion for chained bash commands. Previously a command like `cd pkg && git push` produced a `cd *` session pattern that whitelisted the benign prefix and, via the trailing-`*` optional match, silently approved arbitrary chains (`cd x && rm -rf /`). Now chained commands (containing `&&`, `||`, `;`, `|`, `&`) derive the session pattern from the matched rule that triggered the prompt, and the "for this session" option is hidden entirely when no specific rule exists (catch-all `*` or implicit ask).
- 3ddcc54: Update Pi peer dependencies to use `*` range per extension standard. Update `diff` to v9, `file-type` to v22, `esbuild` to ^0.28.1, and other dev dependencies to latest.
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

## 0.2.0

### Minor Changes

- 2dfb0b1: Add the initial `@nielpattin/pi-permission-system` package and document its companion integration with `@nielpattin/pi-subagents`.

### Patch Changes

- 2dfb0b1: Play the configured permission request sound before opening interactive permission prompts.

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-29

### Added

- Initial `@nielpattin/pi-permission-system` package.
- Imported permission enforcement extension source, tests, config example, schema, and user-facing docs from `@gotgenes/pi-permission-system`.
- Updated package metadata, docs, and service key for the `@nielpattin` scope.
- Documented interoperability with `@nielpattin/pi-subagents`.

### Attribution

- Based on [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system).
- `@gotgenes/pi-permission-system` is based on [`MasuRii/pi-permission-system`](https://github.com/MasuRii/pi-permission-system).
