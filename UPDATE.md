# Pi v0.84.0 compatibility audit

This is a planning document for upgrading the repository from Pi v0.83.x to v0.84.0. It records required changes, optional changes, and audited breaking changes that do not currently affect this repository.

No Pi update, dependency update, source edit, commit, or release was performed while preparing this document.

## Current dependency state

The root workspace currently resolves these four packages to `0.83.0`:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

There is existing version skew that must not survive the workspace upgrade:

- `pnpm-lock.yaml` resolves `pi-skill-toggle`'s Pi peer context to `0.80.2`.
- `extensions/pi-acks/package.json` pins its Pi development dependencies to `0.83.0`.
- `extensions/pi-exa/package-lock.json` is an older, independent lockfile containing Pi `0.74.x` entries even though its current manifest uses `^0.83.0`.
- The ignored, host-loaded `pi-mcp-adapter` is a separate version island. Its manifest and lockfile use `pi-ai@0.74.2`, `pi-coding-agent@0.79.10`, and `pi-tui@0.74.2`.

Upgrade the four Pi packages atomically. Do not mix `0.83.x` and `0.84.x` in the root workspace.

## Required manifest and lockfile updates

Change these constraints to `0.84.0` while preserving the existing range style:

| File                                 | Current constraint                                                        | Required constraint    |
| ------------------------------------ | ------------------------------------------------------------------------- | ---------------------- |
| `package.json`                       | Root `pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui`: `^0.83.0` | `^0.84.0` for all four |
| `extensions/pi-acks/package.json`    | Pi dev dependencies: exact `0.83.0`                                       | Exact `0.84.0`         |
| `extensions/pi-cortex/package.json`  | `pi-tui: ^0.83.0`                                                         | `pi-tui: ^0.84.0`      |
| `extensions/pi-exa/package.json`     | Pi dev dependencies: `^0.83.0`                                            | `^0.84.0`              |
| `extensions/pi-harbor/package.json`  | `pi-coding-agent: ^0.83.0` peer                                           | `^0.84.0`              |
| `extensions/pi-station/package.json` | `pi-tui: ^0.83.0` peer                                                    | `^0.84.0`              |

The `*` peer ranges in `pi-acks`, `pi-permission-system`, `pi-reference`, `pi-skill-toggle`, and `git/github.com/dodo-reach/pi-clarify` do not require manifest edits. They still need to resolve against the single workspace Pi version.

After manifest changes, regenerate the root `pnpm-lock.yaml`. Confirm that the workspace has no Pi `0.80.2` or `0.83.0` entries. Do not hand-edit integrity data. The standalone `extensions/pi-exa/package-lock.json` and the host-loaded `pi-mcp-adapter/package-lock.json` are separate follow-up surfaces, not part of the root pnpm resolution.

## Required source compatibility work

### 1. Pass concrete cancellation through `pi-acks` OAuth refresh

Upstream v0.84 makes provider OAuth refresh cancellation mandatory:

```ts
refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
```

Update:

- `extensions/pi-acks/src/oauth.ts`
- `extensions/pi-acks/src/runtime-auth.ts`

Required behavior:

1. Make `ProviderOwnedOAuth.refresh` require `signal: AbortSignal`.
2. Keep forwarding the signal in the lazy provider wrapper.
3. Pass a concrete, operation-scoped signal to `this.provider.oauth.refresh(...)`. `ExtensionContext.signal` is optional when `ensureActive()` runs during startup, so do not forward `undefined`. Compose a new operation signal with the context signal when one exists.
4. Preserve cancellation through the account-store update callback. A cancelled refresh must not commit a later credential.

Config-form providers have the corresponding v0.84 signature:

```ts
refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
```

No first-party extension currently registers a config-form OAuth provider, but `pi-acks` directly calls Pi's built-in provider OAuth and must follow the same signal contract.

### 2. Pass auth cancellation options to runtime API-key mutations

In v0.84, `ModelRuntime` exposes:

```ts
setRuntimeApiKey(providerId: string, apiKey: string, options?: AuthOperationOptions): Promise<void>;
removeRuntimeApiKey(providerId: string, options?: AuthOperationOptions): Promise<void>;
```

