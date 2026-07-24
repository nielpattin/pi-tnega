# Changesets

Use changesets to record package-impacting changes before pushing.

```bash
pnpm changeset
pnpm version-packages
```

`pnpm version-packages` applies pending changesets, updates package changelogs, and refreshes the root changelog summary.

Packages are versioned independently. Changesets uses scoped package tags such as `@nielpattin/pi-station@0.6.6`.

Publishing is manual through the package publish workflow. Do not publish, release, push, or commit unless explicitly intended.
