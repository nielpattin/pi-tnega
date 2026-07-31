# Monorepo Development & Contributor Guide

This document provides the full contributor workflow for developing, testing, versioning, and publishing packages within this monorepo.

---

## 1. Monorepo Structure & Layout

- **Root Directory**: `C:/Users/niel/.pi/agent`
- **Node.js**: `>=24`
- **Package Manager**: `pnpm 11` (workspace defined in `pnpm-workspace.yaml`)
- **Extension Location**: `extensions/*`
    - [`pi-permission-system`](./extensions/pi-permission-system): Central permission gates for tools, bash, MCP, skills, file paths, and subagents.
    - [`pi-reference`](./extensions/pi-reference): Project reference declaration & resolution with `@alias` autocomplete.
    - [`pi-station`](./extensions/pi-station): Status bar, layout manager, bash mode, hashline editor with in-chat diff preview.
- **Workflow & Automation Tools**:
    - `.changeset/`: Changesets configuration and pending change notes.
    - `.github/workflows/publish.yml`: GitHub Actions manual tag-based package publish workflow.
    - `.husky/`: Local Git hooks (`pre-commit` runs `lint-staged`, `pre-push` runs tests + changeset gate).
    - `scripts/`:
        - `require-changeset.mjs`: Pre-push check requiring changesets for package edits.
        - `sync-monorepo-changelog.mjs`: Aggregates package changelogs into root `CHANGELOG.md`.
        - `release.mjs`: Legacy single-package release orchestrator.
    - `publish.sh`: Helper script to trigger GitHub workflow dispatch for package releases.

