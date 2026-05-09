# pi-command-code-provider

Pi extension provider for [CommandCode](https://commandcode.dev/)'s native `/alpha/generate` API.

## Overview

This extension registers CommandCode as a model provider inside Pi.
It supports streaming completions, tool calling, reasoning/thinking levels, and configurable model catalogs via a local `config.json`.

## Installation

1. Clone or copy this extension into your Pi `agent/extensions/` directory (or any path Pi loads extensions from).
2. Install dependencies:
    ```bash
    npm install
    ```
3. Drop a `config.json` next to `package.json` (see **Configuration** below).
4. Restart Pi.

## Configuration

Create `config.json` in the extension root. Example:

```json
{
    "enabled": true,
    "debug": false,
    "providerId": "command-code",
    "displayName": "Command Code",
    "upstreamUrl": "https://api.commandcode.dev",
    "apiKey": "YOUR_API_KEY",
    "commandCodeVersion": "auto",
    "commandCodeProvider": "commandcode",
    "requestTimeoutMs": 300000,
    "memory": "",
    "headers": {},
    "models": [
        {
            "id": "moonshotai/Kimi-K2.5",
            "name": "Kimi K2.5",
            "contextWindow": 262144,
            "maxTokens": 262144
        }
    ]
}
```

| Key                   | Type      | Default                         | Description                                              |
| --------------------- | --------- | ------------------------------- | -------------------------------------------------------- |
| `enabled`             | `boolean` | `true`                          | Toggle the provider on/off.                              |
| `debug`               | `boolean` | `false`                         | Enable debug logging to a local file.                    |
| `providerId`          | `string`  | `"command-code"`                | Internal provider identifier.                            |
| `displayName`         | `string`  | `"Command Code"`                | Human-readable provider name.                            |
| `upstreamUrl`         | `string`  | `"https://api.commandcode.dev"` | Base URL for the CommandCode API.                        |
| `apiKey`              | `string`  | `""`                            | API key for authentication.                              |
| `commandCodeVersion`  | `string`  | `"auto"`                        | API version (or `"auto"` to detect from `package.json`). |
| `commandCodeProvider` | `string`  | `"commandcode"`                 | Provider slug sent to the API.                           |
| `requestTimeoutMs`    | `number`  | `300000`                        | Request timeout in milliseconds (default 5 minutes).     |
| `memory`              | `string`  | `""`                            | Optional memory/context string.                          |
| `headers`             | `object`  | `{}`                            | Extra HTTP headers to send with each request.            |
| `models`              | `array`   | bundled defaults                | Model catalog; uses bundled defaults when omitted.       |

## Scripts

| Script      | Command                                                 | Description                   |
| ----------- | ------------------------------------------------------- | ----------------------------- |
| `typecheck` | `tsc --noEmit`                                          | Type-check the codebase.      |
| `build`     | `npm run typecheck`                                     | Build check (typecheck only). |
| `test`      | `node --experimental-strip-types --test test/*.test.ts` | Run the test suite.           |

## License

[MIT](LICENSE)
