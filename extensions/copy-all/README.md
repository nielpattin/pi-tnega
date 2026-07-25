# copy-all

Copy the current session transcript to the system clipboard.

## What it does

Registers one user command:

| Command     | Purpose                                                    |
| ----------- | ---------------------------------------------------------- |
| `/copy-all` | Copy all previous user + assistant messages in this thread |

It does **not** register model tools. This is a human-facing convenience command.

## How to use

In Pi:

```text
/copy-all
```

It waits until the agent is idle, then copies:

```text
USER:
...

---

ASSISTANT:
...

---

USER:
...
```

If there are no user/assistant messages, it notifies and does nothing.

## What gets copied

Included:

- user messages
- assistant messages

Excluded:

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
