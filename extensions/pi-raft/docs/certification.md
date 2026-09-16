# Repository checks

The repository checks cover the public package shape and the host boundaries that make a Raft call
safe to execute.

The checks cover:

- strict action and argument validation;
- dynamic MCP dispatch;
- one-shot Task lifecycle and bounded logs;
- bounded memory recall and exact expansion;
- automatic compaction;
- trace sealing, provider lifecycle, and speculative-read freshness;
- TypeScript QuickJS and Python Monty execution boundaries.

Run the routine checks from `extensions/pi-raft`:

```sh
pnpm run check
git diff --check
```

Source-package checks also verify `dist/` package layout and the pnpm-only build path.
