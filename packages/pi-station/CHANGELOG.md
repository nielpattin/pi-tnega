# Changelog

## 0.9.0

### Minor Changes

- 69ce847: Add esbuild build pipeline (dist/) and show edit diff in chat transcript.

   - pi-station is now a built package: `pnpm build` bundles index.ts and
     features/hashline/edit-tool.ts to dist/ via esbuild, with Pi/typebox/node
     builtins marked external. `pi.extensions` points at `./dist/index.js`.
     dist/ is gitignored and rebuilt locally + in CI (publish.yml gained a
     "Build package" step). After editing pi-station source, run
     `pnpm --dir packages/pi-station build` before /reload.
   - The edit tool's renderCall now computes its diff preview synchronously
     (new `computeEditPreviewSync`) whenever a renderable edit input is
     present, so the diff appears in the chat the moment the permission
     dialog opens. The previous gate on argsComplete/executionStarted never
     became true on the visible render frames during the permission prompt,
     so the diff was never shown.

## 0.8.0

### Minor Changes

- 7ba6ff3: Add undo/redo to the prompt editor input.

   - Undo: Ctrl+Z (also keeps the existing Ctrl+-). Intercepts the parent editor's undo to capture pre-undo state into a redo stack.
   - Redo: Ctrl+Y. Overrides Pi's yank (kill-ring paste) keybinding. Configurable via `shortcuts.redo` in station settings.
   - Redo stack is cleared on any new edit (standard undo/redo semantics), enforced via monkey-patched UndoStack.push.
   - Both keys are configurable via `shortcuts.undo` and `shortcuts.redo` in station settings.

   Fix cache_hit segment to use `latestCacheHitRate` from usage stats instead of computing hit rate from cumulative cacheRead/promptTokens. This matches the built-in footer's per-message cache hit rate display.

### Patch Changes

- 3ddcc54: Update Pi peer dependencies to use `*` range per extension standard. Update `diff` to v9, `file-type` to v22, `esbuild` to ^0.28.1, and other dev dependencies to latest.

## 0.7.0

### Minor Changes

- d77095c: Add cache_hit (CH%) segment, fix cost segment to show actual cost, move (auto) indicator to context_pct segment

### Patch Changes

- 3324736: Fix terminal split selection so ST-terminated OSC 8 hyperlinks keep their visible file paths highlighted and copied.
- 2dfb0b1: Update Pi host peer dependency ranges to `^0.78.0`.
- 1da0dd9: Remove pi-station's custom read tool renderer so read output uses the default tool shell.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added Hashline read and edit tools with pi-station read row rendering.
- Added undo/redo to the prompt editor input. Undo: Ctrl+Z (also keeps Ctrl+-). Redo: Ctrl+Y (overrides yank). Both configurable via `shortcuts.undo` and `shortcuts.redo` in station settings.

### Fixed

- Chat scrollbar now has 1 column of padding between content and scrollbar indicator.
- Cache_hit segment now uses `latestCacheHitRate` from usage stats instead of computing from cumulative tokens, matching the built-in footer display.

## 0.6.6

### Patch Changes

- 7424211: Modernize release and publish metadata for the pnpm and Node 24 Changesets workflow.

## [0.6.5] - 2026-05-28

## [0.6.2] - 2026-05-19

### Fixed

- Mouse selection now copies only visible chat text, not trailing padding cells.

## [0.6.1] - 2026-05-18

### Added

- Chat selection can now stay active while scrolling the fixed-editor chat viewport with the mouse wheel.
