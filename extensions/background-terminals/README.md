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

| Tool        | Purpose                          |
| ----------- | -------------------------------- |
| `bg_start`  | Start a background process       |
| `bg_status` | Peek at one process              |
| `bg_logs`   | Read/follow retained output logs |
| `bg_list`   | List all processes               |
| `bg_kill`   | Stop one or more processes       |

### `bg_start`

```text
command: shell command string
title: short label shown in /ps and listings
working_dir: optional cwd
name: optional stable handle (1-48 chars) for later reference
ready: optional readiness condition
```

Use `name` for long-lived services so you can address them later as `"web"` instead of remembering `bt-1`.

Names must be unique among currently running terminals. Reuse is allowed after the terminal settles.

Use `ready` to wait until the process is actually usable before the tool returns:

```text
ready.log: regex matched against captured output
ready.port: TCP port that must accept connections
ready.host: host for port check (default 127.0.0.1)
ready.timeoutSec: timeout in seconds (default 30)
```

If both `log` and `port` are provided, both must pass. On timeout the process stays running and the tool reports timed out; do not assume readiness.

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
  working_dir: ".",
  name: "vite",
  ready: { log: "ready in", port: 5173, timeoutSec: 30 }
)
```

After start you get:

```text
Started background terminal bt-1 (vite) "vite-dev" (pid ..., C:\...)

Command: pnpm dev
Readiness condition MET.
```

When the process exits, the model gets a follow-up message automatically.

### `bg_status`

```text
id: "bt-1" or "vite"
```

Returns status, exit info, and tail-truncated stdout/stderr.

### `bg_logs`

```text
id: "bt-1" or "vite"
lines: max lines to return (default 100)
head: read from start instead of tail (default false)
grep: regex filter pattern
cursor: byte offset from an earlier bg_logs call
follow: wait for new output past cursor (default false)
timeoutSec: timeout for follow in seconds (default 30)
```

Use `bg_logs` when you need retained or filtered output. Prefer it over repeated `bg_status` polling.

Reuse the cursor returned from each call for follow/pagination. Do not invent cursor values.

Example:

```text
bg_logs(id: "vite", grep: "error", lines: 50)
```

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

1. `bg_start` with a stable `name` and `ready` condition when appropriate
2. keep working
3. use `bg_logs` when you need retained or filtered output
4. wait for the automatic exit message, or call `bg_kill` when done

### Bad flow

```text
bg_start
sleep 60
bg_status
sleep 60
bg_status
```

That is unnecessary polling. The extension already delivers a completion message, and `bg_logs` covers retained output.

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
- When using Git `sh.exe`, child PATH is prepended with `Git\usr\bin` and `Git\bin` so Unix helpers (sed, uname) and corepack shims (pnpm) resolve.
- Tree kill uses `taskkill /T /F`.
- Kill reports often show `exit 1` instead of `SIGTERM`. That is normal on Windows.

## Related files

- `index.ts` tool + command registration
- `src/manager.ts` process lifecycle
- `src/ui/ps.ts` `/ps` UI
- `src/prompt.ts` model-facing text
