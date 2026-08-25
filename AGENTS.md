# Repository Instructions

## Non-negotiable rules

- **No unprompted releases or Git mutations:** Do not run `git commit`, `git push`, or release/publish flows unless the user explicitly requests it.
- **Use surgical edits:** Touch only what the assignment requires. Preserve existing comments and structure unless changing them is necessary.

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

## Verification workflow

Follow this order for code changes:

1. Run `pnpm lint`.
2. Run `pnpm typecheck`.
3. Run `pnpm fmt`.

If linting or type checking fails, fix the problem and continue again from the failed step.

When the change adds or alters extension behavior, follow `.pi/skills/tdd/SKILL.md` first: write the failing test in `tests/` (node:test, run with `node tests/<file>.mjs`), watch it fail, then make it pass.
