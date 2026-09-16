# Pi Raft skills

Pi Raft ships one `raft-exec` skill in each kernel tree. The two copies describe the same
host contract in their native syntax:

- `skillsets/typescript/raft-exec/`
- `skillsets/python/raft-exec/`

## Public host surface

- Agents: `agents.run`, `agents.spawn`, `agents.wait`, `agents.status`, `agents.list`,
  `agents.stop`, `agents.log`.
- Memory: `memory.recall`, `memory.expand`.
- Discovery: `tools.search`, `tools.describe`, `tools.call`, `tools.progress`. Search ranks dynamic
  namespaces (MCP servers); a query that names a fixed namespace answers with that namespace's
  refs, and `agents.*` and `memory.*` stay named directly.
- Namespaces: `mcp.*`, `agents.*`, `memory.*`, and the TypeScript payload object `π`. Pi core and registered extension tools are native Pi actions.

## Authoring rules

1. Read the live action schema with `tools.describe` before a computed call.
2. Use `tools.search` for uncertain dynamic refs (MCP namespaces), then `tools.describe`
   and `tools.call` for the exact ref.
3. Call `mcp.*`, `memory.*`, or `agents.*` directly; static namespaces need no search.
4. Keep arguments and returned values JSON-compatible and bounded.
5. Use one-shot Tasks for delegated work and verify every result.

The skill files are the packaged entry points for Raft execution. Automatic compaction, strict
validation, traces, and speculation remain host behavior, not additional guest action namespaces.
