# pi-subagent

Direct subagent delegation for Pi. Spawn one to four child Pi subagent sessions in parallel,
watch them live above the editor, and get one bounded result per agent when each
finishes. No orchestration layer, no phases, no dashboards — the parent decomposes
the work, agents execute, the parent integrates.

## Features

- **Parallel delegation** — `agent_spawn` runs 1 to 4 agents at once, foreground
  wait by default, `background: true` for immediate return with automatic delivery.
- **Real child sessions** — every agent is a real Pi process with its own session
  file, so it can be inspected and audited after the run.
- **Herdr panes** — a single agent splits your current pane; a batch of 2 or more
  gets its own `agents <batch>` tab. Panes stay open when the work finishes so you
  can read the output.
- **Live widget** — the above-editor widget shows each agent's profile, elapsed
  time, current tool activity, and Herdr pane. Finished agents stay visible until
  their pane closes or they are cancelled.
- **Failure visibility** — an agent that stops without a final message becomes
  `failed` with its session file and error text available for inspection.
- **Profile-based delegation** — calls select an agent profile (`worker`, `planner`,
  `explorer`, `critic`, `librarian`), never a model or effort level.
- **Cost visibility** — every result line reports cost, tool calls, context
  footprint, and output size, read from the child's own session usage.

## Requirements

- Pi with package support.
- For visible panes: Herdr and its CLI, with Pi started from inside Herdr
  (`HERDR_ENV=1`). Other terminal multiplexers are not supported.
- Without Herdr, agents run as headless child processes and everything except
  panes works — the `pi` binary must be on `PATH` (or `PI_COMMAND` set to a
  Pi-compatible executable).

Child agents run with your user account's access. Panes isolate visibility, not
processes or permissions.

## Install

This extension lives in the agent monorepo at `extensions/pi-subagent/` and loads
with the parent Pi session. After changing its code, restart Pi or run `/reload`.

## Quick start

Ask Pi to delegate naturally:

```
Use two explorers in parallel to map the auth flow and the session schema, then summarize.
```

Or call the tool directly:

```json
{
    "agents": [
        {
            "profile": "explorer",
            "name": "auth-flow",
            "task": "Map the authentication flow: files, entry points, risks. Read-only."
        },
        {
            "profile": "explorer",
            "name": "session-schema",
            "task": "Map the session schema and its callers. Read-only."
        }
    ]
}
```

Both agents run at once; the result block renders one line per agent when all
finish:

```
✓ auth-flow · explorer · $0.012 · 14 calls · 38k ctx (26 lines)
✓ session-schema · explorer · $0.008 · 9 calls · 21k ctx (18 lines)
```

For fire-and-forget work, add `"background": true`. The call returns immediately
and each batch's results are delivered into the session as `agents-result`
messages.

## How it works

```
1. Parent calls agent_spawn()      → children launch (panes or headless)
2. Agents run as child Pi sessions  → widget shows live profile, activity, pane
3. Parent keeps working              → foreground waits; background returns now
4. Child writes its exit sidecar     → parent settles that agent from the sidecar
5. All agents settle                → one result block, one line per agent
```

An `agent_spawn` call creates one child Pi session per agent. Each child runs to
a normal final assistant message, then records a `.exit` sidecar next to its
session file. The parent never tails output: it polls for the sidecar every
300 ms, extracts the result text, and reads cost, tool-call count, and context
tokens from the child's own session usage.

Children stay open after finishing. Nothing auto-closes panes or tabs and the
child Pi process does not quit, so the full transcript remains readable. Only
`agent_cancel` closes its agent's pane.

### Completion sidecars

The child writes exactly one of these to `<session-file>.exit` (atomic write
with trailing newline):

```json
{ "type": "done" }
{ "type": "error", "errorMessage": "<message>", "stopReason": "error" }
```

The parent interprets them as:

| Sidecar                                  | Outcome     | Result                                                            |
| ---------------------------------------- | ----------- | ----------------------------------------------------------------- |
| `done`                                   | `completed` | The child's final assistant message.                              |
| `error`                                  | `failed`    | The error message, or `Agent exited without a final message.`     |
| Pane gone, no sidecar after 500 ms grace | `failed`    | `Agent pane disappeared before completion evidence was recorded.` |

An agent that exits without a final assistant message becomes `failed`. Its session file remains available for inspection.

### Activity snapshots

While running, each child maintains `<session-file>.activity.json`:

```json
{
    "version": 1,
    "runningChildId": "task-019c2f8e-7b3a-7c42-b9d1-6e8f4a2c1b90",
    "createdAt": 1700000000000,
    "updatedAt": 1700000000000,
    "sequence": 0,
    "latestEvent": "session_start",
    "phase": "starting",
    "agentActive": false,
    "turnActive": false,
    "providerActive": false,
    "toolActive": false
}
```

Snapshots grow `toolName`, `toolCallId`, `activeScope`, and timing fields as the
child works. The widget labels (`read`, `bash`, provider work) come from here.
Session JSONL is used for transcript, inspection, and result extraction, not for
liveness.

