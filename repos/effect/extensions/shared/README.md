# shared

Shared helper modules used by the copied orchestration extensions.

This is **not** a Pi extension. There is no `index.ts` entrypoint and nothing to `/reload`.

## What lives here

| File                     | Used by           | Purpose                                                    |
| ------------------------ | ----------------- | ---------------------------------------------------------- |
| `activity-status.ts`     | `workflows`       | Format footer/status text for running/done/failed counts   |
| `context-utilization.ts` | `workflows`       | Compact context-window utilization display like `42%/128k` |
| `child-session.ts`       | `workflows`       | Create/bind/dispose isolated child Pi sessions safely      |
| `tool-call-timeout.ts`   | `workflows`       | Wrap child tools with independent execution timeouts       |
| `dashboard-state.ts`     | shared UI helpers | Small pure helpers for dashboard selection/state           |

## Why it exists

`workflows` imports sibling modules like:

```ts
import { formatActivityStatus } from "../shared/activity-status.ts";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import { createChildResources } from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
```

Without this folder, `workflows` fails to load.

## Notes

- Keep these pure/shared and free of extension registration.
- Prefer editing here only when multiple extensions need the same helper.
- `subagents` currently ports some of this logic internally rather than importing every helper directly.
