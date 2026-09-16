---
name: raft-exec
description: >-
    Exact reference for checked TypeScript `raft_exec` programs, dynamic namespaces,
    one-shot Tasks, memory recall, and MCP calls.
---

# raft_exec

Write one TypeScript program in `code`. TypeScript is checked before execution and runs in
isolated QuickJS by default. Native Node/Bun execution is an explicit trusted escape hatch. The
configured kernel is exclusive; there is no per-call language selector.

Only the returned value reaches the model. `print()` writes to activity output. Named `payloads`
passed to `raft_exec` are available as `π.<key>`; `π` is payload data, not a tool.

## Dynamic namespaces

Guest code can call `mcp.*`, `agents.*`, and `memory.*` actions. Named payload strings passed to
`raft_exec` are available as the TypeScript data object `π`; `print` and `console` are also
available. Pi core and registered extension tools execute natively in Pi, not inside Raft.

Use the exact host schema. `mcp.*` names come from the server list; `agents.*` and `memory.*`
are fixed namespaces; naming one in `tools.search` answers with its refs. Use `tools.search`
for computed MCP refs.

```ts
const result = await mcp.docs.search({ query: "authentication" });
return result;
```

## Discovery

The generic discovery surface is exactly:

- `tools.search({ query, ... })`
- `tools.describe({ ref })`
- `tools.call({ ref, args? })`
- `tools.progress({ ... })`

```ts
const hits = await tools.search({ query: "deployment status" });
const descriptor = await tools.describe({ ref: hits[0].ref });
return await tools.call({ ref: descriptor.ref, args: {} });
```

`tools.search` ranks dynamic MCP namespaces; naming a fixed namespace (`agents`, `memory`) answers
with its refs. `agents.*` and `memory.*` are otherwise named directly.
Do not invent refs or arguments. Read `inputSchema` and `outputSchema` before a computed call.

## One-shot Tasks

The fixed agent actions are `agents.run`, `agents.spawn`, `agents.wait`, `agents.status`,
`agents.list`, `agents.stop`, and `agents.log`. See `<skill-dir>/references/agents.md` for their
compact contract.

## Memory

The fixed memory actions are `memory.recall` and `memory.expand`. Recall returns bounded ranked
evidence; expand reads selected entries or continuation chunks. Follow returned refs with
`tools.call` when a page supplies one.

## MCP

MCP is a dynamic namespace, not a second catalog API. See `<skill-dir>/references/mcp.md` for
naming and computed-call examples.

## Host boundaries

Host validation, approvals, cancellation, result limits, traces, automatic compaction, and
speculation apply to nested calls. Internal components are host infrastructure, not
a guest API. Keep programs small and return compact JSON-compatible data.
