# pi-handoff: Session handoff for Pi

`pi-handoff` is a native [Pi coding agent](https://pi.dev) extension that extracts useful context from the active branch of the current session into a private Markdown file.

## Features

- **Readable context:** Formats active messages as Markdown and omits internal metadata and unsupported content.
- **Active context:** Exports the compaction-aware messages Pi sends to the agent, including compaction summaries, branch summaries, Bash executions, and tool calls.
- **Filtered metadata:** Omits model changes, provider metadata, token usage, timestamps, all IDs, thinking blocks, thinking signatures, and images.
- **Safe Markdown format:** Stores tool calls with readable argument sections.
- **File operation filtering:** `read` and `write` show only the target file path.
- **Private temporary files:** Writes UTF-8 files with mode `0600` to `/tmp/handoff-<hash>.md`.
- **File loading:** Loads a handoff file into a new session as one user message without dispatching slash commands from the file.

## Commands

| Command                           | Purpose                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `/handoff`                        | Export useful context from the active branch and show the continuation command. |
| `/handoff /tmp/handoff-<hash>.md` | Load a handoff file into the current session.                                   |

## Output format

The export uses plain Markdown with a structured active-context section:

```text
# Pi handoff

### Compaction summary

The previous context summary appears here.
## Active context

### User

Please check the migration.

### Tool call: `read`

Path: db/migrate.sql

```

After export, the extension shows:

```text
use /handoff /tmp/handoff-<hash>.md in new session to continue
```

The export follows the active branch, not abandoned siblings, and keeps only context needed to continue. Loading the file gives the model the transcript as context. It does not recreate the original session roles, tool state, model, or branch identity.

## Installation

To load `pi-handoff` in Pi, add `extensions/pi-handoff` to your workspace extension list, or run it from the repository root:

```bash
pi -e ./extensions/pi-handoff
```