### On-disk layout

For a parent session file `P = /D/N.jsonl`, a child session uses a UUIDv7 filename:

```text
/D/N/<timestamp>_<uuidv7>.jsonl                  child session transcript
/D/N/<timestamp>_<uuidv7>.jsonl.activity.json    live activity snapshot
/D/N/<timestamp>_<uuidv7>.jsonl.exit             completion sidecar
/D/N/agents-tasks.json                            manifest index (version 1, key `jobs`)
```

### Timing

| Interval                         | Value    |
| -------------------------------- | -------- |
| Completion monitor poll          | 300 ms   |
| Pane/process disappearance grace | 500 ms   |
| Widget pane reconciliation       | 5,000 ms |
| Activity snapshot throttle       | 300 ms   |

## Spawning agents

```json
{
    "agents": [
        {
            "profile": "worker",
            "name": "implement",
            "task": "Read plans/auth-fix.md. Implement all uncompleted tasks with test-driven development. Update checkboxes to [x]."
        }
    ],
    "background": false
}
```

### Tool parameters

| Parameter    | Type    | Default  | Description                                                                                                                                             |
| ------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`     | array   | required | 1 to 4 agent specs (schema enforces `maxItems: 4`).                                                                                                     |
| `background` | boolean | `false`  | `true` returns after launch and delivers results automatically; `false` waits for every agent to settle. `background` is true only when exactly `true`. |

### Agent spec fields

| Field     | Type   | Description                                                                                                   |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `profile` | string | Required. Enabled agent profile name. Never a model or effort level.                                          |
| `name`    | string | Required. Short agent name, e.g. `investigate-copy-all`. Names the pane, the widget row, and the result line. |
| `task`    | string | Required. Full task prompt: expected outcome, scope, edit permission, and stop condition.                     |

The public schema exposes neither model nor thinking. An empty `agents` array
returns `{ ok: false, error: 'agent_spawn requires a non-empty "agents" array.' }`.

### Naming coordinated agents

Before launching a group, pick a short task slug and name each agent
`<task>-<role>[-n]`, e.g. `login-api`, `login-test-2`. Use the names in prompts,
handoffs, and results so panes, widget rows, and result lines all match.

### Model and thinking resolution

Each agent selects a profile in `profile`, never a model. The child runtime
resolves as:

- **Model**: profile model verbatim, else the parent `provider/id`, else no
  `--model` argument.
- **Thinking**: profile thinking. There is no per-call override and no parent
  fallback.

### Capacity

At most 4 agents run at once. When `running + incoming > 4`, the spawn fails
closed with:

```text
Concurrency limit exceeded. Maximum 4 concurrent agents allowed.
```

## Results

### Line format

Every settled agent renders one line:

```
✓ <name> · <profile> · $<cost> · <N> call(s) · <ctx> ctx (<lines> lines)
```

Segments with a zero value are skipped, so a quiet agent renders
`✓ solo · worker (1 line)`. A single-agent batch collapses its call block to
the header and shows the one stat line; expanding with `ctrl+o` reveals the full
output. Statuses render `✓` completed and `✗` failed. The word `completed` never appears in the line.

### Background delivery

Background batches return immediately. When a batch's members all settle, each
result arrives as one `agents-result` message (only the last triggers a turn):

```text
customType: agents-result
details: { id, name, profile, status, duration, result }
```

Delivery flushes when the parent is idle, on `agent_end`, or on `agent_settled`.
Foreground tasks and cancelled tasks are never delivered. Verify a delivery
reached the session with:

```bash
jq -c 'select(.type == "custom_message" and .customType == "agents-result")' "$PI_SESSION_FILE" | tail -1
```

## The widget

The widget above the editor tracks every agent spawned by the current Pi process:

```
• agents ● 1 working · ✓ 2 done
  ⠋ auth-flow · explorer · 1m05s · read · pane w9:p3
  ✓ session-schema · explorer · $0.008 · 9 calls · 21k ctx · pane w9:p4
```

- The header dot is amber while anything runs, dim when idle. Per-row spinners
  animate only on running rows.
- Rows show profile, compact elapsed time (`48s`, `1m03s`, `2h04m`), live tool
  activity (`read`, `bash`, provider work), and the Herdr pane id.
- Finished rows keep their stats line. A row leaves only when its agent is
  cancelled or its pane is gone — the 5-second reconciler drops entries whose
  Herdr pane reports `missing`, so panes you close by hand disappear on their own.
- Collapsed by default: at most 3 running and 4 settled rows, then a
  `+N more (/wr to expand)` line. Run `/wr` to expand the widget to
  every row (`/wr to collapse` appears in the header); run `/wr` again to
  collapse. Restored history from the session file never enters the widget;
  `agent_list` is the history view.

## Herdr layout

- **1 agent** splits the current pane to make room.
- **2 to 4 agents** create one `agents <batch>` tab. The first agent reuses the
  tab's root pane; the rest split inside the tab. Panes are renamed to the agent
  names.
- Panes and tabs persist after completion. Cancelling closes that agent's pane.

Without Herdr, every agent runs headless and the same results, widget rows
(without pane chips), and delivery apply.

## Listing and cancelling

| Tool           | Parameters      | Contract                                                                                                                                                                   |
| -------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_list`   | none            | Every tracked task with id, name, profile, status, session file, and usage. The history view.                                                                              |
| `agent_cancel` | `id` (required) | Aborts a live agent (`Agent was aborted.`), closes its pane, and marks it `cancelled`. Cancelling a finished task leaves it untouched. Unknown ids return `... not found.` |

