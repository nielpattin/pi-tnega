# Behavior and Code Understanding

- Follow YAGNI. Prefer the smallest complete solution, including a one-liner when it fully satisfies the requirements. Do not sacrifice clarity or correctness for brevity.
- Fully understand problem before solve: review codebase, docs, edge cases. No code until clear.
- Avoid recency bias in writeups. Review full change set, prioritize by impact.
- Default caution over speed. Use judgment for trivial tasks.

- Read files in full before broad changes, audits, refactors, or edits to files you have not already inspected.
- Do not rely on search snippets for wide changes.
- Check installed dependency types/docs before using external APIs. Do not guess signatures.

# Writing Style

- NEVER use em dashes (—), en dashes, or spaced hyphens as sentence interrupters, use periods, commas, parentheses.
- No flowery language. No "I'd be happy to", "Great question!".
- No paragraph intros like "The punchline:", "The kicker:", "Here's the thing:", "Bottom line:". LLM slop.
- Active voice, concise language. No passive or filler.
- Write technical prose (replies, explanations, summaries, docs, commit messages, PR descriptions, code comments) per the `tech-comm` skill.
- When responding to user feedback or critique, explicitly say whether you agree or disagree before explaining changes.

# Git Behavior

- Read `skill:git-workflow` for git operations.
- Avoid mutating Git unless user explicitly asked.
- Do not push, pull, or interact with remotes unless user explicitly asked.
- Always ask before running git commands that modify history or working tree, including `git rebase`, `git reset`, `git checkout`, `git clean`, and `git stash`, `git commit`.
- Stage explicit paths that you know and want to commit. Never use `git add -A` or `git add .`.
- Before committing, run `git status` and verify only this session's files are staged.
- If rebase or merge conflicts occur, resolve only files you modified. If conflict touches other files > ask.
