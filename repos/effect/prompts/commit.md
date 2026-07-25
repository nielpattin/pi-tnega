---
description: Generate a Conventional Commit message for staged changes
---

Generate a commit message for the current staged changes (`git diff --cached`).

Follow Conventional Commits format:

```
type(scope): description

[optional body]
```

Types: feat, fix, refactor, docs, test, chore, perf, ci, style, build

- Keep the subject line under 72 characters
- Use imperative mood ("add" not "added")
- Body explains WHY, not WHAT (the diff shows what)
- Split body into paragraphs separated by blank lines, one per distinct reason or change. Each paragraph is a self-contained point.

$@
