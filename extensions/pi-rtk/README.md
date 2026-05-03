# @nielpattin/pi-rtk

A pi package that rewrites `bash` tool calls through [RTK](https://github.com/rtk-ai/rtk) before execution, and optionally provides RTK-powered tools for grep and find.

## Features

**Bash rewriting** (enabled by default): transparently rewrites commands like `git status` into `rtk git status` to cut token-heavy shell output by 60-90%.

**RTK tools** (disabled by default): adds `rtk_grep` and `rtk_find` tools that use the RTK CLI for token-optimized output.

## Install

```bash
pi install /path/to/pi-stuff/packages/pi-rtk
```

Or after publishing:

```bash
pi install npm:@nielpattin/pi-rtk
```

## Requirements

Install RTK separately and make sure `rtk rewrite` works in your shell:

```bash
brew install rtk
# or
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh

rtk rewrite "git status"
```

## Usage

Once installed, restart pi or run `/reload`.

```text
/pi-rtk                    Show current state
/pi-rtk status             Show current state
/pi-rtk on                 Enable bash rewriting for this session
/pi-rtk off                Disable bash rewriting for this session
/pi-rtk verbose on|off     Toggle verbose rewrite logging
/pi-rtk statusbar on|off   Toggle footer status indicator
/pi-rtk tools on|off       Toggle rtk_grep, rtk_find tools
/pi-rtk refresh            Re-check RTK availability
/pi-rtk test <cmd>         Preview one rewrite
```

## RTK Tools

Disabled by default. Enable with `/pi-rtk tools on`.

| Tool | Description | RTK command |
|------|-------------|-------------|
| `rtk_grep` | Token-optimized content search | `rtk grep` |
| `rtk_find` | Token-optimized file search | `rtk find` |

## Notes

- Bash rewriting is enabled by default. Toggle with `/pi-rtk off`.
- Verbose mode is enabled by default. Toggle with `/pi-rtk verbose off`.
- Status bar indicator is enabled by default. Toggle with `/pi-rtk statusbar off`.
- RTK tools are disabled by default. Toggle with `/pi-rtk tools on`.
- pi built-in tools like `read`, `edit`, and `write` do not go through RTK.
