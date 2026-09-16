# Repository Instructions

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
    pnpm --dir extensions/pi-web-access check
    ```

- Run lint for a single extension from the repository root with:

    ```text
    pnpm lint extensions/<extension-name>
    ```

    Example:

    ```text
    pnpm lint extensions/pi-acks
    ```

## Contributor workflow

The contributor monorepo workflow for creating and publishing packages lives in [`DEVELOPMENT.md`](./DEVELOPMENT.md).

- Follow `DEVELOPMENT.md` for package work.
- Do not invent an alternate release flow.

## Extension conventions

- Multi-file extensions live in `extensions/<extension-name>/` with their entry point at `extensions/<extension-name>/index.ts`. `pi-raft` builds to `dist/index.js`, so run its build before loading that package locally.
- Single-file extensions live directly at `extensions/<extension-name>.ts`.
- Node-runner tests live under `tests/<extension-name>/` (for example, `tests/pi-web-access/research.mjs`). Never place loose test files directly in the root of `tests/`. `pi-raft` and `pi-fast-resume` keep their vitest suites beside their code in `extensions/<extension-name>/tests/`.

## Nested package instructions

When working on files inside one extension (`extensions/<extension-name>/`) or
package (`packages/<package-name>/`), first read that directory's own `AGENTS.md`
when it exists (for example, `extensions/pi-raft/AGENTS.md`) and follow it
alongside this instruction. The inner instruction file wins on package-specific commands, test
setup, and verification order.

## Testing conventions

- Tests are tracked in version control. `pnpm test` runs the suites under `tests/` with Node's built-in test runner, and a single extension can be scoped with `node --test tests/<extension-name>/**/*.mjs`. `pi-raft` and `pi-fast-resume` run their vitest suites with `pnpm --dir extensions/<extension-name> test`.
- Import extension modules in test files using `loadExtension` from `tests/_bootstrap.mjs`.

## Verification workflow

Follow this order for code changes:

1. Run tests: `pnpm test` (or scoped extension tests: `node --test tests/<extension-name>/**/*.mjs`; `pi-raft`: `pnpm --dir extensions/pi-raft test`).
2. Run `pnpm lint`.
3. Run `pnpm typecheck`.
4. Run `pnpm fmt`.

If any verification step fails, fix the problem and continue again from the failed step.
