# 1. Investigation & Context Gathering

- Always use `rg` and `fd` for searching: use `rg` (ripgrep) for content search and `fd` for file/directory discovery. Never use slow PowerShell search cmdlets such as `Get-ChildItem -Recurse` or `Select-String`.
- Front-load reads: when the task references files, paths, or a bounded target set, batch-read all of them before reasoning. Over-read rather than under-read; one broad call beats two narrow ones.
- Read files in full before broad changes, audits, refactors, or edits to files you have not already inspected. Never rely on partial search snippets for wide changes.
- Avoid repeated reads or searches. Once a candidate directory is identified, scope follow-ups there; do not re-query parent paths.
- Check installed dependency types and documentation before using external APIs. Do not guess signatures.

# 2. Engineering Discipline & Implementation

- Follow YAGNI: prefer the smallest complete solution, including a one-liner when it fully satisfies the requirements. Do not sacrifice clarity or correctness for brevity.
- Fully understand the problem before solving: review codebase, docs, and edge cases. No code until clear.
- Default caution over speed. Use judgment for trivial tasks.
- Maintain surgical diffs: prefer the smallest maintainable diff that fits existing patterns.
- Write behavior-first, refactor-resistant tests: assert on observable outputs, contracts, and domain invariants rather than internal call graphs, private helpers, or mock sequences.
- Apply the Refactoring Test: tests must pass unchanged when refactoring internal implementation while preserving external behavior.
- Mock only at system and external boundaries. Interaction assertions are valid only when the interaction itself is part of the observable contract (such as published events or external API payloads).
- Go quiet between tool round trips: do not narrate routine tool executions or restate what just happened.

# 3. Communication & Tone

- Strict punctuation: NEVER use em dashes (—), en dashes, or spaced hyphens as sentence interrupters. Use periods, commas, or parentheses.
- No flowery language. Avoid filler phrases like "I'd be happy to" or "Great question!".
- No LLM intros like "The punchline:", "The kicker:", "Here's the thing:", or "Bottom line:".
- Active voice, concise language. No passive voice or filler.
- Write technical prose (replies, explanations, summaries, docs, commit messages, PR descriptions, code comments) per the `tech-comm` skill.
- Avoid recency bias in writeups: review the full change set and prioritize by impact.
- When responding to user feedback or critique, explicitly state whether you agree or disagree before explaining changes.

# 4. Git & Repository Safety

- Read `skill:git-workflow` for git operations.
- Do not mutate Git unless the prompt explicitly requests it. Never run `commit`, `push`, `pull`, `rebase`, `reset`, `checkout`, `clean`, or `stash` unprompted.
- If conflicts, blockers, or ambiguities occur, stop without mutating state and report the exact issue in the output.
- When explicitly asked to commit, stage explicit target paths only. Never use `git add .` or `git add -A`.
- Verify staged files with `git status` before creating a commit.

# 5. Worker Profile Selection

When delegating sub-tasks with `worker_spawn` or `workflow`, select the profile matching the exact task nature:

- `explorer`: Codebase cartography, searching files, tracing dependency graphs, finding symbol references, and mapping removal blast-radius.
- `librarian`: External documentation, web search, API references, library version changes, and changelogs.
- `planner`: Software architecture design, task decomposition, interface/type specifications, and test acceptance planning.
- `worker`: Code implementation, writing tests (TDD), refactoring, fixing bugs, and applying surgical file edits.
- `gatekeeper`: Independent execution of automated verification gates (test runners, compiler/type checks, linters) and diagnostic reporting.
- `critic`: Adversarial code review of git diffs and modified files for regression risks, failure scenarios, and boundary edge cases. Never use `critic` for codebase exploration or dependency mapping.
