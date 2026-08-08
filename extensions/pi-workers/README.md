# 🤖 pi-workers — Concurrent Worker Delegation & Process Supervision for Pi

`pi-workers` is a native [Pi coding agent](https://pi.dev) extension that provides sub-agent task delegation, multi-agent coordination, long-running process supervision, and an interactive TUI dashboard.

---

## ✨ Features

- **Concurrent Worker Delegation**: Delegate complex research, analysis, and implementation tasks to 1–4 background worker agents in parallel using `worker_spawn`.
- **Orchestrator Mode**: Easily switch your primary agent into Orchestrator Mode via `/orchestrator [instructions]` to coordinate sub-task execution.
- **Process Supervision**: Run and supervise long-running background services, compilers, watchers, and mock servers using `process_start`.
- **Interactive TUI Dashboard**: Monitor running worker jobs and background processes in real time via `/workers`.
- **Compact Single-Line Transcripts**: Formatted transcript viewer displaying tool calls and results concisely (`✓ tool (N lines/results)`).
- **Clipboard Export Shortcuts**: Copy absolute session paths, working directories (`y`/`p`), or full structured transcripts (`s`) directly to system clipboard.
- **Silent Job Cancellation**: Cancel running worker agents (`worker_cancel` / `x`) without interrupting the parent session with unnecessary error reports.

---

## 🛠️ Tools

### Worker Delegation Tools

| Tool            | Purpose                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `worker_spawn`  | Spawn 1 to 4 worker agents concurrently with `{ workers: [{ name, task, agent }] }`. |
| `worker_list`   | List active and historical worker jobs and their status.                             |
| `worker_cancel` | Cancel a running worker job by ID (suppresses parent result delivery).               |

### Process Supervision Tools

| Tool               | Purpose                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `process_start`    | Start a long-running process or background service (dev servers, watchers, queues). |
| `process_list`     | List all background processes supervised by Pi.                                     |
| `process_snapshot` | Inspect recent output logs and status of a supervised process.                      |
| `process_restart`  | Restart a supervised background process by ID.                                      |
| `process_stop`     | Stop a running background process by ID or name.                                    |

---

## 🚀 Commands

| Command                        | Description                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `/orchestrator [instructions]` | Switch the main agent into Orchestrator Mode to coordinate sub-tasks across concurrent workers.    |
| `/workers`                     | Open the interactive TUI Workers Dashboard (or output a job/process table snapshot in print mode). |
| `/agents`                      | View available agent profiles and open the agent profile configuration UI.                         |
| `/btw <question>`              | Ask a side question to a background worker without interrupting the main conversation.             |

---

## 📊 Dashboard & Viewport Navigation Shortcuts

When in the `/workers` TUI dashboard or detail/transcript views:

- `j` / `k` (or `Up` / `Down` arrows): Navigate worker jobs and background processes with cyclic wrap-around.
- `Enter`: Open takeover / detailed transcript view for the selected worker or process.
- `y` / `p`: Copy session absolute file path or working directory (`cwd`) to system clipboard.
- `s`: Copy formatted transcript payload (with start/end delimiters) to system clipboard.
- `x`: Cancel selected worker job or stop background process.
- `Esc`: Return to dashboard (preserves active selection).

---

## 📦 Installation

To load `pi-workers` in your Pi session, add `extensions/pi-workers` to your workspace extension configuration, or try it directly from the repository root:

```bash
pi -e ./extensions/pi-workers
```
