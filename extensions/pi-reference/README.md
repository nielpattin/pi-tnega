# @nielpattin/pi-reference

Project references for the [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

Declare additional directories — local paths or Git repositories — as accessible to the agent. References are:

1. **Advertised** in the agent's system prompt (if they have a description)
2. **Auto-allowed** through Pi's permission system (no prompts when the agent reads from reference dirs)
3. **Listable** via the `/references` command

## Installation

This package is auto-discovered when placed in `~/.pi/agent/extensions/pi-reference/`.

## Configuration

Add a `references` block to your Pi settings:

- **Global**: `~/.pi/agent/settings.json`
- **Project**: `<project>/.pi/settings.json` (overrides global per-alias)

### Entry forms

```jsonc
{
    "references": {
        // String shorthand: local if starts with ".", "/", or "~"; otherwise git
        "docs": "../product-docs",
        "effect": "Effect-TS/effect",

        // Local object
        "design-system": {
            "path": "../design-system",
            "description": "Use for design system components and tokens"
        },

        // Git object
        "sdk": {
            "repository": "anomalyco/opencode-sdk-js",
            "branch": "main",
            "description": "Use for JavaScript SDK implementation details"
        },

        // Hidden: accessible but not in system prompt guidance
        "internal": {
            "path": "~/internal-code",
            "description": "Internal implementation details",
            "hidden": true
        }
    }
}
```

### Field reference

| Field         | Type    | Required      | Description                                                                                                    |
| ------------- | ------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `path`        | string  | local entries | Directory path. Relative to project cwd (project settings) or home (global settings). Supports `~/` expansion. |
| `repository`  | string  | git entries   | Git repository: `owner/repo`, full URL, or SSH URL.                                                            |
| `branch`      | string  | no            | Branch to checkout. Defaults to repo's default branch.                                                         |
| `description` | string  | no            | If present, the reference is advertised to the agent via system prompt guidance.                               |
| `hidden`      | boolean | no            | If `true`, the reference dir is still auto-allowed but not advertised in the system prompt. Default: `false`.  |

### Alias rules

Reference aliases (the keys under `references`) must be non-empty and must not contain `/`, whitespace, backticks, or commas.

## Git cache

Git references are cloned into `~/.cache/checkouts/<host>/<org>/<repo>` — the same cache path used by the librarian skill. Repos are fetched/refreshed on session start (throttled to every 5 minutes).

## Usage

Type `@` in the editor to browse references:

- `@` alone shows all reference aliases (cyan)
- `@partial` filters aliases by prefix
- `@alias/` browses files inside that reference's directory (filenames shown in cyan)
- Tab on an alias inserts `@alias/` and keeps the dropdown open to browse root contents
- Tab on a file inserts `@alias/path/to/file.ts ` (trailing space dismisses the dropdown)

`@alias/path` tokens stay as literal text when submitted. The system prompt instructs the agent to split on the first `/`, map the alias to its configured path, and append the rest (which may be a file or directory).

The footer status bar shows `refs: N` (reference count). During git sync, the footer shows `⠧ Syncing references... 2/15` (animated spinner + counter) and reverts to `refs: N` when done.

## How it works

1. On `session_start`, references are resolved from global + project settings. Git repos are synced asynchronously through a bounded-concurrency worker pool (3 at a time) with network-error retry, to avoid DNS exhaustion on Windows.
2. On `before_agent_start` (first turn), references with descriptions are injected into the system prompt as an XML block with an explicit instruction telling the agent how to resolve `@alias/path` tokens.

## Graceful degradation

- If a git clone fails, the reference is listed with an error status and retried on the next session start.
