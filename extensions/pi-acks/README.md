# 🔐 pi-acks — Subscription OAuth Account Switcher for Pi

`pi-acks` is a native [Pi coding agent](https://pi.dev) extension for keeping and switching named subscription OAuth accounts independently across supported providers.

It is a local fork of [`@narumitw/pi-accounts`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-accounts). It uses Pi's built-in providers and provider-owned OAuth implementations. A named account temporarily overrides only that provider's runtime auth; selecting `default` restores Pi's normal `/login`, `auth.json`, or environment-based resolution without deleting the named account.

## ✨ Features

- Manages OpenAI Codex subscription OAuth accounts through one interactive `/accounts` command.
- Keeps an independent active named account—or Pi's built-in login—for every provider.
- Stores complete provider-owned OAuth credentials.
- Refreshes rotating OAuth credentials under a cross-process file lock.
- Writes `~/.pi/agent/pi-acks.json` atomically with private directory and `0600` file permissions.
- Mirrors the active account's credential into Pi's `auth.json` so Pi restores the last Codex model at startup without warnings.
- Applies provider-specific runtime API keys, headers, and endpoints.
- Verifies effective runtime auth before reporting activation success.
- Fails closed and aborts only the affected provider's turn after refresh or activation failure.
- Restores the exact provider registration that existed before the account overlay.
- Invalidates cached Codex WebSockets only when the applied Codex identity changes.
- Migrates released `pi-codex-accounts.json` state without deleting the rollback source.

## 🔌 Supported providers

| Provider     | Provider ID    | Account-specific behavior                                                                   |
| ------------ | -------------- | ------------------------------------------------------------------------------------------- |
| OpenAI Codex | `openai-codex` | ChatGPT Plus/Pro OAuth, OAuth-only native-provider bridge, and Codex WebSocket invalidation |

## 📦 Install

This is a local extension in the pi repository. Load it by adding `extensions/pi-acks` to the workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/pi-acks
```

> [!WARNING]
> Do not load `pi-acks` and `@narumitw/pi-accounts` together; both can manage and refresh the same rotating Codex credential independently. They use different storage files (`pi-acks.json` vs `pi-accounts.json`), so an account added in one is not visible in the other.

## 🚀 Usage

Open the interactive account manager:

```text
/accounts
```

The standard manager runs in TUI or RPC mode; Back returns through provider/account screens and
Escape closes the root. Print and JSON modes reject it observably. Any extra text after `/accounts`
is ignored so the entry point stays singular. Provider-owned OAuth challenges, account-name text
input, and exact replacement/removal confirmations remain specialized dialogs because they carry
credential and destructive-action policy rather than ordinary navigation.

When no accounts are saved yet, the menu starts with login:

```text
Accounts

No saved accounts yet.

What do you want to do?
› Login new account
```

After accounts exist, `/accounts` shows the current model and every supported provider's active account before offering actions:

```text
Accounts

Current model:
  OpenAI Codex / gpt-5.5-codex

Active accounts:
  OpenAI Codex: work

What do you want to do?
› Switch OpenAI Codex account
  Login new account
  Remove account
```

Login follows Pi's built-in `/login` style: choose a provider, enter a named account, then complete that provider's OAuth flow. `default` is reserved for Pi's built-in login. Reusing an existing provider/account name asks before replacing the stored credential.

Switching the current model provider is the primary flow. Choosing `default` restores Pi's built-in login for that provider. `/accounts` manages account identity only; it does not switch models except when login succeeds while the current model is still `unknown`, where it selects that provider's default model as onboarding help.

Removing an account lists named accounts as `Provider · account`, asks for confirmation, then removes the credential. Removing an active account automatically restores that provider to Pi's built-in login.

## 🔐 Auth and fail-closed behavior

Each selected account is refreshed through the provider's own OAuth `refresh()` implementation and converted through `toAuth()`. The extension then applies the returned API key, headers, and endpoint, verifies the effective runtime state, and reports success.

If refresh, conversion, provider overlay, or verification fails, the extension installs a non-secret failing runtime credential and aborts turns for that provider. It does not silently fall back to Pi's built-in login, an environment API key, or another named account. Other providers remain independent and usable.

Selecting `default` removes the package-owned runtime override and restores the exact provider registration that existed before activation. Pi's built-in credentials are never deleted.

## 🔑 Startup model restore

Pi restores the last session model at startup only for providers that have configured auth. Because `pi-acks` keeps credentials in its own file and applies them after session start, a Codex model would otherwise be dropped with a `Could not restore model` warning on every restart.

To prevent that, each successful activation mirrors the active account's OAuth credential into Pi's `auth.json` under the `openai-codex` key, with its `accountId` intact, so Pi's native restore and OAuth refresh paths work across restarts. Choosing `default` removes the mirror only when its `accountId` matches the account that was last activated, so a genuine Pi `/login` credential is never deleted. The mirror is best-effort: if Pi's credential store is not writable, runtime auth still applies for the current session.

Codex `availableModelIds` are projected into the active provider model list. Switching Codex accounts rebuilds the projection from the complete pre-overlay model catalog. A currently selected model that is unavailable to the named account is rejected before the turn starts.

## 🗄️ Storage and migration

The canonical file is:

```text
~/.pi/agent/pi-acks.json
```

When `PI_CODING_AGENT_DIR` is set, the file is stored at
`$PI_CODING_AGENT_DIR/pi-acks.json` instead. Its versioned structure keeps account maps and
active names under separate provider IDs. Credential values are private and must not be committed.
When neither canonical nor legacy storage exists, reads use an empty in-memory store without creating
an agent directory or file; the first account mutation creates the private canonical file.

On first load, if `pi-acks.json` does not exist and released `pi-codex-accounts.json` does, the extension:

1. Locks and validates the legacy file.
2. Repairs its permission to `0600`.
3. Copies all Codex credentials and the active name into the `openai-codex` provider section.
4. Atomically installs private `pi-acks.json`.
5. Retains the private legacy file for rollback.

If both files exist, `pi-acks.json` is canonical and the legacy file is not imported again. The retained legacy refresh token may become stale after `pi-acks` rotates it, so rollback can require a new Codex login.

## 🚧 Limitations and non-goals

- This package manages only subscription OAuth accounts. It does not store or switch API-key profiles.
- Continue using Pi's `auth.json`, environment variables, or `!command` secret-manager resolution for API keys.
- It does not rotate accounts automatically, evade quotas, or report usage.
- It does not support arbitrary custom providers in the first release.
- Live OAuth login and model requests depend on provider service availability and account entitlement.

## 🗂️ Package layout

```text
extensions/pi-acks/
├── index.ts
├── src/
│   ├── index.ts
│   ├── account-store.ts
│   ├── accounts.ts
│   ├── oauth.ts
│   ├── runtime-auth.ts
│   └── storage.ts
├── test/
│   ├── accounts-storage.test.ts
│   ├── accounts.test.ts
│   └── support.ts
├── README.md
├── LICENSE
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
    "pi": {
        "extensions": ["./index.ts"]
    }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, OAuth accounts, OpenAI Codex, ChatGPT Plus, ChatGPT Pro, subscription account switching.

## 📄 License

MIT. See [`LICENSE`](./LICENSE). Copyright (c) 2026 narumiruna, forked into this repository for local use.
