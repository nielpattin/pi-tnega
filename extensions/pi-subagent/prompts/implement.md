---
description: Execute approved plan tasks with scored parallel agents and audit the diff with critic via agent_spawn
argument-hint: "[plans/<feature-slug>.md]"
---

You lead the **Implementation & Verification Pipeline**.

Execute the approved plan from `plans/<feature-slug>.md`. Use the smallest safe set of `worker` agents, keep the plan current, and audit the complete diff with one `critic` agent.

### Plan target

${ARGUMENTS:-Locate the relevant or most recently modified plan in the plans/ directory.}

---

### Non-negotiable rules

- Execute only work described by the approved plan.
- Do not invent architectural decisions. Stop and ask the user when a decision is missing.
- Each worker owns exactly one TODO.
- The Parent Session owns plan checkboxes and progress updates.
- Workers must not edit plan checkboxes, reorder TODOs, commit changes, or claim unrelated TODOs.
- Record pre-existing workspace changes before dispatching work.
- Do not overwrite, revert, or claim unrelated user changes.
- Use foreground agents and wait for their results.
- Use the literal `worker` profile for implementation and the literal `critic` profile for the final audit.

### Phase 1: Preflight

1. Locate the target plan.
2. Read the entire plan, especially `Implementation Tasks` and `Execution Strategy`.
3. Confirm that the plan contains settled architectural decisions.
4. Record the current workspace diff so unrelated changes remain separate.
5. Build a task table with each unchecked TODO, dependencies, execution mode, scope, and acceptance criteria.
6. Treat a checked TODO as complete only when the plan and workspace agree.
7. If scores, dependencies, or execution modes are missing, infer them conservatively. Use one agent when safe parallelism is unclear.
8. Stop if the plan cannot safely determine the work.

### Phase 2: Dispatch capacity

Calculate the effective worker cap:

```text
min(4, plan level, number of ready independent tasks)
```

- Plan level **1** permits one worker.
- Plan levels **2** through **5** permit up to four workers.
- Never exceed four concurrent workers.
- Never spawn an empty agent specification.

A task is **ready** when it is unchecked and all dependencies are checked.

A task is **parallel-safe** when it has no unresolved dependency, does not share mutable files or generated artifacts with another task, and does not need another worker's result.

A task is **waterfall-only** when it depends on an output, shares a conflict scope, requires ordered migration, or needs a decision from a previous result.

### Phase 3: Worker contract

Give every worker the exact TODO id, task text, scope, dependencies, and test-first acceptance criteria.

Require every worker to:

- Write a failing test first for runtime behavior, then implement the smallest change that makes it pass.
- State why no behavior test applies for documentation, formatting, configuration, or other non-runtime tasks.
- Run the task's targeted tests and relevant checks.
- Avoid edits outside the stated scope unless the task requires them.
- Return this exact information:
    - `status`
    - `completedTasks`
    - `modifiedFiles`
    - `testsAdded`
    - `testsRun`
    - `blockers`
    - `summary`

### Phase 4: Execution loop

Repeat waves until no executable TODO remains:

1. Re-read the plan TODO section and calculate the current ready set.
2. Select up to the effective cap of parallel-safe ready tasks.
3. Dispatch one foreground `worker` per selected task in one `agent_spawn` call.
4. Wait for every worker in the batch before changing the plan or starting dependent work.
5. For waterfall work, dispatch exactly one foreground worker and inspect its result before selecting the next task.
6. Inspect each worker result and the workspace diff.
7. Update the plan before dispatching another wave.

### Phase 5: Progress updates and failures

After every batch or waterfall result, the Parent Session must update the plan:

- Mark a TODO `[x]` only when its acceptance criteria pass and the result identifies its files and tests.
- Leave a failed or incomplete TODO unchecked.
- Add a short blocker note below a failed or incomplete TODO.
- Preserve task ids, dependencies, scores, execution modes, scopes, and acceptance criteria.
- Recalculate the ready set after every update.
- Never dispatch a task whose dependency remains unchecked.
- When all tasks settle, run the plan's complete verification commands in the Parent Session and record the outcome in the plan.

Do not automatically retry a failed task or dispatch a duplicate prompt.

Continue independent tasks only when they have no shared risk. Stop dependent tasks until the blocker is resolved.

Stop the pipeline and ask the user when any of these conditions occurs:

- An architectural decision is missing.
- A worker violates its scope.
- The workspace contains an unexpected conflict.
- A required check fails and the cause is unclear.
- The work creates a data-loss or security risk.

### Phase 6: Critic audit

After all executable waves finish and the Parent Session updates the plan, run one sequential foreground `agent_spawn` call:

```json
{
    "agents": [
        {
            "profile": "critic",
            "name": "audit",
            "task": "Read plans/<feature-slug>.md and the complete workspace diff. Separate pre-existing changes from implementation changes. Audit every checked TODO against its acceptance criteria, tests, dependency order, concurrency assumptions, security boundaries, data-loss risks, and regressions. Do not edit application code or plan checkboxes. Return verdict (READY TO COMMIT or REVISION REQUIRED), planProgress (array of strings), changesSummary (array of strings), criticSafetyNotes (array of strings), and suggestedCommit (string)."
        }
    ]
}
```

If the critic returns `REVISION REQUIRED`, report the exact TODOs and safety notes. Do not claim completion until the Parent Session resolves them and runs the required checks again.

### Phase 7: Final report

When implementation and audit finish, render the complete **Execution & Verification Report**:

- Target plan path and plan level
- Each parallel wave and waterfall step
- Completed TODOs and worker summaries
- Modified files and tests added or run
- Remaining blockers and unchecked TODOs
- Verification command results
- Critic verdict and safety notes
- Suggested commit message

Then halt and await user confirmation before any commit.
