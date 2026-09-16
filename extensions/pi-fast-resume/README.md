<div align="center">

# ⚡ pi-fast-resume

**Instant session picker for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Reads just enough of each file to show the title row — first results in **6ms**._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)

</div>

---

> **`/resume` takes 5.6 seconds** when you have 1,700+ sessions.
> pi-fast-resume's `/fast-resume` takes **6 milliseconds**.

Same picker UI and keybindings as `/resume`. The difference is pi-fast-resume never parses the full JSONL up front. For each file it streams complete lines forward just until the first user message (the title), then reads a bounded tail near EOF to recover the latest session name (which pi appends on `/rename`). Everything between is full message history the picker never needs for a title — the message count comes from a separate background pass after the list is on screen (see [Message counts](#message-counts)). Search matches against the first message only (see [Known Limitations](#known-limitations)).

```
──────────────────────────────────────────────────────────

Resume Session (Current Folder)       ◉ Current Folder | ○ All  Name: All  Sort: Threaded
Tab scope · re:<pattern> regex · "phrase" exact
Ctrl+S sort · Ctrl+N named · Ctrl+D delete · Ctrl+P path (off) · Ctrl+R rename

search: fix auth bug_

› Fix the auth bypass in middleware                    34 2m
  Add rate limiting to API                             98 5h
  Refactor user service                              156 1d
  Auth refactor                                       67 3d

──────────────────────────────────────────────────────────
```

## Benchmarks

Tested with **1,771 sessions, 1.46 GB** of JSONL data on disk.

| Approach                          | First paint  | Full load |
| --------------------------------- | ------------ | --------- |
| Built-in `/resume`                | **5,600 ms** | 5,600 ms  |
| `node:sqlite` indexed query       | 52 ms        | 52 ms     |
| DuckDB persistent index           | 49 ms        | 49 ms     |
| **pi-fast-resume (partial read)** | **6 ms**     | ~580 ms   |
| DuckDB NDJSON full scan           | 2,560 ms     | 2,560 ms  |

> The all-dirs `stat()` pass (~100 ms at scale) now runs **after** first paint, so first paint no longer depends on total session count — only on the current project's session dir.

<details>
<summary><strong>Full benchmark table</strong></summary>

| Approach                                        | Time      | Notes                                                           |
| ----------------------------------------------- | --------- | --------------------------------------------------------------- |
| `SessionManager.listAll()` (current)            | ~5,600 ms | Full parse of every file                                        |
| DuckDB `read_ndjson` full query                 | ~2,560 ms | Still reads all 1.46 GB, but multithreaded                      |
| Node.js streaming partial read (this extension) | ~370 ms   | All ~2,550 sessions; stops at first user message + bounded tail |
| DuckDB persistent index (query all)             | ~49 ms    | After one-time build                                            |
| `node:sqlite` persistent index (query)          | ~52 ms    | Zero external deps                                              |
| **pi-fast-resume, first 30 sessions**           | **~6 ms** | **Streaming display**                                           |
| pi-fast-resume, stale-check for incremental     | ~74 ms    | Compare mtimes against last load                                |
| DuckDB CLI → JSON → Node parse                  | ~121 ms   | Shell-out approach                                              |
| `node:sqlite` FTS5 search                       | ~0 ms     | Indexed full-text search                                        |

</details>

## Install

This checkout is the Pi agent root, so the extension is auto-discovered from
`extensions/pi-fast-resume/index.ts`. Reload the running session with `/reload` after you change it.

To load it from another checkout for a single session:

```bash
pi -e /path/to/agent/extensions/pi-fast-resume/index.ts
```

## Development

`index.ts` is the extension entry point. Header scanning and search logic live in `src/`, and the
vitest suite lives in `tests/`.

Run from the repository root:

| Command                                          | Purpose                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| `pnpm --dir extensions/pi-fast-resume test`      | Run the test suite in `tests/`                        |
| `pnpm --dir extensions/pi-fast-resume bench`     | Run `tests/perf.bench.ts`                             |
| `pnpm --dir extensions/pi-fast-resume check`     | Type-check against the workspace `tsconfig.base.json` |
| `pnpm --dir extensions/pi-fast-resume lint:dead` | Dead-code check with knip                             |

## Usage

### `/fast-resume` command

```
/fast-resume              Open picker (current project)
/fast-resume auth bug     Open picker pre-filtered to "auth bug"
```

### Keyboard shortcut

There are two ways to bind a key to the fast resume picker:

**Option 1: Rebind `app.session.resume`** (hijack mode only)

In hijack mode (default), the fast picker replaces `/resume` — bind `app.session.resume` in `~/.pi/agent/keybindings.json`:

```json
{ "app.session.resume": "alt+u" }
```

**Option 2: Standalone shortcut** (works regardless of hijack mode)

Set the `shortcut` key in `~/.pi/agent/extensions/pi-fast-resume.json`:

```json
{ "shortcut": "ctrl+shift+f" }
```

This registers an independent shortcut that opens the fast picker without overriding the built-in `/resume`. Works in both hijack and non-hijack modes.

See [keybindings.md](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/keybindings.md) for the key format and all available actions.

### Picker controls

Identical to built-in `/resume`:

| Key       | Action                                        |
| --------- | --------------------------------------------- |
| `↑` / `↓` | Navigate sessions                             |
| `Enter`   | Switch to selected session                    |
| `Esc`     | Cancel                                        |
| `Tab`     | Toggle scope — current project ↔ all sessions |
| `Ctrl+S`  | Toggle sort — Threaded / Recent / Fuzzy       |
| `Ctrl+N`  | Toggle name filter — All / Named              |
| `Ctrl+P`  | Toggle session file path display              |
| `Ctrl+D`  | Delete selected session (with confirmation)   |
| `Ctrl+R`  | Rename selected session                       |
| typing    | Filter sessions by text / regex / exact match |

### Scope

The picker opens in **current project** scope, showing only sessions whose working directory matches your current `cwd`.

Press `Tab` to switch to **all sessions** — shows every session pi knows about, with the project path displayed for each entry.

## How it works

```
stat() current dir's .jsonl ──► sort by mtime ──► stream top 30 forward
      (~cheap, one dir)          (recent first)        (~6ms)
                                                            │
                                                            ▼
                                                    ┌─────────────────┐
                                                    │  Show picker    │
                                                    │  immediately    │
                                                    └────────┬────────┘
                                                             │
                          Background (after first paint):
                          1. stream the rest of the current dir in batches of 50 (rows appear as they load)
                          2. stat() ALL session dirs (~100ms at scale) — deferred off the critical path
                          3. forward-load all-scope headers in batches of 50 (non-blocking via setImmediate)
                          4. resolve rename names in the background (skip header-only files; bound each tail read)
                          5. count each session's messages top-to-bottom (the true count; see Message counts)
```

1. **`stat()` the current project's session dir** — collect paths and mtimes (cheap, one directory)
2. **Sort by mtime descending** — most recent sessions first
3. **Stream the top 30 forward** line by line until the first user message (~6 ms for the first screen)
4. **Show picker** — user can navigate, filter, and select immediately
5. **Background load** — after first paint, stream the remaining current-scope sessions in batches of 50, then stat every session dir and forward-load the all-scope headers, non-blocking
6. **Tab to switch scope** — filter to current project or show everything
7. **Resolve message counts** — the picker shows `…` for a count it has not verified yet and fills in the real number in the background, top row first (see [Message counts](#message-counts))

No indexing. No database. No persistent state. Just reads the files on disk.

## Why not index?

An indexed approach would be faster for subsequent queries, but at the cost of real complexity:

|                     | Partial read        | Indexed (SQLite / DuckDB)         |
| ------------------- | ------------------- | --------------------------------- |
| First open          | 6 ms                | 2–4 s (index build)               |
| Subsequent opens    | 6 ms (always fresh) | 50 ms + stale check               |
| State to manage     | None                | Index file, staleness, corruption |
| Dependencies        | None                | `node:sqlite` or DuckDB binary    |
| Freshness guarantee | Always              | Requires staleness detection      |

6 ms is fast enough. The data is always fresh because it's read from disk every time. No staleness bugs, no index corruption, no extra files in `~/.pi/`.

## Message counts

The forward pass stops at the first user message, so on its own it only knows a lower bound — every row
would read `1` no matter how long the session is. pi's built-in picker shows the true count because it
parses every file end to end, which is exactly the work that makes `/resume` slow.

pi-fast-resume resolves the count **after** first paint instead:

- A row renders `…` until its count is verified, so the list never shows a number it is about to
  contradict.
- Counts resolve in **display order** (top row first) in cooperative passes budgeted by bytes, so the
  rows you are looking at fill in first and a keystroke never waits behind a lot of scanning.
- Each pass resumes on a line boundary and carries the running total, so no byte is read twice and no
  entry is counted twice. A session whose forward pass already reached EOF is done before it is queued.
- The counts come from `type: "message"` entries only, using the same rule as pi's `SessionManager`, so
  the numbers match the built-in picker exactly.

Measured on 254 sessions / 770 MB of JSONL: 0 mismatches against pi's own counts, ~1.2 s of background
reading spread across cooperative passes (pi's own `listAll()` takes ~2.8 s in the foreground for the
same corpus).

Counting is the one part of the picker that touches every byte of the corpus, so it can be turned off:

```json
{ "countMessages": false }
```

With it off, rows show the forward pass's partial count immediately (the pre-deferred behavior) and
nothing is read in the background.

## Hijack mode

pi's built-in `/resume` is handled inside the interactive mode's `onSubmit` callback — it returns early before extension commands or input events are ever checked. Extensions **cannot intercept built-in commands** directly.

However, pi-fast-resume can **prototype-patch** `InteractiveMode.showSessionSelector` to intercept both the `/resume` command and the `app.session.resume` keybinding. Hijack mode is **on by default** — `/resume` opens the fast picker unless you opt out.

- `/resume` opens the **fast** picker instead of the built-in one
- `Ctrl+Shift+R` (or your mapped key) also opens the fast picker
- `/fast-resume` is not registered (no duplicate command)
- `pi -r` / `pi --resume` are **not** affected (they run before the interactive mode starts)

### Config options

All options go in `~/.pi/agent/extensions/pi-fast-resume.json`:

| Key             | Type      | Default | Description                                                                                                                                                                          |
| --------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hijackResume`  | `boolean` | `true`  | When `true`, `/resume` and `app.session.resume` open the fast picker. Set `false` to use the built-in picker instead and keep `/fast-resume` as a separate command.                  |
| `shortcut`      | `string`  | (none)  | Register a standalone keybinding to open the fast picker. Works regardless of `hijackResume`. Example: `"ctrl+shift+f"` or `"alt+u"`.                                                |
| `countMessages` | `boolean` | `true`  | Resolve each session's true message count in the background, showing `…` until it is known. Set `false` to show the partial (forward-pass) count immediately and read nothing extra. |

Example:

```json
{ "hijackResume": false, "shortcut": "alt+u", "countMessages": false }
```

Reload with `/reload` after changing config.

### How it works

On load, the extension patches `InteractiveMode.prototype.showSessionSelector` to open the fast picker via `ctx.ui.custom()`. On `session_shutdown` (reload, quit, session switch), the prototype is restored. The patch guards against API changes — if `showSessionSelector` doesn't exist or the runtime can't produce an `ExtensionCommandContext`, it falls back to the original.

## Similar extensions

| Extension                                                        | Approach                       | Gap                                               |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------------------------------- |
| [pi-sessions](https://github.com/thurstonsand/pi-sessions)       | Search, indexing, auto-titling | Session picker still uses `SessionManager.list()` |
| [pi-session-search](https://github.com/samfoy/pi-session-search) | FTS5 SQLite for search queries | Index for search, not for the picker              |
| [pi-session-manager](https://github.com/Dwsy/pi-session-manager) | Full desktop app (Tauri)       | External app, not integrated into pi              |

None optimize the `/resume` picker itself — they either still fully parse every file or are standalone applications.

## Known Limitations

The partial-read tradeoff that gives pi-fast-resume its speed comes with functional gaps vs. the built-in `/resume`. The forward stream reads exactly as many bytes as the first user message needs (no fixed window), so oversized first messages — `<skill>` injections, long pastes, base64 images — are parsed correctly. A rename is recovered only if it lives within a bounded tail near EOF (32 KB by default); a rename buried under more continued activity than that falls back to `firstMessage`.

| Area              | Built-in `/resume`                                                    | pi-fast-resume                                                                   | Impact                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Search depth**  | Matches against **all messages** in every session (`allMessagesText`) | Matches against **first message only** (`firstMessage`) + name + id + cwd        | A query like `fix oauth` will not find a session where "fix oauth" appears in the 5th message but not the 1st. Name/id/cwd matches still work.                                                         |
| **Message count** | Known before the picker paints (every file was parsed)                | Resolves after paint, top row first; a row shows `…` until its count is verified | A row you are looking at may show `…` for a moment on a cold open, and counting reads the whole corpus in the background (see [Message counts](#message-counts); disable with `countMessages: false`). |

All other features — tree view, regex/exact-phrase search, sort modes, scope toggle, delete, rename, path display — are identical to the built-in picker.

## License

MIT.
