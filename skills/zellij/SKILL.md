---
name: zellij
description: Use when manipulating Zellij sessions, creating tabs or panes, or looking up Zellij CLI commands for terminal multiplexer operations
---

# Zellij Reference

## Overview

Quick reference for Zellij CLI commands to manipulate running sessions. Covers session management, tabs, and panes.

## When to Use

- Creating or attaching to Zellij sessions
- Managing tabs and panes programmatically
- Need CLI commands (not keybindings)
- Automating Zellij operations

**When NOT to use:**
- Looking for keybindings (this is CLI only)
- Layout file syntax
- Configuration options

## Quick Reference

### Sessions

| Task | Command |
|------|---------|
| Create/attach session | `zellij attach --create <name>` or `zellij -s <name>` |
| List sessions | `zellij list-sessions` |
| Kill session | `zellij kill-session <name>` |
| Delete session | `zellij delete-session <name>` |
| Rename session | `zellij action rename-session <name>` |
| Kill all sessions | `zellij kill-all-sessions` (add `-y` to auto-confirm) |
| Delete all sessions | `zellij delete-all-sessions` (add `-f` to force-kill running) |
| Switch session | `zellij action switch-session <name>` |
| Save session | `zellij action save-session` |

### Tabs

| Task | Command |
|------|---------|
| New tab | `zellij action new-tab` |
| New tab with name | `zellij action new-tab --name <name>` |
| New tab with cwd | `zellij action new-tab --cwd <path>` |
| New tab with layout | `zellij action new-tab --layout <layout>` |
| Close tab | `zellij action close-tab` |
| Rename tab | `zellij action rename-tab <name>` |
| Go to tab by name | `zellij action go-to-tab-name <name>` |
| Go to tab by index | `zellij action go-to-tab <index>` |
| List tabs | `zellij action list-tabs` |

### Panes

| Task | Command |
|------|---------|
| New pane (auto) | `zellij action new-pane` |
| Split right | `zellij action new-pane --direction right` |
| Split down | `zellij action new-pane --direction down` |
| Floating pane | `zellij action new-pane --floating` |
| Floating with size | `zellij action new-pane --floating --width 80% --height 60%` |
| Pane with command | `zellij action new-pane -- <command>` |
| Close pane | `zellij action close-pane` |
| Rename pane | `zellij action rename-pane <name>` |
| List panes | `zellij action list-panes` |
| Dump layout | `zellij action dump-layout` |
| Dump screen content | `zellij action dump-screen` |

### Running Commands

| Task | Command |
|------|---------|
| Run command in pane | `zellij run <cmd>` |
| Run and close on exit | `zellij run --close-on-exit <cmd>` |
| Run in direction | `zellij run --direction down <cmd>` |
| Run floating | `zellij run --floating <cmd>` |
| Run in specific dir | `zellij run --cwd <path> <cmd>` |
| Run with name | `zellij run --name <name> <cmd>` |
| Run in-place (suspend current) | `zellij run --in-place <cmd>` |
| Run and block until done | `zellij run --blocking <cmd>` |

### Common Patterns

**New tab for specific task:**
```bash
zellij action new-tab --name "backend" --cwd ~/api
```

**Split pane and run command:**
```bash
zellij action new-pane --direction down -- npm run dev
```

**New pane with guaranteed working directory:**
```bash
# For interactive shell with specific directory
zellij action new-pane --cwd /path/to/dir

# For command that must run in specific directory
zellij action new-pane --cwd /path/to/dir -- sh -c 'cd /path/to/dir && your-command'

# For nvim that must start in specific directory
zellij action new-pane --cwd /path/to/worktree -- sh -c 'cd /path/to/worktree && nvim'
```

**Floating scratch terminal:**
```bash
zellij action new-pane --floating --width 90% --height 90%
```

## Targeting Specific Sessions

Most `zellij action` commands run on the **currently attached session**. To target a specific session from outside:

```bash
zellij -s <session-name> action list-panes
zellij -s <session-name> action list-tabs
zellij -s <session-name> action dump-screen
zellij -s <session-name> action dump-layout
```

Note: `--session` flag does NOT work. Use `-s` before `action`.

## Interactive App Testing in Zellij

When testing an interactive app in Zellij from another terminal, use these rules:

- If the user names or creates a session, use that exact session.
- Target sessions with `zellij -s <session-name> action ...`, not a `--session` flag.
- Prefer launching the app through the user's requested shell. Do not substitute another shell or wrapper unless the user asks.
- Never close the only tab or pane in a Zellij session. Closing the sole tab can terminate the session.
- Before cleanup, list tabs and confirm the replacement tab exists and is running.
- Cleanup order: create replacement tab, confirm it exists, then close older tabs. Never close tabs first.
- Always leave at least one tab alive.
- When sending slash-prefixed input from Git Bash into Zellij, set `MSYS_NO_PATHCONV=1` on the `zellij action write-chars` command so the slash text is not path-converted.
- Never attach to, resurrect, or create a background/detached Zellij session unless the user explicitly asks for background session creation.
- If the target session is exited, detached, or only running in the background, stop and tell the user to attach the session manually first.
- Do not run commands in background-only Zellij sessions as a substitute for the user's visible terminal.
- Only send input to a session when the user confirms it is currently visible/attached, unless the user explicitly requests background automation.
- Do not use `zellij attach -b`, `zellij attach --create-background`, or normal `zellij attach` to resurrect a session for the user. Tell the user what to run instead.

Launch pattern:

```bash
zellij -s <session-name> action new-tab \
  --name <tab-name> \
  --cwd <working-directory> \
  -- <shell> <shell-args>
```

Sending slash-prefixed input safely from Git Bash:

```bash
MSYS_NO_PATHCONV=1 zellij -s <session-name> action write-chars '/command'
MSYS_NO_PATHCONV=1 zellij -s <session-name> action write 13
```

Safe cleanup sequence:

```bash
zellij -s <session-name> action list-tabs
# Confirm the replacement tab is present and should stay alive.
zellij -s <session-name> action go-to-tab-name <old-tab-name>
zellij -s <session-name> action close-tab
zellij -s <session-name> action list-tabs
```


## Common Mistakes

**❌ Using `new-pane --horizontal`**
Correct: `--direction down` (not `--horizontal`)

**❌ Confusing toggle with create**
- `toggle-floating-panes` = show/hide existing floating panes
- `new-pane --floating` = create NEW floating pane

**❌ Forgetting `action` subcommand**
Wrong: `zellij new-tab`
Right: `zellij action new-tab`

**❌ Pane not starting in correct directory**
Problem: Using `--cwd` alone doesn't always ensure the command runs in that directory
```bash
# ❌ Wrong - nvim might not start in the right directory
zellij action new-pane --cwd /path/to/worktree -- nvim

# ✅ Correct - explicitly cd first
zellij action new-pane --cwd /path/to/worktree -- sh -c 'cd /path/to/worktree && nvim'
```

**❌ Running actions on the wrong session**
Problem: `zellij action` runs on the currently attached session, not a named one
```bash
# ❌ Wrong - doesn't target a specific session
zellij action --session my-session list-panes

# ✅ Correct - use -s before action
zellij -s my-session action list-panes
```

To see actual terminal content of a session, use `dump-screen`: 
```bash
zellij -s my-session action dump-screen
```

## Notes

- All `zellij action` commands work inside or outside a session
- Use `--` to separate pane command from zellij options
- Direction options: `right`, `left`, `up`, `down`
- Size units: bare integers or percentages (e.g., `80%`)
