# Architecture & Domain Context

This repository is a monorepo containing native extensions, tools, sub-agent execution engines, and TUI components built for the [Pi coding agent](https://pi.dev) harness (`@earendil-works/pi-coding-agent` v0.84+).

Code in this monorepo is written in TypeScript using **Effect v4** (`effect` v4.0.0-beta), **TypeBox**, and Pi's native extension APIs (`@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`).

---

## 🏛️ System Architecture

```text
                               ┌──────────────────────────────────────────┐
                               │              Parent Session              │
                               │  (Interactive TUI / Orchestrator Mode)   │
                               └────────────────────┬─────────────────────┘
                                                    │
                ┌───────────────────────────────┼────────────────┐
                │                               │                
                ▼                               ▼                
┌───────────────────────────────┐   ┌───────────────────────────────┐
│           workflows           │   │        pi-processes           │
│     JavaScript DSL Engine     │   │   Process Supervision         │
│  (parallel, phase, profiles)  │   │ (start, stop, logs, ready)    │
└───────────────┬───────────────┘   └───────────────┬───────────────┘
                │                                   │
                ▼                                   ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│     Child Workflow Agents     │   │    Supervised OS Processes    │
│   (Persistent Pi Sessions)    │   │   (Servers, watchers, logs)   │
└───────────────────────────────┘   └───────────────────────────────┘
```

---

## 👥 Participants & Domain Vocabulary

### Participants & Roles

- **Parent Session**: The primary interactive conversation session that launches workflows, receives agent outcomes, and inspects workflow runs. _(Avoid: controller, manager)_
- **Workflow Agent**: A child Pi session created to execute one profile-configured workflow assignment independently. _(Avoid: subagent, child worker)_
- **Orchestrator**: The primary agent operating in workflow mode to coordinate profile-configured agents with `phase()` and `parallel()` rather than performing broad exploration itself.
- **Owner Session**: The parent session that created and owns a job's lifecycle and delivery boundary. _(Avoid: current session, worker session)_
- **Harness**: The execution environment running a session (e.g. Pi or Agy). _(Avoid: agent, worker)_

### Work & Execution Units

- **Workflow Assignment**: A unit of agent work delegated by a workflow. Runs independently and reaches a terminal outcome. _(Avoid: background job, process)_
- **Workflow Run**: A tracked orchestration run with an identity, owner session, phases, agent records, lifecycle, and aggregate result.
- **Process**: An external command or service supervised independently of worker assignments (e.g. `pnpm dev`, watchers). _(Avoid: worker when referring to a process)_

### Lifecycle & Outcomes

- **Pending**: The assignment or process has been accepted but has not started executing.
- **Spawned**: Immediate tool acknowledgement that a job was created and handed off. _(Avoid: running, completed)_
- **Running**: The assignment or process is currently executing.
- **Completed**: The job reached its intended terminal outcome successfully. _(Avoid: delivered)_
- **Failed**: Execution or validation could not succeed. _(Avoid: cancelled)_
- **Cancelled**: Execution was intentionally stopped before normal completion.
- **Agent Result**: The terminal payload submitted by a workflow agent for its assignment. Separate from progress updates.

### Interaction & Delivery

- **Submit**: The worker's final act of submitting a worker result or error.
- **Parent Delivery**: Automatic presentation of a settled worker result to the parent session (no polling required).
- **Workflow Dashboard**: Parent-led inspection of workflow phases, agents, transcripts, usage, and recovered runs.
- **Targeted Inspection**: Direct reading of specific key files by the orchestrator using `read` after receiving research findings, before delegating code changes.

---

## 🧩 Monorepo Extensions

The monorepo contains native extensions located under `extensions/`:

| Extension              | Category                | Description                                                                                                                                                                                     | Key Directives / Commands                            |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `workflows`            | Multi-Agent DSL         | Primary JavaScript multi-agent orchestration DSL with profiles, compaction-aware persistent child sessions, parallel fan-out, schema validation, background result cards, and a profile editor. | `workflow`, `/wf`, `/agents`                         |
| `pi-compact-pro`       | Compaction              | Configurable auto-compaction thresholds, reversible model context caps, custom summary model fallbacks, and structured summaries.                                                               | `/compaction`, `session_before_compact`              |
| `pi-processes`         | Process Supervision     | Standalone retained process supervision, readiness checks, logs, lifecycle controls, and process dashboard.                                                                                     | `process_start`, `/processes`                        |
| `btw`                  | Interaction             | Independent modal side-chat with explicit handoff into the parent session.                                                                                                                      | `/btw`, `/btw:inject`                                |
| `pi-constellation`     | Inspection & Compaction | Deterministic zero-LLM compaction and incremental session transcript navigation, search, and message inspection.                                                                                | `session_inspect`, `session_before_compact`          |
| `pi-workers`           | Disabled Reference      | Disabled legacy worker and process implementation retained for later reference only.                                                                                                            | disabled                                             |
| `pi-reference`         | Code Accessibility      | Project reference manager auto-cloning Git repos into `~/.cache/checkouts/` and auto-allowing directories.                                                                                      | `@alias/path`, `/references`                         |
| `pi-cortex`            | Code Intelligence       | Semantic and AST pattern search, call graphs, ONNX embeddings, SQLite knowledge triples, and agent memory.                                                                                      | `code_search`, `code_ast_grep`, `/cc-index`          |
| `pi-exa`               | Web & Research          | Exa-powered web search, webpage content fetching, and multi-source deep research.                                                                                                               | `web_search_exa`, `web_fetch_exa`, `deep_search_exa` |
| `pi-acks`              | Auth & Accounts         | Subscription OAuth account manager and credential switcher for OpenAI Codex.                                                                                                                    | `/accounts`                                          |
| `pi-rtk`               | Token Optimization      | Token-optimized bash command rewriting (`rtk rewrite`) and RTK tools (`rtk_grep`, `rtk_find`).                                                                                                  | `/pi-rtk`                                            |
| `pi-station`           | TUI Compositor          | Fixed-layout TUI compositor status bar, bash mode, hashline file anchors (`LINE#HASH`), prompt history, undo/redo.                                                                              | `/station`, `/stash-history`                         |
| `pi-code-block-picker` | Utilities               | Code block extractor from session history, fuzzy selector, and cross-platform clipboard copy.                                                                                                   | `/codeblocks`, `Ctrl+Shift+Y`                        |
| `pi-codex-usage`       | Monitoring              | OpenAI Codex token limit monitoring and response verbosity control.                                                                                                                             | `/codex-usage`                                       |
| `pi-skill-toggle`      | Skill Governance        | Interactive checklist to toggle skills between automatic agent invocation and manual-only mode.                                                                                                 | `/toggle-skills`                                     |
| `ask-user`             | Interaction             | Structured multiple-choice user question tool with custom text input.                                                                                                                           | `ask_user`                                           |
| `notification`         | Audio Alerts            | Audio completion notifications (`agent_end`) with configurable sounds and volume.                                                                                                               | `~/.pi/agent/settings.json`                          |
| `copy-all`             | Utilities               | Copies the active post-compaction conversation window to the system clipboard.                                                                                                                  | `/copy-all`                                          |
| `tool-selector`        | Inspection              | Read-only inspector displaying active and inactive status for all session tools.                                                                                                                | `/tools`                                             |
| `treepluss`            | TUI Compositor          | Enhanced conversation branch tree component renderer for interactive mode.                                                                                                                      | TUI session visualizer                               |

---

## ⚡ Effect v4 Engineering Standards

When writing TypeScript code in this monorepo:

1. **Source of Truth**: Follow [`repos/effect/LLMS.md`](./repos/effect/LLMS.md) for idiomatic Effect usage, tests, module structure, and API design.
2. **Cheat Sheet**: Refer to [`docs/effect-v4-cheatsheet.md`](./docs/effect-v4-cheatsheet.md) for project-specific Effect v4 idioms.
3. **Idioms**:
    - Use `Effect.gen` for async control flow.
    - Define services using `Context.Tag` and `Layer`.
    - Handle errors explicitly using typed error channels and `Cause` inspection.
    - Avoid unhandled promise rejections or raw `try/catch` blocks inside Effect code.

---

## ⚙️ Package Management & Tooling

- **Package Manager**: Use `pnpm` exclusively. Do **not** use `npm`, `bun`, `npx`, or `bunx`. Use `pnpx` for binary execution without global installation.
- **Python Manager**: Use `uv` exclusively for Python execution and environment management.
- **Surgical Edits**: Touch only what the assignment requires. Preserve existing comments and file structures.
- **Verification Workflow**: Run the following checks in order before completing work:
    1. `pnpm lint`
    2. `pnpm typecheck`
    3. `pnpm fmt`
