# 📋 copy-all — Active Session Clipboard Exporter for Pi

`copy-all` is a native [Pi coding agent](https://pi.dev) extension that copies the active post-compaction conversation window of the current session directly to your system clipboard.

---

## ✨ Features

- **Post-Compaction Window Selection**: Copies user/assistant messages after the last compaction (including the compaction summary), dropping stale or summarized-away history.
- **Clean Text Formatting**: Formats copied history into clean `USER:` and `ASSISTANT:` blocks separated by clear section dividers (`---`).
- **Cross-Platform Clipboard**: Copies safely via `powershell` / `clip` (Windows), `pbcopy` (macOS), and `wl-copy` / `xclip` / `xsel` (Linux).
- **Tool-Noise Filtering**: Excludes internal tool execution results, abandoned conversation branches, and system entries.

---

## 🚀 Commands

| Command | Purpose |
| --- | --- |
| `/copy-all` | Copy the compaction summary and active user/assistant turn messages up to the current session leaf. |

---

## 📄 Clipboard Output Format

When history has been compacted, output starts with the compaction summary:

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

If the session has never been compacted, `/copy-all` exports the active branch's complete user and assistant history.

---

## 📦 Installation

To load `copy-all` in Pi, add `extensions/copy-all` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/copy-all
```
