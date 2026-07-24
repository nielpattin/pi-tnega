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
pnpm lint      # auto-fix lint issues with oxlint
pnpm test      # run Vitest tests
pnpm coverage  # run Vitest coverage with enforced thresholds
pnpm check     # lint, format check, and TypeScript typecheck
```

Git hooks are the validation source for this repo:

- pre-commit: `pnpm lint-staged` (oxlint + oxfmt --check on staged files)
- pre-push: `pnpm test` and `node scripts/require-changeset.mjs origin/main`

GitHub has no CI workflow for routine pushes. Run the local hooks before pushing.

## Package Validation

Use package dry runs to verify npm tarball contents before publishing:

```bash
pnpm --dir packages/pi-permission-system pack --dry-run
pnpm --dir packages/pi-reference pack --dry-run
pnpm --dir packages/pi-station pack --dry-run
```

For raw-TS packages, the dry-run output should include TypeScript source files and package docs, and should not include `dist/`. For `pi-station`, the dry-run should include the built `dist/`.

## Add a New Package

1. Create `packages/pi-foo/` with `package.json` and `tsconfig.json`.
2. The root workspace already includes `packages/*` in `pnpm-workspace.yaml` and root `package.json`.
3. Ensure the package has:
    - `"type": "module"`
    - `"engines": { "node": ">=24" }`
    - `main` pointing to the TypeScript source entrypoint
    - `pi.extensions` or `pi.skills` pointing to package resources
    - a `test` script when it has tests
    - source files and docs in `files[]`
    - repository metadata with `directory: "packages/pi-foo"`
4. Add a changeset with `pnpm changeset` for package-impacting changes.

## Changesets Release Flow

Packages are versioned independently with Changesets.

```bash
pnpm changeset          # record the package and semver impact
pnpm version-packages   # apply changesets and sync the root changelog summary
```

`pnpm version-packages` runs `changeset version` and then `pnpm changelog:sync`. Changesets updates package versions and package changelogs. `CHANGELOG.md` summarizes the latest package changelog entries and is generated from package changelogs.

Changesets uses scoped package tags such as `@nielpattin/pi-station@0.9.0`. Prefer that tag convention for new releases.

The legacy `scripts/release.mjs` script is kept for reference during the transition. Prefer Changesets for new releases.

`pnpm release` runs `changeset publish` and can publish packages to npm. Do not run release, publish, push, or commit steps unless explicitly intended.

## Publish

Publishing is manual, exact, and tag-only. The GitHub publish workflow accepts a package plus a Changesets tag, checks out that tag, verifies the selected package version, runs package-local `pack --dry-run`, then publishes only that package.

```bash
./publish.sh pi-station --tag '@nielpattin/pi-station@0.9.0'
```

The publish workflow installs dependencies and packages the selected package. It does not run `pnpm check`, `pnpm test`, or `pnpm coverage`.

## Aggregate Packages

Aggregate package collections are intentionally deferred. Pi package docs require bundled dependencies and `node_modules/` resource paths for other pi packages. Publishable aggregates such as `@nielpattin/pi-packages`, `@nielpattin/pi-extensions`, or `@nielpattin/pi-skills` should only be added after local package installation tests prove those paths work for this repo's raw TypeScript packages.

## Project Structure

```text
agent-root/
├── .changeset/                   # Changesets config and notes
├── .github/workflows/
│   └── publish.yml               # exact manual npm publish
├── .husky/
│   ├── pre-commit                # pnpm lint-staged
│   └── pre-push                  # pnpm test + changeset gate
├── .nvmrc                        # Node 24
├── openspec/                     # change proposals and specs
├── packages/
│   ├── pi-permission-system      # permission system package
│   ├── pi-reference              # project references package
│   └── pi-station                # published npm package
├── scripts/
│   ├── release.mjs               # legacy per-package release orchestrator
│   ├── require-changeset.mjs     # local changeset gate
│   └── sync-monorepo-changelog.mjs
├── publish.sh                    # gh workflow dispatch helper
├── CHANGELOG.md                  # generated package changelog summary
├── oxlint.config.ts              # oxlint config
├── oxfmt.config.ts               # oxfmt config
├── package.json                  # workspaces, shared devDeps, scripts
├── pnpm-workspace.yaml           # packages/* workspace definition
├── tsconfig.json                 # shared TS config
└── vitest.config.ts              # tests and coverage
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
