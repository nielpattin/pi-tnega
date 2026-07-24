# background-terminals

Run long-lived shell processes in the background without blocking the main agent.

Use this for:

- dev servers
- watch modes
- long builds
- anything that keeps printing output

Do **not** use this for quick one-shot commands. Use the normal `bash` tool for those.

## Commands

| Command | What it does                    |
| ------- | ------------------------------- |
| `/ps`   | Open the background terminal UI |

In TUI:

1. `/ps` opens a list of all tracked terminals.
2. Enter opens a detail view for one terminal.
3. In detail view you can switch stdout/stderr, scroll, and kill.

In non-TUI modes, `/ps` just prints a text list.

## Tools the model can call

| Tool        | Purpose                    |
| ----------- | -------------------------- |
| `bg_start`  | Start a background process |
| `bg_status` | Peek at one process        |
| `bg_list`   | List all processes         |
| `bg_kill`   | Stop one or more processes |

### `bg_start`

```text
command: shell command string
title: short label shown in /ps and listings
working_dir: optional cwd
```

Important limits:

- no stdin
- interactive commands will hang or fail
- max 8 running at once
- session-scoped: killed on session end / reload

Example:

```text
bg_start(
  title: "vite-dev",
  command: "pnpm dev",
  working_dir: "."
)
```

After start you get:

```text
Started background terminal bt-1 "vite-dev" (pid ..., C:\...)

Command: pnpm dev
...
```

When the process exits, the model gets a follow-up message automatically.

### `bg_status`

```text
id: "bt-1"
```

Returns status, exit info, and tail-truncated stdout/stderr.

### `bg_list`

No args. Lists all tracked terminals.

### `bg_kill`

```text
ids: ["bt-1", "bt-2"]
```

Kills the whole process tree.

On Windows this uses `taskkill /T /F`.
On POSIX this uses process-group SIGTERM then SIGKILL.

## How you should use it

### Good prompt

```text
Start the Vite dev server in the background and keep working.
```

### Good model flow

1. `bg_start`
2. keep working
3. only use `bg_status` if you need live output now
4. wait for the automatic exit message, or call `bg_kill` when done

### Bad flow

```text
bg_start
sleep 60
bg_status
sleep 60
bg_status
```

That is unnecessary polling. The extension already delivers a completion message.

## `/ps` detail view keys

Typical keys:

- select / open
- `t` toggle stdout/stderr
- `x` kill
- scroll / page / top / bottom
- back / cancel

The header, command, and shortcut hint wrap fully. They are not truncated with `...`.

## Output storage

- Tool results show tail-truncated output.
- Full logs are spilled to temp files under the private session spill directory.
- `/ps` is the best place to inspect full retained output.

## Notes for Windows

- Shell preference: Git Bash `sh.exe` when available, otherwise `cmd.exe`.
- Tree kill uses `taskkill /T /F`.
- Kill reports often show `exit 1` instead of `SIGTERM`. That is normal on Windows.

## Related files

- `index.ts` tool + command registration
- `src/manager.ts` process lifecycle
- `src/ui/ps.ts` `/ps` UI
- `src/prompt.ts` model-facing text
