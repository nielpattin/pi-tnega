# tasks

Spawn isolated background agents while the main Pi session keeps working.

## What it does

Gives the model parallel workers with their own context windows, then delivers their final answers back.

Also gives you interactive inspection/takeover UI.

## Tools for the model

| Tool               | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `task_spawn`       | Start a background task                                  |
| `task_spawn_batch` | Start several parallel tasks with shared context         |
| `task_wait`        | Block until listed tasks finish                          |
| `task_cancel`      | Cancel running tasks                                     |
| `task_check`       | Peek status/recent activity without consuming the result |
| `task_list`        | List all model-visible tasks                             |

## Commands for you

| Command   | Purpose                                                        |
| --------- | -------------------------------------------------------------- |
| `/tasks`  | List, inspect, and take over tasks                             |
| `/agents` | TUI panel to configure `fast` and `good` agent profiles        |
| `/vibe`   | Toggle Director mode: locks tools to `read` + `vibe_*`         |
| `/btw`    | Ask a one-off side question while the main agent keeps working |

## Agent Definitions & Manager (`/agents`)

Tasks are driven by markdown agent definitions loaded globally from `~/.pi/agent/agents/<name>.md` and project-local `.pi/agents/<name>.md`.

File format:

```md
---
description: short one-line description
display_name: optional UI name
tools: read, bash, grep, find # pi only; ignored for agy
model: provider/model-id # optional; empty = inherit parent
thinking: high # optional; empty = inherit
guidance: when parent model should pick this agent
harness: pi # pi | agy; default pi
enabled: true
---

# body = FULL system prompt for the child

...
```

Use `/agents` in TUI mode to manage, edit, and create agent definitions using a full-screen manager.

Use `agent: "<name>"` and `name: "<short-name>"` in `task_spawn` to spawn a task using a defined role (e.g. `task_spawn(agent: "scout", prompt: "...", name: "audit")`).

## Vibe Mode (`/vibe`)

Real director mode (omp-style), not prompt-only:

- **Locks active tools** to: `read`, `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`
- **Blocks** every other tool at `tool_call` even if something re-enables it
- Injects director system prompt each turn via `before_agent_start`
- Restores previous tool set when turned off
- Cancels active tasks when turned off

Director tools:

| Tool         | Purpose                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `vibe_spawn` | Spawn `fast` or `good` worker from `/agents` profiles                             |
| `vibe_send`  | Follow-up message to a running or finished worker session (restarts when settled) |
| `vibe_wait`  | Block until workers settle                                                        |
| `vibe_kill`  | Cancel one worker                                                                 |
| `vibe_list`  | List workers                                                                      |

## Harnesses

| Harness | What it runs                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| `pi`    | In-process Pi session. Inherits tools/config from this environment.                                            |
| `agy`   | Antigravity CLI (`agy --print`). Multi-turn session support via `--conversation <id>`. Requires `agy` on PATH. |

### `agy` model + effort

Pass the **base** model and let effort pick the CLI slug:

| `model`                      | `reasoning_effort`       | CLI `--model`             |
| ---------------------------- | ------------------------ | ------------------------- |
| `gemini-3.6-flash` (default) | `low` / omit             | `gemini-3.6-flash-low`    |
| `gemini-3.6-flash`           | `medium`                 | `gemini-3.6-flash-medium` |
| `gemini-3.6-flash`           | `high` / `xhigh` / `max` | `gemini-3.6-flash-high`   |
| `gemini-3.6-flash-high`      | any                      | kept as-is                |
| other slug (`claude-...`)    | any                      | kept as-is                |

Other defaults:

```text
mode: accept-edits
print-timeout: 15m
always: --dangerously-skip-permissions --add-dir <cwd>
```

Limits of `agy`:

- one-shot (no multi-turn steer / send)
- no live tool transcript (black-box stdout)
- good for "go implement this, come back with the answer"

## Typical model usage

### Fire-and-forget

```text
task_spawn(
  agent: "scout",
  prompt: "Audit extensions/workflows for race conditions and report findings.",
  name: "workflow-audit"
)
```

Or with task agent:

```text
task_spawn(
  agent: "task",
  prompt: "Implement the failing test fix and report what changed.",
  name: "task-fix"
)
```

Then keep working. When the child finishes, its result is injected as a follow-up message.

### Batch parallel workers

```text
task_spawn_batch(
  context: "Each task audits one extension listed in its prompt. Return findings as bullet points.",
  tasks: [
    { agent: "scout", name: "audit-bg", prompt: "Audit extensions/background-terminals." },
    { agent: "scout", name: "audit-sub", prompt: "Audit extensions/tasks." }
  ]
)
```

Max 4 tasks can run at once including already-running ones. Shared `context` is prepended to every task prompt, so put contracts and paths there once.

### Block for the answer

```text
task_wait(ids: ["task-1"])
```

Use only when the next step cannot continue without that result.

### Cancel / inspect

```text
task_check(id: "task-1")
task_list()
task_cancel(ids: ["task-1"])
```

## Important rules

- Children cannot spawn more tasks/workflows or ask the user.
- Children cannot see the parent conversation, so prompts must be self-contained.
- Max **4** running tasks at once, including any already-running workers.
- Prefer `task_spawn_batch` over several sequential `task_spawn` calls for the same batch of independent work.
- Prefer automatic result delivery over `task_wait`.

## `/btw`

`/btw` is a human-facing side channel:

```text
/btw what does this error mean?
```

It:

1. Spawns a pi task with origin `btw`
2. Opens the takeover UI immediately
3. Stores the answer as a session entry
4. Does **not** inject that answer into the main model context

Use it for side questions while the main agent is busy.

## `/tasks`

Opens a picker of running/finished tasks.

From there you can inspect transcripts and take over an interactive view of a child session.

## Status line

While tasks exist, the footer/status shows counts like:

```text
tasks: ■ 1 running · ■ 2 done · /tasks to view
```

## Dependencies

```text
effect
```

`agy` harness also requires the `agy` binary on PATH.

## Reload after install

```text
/reload
```
