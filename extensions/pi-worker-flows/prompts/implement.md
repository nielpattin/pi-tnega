---
description: Execute approved plan tasks with Worker (TDD), enforce gates with Gatekeeper, audit diff with Critic, and produce final report via workflow
argument-hint: "[plans/<feature-slug>.md]"
---

You are leading the **Implementation & Verification Pipeline** as the lead orchestrator.

Your mission is to execute the approved plan from `plans/<feature-slug>.md` using the `workflow` tool. This runs the automated sequence (**Worker (TDD)** $\rightarrow$ **Gatekeeper (Automated Gates)** $\rightarrow$ **Critic (Semantic Audit)** $\rightarrow$ **Runtime Summary**), delivering the certified report directly without main-session double-typing.

### Plan Target

${ARGUMENTS:-Locate the relevant or most recently modified plan in the plans/ directory.}

---

### Execution Protocol

1. Identify the target plan file `plans/<feature-slug>.md`.
2. Execute the pipeline by calling the `workflow` tool:

- **`args`**: `{"plan":"plans/<feature-slug>.md"}`
- **`script`**:

```js
export const meta = {
    name: "implement-pipeline",
    description: "Execute approved plan tasks, enforce automated gates, and audit diff",
    phases: [{ title: "Implement" }, { title: "Gatekeeper" }, { title: "Audit" }]
};

// 1. Worker implements tasks using TDD
phase("Implement");
const workerResult = await agent(
    `Read ${args.plan}. Implement all uncompleted tasks using test-driven development (write failing tests first, make them pass, preserve surgical diffs). Update task checkboxes in ${args.plan} to [x].`,
    {
        agent: "worker",
        label: "implement",
        schema: {
            type: "object",
            properties: {
                completedTasks: { type: "array", items: { type: "string" } },
                modifiedFiles: { type: "array", items: { type: "string" } },
                testsAdded: { type: "array", items: { type: "string" } },
                summary: { type: "string" }
            },
            required: ["completedTasks", "modifiedFiles", "summary"]
        }
    }
);

// 2. Gatekeeper executes automated test and compiler gates
phase("Gatekeeper");
const gateResult = await agent(
    `Read ${args.plan} (Section 5: Acceptance & Verification Criteria). Inspect git status and run all required automated test suites, type checkers, linters, and formatters.`,
    {
        agent: "gatekeeper",
        label: "gates",
        schema: {
            type: "object",
            properties: {
                passed: { type: "boolean" },
                gates: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            check: { type: "string" },
                            command: { type: "string" },
                            exitCode: { type: "number" },
                            duration: { type: "string" },
                            status: { type: "string" }
                        },
                        required: ["check", "command", "exitCode", "status"]
                    }
                },
                failures: { type: "array", items: { type: "string" } }
            },
            required: ["passed", "gates"]
        }
    }
);

// 3. Critic audits passing code and consolidates evidence for final report
phase("Audit");
const criticResult = await agent(
    `Using worker output:\n${JSON.stringify(workerResult.structured)}\nand Gatekeeper output:\n${JSON.stringify(gateResult.structured)}\nRead ${args.plan} for expected invariants. Review the clean workspace git diff for subtle logic bugs, unhandled error paths, concurrency risks, and regressions.`,
    {
        agent: "critic",
        label: "audit",
        schema: {
            type: "object",
            properties: {
                verdict: { type: "string", enum: ["READY TO COMMIT", "REVISION REQUIRED"] },
                planProgress: { type: "array", items: { type: "string" } },
                changesSummary: { type: "array", items: { type: "string" } },
                gateEvidence: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            check: { type: "string" },
                            command: { type: "string" },
                            exitCode: { type: "number" },
                            duration: { type: "string" },
                            status: { type: "string" }
                        },
                        required: ["check", "command", "exitCode", "status"]
                    }
                },
                criticSafetyNotes: { type: "array", items: { type: "string" } },
                suggestedCommit: { type: "string" }
            },
            required: [
                "verdict",
                "planProgress",
                "changesSummary",
                "gateEvidence",
                "criticSafetyNotes",
                "suggestedCommit"
            ]
        }
    }
);
```

3. When the `workflow` tool call finishes, the runtime Summary agent will have already generated and rendered the complete **Execution & Verification Report**. Do not rewrite, duplicate, or paraphrase the report in the main session. Simply halt and await user confirmation to commit.
