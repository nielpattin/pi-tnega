# Monorepo Development & Contributor Guide

This document provides the full contributor workflow for developing and publishing packages within this monorepo.

---

## 1. Monorepo Structure & Layout

- **Root Directory**: `C:/Users/niel/.pi/agent`
- **Node.js**: `>=24`
- **Package Manager**: `pnpm 11` (workspace defined in `pnpm-workspace.yaml`)
- **Extension Location**: `extensions/*`
    - [`pi-reference`](./extensions/pi-reference): Project reference declaration & resolution with `@alias` autocomplete.
    - [`pi-subagent`](./extensions/pi-subagent): Profile-configured subagent delegation with persistent child Pi sessions, Herdr panes, live widget, in-place recovery, and the `/wr.profile` editor.
    - [`pi-compact-pro`](./extensions/pi-compact-pro): Configurable auto-compaction, model context caps, summary model fallback chains, and structured summaries through `/compaction`.
    - [`pi-processes`](./extensions/pi-processes): Standalone retained process supervision and the `/processes` dashboard.
    - [`btw`](./extensions/btw): Independent side-chat and explicit parent-session handoff.
    - [`pi-constellation`](./extensions/pi-constellation): Deterministic zero-LLM compaction and incremental session transcript inspection (`session_inspect`).
- **Workflow & Automation Tools**:
    - `.githooks/`: Versioned Git hooks (`pre-commit` runs `lint-staged`); `prepare` points Git at them via `core.hooksPath`.
    - `.github/workflows/publish.yml`: GitHub Actions manual tag-based package publish workflow.
    - `scripts/`:
        - `release.mjs`: Legacy single-package release orchestrator.
    - `publish.sh`: Helper script to trigger GitHub workflow dispatch for package releases.

### Repository Layout

```text
agent-root/
├── .github/workflows/
│   └── publish.yml               # exact manual npm publish
├── .githooks/
│   └── pre-commit                # pnpm lint-staged
├── .nvmrc                        # Node 24
├── openspec/                     # change proposals and specs
├── extensions/
│   ├── pi-reference              # project references extension
│   ├── pi-subagent               # profile-configured subagent delegation
│   ├── pi-compact-pro            # configurable compaction and summary models
│   ├── pi-processes              # standalone process supervision
│   ├── btw                       # independent side-chat extension
│   ├── pi-constellation          # deterministic compaction & session inspection
│   └── shared                    # shared extension helpers
├── scripts/
│   ├── release.mjs               # legacy per-package release orchestrator
│   └── typecheck.mjs             # project-wide type check
├── publish.sh                    # gh workflow dispatch helper
├── CHANGELOG.md                  # package changelog summary
├── oxlint.config.ts              # oxlint config
├── oxfmt.config.ts               # oxfmt config
├── package.json                  # workspaces, shared devDeps, scripts
├── pnpm-workspace.yaml           # packages/* and extensions/* workspace definitions
├── tsconfig.json                 # shared TS config
```

---

## 2. Setup & Installation

Install dependencies for all workspace packages from the root directory:

```bash
pnpm install
```

### Git Hooks

The pre-commit hook lives in versioned `.githooks/pre-commit` and runs `pnpm lint-staged`. The `prepare` script (`git config core.hooksPath .githooks`) runs on `pnpm install`, so fresh clones get hooks automatically with no manual setup.

---

## 3. Daily Development & Quality Gates

Run checks from root:

| Command          | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `pnpm test`      | Run native test runner across all extension tests  |
| `pnpm typecheck` | Run TypeScript 7 type check across project configs |
| `pnpm lint`      | Run `oxlint` across all files                      |
| `pnpm lint:fix`  | Auto-fix linting issues                            |
| `pnpm fmt`       | Format files using `oxfmt`                         |

### Package-Specific Commands

Run scripts for individual packages from the root using `pnpm --dir`:

```bash
pnpm --dir extensions/pi-subagent check
pnpm --dir extensions/pi-processes check
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

---

## 5. Editing an Existing Package

- **Raw TypeScript Extensions** (`pi-reference`, `pi-subagent`, `pi-compact-pro`, `pi-processes`, `btw`, `pi-constellation`, and others):
    - Published directly as raw TypeScript source files (`.ts`).
    - Loaded by Pi harness at runtime via `jiti`. No `dist/` build step is required.
- Ensure changes pass the applicable root checks (`pnpm lint`, `pnpm typecheck`, and `pnpm fmt`).

---

## 6. Package Dry-Run (Package Packaging Verification)

Before publishing, verify the contents of the generated tarball:

```bash
pnpm --dir extensions/pi-reference pack --dry-run
```

- **Raw TS packages**: Confirm output contains `.ts` source files, `package.json`, and `README.md` (no `dist/`).
- **Bundled packages**: Confirm output includes the package's documented runtime artifacts.

---

## 7. Publishing Packages to npm

Publishing is **manual, exact, tag-based, and single-package**.

### Step 7.1: Git Tag Convention

Publishing uses scoped package tags formatted as `@nielpattin/<pkg-name>@<version>`.
Example: `@nielpattin/pi-reference@0.2.1`

### Step 7.2: Trigger Release Workflow

Use the helper script `publish.sh` to trigger GitHub Actions:

```bash
./publish.sh pi-reference --tag '@nielpattin/pi-reference@0.2.1'
```

### Step 7.3: Automated Publish Pipeline (`.github/workflows/publish.yml`)

1. Checks out the exact tag commit: `git checkout --detach "<tag>"`.
2. Validates package version matches tag: `@nielpattin/<pkg>@<version>`.
3. Runs build script if defined in package `package.json` (`pnpm --dir extensions/<pkg> run build`).
4. Performs `pack --dry-run`.
5. Publishes package to npm: `pnpm --dir extensions/<pkg> publish --access public --no-git-checks`.

---

## 8. Local Pi Extension Installation & Testing

- Pi loads extensions directly from TypeScript files using `jiti`.
- To test locally in Pi:
    - Copy or link extension files into `~/.pi/agent/extensions/` or `.pi/extensions/`.
    - Verify capability loading, status indicators, and permission prompts in Pi session.

---

## 9. Guidelines & Constraints

- **No Unprompted Git Commits / Pushes**: Do NOT execute `git commit` or `git push` unless explicitly requested by the user.
- **Surgical Edits**: Touch only what is necessary for the assignment. Preserve comments and structure.
- **Always Verify**: Run `pnpm lint`, `pnpm typecheck`, and `pnpm fmt` before declaring success.