## Agent profiles

| Profile     | Responsibility                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `worker`    | General implementation with test-driven development.                                                            |
| `planner`   | Writes implementation specifications into `plans/`.                                                             |
| `explorer`  | Read-only codebase mapping: paths, types, call graphs.                                                          |
| `critic`    | Audits diffs for logic bugs, unhandled paths, regressions.                                                      |
| `librarian` | Read-only web research with verified citations (`web_search`, `fetch_content`, `web_research`, `outline_site`). |

`/wr.profile` manages name, enabled state, model, thinking, tools, description,
system prompt, creation, renaming, deletion, and AI-assisted drafts. Profiles
persist globally at `<agentDir>/agents/<profile-name>.md` (default
`~/.pi/agent/agents/`); project profiles in `<cwd>/agents` and
`<cwd>/.pi/agents` are read for resolution but saves go to the global file.

Children never receive `agent_spawn`, `agent_list`,
`agent_cancel`, or `ask_user`, so agents cannot nest or question you.

## Prompts

| Prompt       | Description                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/plan`      | Explore with subagents, grill on design decisions, write `plans/<slug>.md`.                                                                        |
| `/implement` | Run the approved plan through the `worker` profile (TDD) → `critic` profile (audit) as two sequential `agent_spawn` calls, then render the report. |

`/plan` runs four phases: fact discovery with `explorer`/`librarian` agents
(never ask the user for discoverable facts), design-tree grilling (halt for
answers), plan generation by a `planner` agent into `plans/<feature-slug>.md`
with goal, settled decisions, touchpoints, checkbox tasks, and verification
commands, then review handoff to `/implement`.

`/implement` runs two sequential foreground agents: the **`worker` profile** implements
every unchecked task test-first (including its own tests, linters, and type
checks) and checks the boxes, then **Critic** audits the diff for logic bugs
and returns READY TO COMMIT or REVISION REQUIRED. The parent renders the
Execution & Verification Report and halts for commit confirmation.

## Session history

Agent tasks persist per parent session in `agents-tasks.json` next to the
parent session file. Reloading restores history into `agent_list`. Interrupted
runs from a previous process become failed instead of resurrecting as running.
The widget only ever shows agents from the live process.

## Troubleshooting

- **Agent fails without a result** — check the child's session file from `agent_list`. The result requires the child's final assistant message.
- **Widget row will not leave** — the entry drops when its pane closes or the task
  is cancelled. Closing the pane by hand takes a few seconds to reconcile. If a
  row survives that, its pane id is stale: cancel the task.
- **Spawn fails immediately** — usually a disabled profile name (see
  `/wr.profile`) or 4 agents already running
  (`Concurrency limit exceeded. Maximum 4 concurrent agents allowed.`).
- **No panes appear** — Pi was started outside Herdr. Agents still run headless;
  start Pi from inside Herdr for panes.
- **Background result never arrived** — verify the delivery reached the session
  with the `jq` command above. If the entry exists, spawning and extraction
  worked; investigate parent wake-up rather than the child.

## Development

```bash
node --test tests/pi-subagent/**/*.mjs   # all 101 offline tests
pnpm --dir extensions/pi-subagent check  # type check
pnpm lint extensions/pi-subagent         # lint
pnpm typecheck                           # whole workspace
pnpm fmt                                 # format
```

Tests are fully offline: fake Herdr ops, fake child binaries writing real
sidecars into tmpdirs, no network or model calls.

## Layout

- `index.ts`: package entry point.
- `src/extension.ts`: standalone Pi registration (tools, `/wr.profile`, widget lifecycle, session hooks, background delivery).
- `src/domain.ts`: task lifecycle, specs, and status helpers.
- `src/agent-model.ts`: child usage and transcript types.
- `src/runtime.ts`: Effect layer composition and `runTool`.
- `src/services/`: registry, manager, manifest, persistence, parent lifecycle, agent profiles, model resolution, parent delivery.
- `src/shared/`: child session runner, Herdr process ops, completion monitor, activity tracking.
- `src/tools/agent.ts`: `agent_spawn`, `agent_list`, and `agent_cancel` handlers.
- `src/ui/`: tool call/result rendering, async agent widget, profile editor.
- `src/agent-child.ts`: headless child entry point.
- `prompts/`: `/plan` and `/implement` definitions.
