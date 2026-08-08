# ⚡ workflows — Multi-Agent JavaScript Workflow DSL for Pi

`workflows` is a native [Pi coding agent](https://pi.dev) extension for multi-agent orchestration, fan-out sub-task execution, and structured result aggregation using an inline JavaScript DSL.

---

## ✨ Features

- **Inline JavaScript Orchestration DSL**: Write declarative workflow scripts specifying execution phases, concurrent agent tasks, and structured schema validations.
- **Parallel Fan-Out Execution**: Run up to 4 child agent tasks in parallel with bounded concurrency and automatic schema validation.
- **Background Execution**: Launch workflows asynchronously in background mode (`background: true`) and monitor progress via TUI status views.
- **Interactive TUI Dashboard**: Monitor active and historical workflow runs via `/workflows`.

---

## 🛠️ Tools

| Tool       | Purpose                                                        |
| ---------- | -------------------------------------------------------------- |
| `workflow` | Execute an inline JavaScript multi-agent orchestration script. |

> **Usage Note**: The AI model calls `workflow` when multi-step fan-out orchestration is requested or when the user invokes `ultracode`.

---

## 🚀 Commands

| Command              | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `/workflows`         | List active and historical workflow runs in an interactive TUI dashboard.       |
| `/workflows <runId>` | Open detailed execution view and step-by-step logs for a specific workflow run. |

---

## 📐 Workflow DSL Example

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

---

## 🛡️ Safety & Execution Limits

- **Max Agent Calls**: 32 total agent invocations per workflow run.
- **Max Concurrency**: Bounded at 4 concurrent agents.
- **Execution Sandbox**: Disables `import`, `eval`, timers, network, or raw filesystem access inside workflow scripts.
- **Process Cleanup**: Ensures clean sub-process tree termination across Windows, macOS, and Linux.

---

## 📦 Installation

To load `workflows` in Pi, add `extensions/workflows` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/workflows
```
