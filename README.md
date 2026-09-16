# pi-packages

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A private pnpm workspace of extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). The repository contains workspace packages, private extensions, and standalone TypeScript extensions. Selected packages are published independently to npm.

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
pi install npm:@nielpattin/pi-web-access
```

## Extension inventory

Package status below reflects the manifests in this checkout. A workspace package is not necessarily published to npm.

| Extension                                                           | Purpose                                                                                                 | Package status                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-handoff](./extensions/pi-handoff/README.md)                     | Extract useful context from the active session branch to a private handoff file.                        | Private package, no version                                                                                                                     |
| [notification](./extensions/notification/README.md)                 | Audio alerts when an agent turn completes.                                                              | Local extension, no `package.json`                                                                                                              |
| [tps](./extensions/tps/README.md)                                   | Live token speed, TTFT, and agent-loop usage metrics.                                                   | Local extension, no `package.json`                                                                                                              |
| [pi-acks](./extensions/pi-acks/README.md)                           | Named OpenAI Codex subscription OAuth account management.                                               | Private package, `0.1.0`                                                                                                                        |
| [pi-code-block-picker](./extensions/pi-code-block-picker/README.md) | Search and copy code blocks from session history.                                                       | Local extension, no `package.json`                                                                                                              |
| [pi-codex-usage](./extensions/pi-codex-usage/README.md)             | OpenAI Codex usage monitoring and response settings.                                                    | Local extension, no `package.json`                                                                                                              |
| [pi-cortex](./extensions/pi-cortex/README.md)                       | Code search, AST analysis, call graphs, and agent memory.                                               | Workspace package, `0.1.0`; optional Rust sidecar                                                                                               |
| [pi-fast-resume](./extensions/pi-fast-resume/README.md)             | Instant session picker that streams 16KB partial reads instead of parsing full session JSONL.           | Private package, `0.1.0`                                                                                                                        |
| pi-ide-pro                                                          | VS Code and Neovim context, file autocomplete, and diagnostics for Pi.                                  | Workspace package, `0.1.0`; [VS Code](./extensions/pi-ide-pro/vscode/README.md) and [Neovim](./extensions/pi-ide-pro/nvim/README.md) companions |
| [pi-raft](./extensions/pi-raft/README.md)                           | Programmable `raft_exec` runtime for MCP calls, one-shot Tasks, and memory, with an activity dashboard. | `pi-raft` `0.1.0`                                                                                                                               |
| [pi-processes](./extensions/pi-processes/README.md)                 | Retained background process supervision and a process dashboard.                                        | `@nielpattin/pi-processes` `0.1.0`                                                                                                              |
| [pi-skill-toggle](./extensions/pi-skill-toggle/README.md)           | Toggle automatic skill invocation between enabled and manual-only modes.                                | Private package, `0.1.0`                                                                                                                        |
| [pi-web-access](./extensions/pi-web-access/README.md)               | Multi-engine web search, deep research, site outline discovery, and content extraction.                 | `@nielpattin/pi-web-access` `0.1.0`                                                                                                             |
| [tool-selector](./extensions/tool-selector/README.md)               | Inspect active and inactive tools in the current session.                                               | Local extension, no `package.json`                                                                                                              |
| [treepluss](./extensions/treepluss/README.md)                       | Enhanced conversation tree and TUI turn rendering.                                                      | Local extension, no `package.json`                                                                                                              |

### Standalone extensions

These files live directly under `extensions/` and do not have package manifests:

| File                                                                        | Capability                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`continue-after-compaction.ts`](./extensions/continue-after-compaction.ts) | Resumes the active task after successful compaction.                                                |
| [`describe-image.ts`](./extensions/describe-image.ts)                       | Provides the `describe_image` vision tool with configured fallback models.                          |
| [`double-esc.ts`](./extensions/double-esc.ts)                               | Requires a second `Esc` press to abort an active generation.                                        |
| [`files.ts`](./extensions/files.ts)                                         | Provides `/files` to list session files and open a selected file in VS Code.                        |
| [`startup-timer.ts`](./extensions/startup-timer.ts)                         | Provides `/startup-time` to measure extension startup overhead.                                     |
| [`stats.ts`](./extensions/stats.ts)                                         | Provides `/stats` for daily token usage across Pi sessions.                                         |
| [`herdr-agent-state.ts`](./extensions/herdr-agent-state.ts)                 | Reports agent state to the herdr runtime over its local socket; generated and overwritten by herdr. |

## Common entrypoints

Read each extension's documentation for complete commands and configuration. The main entrypoints include:

- `pi-raft`: `/raft`, `raft_exec`
- `pi-processes`: `/processes`
- `pi-acks`: `/accounts`
- `pi-cortex`: `/cc-index`, `/cc-status`, `/cc-clean`, `/cc-clean-all`, `/cc-ast`, `/cc-remember`, `/cc-recall`, and `/cc-forget`
- `pi-fast-resume`: `/fast-resume` (or `/resume` while hijack mode is on)
- `pi-web-access`: `/websearch`, `web_search`, `web_research`, `fetch_content`, and `outline_site`
- Local utilities: `/handoff`, `/codeblocks`, `/codex-usage`, `/toggle-skills`, `/tools`, `/files`, `/stats`, and `/startup-time`

## Development

Run commands from the repository root:

| Command           | Purpose                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`       | Run Node's test runner for `tests/**/*.mjs`; `pi-raft` and `pi-fast-resume` run vitest suites via `pnpm --dir extensions/<name> test`. |
| `pnpm lint`       | Check files with `oxlint`.                                                                                                             |
| `pnpm lint --fix` | Apply available `oxlint` fixes.                                                                                                        |
| `pnpm typecheck`  | Run TypeScript with the root config and every existing `extensions/*/tsconfig.json`.                                                   |
| `pnpm fmt`        | Format files with `oxfmt`.                                                                                                             |
| `pnpm package`    | Build the `pi-ide-pro` VS Code VSIX at `extensions/pi-ide-pro/dist/pi-ide-pro.vsix`.                                                   |

For a package-specific check:

```bash
pnpm --dir extensions/pi-web-access check
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
├── tests/                       # Node test files for extensions
├── scripts/                     # release, repository sync, and typecheck scripts
├── .github/workflows/           # manual npm publishing workflow
├── .githooks/                   # versioned Git hooks
├── package.json                 # root scripts and shared dependencies
├── pnpm-workspace.yaml          # workspace globs
└── tsconfig.json                # root TypeScript project
```

The workspace configuration also includes `packages/*`, although the current extension code is under `extensions/`.

## Publishing

Publishing is manual, tag based, and driven by `.github/workflows/publish.yml`. The workflow:

1. Checks out the requested tag.
2. Verifies that the tag matches the package name and version.
3. Runs the package's `build` script when one exists.
4. Runs `pack --dry-run`.
5. Publishes the package to npm.

Trigger the workflow directly with GitHub CLI:

```bash
gh workflow run publish.yml \
  -f package=pi-web-access \
  -f tag='@nielpattin/pi-web-access@0.1.0'
```

The `publish.sh` helper searches extension manifests under `extensions/`, matching the workflow.

## License

MIT
