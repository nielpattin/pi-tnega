# @nielpattin/pi-permission-system

Permission enforcement extension for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

This package is maintained in [`nielpattin/pi-packages`](https://github.com/nielpattin/pi-packages). It is based on [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system), which is based on [`MasuRii/pi-permission-system`](https://github.com/MasuRii/pi-permission-system).

## Features

- Hide disallowed tools before an agent starts.
- Enforce `allow`, `ask`, and `deny` policies for tool calls.
- Gate bash commands with wildcard patterns such as `git *: ask` or `rm -rf *: deny`.
- Gate MCP servers, MCP tools, skills, file paths, and external directory access.
- Forward `ask` prompts from subagents back to the parent UI when possible.
- Integrate with `@nielpattin/pi-subagents` through Pi lifecycle events, with no direct package dependency.
- Publish a typed cross-extension permission service through `@nielpattin/pi-permission-system`.

## Install

```bash
pi install npm:@nielpattin/pi-permission-system
```

For local development from this monorepo:

```bash
pi -e ./packages/pi-permission-system/src/index.ts
```

## Quick Start

Create the global config file at `~/.pi/agent/permission.jsonc`:

```jsonc
{
   "permission": {
      "*": "allow",
      "path": {
         "*": "allow",
         "*.env": "deny",
         "*.env.*": "deny",
         "*.env.example": "allow",
      },
      "bash": {
         "rm -rf *": "deny",
         "sudo *": "ask",
      },
      "external_directory": "ask",
   },
}
```

Then start Pi. The extension loads automatically and enforces the policy.

All permissions use one of three states:

| State   | Behavior                                 |
| ------- | ---------------------------------------- |
| `allow` | Permits the action silently              |
| `deny`  | Blocks the action with an error message  |
| `ask`   | Prompts the user for confirmation via UI |

The `path` surface applies across file tools and bash. A `path` deny cannot be overridden by a per-tool allow, so it is the right place to protect sensitive files such as `.env` or `~/.ssh/*`.

## Configuration

Config lives in one JSON file per scope:

| Scope   | Path                                                    |
| ------- | ------------------------------------------------------- |
| Global  | `~/.pi/agent/permission.jsonc`                          |
| Project | `<cwd>/.pi/extensions/pi-permission-system/config.json` |

Project config overrides global config. Per-agent YAML frontmatter overrides both.

Within a surface map such as `bash` or `mcp`, the last matching rule wins. Put broad catch-all rules first and specific overrides after them.

See [`docs/configuration.md`](docs/configuration.md) for the full policy reference.

### Permission request sound

When a permission prompt opens in the Pi UI, the package plays the configured notification sound with `ffplay`. Configure it in `~/.pi/agent/settings.json`:

```json
{
   "piPermissionSystem": {
      "sound": "assets/permission-request.mp3",
      "volume": 100
   }
}
```

Relative paths resolve from `~/.pi/agent/settings.json`. `volume` is a percentage, so `150` plays at 150%. If no setting exists, the package defaults to `~/.pi/agent/assets/permission-request.mp3`.

## Subagent integration

`@nielpattin/pi-permission-system` works well with `@nielpattin/pi-subagents`.

When both packages are installed, `pi-subagents` emits child session lifecycle events and this package registers those sessions automatically. That lets the permission system enforce per-agent policy and forward `ask` decisions from child sessions back to the parent Pi UI.

See [`docs/subagent-integration.md`](docs/subagent-integration.md) for details.

## Cross-extension service

Consumers can import the typed service accessor:

```ts
const { getPermissionsService } = await import("@nielpattin/pi-permission-system");
const service = getPermissionsService();
```

The service is published under `Symbol.for("@nielpattin/pi-permission-system:service")` while the extension is active.

## Documentation

| Document                                                                                                                         | Contents                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`docs/configuration.md`](docs/configuration.md)                                                                                 | Full policy reference, runtime knobs, per-agent overrides, recipes           |
| [`docs/session-approvals.md`](docs/session-approvals.md)                                                                         | Session-scoped rules, pattern suggestions, bash arity table                  |
| [`docs/cross-extension-api.md`](docs/cross-extension-api.md)                                                                     | Cross-extension service accessor, event bus integration, decision broadcasts |
| [`docs/subagent-integration.md`](docs/subagent-integration.md)                                                                   | Permission forwarding and coexistence with subagent extensions               |
| [`docs/guides/permission-frontmatter-for-subagent-extensions.md`](docs/guides/permission-frontmatter-for-subagent-extensions.md) | Convention guide for subagent extension authors                              |
| [`docs/opencode-compatibility.md`](docs/opencode-compatibility.md)                                                               | OpenCode compatibility and porting notes                                     |
| [`docs/troubleshooting.md`](docs/troubleshooting.md)                                                                             | Common issues, diagnostic logging, threat model                              |
| [`docs/migration/legacy-to-flat.md`](docs/migration/legacy-to-flat.md)                                                           | Migration from pre-v2 config layout                                          |

## Development

```bash
pnpm --dir packages/pi-permission-system test
pnpm --dir packages/pi-permission-system check
pnpm --dir packages/pi-permission-system pack --dry-run
```

Run from the repository root for full workspace validation:

```bash
pnpm check
pnpm test
```

## Attribution

MIT licensed. Original copyright remains with MasuRii and Christopher D. Lasher. This package keeps that license notice and documents the fork lineage through `@gotgenes/pi-permission-system`.
