# workflows

Run multi-agent orchestration scripts from an inline JavaScript DSL.

## What it does

Lets the model write a short orchestration script that:

1. declares phases
2. fans work out to isolated child agents
3. waits for structured results
4. returns one aggregate answer

Best for multi-step fan-out work:

- research then synthesize
- review many files in parallel
- verify then report

## Tools for the model

| Tool       | Purpose                               |
| ---------- | ------------------------------------- |
| `workflow` | Run an inline JS orchestration script |

Important restriction from the extension itself:

> Only call `workflow` when the user says `ultracode` or specifically requests a workflow run.

## Commands for you

| Command              | Purpose                          |
| -------------------- | -------------------------------- |
| `/workflows`         | List recent/active workflow runs |
| `/workflows <runId>` | Open one run's detail view       |

## Parameters

| Param        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `script`     | Inline JavaScript workflow script                    |
| `args`       | Optional JSON string exposed to the script as `args` |
| `background` | If true, return immediately and notify later         |

Default mode is **blocking** with live progress.

## Workflow DSL

Available primitives inside the script:

```js
export const meta = {
    name: "reliability-review",
    description: "Review modules for reliability risks, then report",
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
                label: `scan:${file}`,
                phase: "Scan",
                schema: FINDINGS
            })
    )
);

const findings = scans.filter((r) => r.ok).map((r) => r.structured);

phase("Report");

const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, {
    label: "report",
    phase: "Report"
});

return {
    findings,
    report: report.ok ? report.output : report.error
};
```

### Primitives

| Primitive                                 | Purpose                            |
| ----------------------------------------- | ---------------------------------- |
| `export const meta = {...}`               | Name/description/phases for the UI |
| `phase(title)`                            | Mark current phase                 |
| `await agent(prompt, options)`            | Run one isolated child agent       |
| `await parallel([...], { concurrency? })` | Run several agents concurrently    |
| `args`                                    | Parsed tool args                   |

### `agent()` result shape

```js
{
  ok: boolean,
  output: string,
  structured?: object,
  error?: string,
}
```

`agent()` never throws into the script. Always check `.ok`.

## Limits and safety

- Max **32** agent calls per workflow run
- Concurrent agents capped at **4**
- Children cannot recursively orchestrate or ask the user
- Children get normal built-ins + trust-appropriate extensions/settings/skills/AGENTS.md
- Individual child tool calls time out after **3 minutes**
- First assistant response must arrive within **45 seconds**, otherwise the agent call fails clearly
- Sandbox child process teardown uses `taskkill /T /F` on Windows for clean process tree termination
- Persistence writes use atomic fallbacks on Windows when destination locks prevent direct file replacement
- Sandbox has no imports, eval, timers, filesystem, network, or process APIs
- No resume: failed runs are re-run from scratch

## Artifacts

Each run is saved under:

```text
~/.pi/agent/workflows/<runId>/
```

Useful for debugging scripts, statuses, and results.

## Background mode

```js
workflow({
    script: "...",
    background: true
});
```

Returns a run id immediately. When finished, a follow-up message is delivered.

Progress is still available via:

```text
/workflows
```

## When to use workflow vs subagent

| Use                                                      | Prefer           |
| -------------------------------------------------------- | ---------------- |
| One self-contained side task                             | `subagent_spawn` |
| Multi-phase fan-out / synthesize pipeline                | `workflow`       |
| User said `ultracode` or explicitly asked for a workflow | `workflow`       |
| Quick background shell process                           | `bg_start`       |

## Dependencies

```text
acorn
@earendil-works/pi-coding-agent
@earendil-works/pi-tui
typebox
```

Also depends on shared helpers in:

```text
extensions/shared/
```

## Reload after install

```text
/reload
```
