# 📊 pi-codex-usage — OpenAI Codex Usage & Verbosity Control for Pi

`pi-codex-usage` is a native [Pi coding agent](https://pi.dev) extension for checking OpenAI Codex quota/usage and controlling response verbosity.

---

## ✨ Features

- **Usage & Quota Monitoring**: View token limits, current window usage, and quota status for OpenAI Codex models in an interactive TUI screen.
- **Response Verbosity Tuning**: Dynamically adjust OpenAI Codex output verbosity (`low`, `medium`, `high`) to optimize response detail and token consumption.
- **Persistent Preferences**: Stores verbosity settings across agent sessions.

---

## 🚀 Commands

| Command | Description |
| --- | --- |
| `/codex-usage` | Open the interactive Codex usage and quota screen in TUI mode. |
| `/codex-usage <low\|medium\|high>` | Set OpenAI Codex response verbosity directly. |
| `/codex-usage verbosity` | Select response verbosity from an interactive UI menu. |

---

## 📦 Installation

To load `pi-codex-usage` in Pi, add `extensions/pi-codex-usage` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/pi-codex-usage
```
