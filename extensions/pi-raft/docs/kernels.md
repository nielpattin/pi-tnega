# Execution kernels

`raft_exec` runs one checked program in the configured kernel. The kernel is selected by
configuration, not per call.

## TypeScript

TypeScript is checked before execution and runs in isolated QuickJS by default. Native Node/Bun
execution is an explicit trusted escape hatch. Use `await`, direct namespaces, and return one
JSON-compatible value.

## Python

Set `execution.executor.kernel` to "python" for sandboxed Monty. Monty has no ambient filesystem,
network, process, or arbitrary import access; use host calls for effects. Explicit CPython is a
trusted native option and is not the sandboxed backend. Python programs use dictionaries,
`await`, ordinary loops, and `asyncio.gather`.

```python
import asyncio

files, matches = await asyncio.gather(
    mcp.docs.search(query="authentication"),
    tools.search(query="authentication", limit=5),
)
return {"files": files, "matches": matches}

## Shared host surface
Both kernels expose `mcp.*`, `agents.*`, and `memory.*` actions, plus the TypeScript payload
object `π` (and the equivalent Python payload mapping), `print`, and `console`. The generic
discovery actions are `tools.search`, `tools.describe`, `tools.call`, and `tools.progress`; search
covers dynamic MCP namespaces only. Pi core and registered extension tools remain native Pi tools.
Use `tools.describe` before a computed call. The host performs the same schema validation,
approval, cancellation, result bounding, trace, compaction, and speculation checks
regardless of the selected kernel.

## Resource boundary

Monty and QuickJS are isolated guest runtimes. Native execution has the local process
privileges of its host. Kernel selection is inherited by a delegated Task only when its
request explicitly selects or inherits it; it never changes the current program.
```
