# pi-packages

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Independent [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions focused on developer workflow. This repo keeps small Pi packages in one workspace and publishes them to npm.

All extensions publish raw TypeScript source that Pi loads through jiti, so they are not built to `dist/`.

## Packages

| Package                                                   | Role                                                                                                                                                                        | Install                           | npm                                                         | Version    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | ---------- |
| [pi-permission-system](./extensions/pi-permission-system) | Central permission gates for tools, bash, MCP, skills, file paths, and subagents. Edit permission prompt is status-only; the diff lives in the chat via the edit tool.      | `<NONE>`                          |                                                             | 0.2.2      |
| [pi-reference](./extensions/pi-reference)                 | Project references: declare local dirs and Git repos as agent-accessible with @alias autocomplete.                                                                          | `<NONE>`                          |                                                             | 0.2.1      |
| [pi-station](./extensions/pi-station)                     | Station bar, fixed editor layout, bash mode, stash, prompt history, undo/redo, hashline read/edit with in-chat diff preview, and configurable segments for the Pi TUI.      | `pnpm add @nielpattin/pi-station` | [npm](https://www.npmjs.com/package/@nielpattin/pi-station) | 0.9.0      |
| [workflows](./extensions/workflows)                       | Profile-configured multi-agent orchestration with phases, parallel fan-out, persistent child sessions, structured output, background result cards, and the `/wf` dashboard. | `<NONE>`                          |                                                             | 0.1.0      |
| [pi-compact-pro](./extensions/pi-compact-pro)             | Configurable auto-compaction thresholds, model context caps, custom summary models with fallbacks, structured summaries, and the `/compaction` settings panel.              | `<NONE>`                          |                                                             | unreleased |
| [pi-processes](./extensions/pi-processes)                 | Standalone retained process supervision, logs, readiness checks, lifecycle controls, and the `/processes` dashboard.                                                        | `<NONE>`                          |                                                             | 0.1.0      |
| [btw](./extensions/btw)                                   | Independent side-chat with explicit `/btw:inject` handoff.                                                                                                                  | `<NONE>`                          |                                                             | 0.1.0      |
| [pi-constellation](./extensions/pi-constellation)         | Deterministic zero-LLM compaction and incremental session transcript inspection (`session_inspect`).                                                                        | `<NONE>`                          |                                                             | 0.1.0      |

## Prerequisites

- Node.js 24
- pnpm 11
- Pi coding agent for running extensions

## Setup

```bash
pnpm install
```

## Daily Development

```bash
pnpm fmt                 # format with oxfmt
pnpm lint                # lint all files with oxlint
pnpm lint:fix            # auto-fix lint issues with oxlint
pnpm typecheck           # typecheck all project configs
```

See **[DEVELOPMENT.md](./DEVELOPMENT.md)** for detailed contributor instructions on creating and editing packages, publishing, project structure, and tooling.

## Project Structure

```text
agent-root/
├── .github/workflows/
│   └── publish.yml               # exact manual npm publish
├── .githooks/
│   └── pre-commit                # pnpm lint-staged
├── extensions/
│   ├── pi-permission-system      # permission system extension
│   ├── pi-reference              # project references extension
│   ├── pi-station                # published npm extension
│   ├── workflows                 # primary multi-agent orchestration
│   ├── pi-compact-pro            # configurable compaction and summary models
│   ├── pi-processes              # standalone process supervision
│   ├── btw                       # independent side-chat extension
│   ├── pi-constellation          # deterministic compaction & session inspection
│   └── shared                    # shared extension helpers
├── scripts/                      # release and typecheck scripts
├── publish.sh                    # gh workflow dispatch helper
├── CHANGELOG.md                  # package changelog summary
└── package.json                  # workspaces, shared devDeps, scripts
```

## Tooling

| Tool       | Config                | Purpose                        |
| ---------- | --------------------- | ------------------------------ |
| oxlint     | `oxlint.config.ts`    | Linting                        |
| oxfmt      | `oxfmt.config.ts`     | Formatting                     |
| TypeScript | `tsconfig.json`       | Type checking                  |
| Git hooks  | `.githooks/`          | Pre-commit lint-staged         |
| pnpm       | `pnpm-workspace.yaml` | Package manager and workspaces |

## License

MIT