`extensions/pi-acks/src/runtime-auth.ts` currently discovers these methods dynamically and calls them without options. Update its local `RuntimeAuthStorage` type and calls so `setRuntimeApiKey` and `removeRuntimeApiKey` receive `{ signal }` for the active operation. Keep treating synchronization failures as failures of the auth operation. `setRuntimeApiKey` now synchronizes the runtime model/auth snapshot and can report a `CredentialSynchronizationError` after the credential mutation has committed.

A catalog refresh is separate in v0.84. If remote freshness is ever needed, call `refresh({ providers: [providerId], signal })` separately. Do not pass catalog refresh options to `setRuntimeApiKey`.

### 3. Preserve nullable provider headers

Pi v0.84 defines:

```ts
type ProviderHeaders = Record<string, string | null>;
```

`ModelRegistry.getApiKeyAndHeaders()` can now return `null` header values. A `null` value means that a provider default header must be removed. It must not be converted to the string `"null"`.

Required updates:

- `extensions/pi-codex-usage/usage.ts`: when constructing a native `Headers` object, call `headers.delete(key)` for `null` values and `headers.set(key, value)` for strings.
- `extensions/pi-acks/src/runtime-auth.ts`: change the local `getApiKeyAndHeaders` result type from `Record<string, string>` to a nullable-header type. Its existing merge and verification logic already distinguishes deletion markers. Keep `RuntimeProviderConfig.headers` string-only, because registered provider configuration cannot contain deletion markers.
- Keep forwarding nullable headers unchanged in `completeSimple` or `complete` calls in `extensions/pi-harbor/src/ui/agents-panel.ts`, `extensions/pi-permission-system/src/auto-guardian.ts`, and `extensions/describe-image.ts`.

The v0.84 request transform type is also renamed and now operates on `ProviderHeaders`:

```ts
interface ModelsRequestTransforms {
    transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}
```

No first-party source imports `ModelsStreamTransforms` or `ModelsRequestTransforms` today.

### 4. Audit the separately loaded `pi-mcp-adapter`

`pi-mcp-adapter` is ignored by this workspace and is loaded from the host agent directory. It is not upgraded by the root pnpm lockfile.

Before using it with a Pi v0.84 host, update and test it independently:

- Align its Pi development/test packages with the host version, or make its compatibility target explicit.
- Change legacy root imports such as `complete` from `@earendil-works/pi-ai` to `@earendil-works/pi-ai/compat`, or migrate the sampling implementation to the current `Models`/coding-agent runtime APIs. In v0.84, the root `pi-ai` entrypoint is the core API; the old global API is retained under `/compat`.
- Update its sampling auth result types to allow `Record<string, string | null>` and forward deletion markers unchanged.
- Rebuild or remove stale generated bundles and verify any installed copy for old `@earendil-works/pi-ai/base` or root-level legacy imports.

This is a separate compatibility task. Do not assume that upgrading the root workspace fixes the host-loaded adapter.

## `message_update` scope

Pi v0.84 changes the **JSON and RPC wire event** shape. Wire `message_update` events now contain only an `assistantMessageEvent` delta. The cumulative `message` and `assistantMessageEvent.partial` fields are absent. Consumers must assemble deltas between `message_start` and `message_end`; `message_end` remains authoritative.

The current repository is safe in this area:

- `extensions/pi-harbor/src/backends/pi.ts` already reads `assistantMessageEvent` text deltas and does not read the removed fields.
- `extensions/pi-station/index.ts` and `extensions/workflows/runner.ts` subscribe to Pi's in-process extension/session events, not JSON or RPC stdout. The v0.84 in-process `MessageUpdateEvent` still carries `message`, so their current `event.message` reads are not migration errors.

Do not change those two handlers solely because of the wire event release note. If either consumer is later changed to parse JSON or RPC output, replace wire `message_update.message` reads with delta assembly and use `message_start` or `message_end` for the assistant role.

## Breaking changes audited with no current first-party usage

