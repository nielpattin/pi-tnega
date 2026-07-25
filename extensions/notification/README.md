# notification

Play a completion sound when Pi finishes a response (`agent_end`).

## Config

Configure the done sound in `~/.pi/agent/settings.json`:

```json
{
    "notification": {
        "sound": "assets/done.mp3",
        "volume": 100
    }
}
```

Relative paths resolve from the settings file directory. The default done sound is:

`~/.pi/agent/assets/done.mp3`
