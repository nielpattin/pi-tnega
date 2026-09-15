# 📊 pi-codex-usage: OpenAI Codex Usage & Verbosity Control for Pi

`pi-codex-usage` is a native [Pi coding agent](https://pi.dev) extension for checking OpenAI Codex quota/usage and controlling response options.

---

## ✨ Features

- **Usage & Quota Monitoring**: View token limits, current window usage, and quota status for OpenAI Codex models in an interactive TUI screen.
- **Banked Resets**: See banked rate-limit reset credits with expiry hints and spend one with **Ctrl+R**. Locked until **R** refresh, mirroring upstream reset UX.
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

From the usage screen, press **S** to jump straight to the settings screen, **R** to refresh usage (unlocking another reset), and **Ctrl+R** to spend one banked reset credit.

---

## ⚙️ Fast Mode

Fast mode uses a provider-owned Codex transport so Pi cannot overwrite the routing identity while building the request. It:

- sends `service_tier: "priority"` and the configured `text.verbosity` in the request body;
- sends `originator: "codex_cli_rs"` plus `x-codex-routing-hint` on SSE (the WebSocket handshake carries the same identity minus `OpenAI-Beta`, matching stock Pi);
- prefers WebSocket in Pi's normal `auto` mode and falls back to SSE when the WebSocket cannot connect.

- reuses an account-isolated WebSocket session for continuation deltas, with lifecycle cleanup and a sticky per-session SSE fallback;
- compresses SSE request bodies with zstd when the runtime supports it and retries transient responses using server backoff hints.

When fast mode is off, requests continue through Pi's stock Codex provider unchanged. Priority routing may cost more per request.

If fast requests fail, check the redacted telemetry at `<tmp>/pi-codex-fast-debug.log` (transports, statuses, error messages — never tokens or bodies). `/codex-usage` also prints the loaded transport revision.
---

## 📦 Installation

To load `pi-codex-usage` in Pi, add `extensions/pi-codex-usage` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/pi-codex-usage
```
