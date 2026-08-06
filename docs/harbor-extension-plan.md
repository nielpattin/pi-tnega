# Pi Harbor Extension Plan

## Current contract

`@nielpattin/pi-harbor` provides asynchronous agent jobs, supervised process jobs, native shell execution, transcript takeover, and automatic task-result delivery.

The package has one compact parent tool surface:

| Tool               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `task_spawn`       | Start one or more asynchronous agent jobs. Results arrive automatically. |
| `process_start`    | Start a named long-running process job.                                  |
| `job_list`         | List task and process jobs together.                                     |
| `process_snapshot` | Read status and recent logs for one process job.                         |
| `job_cancel`       | Cancel a task or stop a process by namespaced job ID.                    |
| `process_restart`  | Restart one process job.                                                 |
| `bash`             | Run a one-shot shell command.                                            |

Pi worker sessions expose native `bash` and the Harbor `submit` tool. Worker sessions do not expose parent job controls, process controls, or inter-agent messaging. Agy execution uses its process backend and does not receive injected Pi tools.

Task IDs use the `task-N` namespace. Process IDs use the `process-N` namespace. `job_cancel` checks both registries without requiring callers to identify the job kind first.

The following retired surfaces are not part of the current product: the old multiplexed control tool, the director mode, mailbox delivery, follow-up worker messaging, and legacy operation-specific tool names.

## Agent profiles

All profiles are ordinary agent definitions. Built-ins, global Markdown files, and project Markdown files use this precedence:

```text
built-in < ~/.pi/agent/agents/<name>.md < <project>/.pi/agents/<name>.md
```

The built-in prompt bodies are named constants in `src/services/AgentsStore.ts` and each `BUILTIN_AGENTS` entry references its matching constant:

- `FAST_AGENT_BODY`: lightweight research and small implementation work.
- `GOOD_AGENT_BODY`: difficult, multi-file implementation and root-cause debugging.
- `SCOUT_AGENT_BODY`: read-only investigation and dependency mapping.
- `TASK_AGENT_BODY`: general implementation work.
- `REVIEWER_AGENT_BODY`: review of changes and pull request diffs.

Profiles are not special modes. `fast` and `good` are normal Pi profiles and have no hard-coded model or thinking level. Disk definitions can override any built-in profile through the normal agent store.

An agent definition contains its name, description, tools, harness, enabled state, optional model and thinking settings, and body. Empty Markdown bodies are ignored. Agy definitions are projected to managed Agy agent files when required.

## Task jobs

`task_spawn` accepts a flat task or a batch of up to four tasks. Every task has a detailed prompt and a short parent-generated name. The name is separate from the immutable `task-N` job ID and never selects an agent.

Each task may select an agent profile and an optional model override. Omitting the agent selects the general `task` profile. All task calls are asynchronous. There is no provider-facing background flag. The immediate tool result is a concise spawn acknowledgement, and Harbor injects the completed result when the job settles.

The task manager:

1. Waits for parent-session recovery to finish.
2. Resolves the agent definition and required harness fail-closed.
3. Reserves capacity before registering the job.
4. Registers a `task-N` record with the resolved agent and harness snapshot.
5. Starts the Pi or Agy backend.
6. Transitions the record through `pending`, `running`, and one terminal state.
7. Delivers the terminal result exactly once.

The maximum number of running agent jobs is four. Terminal records are retained within the manifest limits and pruned only when they have no active wait or cancellation interest.

### Pi settlement

Pi workers complete only through `submit`:

```json
{ "result": { "data": "complete self-contained result" } }
```

or:

```json
{ "result": { "error": "failure explanation" } }
```

The worker prompt body is placed first, followed immediately by the shared submit-only completion contract. Pi's useful native prompt sections follow afterward. The generic Pi identity sentence is removed from worker prompts without removing the native tool, guideline, documentation, project-context, or skill sections.

Final assistant prose without a successful `submit` never completes a job. The runner sends bounded reminders while preserving the worker tool set, then fails the job after the reminder limit. Output-schema failures remain in the same worker session and can be corrected and resubmitted.

The submit handler validates the payload. The Pi session runner is the sole authority that settles the job, so submit handling cannot race the lifecycle state machine.

### Agy settlement

Agy jobs run through the Agy process backend. The backend captures stdout, stderr, process exit, conversation identity, and semantic transcript events when available. Exit zero with an empty follow-up queue completes the job. Non-zero exit fails it. Cancellation terminates the process tree and cancels the job.

