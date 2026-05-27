# Pi Permission System

Full permission evaluation engine with runtime ask/reply lifecycle and tool integration for Pi.

## Features

- **Wildcard rule evaluation** with last-match-wins semantics
- **Runtime permission requests** with pending queue and deferred resolution
- **Reply modes**: `once` (single approval), `always` (session approval), `reject` (deny with feedback)
- **Session-level reject fanout** - rejecting one request rejects all pending requests in the same session
- **Session memory** for "always" approvals, cleared on new session
- **Tool adapters** for `bash`, `edit`, `read`, `task`, and `external_directory`
- **Event system** for UI/automation integration
- **Migration-safe** - works with existing `config.json` format

## Configuration

The extension reads its configuration from `config.json` in the extension directory. The format supports both flat actions and nested pattern rules:

```json
{
    "permission": {
        "*": "allow",
        "bash": {
            "git *": "ask",
            "git status": "allow",
            "rm *": "deny"
        },
        "edit": "allow",
        "read": "allow",
        "external_directory": "ask"
    }
}
```

### Rule Evaluation

- Rules are evaluated in order (last match wins)
- Wildcard `*` matches any character sequence
- Default action when no rules match: `ask`

## Rollback / Disabling Runtime Service

### Environment Variable

Set `PI_PERMISSION_RUNTIME=0` to disable the runtime permission service and revert to static config-only behavior:

```bash
# Disable runtime permission service
export PI_PERMISSION_RUNTIME=0

# Other valid values to disable:
export PI_PERMISSION_RUNTIME=false
export PI_PERMISSION_RUNTIME=off
```

When disabled:

- Permission tools return a message indicating the service is disabled
- No pending requests are tracked
- The `/permission-runtime` command shows the current mode

### Check Current Mode

Use the `/permission-runtime` command in Pi to see:

- Whether runtime mode is enabled or disabled
- Count of pending requests
- The rollback switch instruction

### Full Rollback

To fully revert to the previous config-only behavior:

1. Set `PI_PERMISSION_RUNTIME=0` in your environment
2. Restart the session to clear session-memory approvals
3. The extension will fall back to static config evaluation only

## Tools

### `permission_list_pending`

List pending runtime permission requests.

**Parameters:**

- `sessionId` (optional): Filter by session ID

### `permission_reply`

Reply to a pending permission request.

**Parameters:**

- `requestId` (required): The pending request ID
- `decision` (required): `once`, `always`, or `reject`
- `message` (optional): Rejection feedback message

## Commands

### `/permission-runtime`

Show runtime permission service mode and rollback switch information.

## Events

The extension emits `permission:event` events with the following structure:

```typescript
{
   kind: "permission-requested" | "permission-resolved",
   requestId: string,
   sessionId: string,
   permission: string,
   patterns: string[],
   action?: "allow" | "ask" | "deny",
   decision?: "once" | "always" | "reject",
   message?: string,
   prompt: FormattedPermissionPrompt,
   timestamp: number
}
```

## Session approvals

Approved "always" rules live in memory for the current session only. They are not written to disk and are cleared on session restart.

## Architecture

```
pi-permission-system/
├── types.ts         # Core types and schemas
├── evaluator.ts     # Wildcard matching and rule evaluation
├── merge.ts         # Ruleset merge helpers
├── service.ts       # Runtime permission service (ask/reply lifecycle)
├── adapters.ts      # Tool-specific permission adapters
├── api.ts           # API surfaces and prompt formatters
├── persistence.ts   # Legacy storage helpers, not used by runtime approvals
├── index.ts         # Extension entry point
└── *.test.ts        # Test files (74 tests)
```
