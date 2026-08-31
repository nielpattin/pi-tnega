# Repository Instructions

Core rules for investigation, engineering discipline, and repository safety live in [APPEND_SYSTEM.md](./APPEND_SYSTEM.md) sections 1, 2, and 5.

## Context and Architecture

- **Read `CONTEXT.md` first:** Before working on non-trivial features, refactors, or architectural changes, read [`CONTEXT.md`](./CONTEXT.md) for domain models, system architecture, and key design constraints.

## Repository layout and commands

- This repository is a single pnpm monorepo.
- Packages live under `packages/<package-name>`; extensions live under `extensions/<extension-name>`.
- Extensions live under `extensions/`.
- Run `pnpm install` from the repository root to install dependencies for all packages and extensions.
- Run package-specific commands from the repository root with:

    ```text
    pnpm --dir <workspace-root>/<package-name> <command>
    ```

    Examples:

    ```text
    pnpm --dir extensions/pi-worker-flows check
    ```

- Run lint for a single extension from the repository root with:

    ```text
    pnpm lint extensions/<extension-name>
    ```

    Example:

    ```text
    pnpm lint extensions/pi-acks
    ```

## Effect code

When writing Effect code:

1. Read [`repos/effect/LLMS.md`](./repos/effect/LLMS.md). Treat it as the source of truth for idiomatic Effect usage, tests, module structure, and API design.
2. Read [`docs/effect-v4-cheatsheet.md`](./docs/effect-v4-cheatsheet.md) for a quick reference to this project's Effect v4 patterns and idioms.

## Vendored repositories

External repositories are vendored under `repos/` as read-only reference material.

- Prefer examples and patterns from vendored source code over generated guesses or web search results.
- Do not edit files under `repos/` unless the user explicitly asks.
- Do not import application code from `repos/`. Continue importing from normal package dependencies.

## Contributor workflow

The contributor monorepo workflow for creating and publishing packages lives in [`DEVELOPMENT.md`](./DEVELOPMENT.md).

- Follow `DEVELOPMENT.md` for package work.
- Do not invent an alternate release flow.

## Extension conventions

- Multi-file extensions live in `extensions/<extension-name>/` with their entry point at `extensions/<extension-name>/index.ts`.
- Single-file extensions live directly at `extensions/<extension-name>.ts`.
- Each extension owns its tests in an independent directory under `tests/<extension-name>/` (for example, `tests/pi-worker-flows/orchestrator.mjs`). Never place loose test files directly in the root of `tests/`.

## Testing conventions

- Follow the `test-driven-development` skill for all new features, bugfixes, refactors, and behavior modifications.
- Write the failing test first, verify that it fails for the expected reason, then write minimal code to pass.
- Tests are tracked in version control and run with Node's built-in test runner. Run all tests with `pnpm test`, or scope to an extension with `node --test tests/<extension-name>/**/*.mjs`.
- Import extension modules in test files using `loadExtension` from `tests/_bootstrap.mjs`.

## Verification workflow

Follow this order for code changes:

1. Run tests: `pnpm test` (or scoped extension tests: `node --test tests/<extension-name>/**/*.mjs`).
2. Run `pnpm lint`.
3. Run `pnpm typecheck`.
4. Run `pnpm fmt`.

If any verification step fails, fix the problem and continue again from the failed step.
