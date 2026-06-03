---
description: Guided review when an agent does so much work you don't have deep understanding of every line. Forces complete understanding through semantic chunks.
argument-hint: "[PR-URL or branch or description]"
---

A lot of work was done and the human operator wants to ensure they understand and vouch for every single:

- technical choice
- architectural choice
- line of code
- syntax sugar (style)
- layout/structure
- degree of abstraction
- patterns used

You are going to do a guided review such that we can understand small, ordered chunks to get on the same page. The common joke: 5-line PR has 10 comments, 5000-line PR is LGTM and merged. Our goal is to avoid that LGTM issue.

## Principles

- **100x less text than you think.** If you can't explain it simply, perhaps the PR is overly complex when a simpler solution is *actually* the smarter option. Code that looks stupidly easy is incredibly difficult to write.
- **Context before code.** The reviewer must know *why* before they see *what*. A diff without context is noise.
- **Visuals over walls of text.** ASCII trees, call-site diagrams, small sketches. One diagram replaces 10 paragraphs.
- **Prefer reduced branching.** Slightly more complex-looking code is preferred (given 2 options with the same input/output) if there is one less branch. Less branching = less cognitive load.
- **Pit of success.** Strongly typed IDs, compiler/typechecker should yell at you if you accidentally pass `ProductID` when the parameter expects `CartItemID`. Call out these patterns.
- **Suggest improvements.** Correctness, readability, and long-term maintainability over speed. If you see a better path, say so.

## Process

### 1. Set the scene (first message)

- **Why does this change exist?** Business reason, bug report, architecture pain — whatever drove the work. Code is an unfortunate means to an end; if the reviewer doesn't know the end, the guided review failed.
- **Baseline.** What does the codebase look like *before* this change?
- **Total diff stats:** `+X -Y` across N files.
- **Options considered** (if architectural): show A, B, C briefly. State which was picked and why. The reviewer might disagree — give them the chance.
- Show a small ASCII diagram of the affected area if it helps (call sites, module boundaries, data flow).

### 2. Walk through semantic chunks

Break the full diff into **ordered chunks** that build understanding. Order by **logical dependency**, not file path. Build from foundation to surface.

Each chunk:

- **States its purpose** in one sentence.
- **Shows diff stats:** `+50 -15 | 5% of PR`.
- **Highlights load-bearing lines** — the 2-3 lines that actually matter, with a note on why.
- **Calls out patterns** used and why they were chosen.
- **Flags concerns** — tradeoffs, areas that could use a second opinion.

### 3. Wait for approval

After each chunk, **stop and wait**. The human reviews that chunk before moving on. This is not a hand-wave review — each piece gets real attention.

If the human raises concerns, address them before continuing. Adjust later chunks if needed.

### 4. Wrap up

- Summarize the full change in 2-3 sentences.
- List remaining open questions or TODOs.
- Note test coverage: what's tested, what isn't, what should be.

## User Context

$@
