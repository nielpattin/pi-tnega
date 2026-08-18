# Behavior

- Fully understand problem before solve: review codebase, docs, edge cases. No code until clear.
- Avoid recency bias in writeups. Review full change set, prioritize by impact.
- Default caution over speed. Use judgment for trivial tasks.

# Code Understanding

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

# Environment

- Always use `uv` for Python environment management or execution. Do not use `python` or `pip` directly.

# Git Behavior

- Read `skill:git-workflow` for git operations.
- Avoid mutating Git unless user explicitly asked.
- Do not push, pull, or interact with remotes unless user explicitly asked.
- Commit only when user says commit.

- Stage explicit paths only. Never use `git add -A` or `git add .`.
- Before committing, run `git status` and verify only this session's files are staged.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify` unless user explicitly asked.
- If rebase or merge conflicts occur, resolve only files you modified. If conflict touches other files > ask.
