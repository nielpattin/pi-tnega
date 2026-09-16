# Architecture and security

## Runtime path

```text
raft_exec
    |
    v
TypeScript checker or Python backend
    |
    v
JSON-only host bridge
    |
    v
ActionRegistry <--> internal ComponentSupervisor
    |
    +-- mcp.* dynamic MCP tools
    +-- agents.* one-shot Tasks
    +-- memory.recall / memory.expand
```

QuickJS is isolated by default. Guest code has no ambient filesystem, network, process, or
module access. Every effect crosses the host bridge, where argument schemas, approvals,
audits, time limits, cancellation, and result bounds apply. Each execution gets a fresh
context. Named payloads remain data in the TypeScript `π` object.

## Discovery and calls

The generic surface is intentionally small: `tools.search`, `tools.describe`, `tools.call`,
and `tools.progress`. Known actions use `mcp.*`, `agents.*`, and `memory.*`; search ranks dynamic
MCP namespaces, and a query that names a fixed namespace answers with that namespace's refs.
Uncertain or computed refs use the read -> describe -> call path.
The registry rejects bare or unknown refs and validates the call again immediately before invocation.

```ts
// Dynamic namespaces you cannot name come from discovery search.
const hits = await tools.search({ query: "deployment status" });
const descriptor = await tools.describe({ ref: hits[0].ref });
return await tools.call({ ref: descriptor.ref, args: {} });
```

`mcp.*`, `agents.*`, and `memory.*` are host namespaces resolved by the registry. Their schemas
and permissions remain authoritative even when a property name is known in advance; `tools.search`
covers only `mcp.*`. Pi core and registered extension tools are native Pi actions outside Raft.

## Internal control

The internal component supervisor stages provider publication, validates requirements, tracks
effect conflicts, and retires generations safely. It is host infrastructure, not a model-facing
component API. Automatic compaction rewrites old session context into bounded deterministic
summaries. Speculation may pre-launch eligible read calls, but the real call
always rechecks policy, freshness, and validation before consuming a result.

## Failure and trace boundaries

Strict validation fails closed for missing required fields, unknown fields, invalid refs, and
non-JSON values. A failed call never widens permissions. Traces retain bounded structural
facts, outcomes, and operation order; arbitrary provider payloads are not treated as trace
metadata. Cancellation and deadline handling seal in-flight operations with typed outcomes.
