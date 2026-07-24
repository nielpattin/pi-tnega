<validation>
- `pnpm lint` for linting.
- `pnpm check` for lint, type, test checks.
- Test with vitest, write tests in tests/ directory in their own extension folder, name with *.test.ts
- Or if the extension is small and one file (no folder), write the test in the root `tests/` directory and run them with `pnpm test tests/<extension-name>.test.ts`
</validation>

<environment>
- The agent root is a single pnpm monorepo with packages located under `packages/<package-name>`.
- Run `pnpm install` in the agent root directory to install dependencies for all packages and extensions.
- Run package commands from root using `pnpm --dir packages/<package-name> <command>` (e.g. `pnpm --dir packages/pi-permission-system check` or `pnpm --dir packages/pi-permission-system test`).
</environment>

# Monorepo Development & Package Workflow

This document provides the full A-Z workflow for creating, updating, testing, versioning, and publishing packages within this monorepo.

---

## 1. Monorepo Structure & Layout

- **Root Directory**: `C:/Users/niel/.pi/agent`
- **Node.js**: `>=24`
- **Package Manager**: `pnpm 11` (workspace defined in `pnpm-workspace.yaml`)
- **Package Location**: `packages/*`
  - `packages/pi-permission-system`: Central permission gates for tools, bash, MCP, skills, file paths, subagents.
  - `packages/pi-reference`: Project reference declaration & resolution with `@alias` autocomplete.
  - `packages/pi-station`: Status bar, layout manager, bash mode, hashline editor with in-chat diff preview.
- **Workflow & Automation Tools**:
  - `.changeset/`: Changesets configuration and pending change notes.
  - `.github/workflows/publish.yml`: GitHub Actions manual tag-based package publish workflow.
  - `.husky/`: Local Git hooks (`pre-commit` runs `lint-staged`, `pre-push` runs tests + changeset gate).
  - `scripts/`:
    - `require-changeset.mjs`: Pre-push check requiring changesets for package edits.
    - `sync-monorepo-changelog.mjs`: Aggregates package changelogs into root `CHANGELOG.md`.
    - `release.mjs`: Legacy single-package release orchestrator.
  - `publish.sh`: Helper script to trigger GitHub workflow dispatch for package releases.

---

## 2. Setup & Installation

Install dependencies for all workspace packages from the root directory:

```bash
pnpm install
```

---

## 3. Daily Development & Quality Gates

Run checks and tests from root:

| Command | Purpose |
| --- | --- |
| `pnpm check` | Full verification: formatting check, linting, typechecking, and unit tests |
| `pnpm test` | Run Vitest unit test suite (`vitest run`) |
| `pnpm coverage` | Run test coverage with Vitest |
| `pnpm typecheck` | Run TypeScript type check (`tsc --noEmit`) |
| `pnpm lint` | Run `oxlint` across all files |
| `pnpm lint:fix` | Auto-fix linting issues |
| `pnpm fmt` | Format files using `oxfmt` |
| `pnpm fmt:check` | Check code formatting compliance |

### Package-Specific Commands
Run scripts for individual packages from the root using `pnpm --dir`:

```bash
pnpm --dir packages/pi-permission-system test
pnpm --dir packages/pi-permission-system check
pnpm --dir packages/pi-station build
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
     "files": [
       "*.ts",
       "README.md",
       "CHANGELOG.md"
     ]
   }
   ```
3. **Add `tsconfig.json`**: Extend the monorepo root TypeScript configuration.
4. **Workspace Link**: `pnpm-workspace.yaml` automatically detects any folder inside `packages/*`. Run `pnpm install` to update workspace links.
5. **Add Initial Changeset**: Run `pnpm changeset` to record the initial package intent.

---

## 5. Editing an Existing Package

- **Raw TypeScript Packages** (`pi-permission-system`, `pi-reference`):
  - Published directly as raw TypeScript source files (`.ts`).
  - Loaded by Pi harness at runtime via `jiti`. No `dist/` build step is required.
- **Bundled Packages** (`pi-station`):
  - Requires a build step (`pnpm --dir packages/pi-station build`) to generate entrypoints into `dist/`.
- Ensure changes pass `pnpm check` and add appropriate tests in `packages/<name>/test/` or root `tests/`.

---

## 6. Changesets & Versioning Workflow

Packages use independent versioning managed by Changesets.

### Step 6.1: Record a Changeset
When modifying any file inside `packages/`:

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
- *Emergency Bypass*: Set `SKIP_CHANGESET_CHECK=1` or `SKIP_HOOKS=1` in environment variables if bypassing intentionally.

---

## 7. Version Bumping & Changelog Synchronization

To apply changesets and bump package versions:

```bash
pnpm version-packages
```

What `pnpm version-packages` does:
1. `changeset version`: Consumes `.changeset/*.md` files, bumps versions in `packages/*/package.json`, and appends entries to `packages/*/CHANGELOG.md`.
2. `pnpm changelog:sync`: Executes `scripts/sync-monorepo-changelog.mjs`, which extracts the latest version entry from each package changelog and syncs them into the root `CHANGELOG.md` between `<!-- package-changelog-summary -->` comments.

---

## 8. Package Dry-Run (Package Packaging Verification)

Before publishing, verify the contents of the generated tarball:

```bash
pnpm --dir packages/pi-permission-system pack --dry-run
pnpm --dir packages/pi-reference pack --dry-run
pnpm --dir packages/pi-station pack --dry-run
```

- **Raw TS packages**: Confirm output contains `.ts` source files, `package.json`, and `README.md` (no `dist/`).
- **Bundled packages**: Confirm output includes compiled `dist/` artifacts.

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
3. Runs build script if defined in package `package.json` (`pnpm --dir packages/<pkg> run build`).
4. Performs `pack --dry-run`.
5. Publishes package to npm: `pnpm --dir packages/<pkg> publish --access public --no-git-checks`.

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