| v0.84 change                                                                                                       | Audit result                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelsStreamTransforms` renamed to `ModelsRequestTransforms`                                                      | No current import or implementation. No action.                                                                                                                                                                                                                                                                 |
| `ModelRegistry.refresh()` now accepts `ModelsRefreshOptions` and returns `ModelsRefreshResult`                     | No first-party model registry refresh calls. No action.                                                                                                                                                                                                                                                         |
| Provider refresh context replaces `context.store` with `context.stored` and generation-checked `context.publish()` | No first-party `refreshModels` implementation and no `context.store` usage. The `createProvider({ fetchModels })` helper owns this migration for helper-created providers. No action.                                                                                                                           |
| Pi-agent-core v4 `Session`, `SessionStorage`, `SessionRepo`, durable operation records, and lane views             | No imports of the v4 session APIs. Existing `SessionManager` usage comes from `pi-coding-agent` and is not a direct legacy pi-agent-core repository implementation. No action.                                                                                                                                  |
| Legacy JSONL and in-memory pi-agent-core repositories removed                                                      | No direct use of those repository APIs. No action.                                                                                                                                                                                                                                                              |
| v2 `AgentHarness` promoted to the default pi-agent-core entrypoint and experimental subpaths removed               | No `AgentHarness` or experimental subpath imports. No action.                                                                                                                                                                                                                                                   |
| Required pi-agent-core `FileSystem.renameFile()`                                                                   | `extensions/pi-skill-toggle/src/ports/fs.ts` is an application-owned filesystem port, not an AgentHarness filesystem. `pi-harbor` has a separate job-persistence port. Neither needs `renameFile()` for this release. Add same-filesystem replacement semantics only if either is later passed to AgentHarness. |
| Remote session list summaries replaced by durable `SessionMetadata`                                                | No `RemoteSession`, `PiClient`, or remote session client usage. No action.                                                                                                                                                                                                                                      |

Existing `SessionManager` consumers include `extensions/read-session.ts`, `extensions/pi-harbor/src/ui/session-transcript.ts`, `extensions/workflows/runner.ts`, and child-session helpers. They should be smoke-tested after the package upgrade, but they do not need the pi-agent-core v4 repository migration described in the release notes.

## Optional v0.84 features

These are available after the compatibility work and do not require source changes in this repository:

- Fullscreen TUI mode with `/settings` or `--tui-mode fullscreen`.
- Mermaid and terminal-friendly LaTeX rendering.
- Per-directory `AGENTS.override.md` context files.
- Arbitrary OpenAI-compatible `samplingParams` and opt-in vLLM `thinking_token_budget`.
- Built-in Baseten authentication and model catalog support.
- `pi.registerMarkdownTransformer()` for display-only Markdown transforms. No current extension registers one.
- `AI_AGENT=pi` in Pi-created CLI and RPC child-process environments.
- Deferred provider responses, telemetry contracts, and the experimental remote-session client. No current consumers were found.

The ignored `models.json` and `settings.json` can opt into model and TUI features locally. No committed configuration migration is required.

## Upgrade and verification order

After reviewing this document and applying the planned source and manifest changes:

1. Update all listed Pi constraints together.
2. Regenerate the root lockfile and verify one Pi `0.84.0` workspace version.
3. Run `pnpm lint`.
4. Run `pnpm typecheck`.
5. Run `pnpm fmt`.
6. Run `git diff --check`.
7. Run focused checks for `pi-acks`, `pi-cortex`, `pi-exa`, `pi-harbor`, and `pi-station`.
8. Smoke-test Codex OAuth refresh and cancellation, Codex usage headers, workflow first-response detection, Harbor streaming output, child sessions, and any JSON/RPC integrations.

Do not run `pi update` until the source and dependency changes have been reviewed.

## Upstream references

- [Pi v0.84.0 release notes](https://github.com/earendil-works/pi/releases/tag/v0.84.0)
- [`pi-ai` models and request transforms](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/src/models.ts)
- [`pi-ai` auth types](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/src/auth/types.ts)
- [`ModelRuntime` API](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/model-runtime.ts)
- [Config-form provider OAuth types](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/provider-composer.ts)
- [JSON/RPC event conversion](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/modes/json-event.ts)
- [In-process extension message events](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/extensions/types.ts)
