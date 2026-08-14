# 🔔 notification: Audio Completion Alerts for Pi

`notification` is a native [Pi coding agent](https://pi.dev) extension that plays audio completion notifications when agent tasks finish (`agent_end`).

---

## ✨ Features

- **Audio Notifications**: Plays a sound when the agent finishes generating a response or completing a turn.
- **Configurable Sound & Volume**: Supports custom audio files (`.mp3`, `.wav`) and volume controls in settings.
- **Cross-Platform Audio**: Native audio playback via system utilities (`afplay` on macOS, `powershell` on Windows, `paplay`/`aplay`/`ffplay` on Linux).

---

## ⚙️ Configuration

Configure notification preferences in `~/.pi/agent/settings.json` (or `.pi/settings.json` for project-level settings):

```json
{
    "notification": {
        "sound": "assets/done.mp3",
        "volume": 100
    }
}
```

- **`sound`**: Path to the audio file. Relative paths resolve from the settings file directory. Defaults to `~/.pi/agent/assets/done.mp3`.
- **`volume`**: Playback volume percentage (1 to 100).

---

## 📦 Installation

To load `notification` in Pi, add `extensions/notification` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/notification
```
