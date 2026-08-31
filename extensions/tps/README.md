# tps: Live token speed metrics for Pi

`tps` is a native [Pi coding agent](https://pi.dev) extension that displays live token throughput while the model streams a response and reports usage when the agent loop ends.

## Features

- Shows live `TPS` in the status bar using a one-second sliding window.
- Tracks time to first token (`TTFT`).
- Counts text, thinking, and `edit` or `write` tool-call deltas using the default direct strategy.
- Uses the same active-stream timer for live and final TPS, excluding prompt-processing tool waits.
- Uses fixed default speed tiers with color-coded status-bar output.
- Reports input, output, cache, total tokens, complete loop time, and the duration of the last assistant message.
- Reports an intermediate summary after a message when the agent continues with more work.
- Does not register commands or read and write extension configuration.

## Installation

Load the extension from the repository root:

```bash
pi -e ./extensions/tps
```
