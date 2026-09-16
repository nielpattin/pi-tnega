# Agents reference

The public `agents` namespace has exactly seven actions:

- `agents.run({ task, ...options })` runs one Task and waits for its result.
- `agents.spawn({ task, ...options })` starts a background Task and returns a handle.
- `agents.wait({ id })` waits for a spawned Task.
- `agents.status({ id })` inspects its current local status.
- `agents.list()` lists local Tasks.
- `agents.stop({ id })` stops a running local Task.
- `agents.log({ id, lines?, before? })` reads its bounded event stream.

`task` is required for `run` and `spawn`. Discover optional fields from the live schema:

```ts
const schema = await tools.describe({ ref: "agents.run" });
const handle = await agents.spawn({ task: "Review the auth flow." });
// handle.awaitWith is the exact agents.wait call; handle.id addresses the run.
const result = await agents.wait({ id: handle.id });
return { schema, result };
```

`run` is the one-shot form of `spawn` plus `wait`. Structured output validated by a requested
schema is returned in `value`; otherwise use the bounded text. Failed, stopped, and timed-out
Tasks are outcomes to inspect, not reasons to repeat successful work.
