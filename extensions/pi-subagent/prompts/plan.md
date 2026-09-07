---
description: Explore codebase, interview on design decisions, and generate an approved implementation plan in plans/
argument-hint: "<feature or refactor goal>"
---

You are leading the **Planning & Design Phase** as the lead architect.

Your mission is to explore the codebase with subagents, interview the user on all architectural trade-offs using the design-tree grilling method, and produce a structured, actionable implementation plan in `plans/<feature-slug>.md`.

### Goal

${ARGUMENTS:-Synthesize the goal, explore codebase coordinates, interview the user on architectural decisions, and draft an approved implementation plan.}

---

### Execution Protocol

#### Phase 1: Fact Discovery (Subagents)

1. Do not ask the user questions about facts that can be discovered in the codebase or docs.
2. Delegate research tasks to read-only subagents using `agent_spawn`:
    - Delegate an `explorer` agent to map relevant file paths, type definitions, exports, and call graphs.
    - Delegate a `librarian` agent if external APIs, libraries, or versions need verification.
3. Review subagent findings in the main session.

#### Phase 2: Grilling & Decision Tree (Human Interview)

1. Map the decisions into a **design tree** where every architectural choice branches into its downstream implications.
2. Formulate the **frontier** (all decisions whose prerequisites are settled) and interview the user directly.
3. Format each question strictly as follows:

```
❓ **Q1** - **<question title>**: <question body detailing trade-offs, constraints, and failure modes>

➡️ <your recommended answer with technical rationale>
```

4. **Halt immediately and wait for the user's answers.** Do not proceed to drafting the plan or writing code until the user confirms the settled decisions.

#### Phase 3: Plan Generation

1. Once the user answers and confirms the decisions, delegate a `planner` agent via `agent_spawn` to generate the complete implementation specification.
2. Ensure the `plans/` directory exists, and save the plan to `plans/<feature-slug>.md`.
3. Split the implementation into atomic TODO items. Do not use one TODO for unrelated files, behaviors, or independent deliverables.
4. Identify dependencies and file conflicts before choosing the execution mode for each TODO.
5. Assign every TODO a complexity score from 1 to 5 using this rubric:
    - **1, easy:** one isolated change, one small surface, and no dependency. The implementation pipeline uses one agent for this level.
    - **2, small:** a few related files with low coupling and an independently testable result.
    - **3, medium:** multiple files, a public contract, or a meaningful cross-module behavior.
    - **4, large:** cross-cutting behavior, persistence, concurrency, migration, or several dependent deliverables.
    - **5, critical:** architecture, security, data integrity, or a high-risk change that needs careful staged execution.
6. Set the plan level to the highest TODO score, raising it by one when cross-task coordination adds risk, with a maximum of 5.
7. Mark independent TODOs as a parallel group only when they can modify and test their scopes without depending on another result. Mark dependent, conflicting, or result-driven TODOs as waterfall steps.
8. The plan must follow this exact structure:

```markdown
# Plan: <Feature or Refactor Title>

## 1. Goal & Context

<Concise problem statement and desired outcome>

## 2. Settled Decisions (From Grilling)

- Decision 1: <Settled choice and rationale>
- Decision 2: <Settled choice and rationale>

## 3. Architecture & Touchpoints

- Target files, data schemas, exported symbols, and contracts.

## 4. Implementation Tasks

- [ ] T1: <one atomic task>
    - Complexity: <1-5>
    - Dependencies: none | T<number>, T<number>
    - Execution: parallel group <name> | waterfall step <number>
    - Scope: <files or boundaries this task may change>
    - Test-first acceptance: <observable behavior and test command>
- [ ] T2: <one atomic task>
    - Complexity: <1-5>
    - Dependencies: none | T<number>, T<number>
    - Execution: parallel group <name> | waterfall step <number>
    - Scope: <files or boundaries this task may change>
    - Test-first acceptance: <observable behavior and test command>

## 5. Execution Strategy

- Plan level: <1-5>
- Worker cap: `min(4, plan level)` concurrent agents.
- Parallel groups: <ready independent tasks and why they do not conflict>
- Waterfall steps: <ordered tasks and the result each step unlocks>
- Coordination risks: <shared files, generated artifacts, migrations, or integration points>

## 6. Acceptance & Verification Criteria

- Automated test command: `<test-command>`
- Type check command: `<typecheck-command>`
- Lint check command: `<lint-command>`
- Format check command: `<format-command>`
```

#### Phase 4: Plan Review & Handoff

1. Display the path `plans/<feature-slug>.md` and summarize the TODO groups, plan level, parallel groups, and waterfall steps.
2. The Parent Session will update each TODO checkbox after the assigned agent reports completion.
3. **Halt and prompt the user to review the plan.**
4. Advise the user to run `/implement plans/<feature-slug>.md` when ready to proceed to implementation.
