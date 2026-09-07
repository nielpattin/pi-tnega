# pi-packages

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A private pnpm workspace of extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). The repository contains workspace packages, private extensions, and standalone TypeScript extensions. Selected packages are published independently to npm. The current publish workflow supports only `pi-reference` and `pi-station`.

Most Pi extension entrypoints are raw TypeScript files loaded directly by Pi. `pi-ide-pro` also includes VS Code and Neovim companions, and `pi-cortex` can build an optional Rust sidecar.

## Prerequisites

- Node.js `>=24.16.0`
- pnpm `>=11.22.0 <12`
- Pi coding agent 0.84 or newer
- Rust and Cargo for the optional `pi-cortex` sidecar
- VS Code 1.80 or newer or Neovim 0.11 or newer for the `pi-ide-pro` companions

## Installation

Install repository dependencies from the root directory:

```bash
pnpm install
```

To load an extension from this checkout for a Pi session:

```bash
pi -e ./extensions/<extension-name>
```

Standalone extensions are loaded by their file path:

```bash
pi -e ./extensions/<extension-name>.ts
```

For a published package, follow its package README. For example:

```bash
pi install npm:@nielpattin/pi-station
```

## Extension inventory

Package status below reflects the manifests in this checkout. A workspace package is not necessarily published to npm.

| Extension                                                           | Purpose                                                                                    | Package status                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [ask-user](./extensions/ask-user/README.md)                         | Structured multiple-choice questions for the user.                                         | Private package, no version                                                                                                                     |
| [btw](./extensions/btw/README.md)                                   | Independent side chat with explicit handoff to the parent session.                         | `@nielpattin/btw` `0.1.0`                                                                                                                       |
| [pi-handoff](./extensions/pi-handoff/README.md)                     | Extract useful context from the active session branch to a private handoff file.           | Private package, no version                                                                                                                     |
| [notification](./extensions/notification/README.md)                 | Audio alerts when an agent turn completes.                                                 | Local extension, no `package.json`                                                                                                              |
| [tps](./extensions/tps/README.md)                                   | Live token speed, TTFT, and agent-loop usage metrics.                                      | Local extension, no `package.json`                                                                                                              |
| [pi-acks](./extensions/pi-acks/README.md)                           | Named OpenAI Codex subscription OAuth account management.                                  | Private package, `0.1.0`                                                                                                                        |
| [pi-code-block-picker](./extensions/pi-code-block-picker/README.md) | Search and copy code blocks from session history.                                          | Local extension, no `package.json`                                                                                                              |
| [pi-codex-usage](./extensions/pi-codex-usage/README.md)             | OpenAI Codex usage monitoring and response settings.                                       | Local extension, no `package.json`                                                                                                              |
| [pi-compact-pro](./extensions/pi-compact-pro/README.md)             | Configurable compaction thresholds, summary models, and structured summaries.              | Local extension, no `package.json`                                                                                                              |
| [pi-constellation](./extensions/pi-constellation/README.md)         | Deterministic compaction and incremental session inspection.                               | Private package, no version                                                                                                                     |
| [pi-cortex](./extensions/pi-cortex/README.md)                       | Code search, AST analysis, call graphs, and agent memory.                                  | Workspace package, `0.1.0`; optional Rust sidecar                                                                                               |
| pi-ide-pro                                                          | VS Code and Neovim context, file autocomplete, and diagnostics for Pi.                     | Workspace package, `0.1.0`; [VS Code](./extensions/pi-ide-pro/vscode/README.md) and [Neovim](./extensions/pi-ide-pro/nvim/README.md) companions |
| [pi-processes](./extensions/pi-processes/README.md)                 | Retained background process supervision and a process dashboard.                           | `@nielpattin/pi-processes` `0.1.0`                                                                                                              |
| [pi-reference](./extensions/pi-reference/README.md)                 | Local and Git project references with `@alias` autocomplete.                               | `@nielpattin/pi-reference` `0.2.1`; publish workflow target                                                                                     |
| [pi-skill-toggle](./extensions/pi-skill-toggle/README.md)           | Toggle automatic skill invocation between enabled and manual-only modes.                   | Private package, `0.1.0`                                                                                                                        |
| [pi-station](./extensions/pi-station/README.md)                     | Status bar, fixed editor layout, bash mode, stash, history, undo/redo, and hashline tools. | `@nielpattin/pi-station` `0.9.0`; publish workflow target                                                                                       |
| [pi-web-access](./extensions/pi-web-access/README.md)               | Multi-engine web search, deep research, site outline discovery, and content extraction.    | `@nielpattin/pi-web-access` `0.1.0`                                                                                                             |
| [pi-subagent](./extensions/pi-subagent/README.md)                   | Direct subagent delegation with profile-selected child Pi sessions in Herdr panes.         | `@nielpattin/pi-subagent` `0.1.0`                                                                                                               |
| [tool-selector](./extensions/tool-selector/README.md)               | Inspect active and inactive tools in the current session.                                  | Local extension, no `package.json`                                                                                                              |
| [treepluss](./extensions/treepluss/README.md)                       | Enhanced conversation tree and TUI turn rendering.                                         | Local extension, no `package.json`                                                                                                              |

