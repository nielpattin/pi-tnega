# Repository Instructions

## Non-negotiable rules

- **No unprompted releases or Git mutations:** Do not run `git commit`, `git push`, or `pnpm release` unless the user explicitly requests it.
- **Use surgical edits:** Touch only what the task requires. Preserve existing comments and structure unless changing them is necessary.

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
    pnpm --dir extensions/pi-harbor check
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

The contributor monorepo workflow for creating packages, adding changesets, versioning, and publishing lives in [`DEVELOPMENT.md`](./DEVELOPMENT.md).

- Follow `DEVELOPMENT.md` for package work.
- Do not invent an alternate release flow.

## Extension conventions

- Every extension must have its entry point at `extensions/<extension-name-folder>/index.ts`.
- Re-export each extension from `extensions/index.ts` with:

    ```ts
    export * from "./<extension-name>.ts";
    ```

## Verification workflow

Follow this order for code changes:

1. Run `pnpm lint`.
2. Run `pnpm typecheck`.
3. Run `pnpm fmt`.
4. Run `git diff --check`.

If linting or type checking fails, fix the problem and continue again from the failed step.
