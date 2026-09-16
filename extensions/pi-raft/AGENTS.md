# AGENTS.md

## Package manager

This repository uses pnpm 11. Install dependencies with:

```sh
pnpm install
```

When this repository sits inside another pnpm workspace, run the install from the workspace root.

Do not use Bun or npm for package scripts.

## Local extension loading

Pi loads `dist/index.js` after `pnpm run build`. The compiled package includes
generated declarations and runtime files.

The compiled entry resolves `dist/worker.js` for child agent processes and reads
`dist/bundle/` to discover host runner constructors. Build artifacts are required when loading the package locally.

## Before committing

```sh
pnpm run check
```

This command runs the type check, build assertions, full test suite, and dead-code check.

## Incremental checks

Use these commands during development:

```sh
pnpm run check:fast
pnpm run test:changed
pnpm run test:related -- src/ui/settings.ts
```

The full suite takes approximately two minutes. Always run `pnpm run check` before a commit.

## Commits

Use conventional commits. Examples include `feat(scope): description`, `fix(scope): description`, and `chore(release): version`.
