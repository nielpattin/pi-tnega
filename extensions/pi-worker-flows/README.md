# pi-worker-flows

`pi-worker-flows` is Pi's primary multi-agent orchestration extension. It runs model-authored JavaScript workflows in a permission-restricted child process and exposes isolated profile-configured workers, phases, parallel fan-out, a mandatory final Summary phase, persistence, a worker profile editor, and a workflow dashboard.

## Features

- Sandboxed inline JavaScript orchestration with `phase()`, `agent()`, `parallel()`, and `args`.
- Bounded parallel execution with a maximum of four active agents and 32 total calls per run: up to 31 work agents plus the mandatory Summary.
- Profile-based work agents. Workflow scripts select `worker`, `planner`, `explorer`, `critic`, `gatekeeper`, or `librarian` instead of selecting models, providers, or thinking effort directly for work.
- The read-only `librarian` profile uses the Exa web tools to gather current documentation, release, API, version, and compatibility information with source URLs.
- Profile settings control work-agent tools, instructions, model selection, and thinking level.
- Schema-driven `structured_output` results with a hardened final-action prompt contract and the existing `{ ok, output, structured, error }` result contract.
- Automatic final Summary agent with its own system prompt and no tools. Its waiting record appears when the run starts, then receives the immediately preceding phase's structured results, and its final assistant text is the workflow result.
- The Summary transcript shows the actual system prompt, source data, and final assistant message.
- Dashboard `s` settings UI for choosing the final Summary model and thinking level.
- Compaction-aware child sessions that tolerate provider retries and recoverable context overflow.
- Persistent Pi child sessions scoped to the parent Pi session when a parent session file exists.
- Workflow metadata and results under `~/.pi/agent/workflows/<runId>/`; agent transcripts are read from their persisted child session files.
- Blocking and background runs with automatic follow-up delivery. Background results render as collapsible cards: the collapsed view keeps the workflow summary and agent records visible, while `Ctrl+O` reveals the `Result` section.
- Configured fallback models retry a final Summary completion after provider failures. Work-agent fallbacks only run before tool activity starts, preventing duplicate `structured_output` calls.
- `/wf` dashboard for phases, agents, transcripts, usage, and recovered runs.
- `/wr-profile` lists and edits the shared worker profiles with save, toggle, create, delete, and prompt editing.
- Direct worker delegation with `worker_spawn`, `worker_list`, and `worker_cancel`. These workers run without creating a workflow, phases, or a final Summary.
- Direct `worker_spawn` batches contain 1 to 4 workers. They wait for completion by default; set `background: true` to return immediately and receive automatic parent delivery.
- `/wr` opens the direct worker runs dashboard. `/wr-profile` manages the profiles used by workflows and direct workers.

## Workflow DSL

```js
export const meta = {
    name: "reliability-review",
    description: "Review modules and summarize the findings",
    phases: [{ title: "Scan" }, { title: "Report" }]
};

phase("Scan");

const FINDINGS = {
    type: "object",
    properties: {
        issues: { type: "array", items: { type: "string" } },
        ok: { type: "boolean" }
    },
    required: ["issues", "ok"]
};

const scans = await parallel(
    args.files.map(
        (file) => () =>
            agent(`Review ${file} for correctness and reliability risks.`, {
                agent: "explorer",
                label: `scan:${file}`,
                phase: "Scan",
                schema: FINDINGS
            })
    )
);

const findings = scans.filter((result) => result.ok).map((result) => result.structured);

phase("Report");
const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, {
    agent: "worker",
    label: "report",
    phase: "Report"
});

// The runtime appends the mandatory Summary phase and returns its text.
// The script return value is not the workflow result.
```

`agent()` defaults to the `worker` profile when `agent` is omitted. It never throws into the workflow script. Always inspect `result.ok` before using `result.output` or `result.structured`.

The runtime always appends a reserved `Summary` phase after the declared phases. Do not declare or call a phase named `Summary`. It receives the structured results from the immediately preceding phase. It uses a dedicated system prompt, has no tools, and does not call `structured_output`; its assistant text becomes `WorkflowDetails.result` and the workflow tool's final result. Configure its model and thinking level by pressing `s` in the `/wf` dashboard. The setting is stored at `~/.pi/agent/.ext-config/workflows.json`.

## Persistence and recovery

Workflow metadata is stored under `~/.pi/agent/workflows/<runId>/`. When the parent Pi session is persisted, each child agent also receives a persistent Pi session file in the parent-scoped child-session directory. The workflow dashboard reads recovered transcripts from those session files.

Recovery marks interrupted runs as aborted. It never silently resumes provider work.

Background result cards normalize displayed paths to slash-separated forms such as `~/.pi/agent/workflows/<runId>`.

## Commands

- `/wf` opens the workflow run dashboard in a full-size screen. Regular TUI mode uses an alternate terminal buffer; fullscreen mode reuses Pi's existing alternate buffer without nesting one.
- `/wf <runId>` opens one run.
- In the dashboard, `s` opens Summary settings, `r` saves a report, and `c` copies an agent transcript.
- In an agent transcript, `y`/`p` copies the child session path, `t` toggles thinking, `Ctrl+S` toggles the system prompt, and the mouse wheel scrolls three lines per step.
- `/wr-profile` opens the shared worker profile editor in the TUI, or lists worker profiles in non-interactive mode.
- `/wr` lists direct worker runs and opens their dashboard.

## Safety limits

- Maximum four concurrent agents per workflow.
- Maximum 32 agent calls per workflow.
- Workflow source, arguments, IPC messages, and results are byte bounded.
- Workflow scripts cannot import modules, evaluate dynamic code, access the filesystem, access the network, start processes, invoke interactive questions, or recursively start workflows.
- Child tool calls have bounded timeouts.

## Installation

```bash
pi -e ./extensions/pi-worker-flows
```