### Standalone extensions

These files live directly under `extensions/` and do not have package manifests:

| File                                                                        | Capability                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`continue-after-compaction.ts`](./extensions/continue-after-compaction.ts) | Resumes the active task after successful compaction.                         |
| [`describe-image.ts`](./extensions/describe-image.ts)                       | Provides the `describe_image` vision tool with configured fallback models.   |
| [`double-esc.ts`](./extensions/double-esc.ts)                               | Requires a second `Esc` press to abort an active generation.                 |
| [`files.ts`](./extensions/files.ts)                                         | Provides `/files` to list session files and open a selected file in VS Code. |
| [`startup-timer.ts`](./extensions/startup-timer.ts)                         | Provides `/startup-time` to measure extension startup overhead.              |
| [`stats.ts`](./extensions/stats.ts)                                         | Provides `/stats` for daily token usage across Pi sessions.                  |

## Common entrypoints

Read each extension's documentation for complete commands and configuration. The main entrypoints include:

- `pi-subagent`: `/wr`, `/wr.profile`, `agent_spawn`, `agent_list`, `agent_recover`, and `agent_cancel`
- `pi-station`: `/station`, `/stash-history`, `/bash-mode`, and `/bash-reset`
- `pi-compact-pro`: `/compaction`
- `pi-processes`: `/processes`
- `pi-reference`: `/references`
- `pi-acks`: `/accounts`
- `pi-cortex`: `/cc-index`, `/cc-status`, `/cc-clean`, `/cc-ast`, `/cc-remember`, `/cc-recall`, and `/cc-forget`
- `pi-web-access`: `/websearch`, `web_search`, `web_research`, `fetch_content`, and `outline_site`
- `btw`: `/btw` and `/btw:inject`
- Local utilities: `/handoff`, `/codeblocks`, `/codex-usage`, `/toggle-skills`, `/tools`, `/files`, `/stats`, and `/startup-time`

## Development

Run commands from the repository root:

| Command           | Purpose                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `pnpm test`       | Run Node's test runner across all extension tests (`tests/*/**/*.mjs`).              |
| `pnpm lint`       | Check files with `oxlint`.                                                           |
| `pnpm lint:fix`   | Apply available `oxlint` fixes.                                                      |
| `pnpm typecheck`  | Run TypeScript with the root config and every existing `extensions/*/tsconfig.json`. |
| `pnpm fmt`        | Format files with `oxfmt`.                                                           |
| `pnpm package`    | Build the `pi-ide-pro` VS Code VSIX at `extensions/pi-ide-pro/dist/pi-ide-pro.vsix`. |
| `pnpm sync:repos` | Synchronize configured reference repositories.                                       |

For a package-specific check:

```bash
pnpm --dir extensions/pi-subagent check
```

Build the optional `pi-cortex` sidecar with:

```bash
pnpm --dir extensions/pi-cortex build:rust
```

## Project structure

```text
agent-root/
├── extensions/                  # Pi extension directories and standalone .ts files
│   └── pi-ide-pro/              # Pi extension plus VS Code and Neovim companions
├── tests/                       # Node test files for extensions (pi-web-access, pi-subagent)
├── scripts/                     # release, repository sync, and typecheck scripts
├── .github/workflows/           # manual npm publishing workflow
├── .githooks/                   # versioned Git hooks
├── package.json                 # root scripts and shared dependencies
├── pnpm-workspace.yaml          # workspace globs
└── tsconfig.json                # root TypeScript project
```

The workspace configuration also includes `packages/*`, although the current extension code is under `extensions/`.

## Publishing

Publishing is manual, tag based, and limited by `.github/workflows/publish.yml` to `pi-reference` and `pi-station`. The workflow:

1. Checks out the requested tag.
2. Verifies that the tag matches the package name and version.
3. Runs the package's `build` script when one exists.
4. Runs `pack --dry-run`.
5. Publishes the package to npm.

Trigger the workflow directly with GitHub CLI:

```bash
gh workflow run publish.yml \
  -f package=pi-station \
  -f tag='@nielpattin/pi-station@0.9.0'
```

The checked-in `publish.sh` helper still searches for manifests under `packages/`, while the workflow uses `extensions/`. Use the workflow command above until that helper is corrected.

## License

MIT