Agy control and transcript polling remain backend concerns. They do not add Pi tools or parent tools to the child process.

## Process jobs

`process_start` creates a retained `process-N` job for a named command. Names are unique among active process jobs. Optional readiness conditions can watch a log expression, a TCP port, or both.

`process_snapshot` returns status and bounded recent output. `process_restart` restarts a retained process using its original start configuration. `job_cancel` stops the process tree. `bash` remains a one-shot native shell tool and is not retained as a process job.

The process supervisor enforces a maximum of eight running process jobs, keeps bounded output, handles Windows and POSIX tree termination, and removes only safe terminal records during pruning.

## Job inspection and delivery

`job_list` returns concise records for both task and process jobs. It does not include full transcripts, system prompts, or unbounded result data. Full details remain available to the terminal UI and takeover views.

Task results are delivered automatically after settlement. A caller does not need to poll or send a follow-up message to a worker. Transcript takeover reads the persisted child transcript and sends new instructions through the parent session's takeover flow when the backend supports it. Workers are one-time executions; later work is a new task or a transcript-based takeover.

## Transcript model

Harbor stores semantic transcript entries instead of synthetic tool log strings:

- user text
- thinking text
- assistant text
- tool calls with tool name and arguments
- tool results with bounded content and error state

Pi transcript capture reads session JSONL events. Agy transcript polling maps available process records into the same semantic entry model. Raw output is retained only as a bounded fallback and is not used to fabricate tool rows.

## User interface

`/tasks` is the unified full-screen dashboard. It has Jobs and Processes views, bounded terminal rendering, alternate-screen handling, live status updates, process logs, and session takeover.

Rows use explicit labels:

```text
status · name · agent <name> · via <harness> · job-id · elapsed · state
```

The UI never renders filler labels, internal origin values, or an unlabeled agent and harness pair. Task results and process snapshots use the same job registry and process supervisor records as the tools.

`/agents` edits normal Markdown agent definitions. It does not have a separate profile mode. The panel displays harness, tools, description, model, thinking, and file path fields and persists global overrides safely.

## Persistence and recovery

Each parent session has an isolated child-session directory and `harbor-jobs.json` manifest. The manifest stores bounded job identity, lifecycle state, agent resolution, process metadata, result summaries, and recent transcript entries.

Persistence is atomic and Windows-safe. Invalid or oversized manifests are quarantined instead of partially loaded. Pending and running jobs become failed on parent-session restart rather than being resumed and duplicated. Terminal jobs can be restored and remain visible in the dashboard.

Parent-session activation is serialized. Spawning waits until the active parent manifest and registry are ready. Task sequence reservation continues above recovered `task-N` IDs.

## Source layout

```text
extensions/pi-harbor/
├── index.ts
├── package.json
├── tsconfig.json
└── src/
    ├── domain.ts
    ├── extension.ts
    ├── runtime.ts
    ├── services/
    │   ├── AgentsStore.ts
    │   ├── HarborJobManifest.ts
    │   ├── HarborJobPersistence.ts
    │   ├── HarborJobRecovery.ts
    │   ├── JobRegistry.ts
    │   ├── ParentSessionGate.ts
    │   ├── ProcessSupervisor.ts
    │   ├── ResultDelivery.ts
    │   └── TaskManager.ts
    ├── backends/
    │   ├── agy.ts
    │   ├── pi-model.ts
    │   └── pi.ts
    ├── tools/
    │   ├── jobs.ts
    │   ├── process.ts
    │   ├── submit.ts
    │   └── task.ts
    ├── ui/
    │   ├── agents-panel.ts
    │   ├── tasks-dashboard.ts
    │   ├── takeover.ts
    │   └── tool-renderers.ts
    └── utils/
        ├── acp-decoder.ts
        ├── child-session-dir.ts
        ├── kill-tree.ts
        ├── output-buffer.ts
        ├── process-telemetry.ts
        ├── ready-poller.ts
        ├── session-transcript.ts
        ├── shell-env.ts
        └── stream-close.ts
```

## Verification

Use the package commands from the monorepo root:

```text
pnpm --dir extensions/pi-harbor check
pnpm lint extensions/pi-harbor
pnpm typecheck
pnpm fmt
git diff --check
```

The root typecheck includes every extension and therefore requires every extension workspace to have its own `tsconfig.json`. A missing temporary extension configuration is an environment/repository setup failure, not a Harbor type error.
