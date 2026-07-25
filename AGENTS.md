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

# Agent notes

Contributor monorepo workflow (create package, changesets, version, publish) lives in [DEVELOPMENT.md](./DEVELOPMENT.md).

Follow DEVELOPMENT.md for package work. Do not invent alternate release flows.

## Guidelines & Constraints

- **No Unprompted Git Commits / Pushes**: Do NOT execute `git commit`, `git push`, or `pnpm release` unless explicitly requested by the user.
- **Surgical Edits**: Touch only what is necessary for the task. Preserve comments and structure.
- **Always Verify**: Verify changes with `pnpm check` or `pnpm test` before declaring success.
