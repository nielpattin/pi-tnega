# subagents

Spawn isolated background agents while the main Pi session keeps working.

## What it does

Gives the model parallel workers with their own context windows, then delivers their final answers back.

Also gives you interactive inspection/takeover UI.

## Tools for the model

| Tool              | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `subagent_spawn`  | Start a background subagent                              |
| `subagent_wait`   | Block until listed subagents finish                      |
| `subagent_cancel` | Cancel running subagents                                 |
| `subagent_check`  | Peek status/recent activity without consuming the result |
| `subagent_list`   | List all model-visible subagents                         |

## Commands for you

| Command      | Purpose                                                        |
| ------------ | -------------------------------------------------------------- |
| `/subagents` | List, inspect, and take over subagents                         |
| `/agents`    | TUI panel to configure `fast` and `good` agent profiles        |
| `/vibe`      | Toggle Director mode: locks tools to `read` + `vibe_*`         |
| `/btw`       | Ask a one-off side question while the main agent keeps working |

## Agent Definitions & Manager (`/agents`)

Subagents are driven by markdown agent definitions loaded globally from `~/.pi/agent/agents/<name>.md` and project-local `.pi/agents/<name>.md`.

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

Use `agent: "<name>"` and `name: "<short-name>"` in `subagent_spawn` to spawn a subagent using a defined role (e.g. `subagent_spawn(agent: "scout", prompt: "...", name: "audit")`).

## Vibe Mode (`/vibe`)

Real director mode (omp-style), not prompt-only:

- **Locks active tools** to: `read`, `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`
- **Blocks** every other tool at `tool_call` even if something re-enables it
- Injects director system prompt each turn via `before_agent_start`
- Restores previous tool set when turned off
- Cancels active subagents when turned off

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
subagent_spawn(
  agent: "scout",
  prompt: "Audit extensions/workflows for race conditions and report findings.",
  name: "workflow-audit"
)
```

Or with task agent:

```text
subagent_spawn(
  agent: "task",
  prompt: "Implement the failing test fix and report what changed.",
  name: "task-fix"
)
```

Then keep working. When the child finishes, its result is injected as a follow-up message.

### Block for the answer

```text
subagent_wait(ids: ["sa-1"])
```

Use only when the next step cannot continue without that result.

### Cancel / inspect

```text
subagent_check(id: "sa-1")
subagent_list()
subagent_cancel(ids: ["sa-1"])
```

## Important rules

- Children cannot spawn more subagents/workflows or ask the user.
- Children cannot see the parent conversation, so prompts must be self-contained.
- Max **4** running subagents at once.
- Prefer automatic result delivery over `subagent_wait`.

## `/btw`

`/btw` is a human-facing side channel:

```text
/btw what does this error mean?
```

It:

1. Spawns a pi subagent with origin `btw`
2. Opens the takeover UI immediately
3. Stores the answer as a session entry
4. Does **not** inject that answer into the main model context

Use it for side questions while the main agent is busy.

## `/subagents`

Opens a picker of running/finished subagents.

From there you can inspect transcripts and take over an interactive view of a child session.

## Status line

While subagents exist, the footer/status shows counts like:

```text
subagents: ■ 1 running · ■ 2 done · /subagents to view
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
