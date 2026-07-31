# copy-all

Copy the active post-compaction window of the current session to the system clipboard.

## What it does

Registers one user command:

| Command     | Purpose                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `/copy-all` | Copy the last compaction summary + user/assistant messages up to the current active leaf |

It does **not** register model tools. This is a human-facing convenience command.

## How to use

In Pi:

```text
/copy-all
```

It waits until the agent is idle, then uses `sessionManager.buildContextEntries()` so pre-compaction history is dropped. When the branch was compacted, the clipboard starts with the latest compaction summary:

```text
COMPACTION:
...

---

USER:
...

---

ASSISTANT:
...
```

If the session was never compacted, it copies the full active branch (user + assistant only).

If there are no sections to copy, it notifies and does nothing.

## What gets copied

Included:

- latest compaction summary (when present on the active branch)
- user messages after the last compaction (or the full branch if never compacted)
- assistant messages in that same window

Excluded:

- messages summarized away by compaction (pre-`firstKeptEntryId`)
- abandoned / non-active branches
- tool results
- custom system/extension entries
- empty messages

Image blocks become:

```text
[image]
```

## Platform note

Clipboard resolution strategy:

- **Windows**: Prefers `powershell` (`Set-Clipboard` via UTF-8 `StreamReader`), falls back to `clip`.
- **macOS**: Native `pbcopy`.
- **Linux**: Prefers `wl-copy` (Wayland), falls back to `xclip` or `xsel`.

## Dependencies

```text
effect
```

## Reload after install

```text
/reload
```
