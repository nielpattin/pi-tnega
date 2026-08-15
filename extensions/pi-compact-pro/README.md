# pi-compact-pro

Auto-compaction configuration, custom summary model fallback chains, and structured summary enhancement extension for Pi (`@earendil-works/pi-coding-agent`).

## Overview

Pi uses context compaction when conversations grow long. By default, auto-compaction triggers near the context window limit minus `reserveTokens`, and uses the active session model to summarize. `pi-compact-pro` adds configurable compaction thresholds, reversible model context caps across active and scoped models, dedicated custom compaction models with up to 3 fallbacks, an interactive `/compaction` management panel, and structured summarization preserving file paths, errors, task states, and key decisions.

## Features

1. **Configurable context limits**: Caps large model context windows (such as 1M models) across the active model, registry, and scoped cycling models to a manageable working size.
2. **Dedicated compaction models with 3-tier fallback**: Lets you specify cheaper or faster models (such as Gemini Flash or Claude Haiku) for compaction summaries instead of using the primary session model, with an automatic fallback chain of up to 3 models.
3. **Predictable compaction targets**: Derives Pi's native `reserveTokens` setting from the active model's effective context window minus `compactionTarget`, triggering auto-compaction at the desired token budget even when the native model window is smaller than the configured cap.
4. **Structured summary prompts**: Injects detailed continuity instructions into the summarizer, preserving exact paths, error messages, rationale, and active work without breaking Pi's native XML tool tracking.
5. **Graceful fallback**: Uses Pi's native `session_before_compact` extension seam. If custom summarization fails or is aborted across all candidate models, Pi falls back to its built-in summarizer automatically.
6. **Reversible context caps**: Retains original model context sizes in memory so increasing caps or resetting configuration works immediately without restarting the process.
7. **Interactive TUI panel & CLI**: Provides the `/compaction` command with an interactive SettingsList UI, token presets, current context metrics, summary model selection, and scriptable text shortcuts.

## Configuration

Configuration is stored at:

```text
~/.pi/agent/.ext-config/pi-compact-pro.json
```

Native Pi settings are synchronized to:

```text
~/.pi/agent/settings.json (compaction section)
```

The UI keeps these values separate:

- **Native window**: the provider's catalog context size, for example `1.0M`.
- **Max context**: this extension's runtime ceiling, for example `256k`.
- **Compaction target**: the desired context size when compaction starts.
- **Reserve tokens**: the native Pi value calculated as effective window minus target for the active model.

### Configuration schema

```json
{
    "maxContext": 128000,
    "compactionTarget": 64000,
    "keepRecentTokens": 20000,
    "enabled": true,
    "summaryModels": ["google/gemini-2.5-flash", "anthropic/claude-3-5-haiku", "openai/gpt-4o-mini"],
    "modelOverrides": {
        "provider/model-id": {
            "maxContext": 96000
        }
    }
}
```

| Field              | Type     | Default  | Description                                                                                                                                                                                  |
| ------------------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxContext`       | number   | `128000` | Global context window ceiling applied to all models with larger windows. Use `-1` for no cap (each model keeps its native provider window).                                                  |
| `compactionTarget` | number   | `64000`  | Token count threshold where auto-compaction triggers.                                                                                                                                        |
| `keepRecentTokens` | number   | `20000`  | Token budget of uncompacted recent conversation turns kept intact.                                                                                                                           |
| `enabled`          | boolean  | `true`   | Enables or disables automatic compaction.                                                                                                                                                    |
| `summaryModels`    | string[] | `[]`     | Optional ordered list of up to 3 models to use for compaction summaries (in fallback order). Format: `"provider/modelId"`. If omitted or all candidates fail, uses the active session model. |
| `modelOverrides`   | object   | `{}`     | Optional per-model `maxContext` overrides keyed by `provider/modelId`. A value of `-1` removes the cap for that model.                                                                       |

## Commands

### Interactive panel

Run `/compaction` without arguments in TUI mode to open the settings interface. Everything is configurable from the UI, no JSON editing required:

- **Auto-compaction**: toggle on/off.
- **Compaction target**: preset trigger thresholds (40k to 200k) or type a custom value via the "Custom value…" entry.
- **Keep recent**: preset token budgets (5k to 60k) or a custom value.
- **Reserve tokens**: read-only, shows the native Pi reserve computed from the active model's effective window minus the target.
- **Max context**: global ceiling, including a "No cap (native windows)" option (stored as `-1`) and custom values up to 1M.
- **Model overrides**: add, edit, or remove per-model `maxContext` overrides (each can also be set to "No cap"). Nested pickers navigate with Enter/Esc.
- **Primary summary model + Fallback model 1 + Fallback model 2**: build a 3-tier fallback chain from the UI. Each slot lists every available model with its native window; fallback slots also offer "None".
- **Fallback chain**: read-only summary of the effective order (primary → fallback 1 → fallback 2 → active session model).
- **Current model / Context usage**: live status rows showing effective window vs native window and usage percentage.
- **Reset to defaults**: restores the default maxContext/target and clears overrides and fallback models.

Search-as-you-type filtering is available inside model pickers (type to filter across provider, id, and description). The settings list itself does not filter.

### Command-line shortcuts

```text
/compaction summaryModel google/gemini-2.5-flash,anthropic/claude-3-5-haiku
/compaction summaryModel default
/compaction maxContext 128000
/compaction target 64000
/compaction keepRecent 20000
/compaction enabled true
/compaction reset
```

## Summary Structure

Summaries generated by `pi-compact-pro` maintain strict continuity sections:

- `## Goal`: Active user objectives and task scope.
- `## Constraints & Preferences`: Expressed guidelines, rules, and user preferences.
- `## Progress`: Completed items (`Done`), current work (`Active`), and blocking issues (`Blocked`).
- `## Key Decisions`: Architecture and design decisions paired with rationale.
- `## Next Steps`: Ordered list of concrete next actions.
- `## Critical Context`: Exact paths, commands, URLs, error strings, and environment facts.
- `<read-files>` and `<modified-files>`: Native XML file tracking blocks computed from session tool operations.

## Testing & Verification

Unit and regression tests are written with `node:test` in `tests/pi-compact-pro.mjs`:

```bash
node tests/pi-compact-pro.mjs
pnpm lint extensions/pi-compact-pro
pnpm typecheck
pnpm fmt
```

## Installation

```bash
pi -e ./extensions/pi-compact-pro
```
