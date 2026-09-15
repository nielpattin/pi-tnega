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

- Multi-file extensions live in `extensions/<extension-name>/` with their entry point at `extensions/<extension-name>/index.ts`.
- Single-file extensions live directly at `extensions/<extension-name>.ts`.
- Each extension owns its tests in an independent directory under `tests/<extension-name>/` (for example, `tests/pi-web-access/ssrf-protection.mjs`). Never place loose test files directly in the root of `tests/`.

## Testing conventions

- Tests are tracked in version control and run with Node's built-in test runner. Run all tests with `pnpm test`, or scope to an extension with `node --test tests/<extension-name>/**/*.mjs`.
- Import extension modules in test files using `loadExtension` from `tests/_bootstrap.mjs`.

## Verification workflow

Follow this order for code changes:

1. Run tests: `pnpm test` (or scoped extension tests: `node --test tests/<extension-name>/**/*.mjs`).
2. Run `pnpm lint`.
3. Run `pnpm typecheck`.
4. Run `pnpm fmt`.

If any verification step fails, fix the problem and continue again from the failed step.
