# 📊 pi-codex-usage: OpenAI Codex Usage & Verbosity Control for Pi

`pi-codex-usage` is a native [Pi coding agent](https://pi.dev) extension for checking OpenAI Codex quota/usage and controlling response options.

---

## ✨ Features

- **Usage & Quota Monitoring**: View token limits, current window usage, and quota status for OpenAI Codex models in an interactive TUI screen.
- **Fast Mode**: Route Codex requests through OpenAI's `priority` service tier (`service_tier: "priority"`) for faster responses. Off by default.
- **Response Verbosity Tuning**: Dynamically adjust OpenAI Codex output verbosity (`low`, `medium`, `high`) to optimize response detail and token consumption.
- **Persistent Preferences**: Stores fast mode and verbosity settings across agent sessions in `~/.pi/agent/pi-codex-usage.json`.

---

## 🚀 Commands

| Command                            | Description                                                    |
| ---------------------------------- | -------------------------------------------------------------- |
| `/codex-usage`                     | Open the interactive Codex usage and quota screen in TUI mode. |
| `/codex-usage settings`            | Open the settings screen to toggle fast mode and verbosity.    |
| `/codex-usage fast`                | Toggle fast mode.                                              |
| `/codex-usage fast on\|off`        | Enable or disable fast mode directly.                          |
| `/codex-usage <low\|medium\|high>` | Set OpenAI Codex response verbosity directly.                  |
| `/codex-usage verbosity`           | Select response verbosity from an interactive UI menu.         |

From the usage screen, press **S** to jump straight to the settings screen.

---

## ⚙️ Fast Mode

Fast mode adds `service_tier: "priority"` to each OpenAI Codex request payload, the same mechanism used by `pi-codex-conversion`. Priority tier typically responds faster but can cost more per request. Toggle it in the settings screen, or with `/codex-usage fast on|off`.

---

## 📦 Installation

To load `pi-codex-usage` in Pi, add `extensions/pi-codex-usage` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/pi-codex-usage
```
