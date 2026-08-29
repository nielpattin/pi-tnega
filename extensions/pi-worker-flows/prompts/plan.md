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
2. Delegate research tasks to read-only subagents using `worker_spawn`:
    - Delegate an `explorer` worker to map relevant file paths, type definitions, exports, and call graphs.
    - Delegate a `librarian` worker if external APIs, libraries, or versions need verification.
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

1. Once the user answers and confirms the decisions, delegate a `planner` worker via `worker_spawn` to generate the complete implementation specification.
2. Ensure the `plans/` directory exists, and save the plan to `plans/<feature-slug>.md`.
3. The plan file must follow this exact structure:

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

- [ ] Task 1: <Task description with test-first criteria>
- [ ] Task 2: <Task description with test-first criteria>
- [ ] Task 3: <Task description with test-first criteria>

## 5. Acceptance & Verification Criteria

- Automated test command: \`<test-command>\`
- Type check command: \`<typecheck-command>\`
- Lint check command: \`<lint-command>\`
```

#### Phase 4: Plan Review & Handoff

1. Display the path `plans/<feature-slug>.md` and summarize the planned tasks.
2. **Halt and prompt the user to review the plan.**
3. Advise the user to run `/implement plans/<feature-slug>.md` when ready to proceed to implementation.
