# Providers

A Raft provider publishes a namespaced action slice to the host `ActionRegistry`. Each action
declares its input schema, output behavior, risk, and effect classification. The registry
resolves exact refs, validates arguments, applies approval and bounds, invokes the provider, and
records a bounded trace.

## Built-in namespaces

Pi core and registered extension tools are native Pi actions and are not Raft providers.

- `mcp.*` exposes dynamically addressed MCP tools.
- `agents.*` exposes the seven one-shot Task actions.
- `memory.recall` and `memory.expand` expose session evidence.

The generic `tools` surface contains only `search`, `describe`, `call`, and `progress`.

## Provider lifecycle

The internal ComponentSupervisor stages provider publication, checks requirements, serializes
conflicting effects, and retires old generations after active calls settle. Provider changes
are atomic from the registry reader's perspective. A missing required capability fails closed;
it never grants a guessed capability.
