---
name: raft-exec
description: >-
    Exact reference for Python `raft_exec` programs, dynamic namespaces, one-shot
    Tasks, memory recall, and MCP calls.
---

# raft_exec - Python

Write an async Python body in `code`: top-level `await` and `return`, no event-loop runner. The
default Monty backend is sandboxed. Explicit CPython is trusted native execution. The configured
kernel is exclusive.

Only the returned JSON-compatible value reaches the model. `print()` writes to activity output.
Named payloads are available through `π["key"]`; `π` is payload data, not a tool. `print` and
`console` are available. Pi core and registered extension tools execute natively in Pi, not inside Raft.

- `mcp.<server>.<tool>(...)` calls MCP tools.
- `agents.<action>(...)` calls one-shot agent actions.
- `memory.<action>(...)` calls memory actions.

```python
import asyncio

result, hits = await asyncio.gather(
    mcp.docs.search(query="authentication"),
    tools.search(query="authentication", limit=5),
)
return {"result": result, "hits": hits}

## Discovery

The generic discovery surface is exactly `tools.search`, `tools.describe`, `tools.call`, and
`tools.progress`. `tools.search`, `tools.describe`, and `tools.call` cover dynamic MCP refs, and
`tools.progress` reports progress. Naming a fixed namespace in `tools.search` answers with its
refs, and `agents.*` and `memory.*` are named directly. Use dictionaries and await each host action:

Read the live input schema before a computed call. Do not guess fields or pass a bare name to
`tools.call`.

## One-shot Tasks and memory

The fixed agent actions are `agents.run`, `agents.spawn`, `agents.wait`, `agents.status`,
`agents.list`, `agents.stop`, and `agents.log`. The fixed memory actions are `memory.recall` and
`memory.expand`. See `<skill-dir>/references/agents.md` and `<skill-dir>/references/mcp.md` when
those surfaces are needed.

Use ordinary loops and `asyncio.gather`, and
return small dictionaries or lists. Host validation, approvals, bounds, traces, automatic
compaction and speculation remain authoritative. Internal components are host
infrastructure, not a guest namespace.

## Recovery

Repair only the failing call or syntax after an error. Do not replay successful effects blindly.
Keep values JSON-compatible.
```
