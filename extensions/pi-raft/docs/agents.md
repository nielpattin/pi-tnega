# Agents and Tasks

Raft exposes short-lived, one-shot Tasks. A Task runs under the owner session, settles once,
and returns a bounded result.

## Actions

The public `agents` namespace contains exactly these actions:

- `agents.run({ task, ...options })` runs a Task and waits for its result.
- `agents.spawn({ task, ...options })` starts a Task and returns a handle.
- `agents.wait({ id })` waits for a spawned Task.
- `agents.status({ id })` reads the latest local status.
- `agents.list()` lists local Tasks.
- `agents.stop({ id })` stops a running local Task.
- `agents.log({ id, lines?, before? })` reads its bounded event stream.

`task` is required for `run` and `spawn`. Their optional request fields are defined by the live
schema: use `tools.describe({ ref: "agents.run" })` or the corresponding action ref before
constructing a computed call.

```ts
const handle = await agents.spawn({
    task: "Review the authentication flow and report concrete risks.",
    name: "auth review",
});
const status = await agents.status({ id: handle.id });
const result = await agents.wait({ id: handle.id });
return { status, result };
```

`run` is the synchronous one-shot form of `spawn` plus `wait`. A schema-validated result is in
`value`; otherwise use the bounded text result. `status`, `list`, and `log` are observational.
Do not blindly repeat successful work after a failed, stopped, or timed-out Task.
