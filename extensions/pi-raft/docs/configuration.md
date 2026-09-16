# Configuration

Raft reads global settings from `~/.pi/agent/raft.json` and, in trusted projects, a
project override from `.pi/raft.json`. Project values override global values. Configuration
changes that affect host providers are applied on reload.

## Execution

```json
{
    "execution": {
        "executor": {
            "kernel": "typescript",
            "runtime": "quickjs",
            "maxTimeoutMs": 3600000,
            "pythonRuntime": "monty"
        }
    },
    "tools": { "mcp": { "enabled": true } }
}
```

`kernel` is `"typescript"` or `"python"`; `runtime` selects QuickJS or an explicit native
TypeScript runtime. Python uses Monty unless trusted CPython is explicitly selected. Raft is
orchestration-only: Pi core and registered extension tools are called natively by Pi, while
`raft_exec` can call `mcp.*`, `agents.*`, and `memory.*` and can use its payload object.

## Agents

`agents.enabled` is the master switch for starting agents: when off, `agents.run` and
`agents.spawn` are rejected while `status`, `list`, and `log` still work. `agents.runner` selects
the default `pi` or `claude` harness. `agents.defaultTools` is the positive
core-tool allowlist for newly spawned agents; loaded extension tools are enabled by default when
extensions are enabled. `agents.excludeTools` records tools disabled through the single Enable Tools
picker. `agents.thinking`, `agents.timeoutMs`, concurrency, and depth settings bound Task requests.
`agents.maxDepth` counts agent levels below the session, so 0 blocks every agent call and 1 lets
this session start agents that cannot start their own.
A request can choose its runner, child kernel, model, tools, working directory, and output
schema; the action schema is authoritative.

## Memory and MCP

`memory.enabled` controls the local recall index and its configured bounds. `tools.mcp.enabled`,
OAuth policy, call limits, and the configured server allowlist control dynamic `mcp.*` calls.
MCP descriptors are resolved by the host; credentials never enter model-visible discovery
metadata.

## Safety and tool risk overrides

Approval modes apply to the effective risk class of each action. Use `safety.toolRisks` to override a provider's declared/default class for an exact canonical ref:

```json
{
    "safety": {
        "approvals": {
            "read": "allow",
            "write": "ask",
            "execute": "ask",
            "network": "ask",
            "agent": "ask"
        },
        "toolRisks": {
            "pi.read": "read",
            "pi.bash": "execute",
            "extensions.browser": "network",
            "mcp.github.search": "read"
        }
    }
}
```

Valid classes are `read`, `write`, `execute`, `network`, and `agent`. Malformed entries are ignored during
normalization.

Without an override, a ref runs under its built-in class:

| ref                                       | class                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| `pi.read`, `pi.grep`, `pi.find`, `pi.ls`  | `read`                                                         |
| `pi.write`, `pi.edit`                     | `write`                                                        |
| `pi.bash`, `pi.powershell`                | `execute`                                                      |
| `extensions.*` (Pi tools from extensions) | `execute`                                                      |
| `mcp.*` (MCP actions)                     | `execute`                                                      |
| Raft registry actions                     | declared per action, for example `read`, `network`, or `agent` |

Pi exposes no risk metadata for tools, so Raft's core-tool table is the only declaration that exists for
`pi.*`; extension tools and MCP actions have none at all and stay on `execute`, the class whose default policy
is the most restrictive. Overrides apply to Raft provider actions and direct Pi/extension tool calls alike.

`/raft settings` → Approvals → Action risks edits the same map without touching JSON. Rows show the class
each tool runs under, never a placeholder, and cover every Pi core tool, every loaded extension tool, and
every ref already present in the file. When an extension registers a tool under a Pi core name, calls resolve
to the extension implementation: its row appears as `extensions.<name>`, flagged as overriding the core tool,
while the `pi.<name>` row stays for when the extension is unloaded. Cycling a row writes an override, and cycling back to that tool's
built-in class removes it. Refs outside those sets (MCP servers and other dynamic namespaces) are added with
`Add exact ref`, which takes a `provider.action` ref and then its class.

## Automatic compaction

```json
{ "lifecycle": { "compaction": { "engine": "raft", "targetContextRatio": 0.65 } } }
```

Raft's automatic compactor is the default. Set `engine` to `"pi"` to use Pi's native
compactor. The target ratio is a bounded occupancy ceiling, so the compacted context must fit
under `contextWindow × ratio`; the raw continuity tail comes from Pi's own `keepRecentTokens`
compaction setting, not from `raft.json`.
Thresholds are evaluated at safe settled boundaries.

## Speculation

`speculation.enabled`, concurrency, entry, buffer, and lifetime bounds configure speculative
read-ahead. Only eligible calls are launched early, and every served result goes through the
normal validation and policy path again.

## Internal components and UI

The `components` configuration array is consumed by the internal ComponentSupervisor. Entries
are validated, staged, and retired as a host concern; there is no guest component control
surface. UI settings affect presentation only and do not widen capabilities.
