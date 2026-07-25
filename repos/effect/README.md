# pi-packages

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Independent [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions focused on developer workflow. This repo keeps small Pi packages in one workspace while preserving independent package versions, release notes, and npm publishing.

Most packages publish raw TypeScript source that Pi loads through jiti, so they are not built to `dist/`. The exception is `pi-station` (esbuild-bundled entrypoint), which builds to `dist/` via `pnpm --dir packages/pi-station build`.

## Packages

| Package                                                 | Role                                                                                                                                                                   | Install                           | npm                                                         | Version |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------- |
| [pi-permission-system](./packages/pi-permission-system) | Central permission gates for tools, bash, MCP, skills, file paths, and subagents. Edit permission prompt is status-only; the diff lives in the chat via the edit tool. | `<NONE>`                          |                                                             | 0.2.2   |
| [pi-reference](./packages/pi-reference)                 | Project references: declare local dirs and Git repos as agent-accessible with @alias autocomplete.                                                                     | `<NONE>`                          |                                                             | 0.2.1   |
| [pi-station](./packages/pi-station)                     | Station bar, fixed editor layout, bash mode, stash, prompt history, undo/redo, hashline read/edit with in-chat diff preview, and configurable segments for the Pi TUI. | `pnpm add @nielpattin/pi-station` | [npm](https://www.npmjs.com/package/@nielpattin/pi-station) | 0.9.0   |

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
pnpm fmt       # format with oxfmt
pnpm lint      # lint with oxlint
pnpm lint:fix  # auto-fix lint issues with oxlint
pnpm test      # run Vitest tests
pnpm coverage  # run Vitest coverage with enforced thresholds
pnpm check     # format check, lint, TypeScript typecheck, and unit tests
```

See **[DEVELOPMENT.md](./DEVELOPMENT.md)** for detailed contributor instructions on creating and editing packages, changesets, versioning, publishing, project structure, and tooling.

## Project Structure

```text
agent-root/
├── .changeset/                   # Changesets config and notes
├── .github/workflows/
│   └── publish.yml               # exact manual npm publish
├── .husky/
│   ├── pre-commit                # pnpm lint-staged
│   └── pre-push                  # pnpm test + changeset gate
├── packages/
│   ├── pi-permission-system      # permission system package
│   ├── pi-reference              # project references package
│   └── pi-station                # published npm package
├── scripts/                      # release & changelog scripts
├── publish.sh                    # gh workflow dispatch helper
├── CHANGELOG.md                  # generated package changelog summary
└── package.json                  # workspaces, shared devDeps, scripts
```

## Tooling

| Tool       | Config                | Purpose                        |
| ---------- | --------------------- | ------------------------------ |
| Changesets | `.changeset/`         | Versioning and changelogs      |
| oxlint     | `oxlint.config.ts`    | Linting                        |
| oxfmt      | `oxfmt.config.ts`     | Formatting                     |
| Vitest     | `vitest.config.ts`    | Testing and coverage           |
| TypeScript | `tsconfig.json`       | Type checking                  |
| Husky      | `.husky/*`            | Git hooks                      |
| pnpm       | `pnpm-workspace.yaml` | Package manager and workspaces |

## License

MIT
