## Validation

- `pnpm lint` for linting.
- `pnpm check` for lint, type, test checks.
- Test with vitest, write tests in tests/ directory in their own extension folder, name with \*.test.ts
- Or if the extension is small and one file (no folder), write the test in the root `tests/` directory and run them with `pnpm test tests/<extension-name>.test.ts`
