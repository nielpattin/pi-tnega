# Interface and commands

Raft adds a compact activity widget and a dashboard to Pi. They show bounded execution
activity, Task status, validation failures, traces, compaction, and provider transitions. The
interface is observational: opening or closing it does not replace the Main session or start
new work.

## Commands

- `/raft` or `/raft dashboard` opens the activity dashboard.
- `/raft status` reports the working directory, providers, runner, agent limits, MCP state, and widget state.
- `/raft settings` edits Raft configuration.
- `/raft reload` reloads configuration and runtime resources.
- `/raft providers` lists the registered providers.
- `/raft agents` lists local Tasks.
- `/raft log <id> [--lines N] [--before N]` reads a Task's bounded event stream.
- `/raft export-log <id> [path]` copies a Task's run directory.
- `/raft stop <id>` stops a running Task.
- `/raft remove <id>` (alias `/raft kill <id>`) stops a Task and cleans up its run directory.

Use Pi's normal transcript controls to inspect a `raft_exec` result. Nested calls retain
bounded details and their structural trace; the dashboard does not expose a second action
surface for them.

## Settings

Settings are grouped as Executor, MCP, Approvals, Agents, UI, Code previews, and Lifecycle
(compaction and retention). Memory and speculation are configured in `raft.json` only.
Project settings require a trusted project. Changes are validated before they take effect.

## Presentation rules

Activity rows preserve source order and distinguish running, completed, failed, stopped, and
timed-out operations. Long values are clipped at the presentation boundary. The interface does
not treat display text as a result or as a permission decision.
