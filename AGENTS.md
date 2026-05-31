## Validation

- `pnpm lint` for linting.
- `pnpm check` for lint, type, test checks.
- Test with vitest, write tests in tests/ directory in their own extension folder, name with \*.test.ts
- Or if the extension is small and one file (no folder), write the test in the root `tests/` directory and run them with `pnpm test tests/<extension-name>.test.ts`

## Environment

- The `packages` directory is a git submodule, so you need to run `git submodule update --init --recursive` after cloning the repository to get the packages.
- The `packages` directory is also a pnpm workspace, so you need to run `pnpm install` in the root directory to install the dependencies for the packages. And you must cd into the package you want to run some commands, like `pnpm run <command>` or `pnpm test`, to run them in the context of that package.