### Repository Layout

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
├── extensions/
│   ├── pi-permission-system      # permission system extension
│   ├── pi-reference              # project references extension
│   └── pi-station                # published npm extension
├── scripts/
│   ├── release.mjs               # legacy per-package release orchestrator
│   ├── require-changeset.mjs     # local changeset gate
│   └── sync-monorepo-changelog.mjs
├── publish.sh                    # gh workflow dispatch helper
├── CHANGELOG.md                  # generated package changelog summary
├── oxlint.config.ts              # oxlint config
├── oxfmt.config.ts               # oxfmt config
├── package.json                  # workspaces, shared devDeps, scripts
├── pnpm-workspace.yaml           # packages/* and extensions/* workspace definitions
├── tsconfig.json                 # shared TS config
└── vitest.config.ts              # tests and coverage
```

---

## 2. Setup & Installation

Install dependencies for all workspace packages from the root directory:

```bash
pnpm install
```

---

## 3. Daily Development & Quality Gates

Run checks and tests from root:

| Command          | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `pnpm check`     | Full verification: formatting check, linting, typechecking, and unit tests |
| `pnpm test`      | Run Vitest unit test suite (`vitest run`)                                  |
| `pnpm coverage`  | Run test coverage with Vitest                                              |
| `pnpm typecheck` | Run TypeScript 7 type check (`tsc --noEmit`)                               |
| `pnpm lint`      | Run `oxlint` across all files                                              |
| `pnpm lint:fix`  | Auto-fix linting issues                                                    |
| `pnpm fmt`       | Format files using `oxfmt`                                                 |
| `pnpm fmt:check` | Check code formatting compliance                                           |

### Package-Specific Commands

Run scripts for individual packages from the root using `pnpm --dir`:

```bash
pnpm --dir extensions/pi-permission-system test
pnpm --dir extensions/pi-permission-system check
pnpm --dir extensions/pi-station test
```

---

## 4. Creating a New Package

1. **Create Directory**: `packages/pi-<name>/`
2. **Add `package.json`**:
    ```json
    {
        "name": "@nielpattin/pi-<name>",
        "version": "0.1.0",
        "type": "module",
        "main": "index.ts",
        "engines": {
            "node": ">=24"
        },
        "repository": {
            "type": "git",
            "url": "git+https://github.com/nielpattin/pi-packages.git",
            "directory": "packages/pi-<name>"
        },
        "files": ["*.ts", "README.md", "CHANGELOG.md"]
    }
    ```
3. **Add `tsconfig.json`**: Extend the monorepo root TypeScript configuration (`../../tsconfig.base.json`).
4. **Workspace Link**: `pnpm-workspace.yaml` automatically detects folders inside `packages/*` and `extensions/*`. Run `pnpm install` to update workspace links.
5. **Add Initial Changeset**: Run `pnpm changeset` to record the initial package intent.

---

## 5. Editing an Existing Package

- **Raw TypeScript Extensions** (`pi-permission-system`, `pi-reference`, `pi-station`, `pi-harbor`, and others):
    - Published directly as raw TypeScript source files (`.ts`).
    - Loaded by Pi harness at runtime via `jiti`. No `dist/` build step is required.
- Ensure changes pass `pnpm check` and add appropriate tests in `extensions/<name>/test/` or root `tests/`.

---

## 6. Changesets & Versioning Workflow

Packages use independent versioning managed by Changesets.

### Step 6.1: Record a Changeset

When modifying any file inside `extensions/`:

```bash
pnpm changeset
```

Select the affected package(s), specify the version bump type (`patch`, `minor`, `major`), and enter a brief description of the changes.

### Step 6.2: Pre-Push Changeset Gate

Git pre-push hook (`.husky/pre-push`) automatically verifies changesets:

```bash
node scripts/require-changeset.mjs origin/main
```

If package source files were modified without a corresponding `.changeset/*.md` file, the push is blocked.

- _Emergency Bypass_: Set `SKIP_CHANGESET_CHECK=1` or `SKIP_HOOKS=1` in environment variables if bypassing intentionally.

---

## 7. Version Bumping & Changelog Synchronization

To apply changesets and bump package versions:

```bash
pnpm version-packages
```

What `pnpm version-packages` does:

1. `changeset version`: Consumes `.changeset/*.md` files, bumps versions in `extensions/*/package.json`, and appends entries to `extensions/*/CHANGELOG.md`.
2. `pnpm changelog:sync`: Executes `scripts/sync-monorepo-changelog.mjs`, which extracts the latest version entry from each package changelog and syncs them into the root `CHANGELOG.md` between `<!-- package-changelog-summary -->` comments.

---

## 8. Package Dry-Run (Package Packaging Verification)

Before publishing, verify the contents of the generated tarball:

```bash
pnpm --dir extensions/pi-permission-system pack --dry-run
pnpm --dir extensions/pi-reference pack --dry-run
pnpm --dir extensions/pi-station pack --dry-run
```

- **Raw TS packages**: Confirm output contains `.ts` source files, `package.json`, and `README.md` (no `dist/`).
- **Bundled packages**: Confirm output includes the package's documented runtime artifacts.

---

## 9. Publishing Packages to npm

Publishing is **manual, exact, tag-based, and single-package**.

### Step 9.1: Git Tag Convention

Changesets uses scoped package tags formatted as `@nielpattin/<pkg-name>@<version>`.
Example: `@nielpattin/pi-station@0.9.0`

### Step 9.2: Trigger Release Workflow

Use the helper script `publish.sh` to trigger GitHub Actions:

```bash
./publish.sh pi-station --tag '@nielpattin/pi-station@0.9.0'
```

### Step 9.3: Automated Publish Pipeline (`.github/workflows/publish.yml`)

1. Checks out the exact tag commit: `git checkout --detach "<tag>"`.
2. Validates package version matches tag: `@nielpattin/<pkg>@<version>`.
3. Runs build script if defined in package `package.json` (`pnpm --dir extensions/<pkg> run build`).
4. Performs `pack --dry-run`.
5. Publishes package to npm: `pnpm --dir extensions/<pkg> publish --access public --no-git-checks`.

---

## 10. Local Pi Extension Installation & Testing

- Pi loads extensions directly from TypeScript files using `jiti`.
- To test locally in Pi:
    - Copy or link extension files into `~/.pi/agent/extensions/` or `.pi/extensions/`.
    - Verify capability loading, status indicators, and permission prompts in Pi session.

---

## 11. Guidelines & Constraints

- **No Unprompted Git Commits / Pushes**: Do NOT execute `git commit`, `git push`, or `pnpm release` unless explicitly requested by the user.
- **Surgical Edits**: Touch only what is necessary for the task. Preserve comments and structure.
- **Always Verify**: Verify changes with `pnpm check` or `pnpm test` before declaring success.
