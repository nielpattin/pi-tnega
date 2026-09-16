<div align="center">

# pi-raft

**A programmable tool and agent runtime for [Pi](https://github.com/earendil-works/pi-coding-agent)**

</div>

Raft gives Pi one programmable tool, `raft_exec`. A checked TypeScript or Python program can call MCP actions, one-shot agent actions, and memory actions, then return one bounded result. Pi core and registered extension tools remain native Pi tools called by Pi itself.

## Core contract

- TypeScript runs in isolated QuickJS by default; Python uses sandboxed Monty when `execution.executor.kernel` is `"python"`.
- The guest surface exposes `mcp.*`, `agents.*`, `memory.*`, the TypeScript payload object `π`, and `print`/`console`; named payload strings are data, not tools.
- Discovery is deliberately small: `tools.search`, `tools.describe`, `tools.call`, and `tools.progress`; search ranks dynamic MCP namespaces and answers a query that names a fixed namespace with that namespace's refs, while `agents.*` and `memory.*` stay named directly.
- Agent Tasks are one-shot. The only public agent actions are `agents.run`, `agents.spawn`, `agents.wait`, `agents.status`, `agents.list`, `agents.stop`, and `agents.log`.
- Memory exposes only `memory.recall` and `memory.expand`.

The host still owns strict argument validation, approval, audit traces, cancellation, and result bounds. The internal component supervisor, automatic compaction, and speculative read-ahead remain host features.

## Quick start

```bash
pi install npm:pi-raft
```

For a local checkout:

```bash
pnpm install
pnpm build
pi install /absolute/path/to/pi-raft
```

## Example

```ts
// Dynamic namespaces you cannot name come from discovery search.
const matches = await tools.search({ query: "authentication" });
const action = await tools.describe({ ref: matches[0].ref });
return await tools.call({ ref: action.ref, args: {} });
```

Use a known MCP namespace directly:

```ts
const answer = await mcp.docs.search({ query: "authentication" });
return answer;
```

## Reference

- [Configuration](docs/configuration.md)
- [Execution kernels](docs/kernels.md)
- [Agents and Tasks](docs/agents.md)
- [Memory recall](docs/memory-recall.md)
- [Compaction](docs/compaction.md)
- [Components](docs/components.md)
- [Providers](docs/providers.md)
- [Architecture and security](docs/architecture.md)
- [Speculation](docs/speculation.md)
- [Interface and commands](docs/interface.md)
- [Skills](docs/skills.md)
- [Audit traces](docs/audit-trace.md)
- [Repository checks](docs/certification.md)
- [Component calculus](docs/component-calculus.md)
- [Provider component calculus](docs/provider-component-calculus.md)

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm check
```

`pnpm check` runs the type check, build assertions, full test suite, and dead-code check. Lint and formatting live at the repository root: `pnpm lint` and `pnpm fmt`.

## License

MIT
