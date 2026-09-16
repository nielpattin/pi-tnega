# Agents reference - Python

The public `agents` namespace has exactly seven actions:

- `agents.run(task="...", **options)` runs one Task and waits.
- `agents.spawn(task="...", **options)` starts one Task and returns a handle.
- `agents.wait(id="...")` waits for a spawned Task.
- `agents.status(id="...")` inspects its current local status.
- `agents.list()` lists local Tasks.
- `agents.stop(id="...")` stops a running local Task.
- `agents.log(id="...", lines=..., before=...)` reads its bounded event stream.

`task` is required for `run` and `spawn`. Discover optional fields with:

```python
schema = await tools.describe(ref="agents.run")
handle = await agents.spawn(task="Review the auth flow.")
result = await agents.wait(id=handle["id"])
return {"schema": schema, "result": result}
```

A requested schema puts structured output in `value`; otherwise use bounded text. Failed, stopped,
and timed-out Tasks are outcomes to inspect, not reasons to repeat successful work.
