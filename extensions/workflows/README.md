# workflows

`workflows` is Pi's primary multi-agent orchestration extension. It runs model-authored JavaScript workflows in a permission-restricted child process and exposes isolated profile-configured agents, phases, parallel fan-out, structured results, persistence, a profile editor, and a workflow dashboard.

## Features

- Sandboxed inline JavaScript orchestration with `phase()`, `agent()`, `parallel()`, and `args`.
- Bounded parallel execution with a maximum of four active agents and 32 calls per run.
- Profile-based child agents. Workflow scripts select `fast`, `good`, `scout`, or `reviewer` instead of selecting models, providers, or thinking effort directly.
- Profile settings control tools, instructions, model selection, and thinking level.
- Schema-driven `structured_output` results with a hardened final-action prompt contract and the existing `{ ok, output, structured, error }` result contract.
- Compaction-aware child sessions that tolerate provider retries and recoverable context overflow.
- Persistent Pi child sessions scoped to the parent Pi session when a parent session file exists.
- Workflow artifacts under `~/.pi/agent/workflows/<runId>/` for scripts, arguments, results, transcripts, and recovery metadata.
- Blocking and background runs with automatic follow-up delivery.
- `/workflows` dashboard for phases, agents, transcripts, usage, and recovered runs.
- `/agents` profile listing and fullscreen profile editor with save, toggle, create, delete, and prompt editing.

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
                agent: "scout",
                label: `scan:${file}`,
                phase: "Scan",
                schema: FINDINGS
            })
    )
);

const findings = scans.filter((result) => result.ok).map((result) => result.structured);

phase("Report");
const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, {
    agent: "good",
    label: "report",
    phase: "Report"
});

return {
    findings,
    report: report.ok ? report.output : report.error
};
```

`agent()` defaults to the `good` profile when `agent` is omitted. It never throws into the workflow script. Always inspect `result.ok` before using `result.output` or `result.structured`.

## Persistence and recovery

Workflow metadata is stored under `~/.pi/agent/workflows/<runId>/`. When the parent Pi session is persisted, each child agent also receives a persistent Pi session file in the parent-scoped child-session directory. The workflow dashboard can inspect recovered transcripts, usage, profile, model, and session metadata.

Recovery marks interrupted runs as aborted. It never silently resumes provider work.

## Commands

- `/workflows` opens the workflow run dashboard in a full-size screen. Regular TUI mode uses an alternate terminal buffer; fullscreen mode reuses Pi's existing alternate buffer without nesting one.
- `/workflows <runId>` opens one run.
- In an agent transcript, `s` copies the transcript, `y`/`p` copies the child session path, `t` toggles thinking, `Ctrl+S` toggles the system prompt, and the mouse wheel scrolls three lines per step.
- `/agents` opens the profile editor in the TUI, or lists profiles in non-interactive mode.

## Safety limits

- Maximum four concurrent agents per workflow.
- Maximum 32 agent calls per workflow.
- Workflow source, arguments, IPC messages, and results are byte bounded.
- Workflow scripts cannot import modules, evaluate dynamic code, access the filesystem, access the network, start processes, invoke interactive questions, or recursively start workflows.
- Child tool calls and first responses have bounded timeouts.

## Installation

```bash
pi -e ./extensions/workflows
```
