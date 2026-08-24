# Workflows Extension Design

## Status and scope

This document describes the code logic and approved target design of the `workflows` extension. It is not only a description of the terminal UI.

The target terminology is **Worker**. The target DSL uses `worker()` and `profile`, not the legacy assignment terminology still present in some source filenames and current implementation symbols. This document is being refined before that code migration. Sections that describe current gaps identify behavior that is not implemented yet.

The extension is implemented primarily in:

- `extensions/workflows/index.ts`
- `extensions/workflows/runner.ts`
- `extensions/workflows/sandbox.ts`
- `extensions/workflows/sandbox-child.cjs`
- `extensions/workflows/controller.ts`
- `extensions/workflows/artifacts.ts`
- `extensions/workflows/model.ts`
- `extensions/workflows/meta.ts`
- `extensions/workflows/prompt.ts`
- `extensions/workflows/settings.ts`
- `extensions/workflows/dashboard.ts`
- `extensions/workflows/agents-panel.ts`
- `extensions/shared/child-session.ts`
- `extensions/shared/agent-profiles.ts`

The design has two execution layers:

1. A model-authored workflow script coordinates work.
2. Isolated Pi child sessions perform individual Worker assignments.

The workflow script is not itself a Worker session. It is a restricted orchestration program. A Workflow Worker is the Pi child session that performs a delegated assignment.

The approved target includes context caps, late structured-result acceptance, Summary fallbacks, profile-defined Worker types, flexible model routes, and same-session completion recovery. Code changes will follow after this design is finalized.

---

## 1. Purpose

The extension lets the parent Pi session turn a large task into a bounded multi-Worker run.

A typical run looks like this:

```text
Parent Session
    |
    | workflow tool call containing JavaScript
    v
Workflow Run
    |
    | sandboxed orchestration script
    v
Workflow phases
    |
    | worker() and parallel()
    v
Workflow Workers
    |
    | isolated Pi child sessions
    v
Provider model requests
    |
    v
Structured work results
    |
    v
Mandatory final Summary
    |
    v
Workflow result returned to the Parent Session
```

The extension is intended for tasks that benefit from:

- Several independent investigations.
- Read-only research followed by implementation or review.
- Parallel review of multiple files or perspectives.
- Ordered phases where later work consumes earlier results.
- A final synthesis that is separate from the individual Workers.

The extension is not intended to be:

- A general-purpose JavaScript runtime with filesystem or network access.
- A replacement for the normal parent Pi session.
- A process supervisor. Process supervision belongs to the separate process extension.
- A durable distributed job queue.
- A transparent way for a child Worker to recursively start more workflows.

---

## 2. Domain terminology

The code and surrounding repository use the following concepts.

| Term                   | Meaning                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parent Session**     | The interactive Pi session that owns the workflow tool call, receives results, and opens the dashboard.                                                    |
| **Orchestrator**       | The model or workflow script coordinating phases and assignments. It is not a separate provider session.                                                   |
| **Workflow Run**       | One complete execution with a run ID, metadata, phases, Worker records, status, result, and artifacts.                                                     |
| **Worker Assignment**  | One unit of work requested through `worker()`.                                                                                                             |
| **Workflow Worker**    | The isolated Pi child session executing one Worker Assignment.                                                                                             |
| **Worker Record**      | The live and persisted status record for one assignment, including profile, route, model, usage, transcript, result, and error.                            |
| **Summary Worker**     | The final direct-completion request that synthesizes the latest work phase. It is not created through the normal Worker runner.                            |
| **Run Controller**     | The parent-side scheduler that owns concurrency, abort signals, call counts, and shutdown settlement.                                                      |
| **Workflow Sandbox**   | The separate Node child process that executes the model-authored JavaScript orchestration code.                                                            |
| **Workflow Dashboard** | The `/wf` TUI used to inspect runs, phases, transcripts, models, usage, and errors.                                                                        |
| **Artifact Directory** | The project-scoped workflow directory under `~/.pi/agent/workflows/--<encoded-cwd>--/` containing user-readable run folders and all durable workflow data. |

The important distinction is that the Workflow Worker uses a Pi session runtime and Pi-compatible JSONL, while its persistence is redirected into the workflow folder. Nothing is stored in `~/.pi/agent/sessions/`.

---

## 3. High-level architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Parent Pi Session                                                       │
│                                                                         │
│  workflows(pi)                                                         │
│  ├─ workflow tool                                                       │
│  ├─ /wf command and dashboard                                          │
│  ├─ /workers command and profile editor                               │
│  ├─ activeRuns                                                         │
│  └─ parent session lifecycle handlers                                  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │ workflow source, args, phase events,
                                │ Worker requests and serialized results
                                v
┌─────────────────────────────────────────────────────────────────────────┐
│ RunController and parent-side callbacks                                │
│                                                                         │
│  ├─ concurrency semaphore, maximum 16 active Workers                  │
│  ├─ run budget, maximum 1,000 regular Workers plus Summary             │
│  ├─ run and invocation AbortSignals                                    │
│  ├─ live WorkerRecord updates                                           │
│  └─ checkpoint persistence                                              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ authenticated IPC
                                v
┌─────────────────────────────────────────────────────────────────────────┐
│ Workflow Sandbox child process                                          │
│                                                                         │
│  sandbox.ts                                                            │
│  ├─ spawns sandbox-child.cjs                                           │
│  ├─ Node permission mode                                               │
│  ├─ IPC validation and byte limits                                     │
│  ├─ child termination and cleanup                                      │
│  └─ phase and Worker message bridge                                    │
│                                                                         │
│  sandbox-child.cjs                                                      │
│  ├─ VM context with no code generation                                  │
│  ├─ worker(), parallel(), phase(), args                                │
│  ├─ no imports, filesystem, network, process, or child-process API      │
│  └─ unawaited-Worker detection before returning                         │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ Worker request callback in parent
                                v
┌─────────────────────────────────────────────────────────────────────────┐
│ Workflow Worker runner                                                  │
│                                                                         │
│  runner.ts                                                             │
│  ├─ profile and model resolution                                       │
│  ├─ child resource loader with noExtensions                             │
│  ├─ structured_output tool                                             │
│  ├─ model fallback rules                                                │
│  ├─ progress and transcript projection                                 │
│  ├─ compaction-aware completion                                        │
│  └─ bounded child-session cleanup                                      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                v
┌─────────────────────────────────────────────────────────────────────────┐
│ Isolated Pi child session                                               │
│                                                                         │
│  profile tools + structured_output                                     │
│  resolved profile route, exact model, or Parent Session model           │
│  project trust and child settings                                       │
│  workflow-owned Pi-compatible transcript.jsonl                          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                v
                         Provider/model runtime
```

The active Parent process owns execution policy and live lifecycle. The workflow folder owns durable persisted state, and a later Parent process can recover it through **Continue run**. The sandbox cannot directly create Pi sessions or access the host filesystem. It can only send the narrow operations that the parent process accepts.

---

## 4. Extension registration and entry points

The default export in `index.ts` installs the extension into Pi.

It registers:

- The `workflow` tool.
- The `/wf` command.
- The target `/workflows` library command.
- The `/workers` command.
- The background workflow message renderer.
- `session_start` handling for the activity indicator.
- `session_shutdown` handling for abort and cleanup.

### `workflow` tool

The tool accepts:

```ts
{
  script: string;
  args?: string;
  background?: boolean;
}
```

`args` is parsed as JSON when possible. If parsing fails, the raw string is passed to the sandbox. Background mode is only enabled when the caller requests it and the parent has a UI.

The script's return value is deliberately ignored. A workflow's public result is the final Summary output, not the value returned by the orchestration function.

### `/wf`

`/wf` lists and opens workflow runs. In TUI mode it opens the dashboard. In non-TUI mode it prints or notifies with a text listing and can show a selected run's report.

### `/workers`

`/workers` lists or edits the named Worker profiles. In a TUI it opens the profile editor. Without a UI it prints the available profiles and their enabled state.

### `/workflows`

The target `/workflows` command lists built-in, global, and project reusable workflow scripts. It can preview metadata, run a selected workflow with arguments, save an inline workflow into a library, and open the run history for the current encoded project path.

The command passes the selected source through the same sandbox, IPC limits, Worker policy, persistence, Summary, and observability paths as an inline workflow. A reusable script never receives additional privileges because it came from a library.

---

## 5. Workflow source preparation

`meta.ts` prepares the source before execution.

### Static metadata

A script may begin with a static declaration such as:

```js
export const meta = {
    name: "reliability-review",
    description: "Review selected modules and synthesize findings",
    phases: [
        { title: "Scan", detail: "Read-only investigation" },
        { title: "Report", detail: "Cross-check and prepare findings" }
    ]
};
```

Metadata is parsed with Acorn. The declaration is decoded from literals without evaluating it. The parser accepts plain strings, numbers, booleans, null, arrays, and objects. It rejects executable metadata such as calls, identifiers, getters, methods, spreads, computed keys, and unsupported expressions.

Metadata values are sanitized:

- Workflow name: maximum 160 characters.
- Description: maximum 2,000 characters.
- Up to 64 declared phases.
- Phase title: maximum 160 characters.
- Phase detail: maximum 2,000 characters.

The metadata declaration is removed from the executable source while preserving line positions. Static imports and exports other than the allowed `meta` declaration are rejected.

### Reserved Summary phase

The runtime appends a `Summary` phase after the declared phases. A script should not declare or call a phase named `Summary`.

The runtime creates the Summary record before work starts so the dashboard can show that the final synthesis is waiting.

### Dynamic phases

`phase(title)` sends a phase event to the parent. If the title was not declared in metadata, the parent adds it to the run's phase list. This allows a script to report runtime-discovered phases, although declared metadata is preferred for stable UI ordering.

---

## 6. Workflow DSL

The sandbox exposes only four workflow primitives and one frozen argument value.

### `args`

`args` contains the parsed tool argument. The sandbox deep-freezes the value before exposing it to the script. It is `undefined` when the tool call omitted the argument.

### `phase(title)`

Marks the current work phase and sends a progress event to the parent. It does not execute a Worker and does not wait for work.

### `worker(prompt, options)`

Requests one Workflow Worker Assignment.

The target options are:

```ts
{
    profile?: string; // Worker type, defaults to "good"
    route?: string;   // logical model route, such as "small" or "big"
    model?: string;   // exact provider/model override
    isolation?: "shared" | "worktree";
    label?: string;
    phase?: string;
    schema?: object;  // custom JSON schema
}
```

`profile` defines what kind of Worker runs the task. It controls tools, system instructions, role, and default execution policy. `route` selects a configured logical model route without requiring the workflow author to know a provider or model ID. `model` is an optional exact override and must resolve through Pi's model registry. `isolation` selects the shared project directory or a dedicated Git worktree, overriding the profile default.

If no profile is supplied, the `good` profile is selected. A Worker request is awaitable. The sandbox deliberately implements it as a restricted Promise-like object so an unawaited request can be detected before the workflow returns.

The script receives an envelope, not a raw provider result:

```ts
{
    ok: boolean;
    output: string;
    structured?: unknown;
    error?: string;
}
```

A failed assignment normally resolves with `ok: false` instead of throwing into the script. Scripts should branch on `ok` before consuming the result.

Example:

```js
phase("Scan");

const result = await worker("Inspect the target module for reliability risks.", {
    profile: "scout",
    route: "small",
    label: "scan:runner",
    phase: "Scan"
});

if (!result.ok) {
    // Preserve the failure for the final Summary instead of hiding it.
    phase("Report");
}
```

A stronger model can be selected without changing the Worker type:

```js
const result = await worker("Inspect subtle reliability risks.", {
    profile: "scout",
    route: "big"
});
```

The Worker remains read-only because its profile still controls its tools.

### `parallel(thunks, options)`

`parallel()` accepts zero-argument functions that return Worker requests:

```js
const results = await parallel(
    files.map(
        (file) => () =>
            worker(`Review ${file}`, {
                profile: "scout",
                route: "small",
                label: `scan:${file}`,
                phase: "Scan"
            })
    ),
    { concurrency: 4 }
);
```

The sandbox implementation:

- Requires an array.
- Requires every item to be a function.
- Requires a positive integer concurrency value when supplied.
- Caps requested concurrency at 16.
- Preserves input order in the returned array.
- Uses a bounded Worker loop rather than launching every item at once.

The parent `RunController` applies a second concurrency limit, so the DSL limit is not the only protection.

### Built-in quality helpers

The target library includes deterministic quality patterns built on the existing flat Worker and structured-result contracts:

- `verify()`: run explicit checks and return a bounded pass/fail result.
- `judgePanel()`: run multiple read-only reviewer Workers and combine their structured judgments.
- `completenessCheck()`: compare a result against a declared checklist or schema.
- `gate()`: stop or continue a phase from an explicit structured predicate.
- `retry()`: retry an idempotent check with a bounded attempt count.

These helpers are ordinary workflow source, not privileged runtime operations. They create sibling Workers only and never create nested workflows. `retry()` cannot silently repeat a side-effectful assignment. Provider completion recovery remains the runner's same-session repair and fallback policy.

### Built-in workflows and reuse

Built-in workflows are immutable, versioned scripts shipped with the extension. Initial built-ins are:

- `deep-research`
- `code-review`
- `codebase-audit`
- `adversarial-review`
- `multi-perspective`

Reusable scripts are stored under the workflow root:

```text
~/.pi/agent/workflows/
├── library/                         # global user workflows
└── --<encoded-cwd>--/
    ├── project.json
    ├── library/                     # project workflows
    └── <timestamp>_<workflow-slug>/ # run folders
```

Resolution precedence is project library, then global library, then built-ins. The selected source is copied into the run folder and its name, source kind, version, path, and content hash are recorded in `workflow.json` so later inspection does not depend on a mutable library file.

Library scripts must use the same static metadata rules and sandbox boundary as inline scripts. They cannot import other workflows, call a nested workflow primitive, or bypass the Worker profile and route policy.

### Script completion

The sandbox checks for unconsumed and in-flight Worker requests after the script's returned Promise settles. A script that starts an assignment without awaiting it fails rather than silently losing work.

The script result is serialized only to validate completion. The parent ignores it and runs the mandatory Summary phase.

---

## 7. Sandbox design

The workflow source is model-authored code, so it has a separate execution boundary.

### Parent-side process boundary

`sandbox.ts` starts `sandbox-child.cjs` as a separate Node process with:

- Node permission mode.
- Read permission only for the sandbox worker module directory.
- A 128 MB V8 heap limit.
- A bounded stack size.
- IPC as the only useful connection to the parent.
- A random authentication token on every run.

The child is terminated on normal completion, cancellation, protocol failure, or parent shutdown. Windows uses `taskkill /T /F` to terminate the process tree. Other platforms use `SIGTERM` followed by a delayed `SIGKILL` fallback.

### VM execution boundary

`sandbox-child.cjs` creates a null-prototype VM context and disables string and WebAssembly code generation. It exposes only the workflow bootstrap API.

The child workflow script cannot directly:

- Import modules.
- Read or write files.
- Use the network.
- Spawn processes.
- Invoke interactive questions.
- Start another workflow through a host extension.
- Use ordinary `process` capabilities.
- Use `eval` or generated WebAssembly.

The child process does contain the IPC bridge, but the bootstrap deletes the bridge from the workflow global after initialization. The parent also validates every message and checks the run token.

The VM timeout is applied to synchronous bootstrap and script setup. It is not a whole-workflow wall-clock deadline because the workflow must await model requests asynchronously.

### No nested workflows

Nested workflows are not supported and are not part of the target design.

- The sandbox exposes `worker()`, not a nested `workflow()` or `childWorkflow()` primitive.
- A Worker child session uses `noExtensions: true` and cannot load the workflow extension.
- The `workflow` tool is excluded from every Worker tool set.
- A Worker can perform its assigned task, but it cannot create another Worker, start another sandbox, or create a child Workflow Run.
- `parallel()` creates sibling Workers in the current run only.
- The parent stores one flat Worker list per Workflow Run. There are no nested run trees.

If a protocol message attempts to create a nested workflow, the parent rejects it as an unsupported capability rather than starting another run.

### IPC protocol

The parent accepts these message kinds:

- `phase`: phase title update.
- `worker`: Worker assignment request.
- `result`: serialized script completion.
- `error`: sandbox failure.

The child accepts `workerResult` messages in response to its own request IDs.

Current byte and count limits include:

| Value                            |              Limit |
| -------------------------------- | -----------------: |
| Workflow source                  |            512 KiB |
| Serialized arguments             |            256 KiB |
| Serialized workflow result       |              1 MiB |
| Worker request or result message |            512 KiB |
| Worker prompt                    | 100,000 characters |
| Worker requests                  |              1,000 |
| Phase title in IPC               |        4,096 bytes |

Values crossing the boundary are normalized to inert serializable data. Cycles, functions, symbols, unsupported values, deep objects, large strings, and non-finite numbers are represented or truncated instead of being allowed to break the protocol.

---

## 8. Run controller and scheduling

`RunController` is the parent-side owner of task scheduling.

### Concurrency and scale

The target controller uses a bounded queue and a semaphore with a default and maximum of 16 active Workers. A requested value below 16 can reduce concurrency for one `parallel()` call or phase. A requested value above 16 is clamped.

The target regular-Worker run budget is 1,000 Workers. The Summary is separate and runs as the final synthesis after regular Workers settle. The Summary is not taken out of the 1,000-Worker regular budget.

The controller creates lightweight queued records for work that has not started and creates child sessions only for active queue slots. It never creates 1,000 child sessions at once. A worktree is created only when its Worker reaches an active slot.

A Worker retry does not consume another regular-Worker slot or create another Worker record. Retry attempts have a separate completion-attempt budget.

The controller also applies route-specific concurrency limits. For example, a global limit of 16 can contain only three active `big` route Workers when the `big` route limit is three.

### Scale guarantees

The following rules are mandatory:

- Use a bounded queue. Never create one child session per queued Worker.
- Enforce route-specific concurrency under the global 16-Worker limit.
- Keep a separate completion-attempt budget for retries.
- Use same-session fallback model continuation.
- Never execute the same logical task twice.
- Never create a child workflow or nested Workflow Run.

### Signals

A run has a controller-level `AbortSignal`. Each scheduled Worker receives a child task signal combined with:

- The run signal.
- The individual invocation signal used by the dashboard or workflow callback.

Abort handling covers:

- Parent tool cancellation for blocking runs.
- User cancellation from `/wf`.
- Parent session shutdown.
- Sandbox cleanup.
- Child tool timeout propagation.

### Settlement

When a run is ending, the controller seals new work, optionally aborts active work, and waits for all registered tasks. Settlement has an eight-second default deadline. Workers still in `running` or `waiting` state after cleanup are marked as errors.

### Blocking and background ownership

Blocking runs inherit the workflow tool's signal. If the tool call is cancelled, the run is cancelled.

Background runs do not inherit the tool call signal, so pressing Escape or finishing the parent tool invocation does not cancel them. They remain in `activeRuns` and are still aborted during `session_shutdown`.

Background mode is therefore detached from the current turn, but not durable across a process or session shutdown.

---

## 9. Workflow run lifecycle

The main lifecycle is implemented in the `workflow` tool handler in `index.ts`.

### Step 1: Parse and prepare

1. Parse the script and static metadata.
2. Parse `args` as JSON, or retain it as a raw string on parse failure.
3. Load workflow settings.

### Step 2: Create identity and initial state

1. Generate a run ID in the form `wf_<random hex>`.
2. Create the run artifact directory.
3. Record the parent session ID and canonical project working directory. The project path determines the workflow folder.
4. Append the declared phases and the reserved Summary phase.
5. Add a waiting Summary Worker record after the regular-Worker budget. Its index is not a fixed regular-Worker index.
6. Write the original `script.js` and optional `args.json`.
7. Persist the initial compact `workflow.json`.

### Step 3: Create execution resources

1. Create a `RunController`.
2. Capture the parent's project trust decision.
3. Prepare shared or per-Worker Git worktree resources according to the profile and `isolation` option.
4. Set each Worker session's working directory to its selected isolation root.
5. Use `noExtensions: true` for Workflow Worker resource loading.

### Step 4: Execute the sandbox script

The parent starts `runWorkflowSandbox()` with callbacks for:

- `onPhase`: update current phase and persist progress.
- `onWorker`: create and schedule a Worker Assignment.

### Step 5: Register a Worker

For every `worker()` request, the parent:

1. Checks the 1,000-Worker regular budget.
2. Allocates a one-based Worker index.
3. Resolves and validates the profile, model route, and isolation policy.
4. Creates a `WorkerRecord` in the current phase with its selected working directory and worktree metadata.
5. Inserts it before the Summary record.
6. Creates an individual abort controller.
7. Schedules the actual child session through `RunController`.

### Step 6: Run the child session

The runner resolves the profile and model route, creates a child Pi session in the run's workflow-owned session directory, observes progress, and returns a `WorkerOutcome`. The parent updates the Worker Record with:

- State.
- Result or error.
- Provider and model.
- Context window.
- Profile and isolation mode.
- Runtime session ID and workflow-owned transcript path.
- Working directory, base commit, worktree path, and changed-file metadata when isolated.
- System prompt.
- Pi-compatible JSONL transcript.
- Usage.
- Preview and timestamps.

### Step 7: Finish the sandbox phase

When the script completes or fails, the parent performs cleanup of active script execution. An individual `worker()` failure does not automatically abort the script because it is represented by `ok: false`.

A script-level exception, protocol error, source limit failure, or sandbox exit marks the run as failed. Unless the run was aborted, the final Summary is still attempted so the failure can be included in the final report.

### Step 8: Run the Summary

The parent sets the current phase to `Summary` and collects the results from the immediately preceding phase. It then performs a direct completion request using the configured Summary model.

### Step 9: Settle and finalize

1. Abort remaining work if the run failed or was aborted.
2. Wait for controller tasks within the shutdown deadline.
3. Mark unsettled records as errors.
4. Capture Worker diffs and clean up worktrees according to the retention policy.
5. Set the final workflow status.
6. Flush `workflow.json` synchronously.
7. Remove the run from `activeRuns` after completion.
8. For background mode, send a follow-up message to the Parent Session.

---

## 10. Workflow Worker design

`runner.ts` owns one delegated Pi child session at a time. The child session is a Workflow Worker. Its profile defines its role and capabilities, while its route defines the model policy used to execute that role.

### Resource loading

`createWorkflowResources()` creates:

- A `SettingsManager` for the selected shared or worktree working directory.
- A `DefaultResourceLoader` rooted at that isolation directory.
- Project trust configuration inherited from the parent.
- Automatic compaction unless compaction was explicitly disabled globally or for the project.
- The selected Worker profile system prompt.
- The structured-output system instruction.
- `noExtensions: true`.

Ambient workspace extensions are intentionally not loaded in child sessions. This prevents unrelated host extensions from adding tools, listeners, or recursive workflow capabilities to every Worker.

### Worker tool policy

The Worker receives the tools named by its selected profile plus `structured_output`.

The shared child policy excludes:

- `workflow`
- `ask_user`

The profile determines whether the Worker receives read-only tools or editing tools. The structured-output tool is added by the runner and is not removed by the profile tool list.

### Git worktree isolation

A Worker with `isolation: "worktree"` receives a dedicated temporary Git worktree. The worktree is created before the Pi session starts and the Worker working directory is set to that worktree instead of the parent working directory.

```text
<run-folder>/workers/<workerIndex>/
├── worktree.json
├── worktree/
└── diff.patch
```

The worktree policy is:

- `fast` and `good` default to `worktree` because they have editing tools.
- `scout` and `reviewer` default to `shared` because they are read-only.
- An explicit `worker()` `isolation` option overrides the profile default.
- Each active Worker gets its own worktree. Parallel Workers never share an editing checkout.
- The worktree starts from the captured parent `HEAD` commit. Uncommitted parent changes are not copied implicitly.
- The parent working directory is never modified by Worker tools.
- The Worker may create local commits in its worktree, but the runtime never commits, merges, pushes, or applies changes to the parent automatically.
- The dashboard shows the base commit, worktree path, changed files, diff, and cleanup state.
- Completion captures the full patch from the base commit through `HEAD` plus uncommitted changes in `diff.patch`. A user-controlled apply or retain action is required to move changes into the parent project.
- Abort, timeout, failure, and Continue run preserve enough metadata to clean up or recover the worktree safely.

If the project is not a Git repository, an explicitly requested worktree fails clearly. The runtime never silently falls back to the shared parent directory. Git may keep its required administrative record under the repository's `.git/worktrees`; the checkout and workflow artifacts remain under the workflow run folder.

### Worker profiles

Built-in profiles are:

| Profile    | Worker type                              | Default tools        | Thinking | Default route | Default isolation |
| ---------- | ---------------------------------------- | -------------------- | -------- | ------------- | ----------------- |
| `fast`     | Small implementation or focused research | Read and write tools | `low`    | `small`       | `worktree`        |
| `good`     | General implementation and careful work  | Read and write tools | `high`   | `medium`      | `worktree`        |
| `scout`    | Read-only codebase investigation         | Read, grep, and find | `low`    | `small`       | `shared`          |
| `reviewer` | Read-only change review                  | Read, grep, and find | `high`   | `medium`      | `shared`          |

A profile is the Worker type. Changing the model route does not change the profile's tools, system prompt, or role.

Profiles may be overridden or added through Markdown files. The loader searches the existing Pi profile locations:

- The active Pi profile directory's `agents` directory.
- The project `agents` directory.
- The project `.pi/agents` directory.

These storage paths are existing Pi conventions. The runtime concept and public DSL name is Worker.

Project profiles override global profiles. A file with a built-in profile name acts as an override of that built-in definition.

Profile fields include:

- Name and description.
- Tool names.
- System prompt body.
- Optional exact `model`.
- Optional default `route`.
- Optional `fallbackRoutes`.
- Optional exact `fallbackModels`.
- Optional thinking level.
- Default isolation: `shared` or `worktree`.
- Enabled state.
- Compatibility harness metadata.

The `harness` field is retained for profile-file compatibility. The Worker runner executes Pi child sessions.

### Model routes

A route is a user-configured logical model choice. The workflow author can request `small`, `medium`, `big`, or another configured route without knowing the provider or concrete model ID. The route concept generalizes the remote project's tier concept while allowing names that describe local policy rather than model size.

Workflow settings contain route definitions such as:

```json
{
    "routes": {
        "small": {
            "model": "openai-codex/gpt-5.4-mini",
            "thinking": "low",
            "fallbackRoutes": ["medium"]
        },
        "medium": {
            "model": "openai-codex/gpt-5.4",
            "thinking": "medium",
            "fallbackRoutes": ["big"]
        },
        "big": {
            "model": "openai-codex/gpt-5.5",
            "thinking": "high"
        }
    },
    "routeConcurrency": {
        "small": 16,
        "medium": 8,
        "big": 3
    }
}
```

Route configuration is user-owned. A settings command may suggest `small`, `medium`, and `big` mappings by ranking authenticated models from Pi's registry, but the resulting provider/model mapping is explicit and inspectable. The runtime never invents a provider for a route at call time. If no route is selected, resolution can fall back to the Parent Session model; an explicitly requested unknown route is an error.

Custom route names are allowed. A phase may also declare a default route, for example:

```js
export const meta = {
    phases: [
        { title: "Scan", detail: "Read-only investigation", route: "small" },
        { title: "Review", detail: "Deep cross-check", route: "big" }
    ]
};
```

A phase route is only a default. A Worker call route, exact model, or profile route takes precedence. A route must resolve to an available Pi model. An unknown route or invalid configured model fails clearly instead of silently selecting an unrelated model.

### Model resolution

The target resolution order is:

1. An exact `worker.model` supplied for this Worker.
2. A `worker.route` supplied for this Worker.
3. An exact model defined by the selected profile.
4. The profile's default route.
5. A phase-level default route, when configured.
6. The Parent Session model.

An exact model is resolved through Pi's model registry. The provider and credentials come from Pi's registry, not from the workflow script. An exact model that is not available is an error.

The route is resolved to its configured model and thinking level before the child session starts. All selected models, including route models, exact models, Summary models, and fallback models, are capped to the Parent Session's context window.

The context cap is applied even when a selected model has a larger native context window. This prevents a Worker from operating with a context capacity that the Parent Session cannot safely represent or support.

### Same-session completion fallback

A model route fallback changes only the model used by the existing Worker session. It does not change:

- The Worker profile.
- Allowed tools.
- System prompt.
- Working directory.
- Conversation history.
- Task state.

The completion sequence is:

1. Run the Worker on the primary resolved model.
2. If it does not submit valid `structured_output`, ask the same session to finish and submit the tool result.
3. If that repair fails, resolve the next fallback route or exact fallback model.
4. Change the model on the same session.
5. Ask the same session to continue the unfinished task and submit `structured_output`.
6. Return success only after a schema-valid payload is captured.

The runtime never starts the whole task again under a new session. If the existing session is lost or cannot continue safely, the Worker fails visibly.

### Worker session persistence

The workflow storage directory mirrors Pi's project scoping without using Pi's global session directory. Pi encodes the canonical working directory as:

```ts
const encodedCwd = resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
const projectDir = `--${encodedCwd}--`;
```

For example, `C:/Users/niel/.pi/agent` becomes `--C-Users-niel-.pi-agent--`.

Each active Worker uses a normal Pi session runtime with a custom session directory inside the current workflow run:

```text
~/.pi/agent/workflows/--<encoded-cwd>--/<run-folder>/workers/<workerIndex>/
```

Its `transcript.jsonl` uses Pi's native JSONL session-entry schema, including session headers, messages, tool results, compaction, model changes, and extension entries. Workflow lifecycle records are separate `events.jsonl` entries. No Worker session file is written under `~/.pi/agent/sessions/`.

The run folder is user-readable, using `<timestamp>_<workflow-slug>` rather than exposing the internal run ID. If two runs collide, the allocator adds a numeric suffix. The internal run ID remains in `workflow.json`.

The runner emits a bounded shutdown event to the child extension runner and then disposes the session. Cleanup is idempotent and has a five-second default timeout.

### Tool timeout

Every registered child tool is wrapped with an independent three-minute timeout. The guard is reapplied when a child Worker starts so tools registered later are also covered.

This is a per-tool timeout, not a whole-Worker or whole-workflow deadline. A model request, compaction retry, or workflow run may have a different lifetime.

### Compaction awareness

The runner observes Pi compaction and automatic retry events. It does not treat an intermediate `agent_end` as final while:

- Compaction is active.
- Provider retry is active.
- The event indicates that another turn will retry.

This prevents a child from being marked complete during an intermediate context-management turn.

---

## 11. Structured result protocol

All Workflow Workers use a terminating `structured_output` tool.

### Default schema

When the script does not supply a custom schema, the runner uses:

```json
{
    "type": "object",
    "properties": {
        "output": {
            "type": "string",
            "description": "The concise final answer for the workflow assignment."
        }
    },
    "required": ["output"],
    "additionalProperties": false
}
```

The child is instructed to call `structured_output` exactly once as its final action and not write a prose answer after the tool call.

For the default schema, the runner exposes the captured `structured.output` as the convenient `output` field in the script result.

### Custom schema

A script can supply a custom JSON object schema:

```js
const result = await worker("Extract actionable findings", {
    profile: "scout",
    route: "small",
    schema: {
        type: "object",
        properties: {
            findings: {
                type: "array",
                items: { type: "string" }
            },
            confidence: { type: "number" }
        },
        required: ["findings", "confidence"],
        additionalProperties: false
    }
});

if (result.ok) {
    const findings = result.structured.findings;
}
```

The schema is converted to a TypeBox-compatible tool definition after bounded JSON validation. The tool validates its parameters before the tool executor receives them and terminates the child turn.

### Result acceptance and failure

A successful assignment normally requires a captured structured result.

The current runner also accepts a captured structured result when the provider reports a late request error, provided the assignment was not aborted and the stop reason is not `aborted`. This handles providers that report an error after the model already submitted the final structured payload.

If there is no captured structured result:

- A provider or session error returns `ok: false` with an error message.
- A normal completion without `structured_output` returns `ok: false` with a structured-result contract error.
- An abort returns `ok: false` with `aborted: true`.

The Summary is intentionally different. It is a direct text completion with no tools and does not use `structured_output`.

---

## 12. Fallback model behavior

Worker model routing and fallback configuration live in `workflows.json`.

```json
{
    "summaryModel": "provider/model-id",
    "summaryThinking": "high",
    "routes": {
        "small": {
            "model": "provider/fast-model",
            "thinking": "low",
            "fallbackRoutes": ["medium"]
        },
        "medium": {
            "model": "provider/strong-model",
            "thinking": "medium"
        }
    },
    "routeConcurrency": {
        "small": 16,
        "medium": 8
    },
    "limits": {
        "maxConcurrency": 16,
        "maxWorkersPerRun": 1000,
        "maxCompletionAttemptsPerWorker": 3
    },
    "fallbackModels": ["provider/backup-model"]
}
```

A profile or route can define logical `fallbackRoutes`. The settings-level `fallbackModels` list provides exact model fallbacks when configured route fallbacks are exhausted. `maxCompletionAttemptsPerWorker` is separate from the 1,000-Worker run budget. All fallback candidates are resolved and validated before the same-session continuation is attempted.

### Current implementation gap

The current runner only changes a Worker model before meaningful tool activity starts. The approved target behavior extends this to the narrow completion-repair path:

- The run must not be aborted.
- The existing Worker session must still be available.
- The profile and tool set must remain unchanged.
- The runtime must be retrying completion, not replaying the whole task.
- The fallback route or exact model must resolve through Pi's model registry.

A fallback changes the model on the existing child session and asks it to continue the unfinished task and submit `structured_output`. It never creates a new session or restarts the original prompt.

### Summary fallback

The Summary uses direct completion and loops through the primary model followed by configured fallback models sequentially.

It tries the next model when the previous request:

- Throws.
- Reports a provider error.
- Returns no text.

It stops for an abort. The final error is retained if every model fails.

### Approved Worker completion policy

This is the approved target behavior. It is not implemented yet.

The Worker must finish through the structured-output tool. A Worker is never considered successful merely because it produced some assistant text. The required sequence is:

1. The primary model performs the assignment and calls `structured_output` as its final action.
2. If the assignment has not produced a valid structured result, the runtime asks the same child session to finish the assignment and call `structured_output` again.
3. If the same-session repair still fails, the runtime switches the existing child session to the next configured fallback model and asks that session to continue and submit the structured result.
4. Each fallback attempt keeps the existing session, conversation history, tool history, working directory, and task state. It does not create a new task or restart the original prompt from the beginning.
5. The Worker succeeds only after a schema-valid structured payload is captured. If all bounded attempts fail, the Worker returns an error and is not reported as successful.

The retry prompt must be completion-focused. It should tell the model to continue any unfinished work in the existing session and call `structured_output` when complete. It must not ask the fallback model to repeat the whole assignment from scratch.

The runtime must stop immediately for an abort. It must also stop and report an error when the existing child session is lost or cannot safely continue. The retry loop must be bounded, so a provider or model that never submits the tool cannot hold the workflow forever.

In this design, “error free” means that the extension never silently accepts an incomplete or unstructured Worker result. Schema validation proves the result has the required shape, but it does not prove the task's semantic correctness. Semantic correctness requires the task prompt, tests, or a later verification step.

The design intentionally does not include prose JSON extraction. If the model cannot submit a valid `structured_output` payload after same-session repair and same-session fallback attempts, the Worker fails visibly.

---

## 13. Summary phase design

The Summary is a first-class record in every run.

### Inputs

`collectPreviousPhaseResults()` selects the latest phase represented by non-Summary Worker Records. The Summary prompt contains:

- The selected phase name.
- Each assignment label.
- Each assignment state.
- The structured result when available.
- The error when the assignment failed.

The Summary receives the immediately preceding phase, not an unrestricted view of every earlier phase. Scripts that need earlier information must carry it forward through later Worker assignments or include it in a later phase's prompt.

### Execution

`runWorkflowSummary()` bypasses the normal Worker session and calls `completeSimple()` directly. It supplies:

- The dedicated Summary system prompt.
- The previous-phase source data as a user message.
- The selected model.
- The configured thinking level.
- The parent context cap.
- No tools.
- No child profile.
- No structured-output tool.

The Summary output is plain assistant text and becomes `WorkflowDetails.result`. The Summary Worker is a lifecycle record for this direct completion request, not a profile-defined Worker session.

### Failure behavior

The Summary can fail even when all Workers succeeded. In that case:

- The Summary record is marked as an error.
- The run is marked failed.
- Completed Worker records remain persisted and inspectable.
- The error is shown in the workflow result and dashboard.

A script or sandbox failure still leads to a Summary attempt unless the run was aborted. This allows the Summary to report partial work and failures.

---

## 14. Run state and persistence

### In-memory live state

The extension keeps active runs in an `activeRuns` map. Each entry contains:

- `WorkflowDetails`.
- `RunController`.
- Live child sessions by Worker index.
- Abort controllers by Worker index.
- The completion Promise.

The tool renderer and dashboard use this live object while a run is active.

### Artifact layout

All durable workflow data is stored under a Pi-style encoded working-directory folder. No workflow data is stored under Pi's global session folder.

```text
~/.pi/agent/workflows/
├── library/                                  # global user workflows
└── --C-Users-niel-.pi-agent--/
    ├── project.json
    ├── library/                              # project workflows
    ├── 2026-08-16T14-32-10-123Z_worker-migration/
    │   ├── workflow.json             # atomic current snapshot and manifest
    │   ├── script.js
    │   ├── args.json                 # only when args was supplied
    │   ├── events.jsonl              # workflow lifecycle journal
    │   ├── lease.json                # ownership and heartbeat
    │   ├── backups/
    │   ├── workers/
    │   │   └── 001/
    │   │       ├── worker.json       # assignment state and metadata
    │   │       ├── transcript.jsonl  # Pi-compatible session JSONL
    │   │       ├── result.json       # schema-valid structured result
    │   │       ├── usage.json        # provider usage and cost data
    │   │       ├── worktree.json     # isolation metadata when enabled
    │   │       ├── worktree/         # dedicated Git checkout when enabled
    │   │       └── diff.patch        # captured changes before cleanup
    │   ├── summary/
    │   │   ├── worker.json
    │   │   ├── transcript.jsonl
    │   │   ├── result.txt
    │   │   └── usage.json
    │   └── reports/
    └── 2026-08-16T15-08-44-991Z_context-review/
        └── ...
```

The project folder name is exactly Pi's encoded canonical working directory. `project.json` stores the original canonical path and display metadata. Run folders use a timestamp and workflow slug for human-readable navigation. The internal run ID remains in `workflow.json` and is not required in the folder name.

`workflow.json` is the compact inspectable snapshot. `events.jsonl` is the append-only workflow journal for lifecycle transitions, Worker state changes, leases, retries, and recovery decisions. Worker `transcript.jsonl` files use Pi's native session-entry schema. This combines local folder inspection and atomic snapshots with Pi's transcript format and durable manager metadata.

A run can be understood without an in-memory manager, a database, or any file under `~/.pi/agent/sessions/`.

### Checkpointing

`createWorkflowPersistence()` coalesces snapshot checkpoints with a default 500 ms interval. Important transitions append an event to `events.jsonl` and flush the snapshot immediately, including:

- Run creation and lease acquisition.
- Worker record creation and queue admission.
- Worker start, completion, error, abort, and retry transitions.
- Summary start and completion.
- Lease renewal and recovery decisions.
- Final run completion.

The final flush is synchronous. Snapshot writes use atomic same-directory replacement, bounded serialization, and bounded backups. Journal appends are ordered and fsynced when the platform permits it. A partial snapshot never replaces the last valid snapshot.

### Recovery

A workflow manager scans `~/.pi/agent/workflows/` by encoded project directory and run folder, not by Parent Session history or Pi's global session directory. It validates `workflow.json`, replays `events.jsonl` after the snapshot sequence, checks the lease, and reconstructs Worker records from their workflow-owned files.

A stale lease is recovered only after its heartbeat timeout. Completed Workers remain completed and are never scheduled again. Waiting Workers may resume from the recorded queue position. A Worker that was active when ownership was lost is marked `interrupted` and requires an explicit recovery decision; the manager never guesses that an external side effect did or did not happen.

The `/wf` dashboard exposes this action as **Continue run**. Continue run:

1. Acquires the workflow lease.
2. Loads `workflow.json` and replays `events.jsonl`.
3. Skips completed Workers and preserves their results.
4. Continues waiting Workers from the recorded queue.
5. Reopens an interrupted Worker's existing Pi-compatible `transcript.jsonl` as the same logical Worker session.
6. Never creates a duplicate Worker record or silently replays an unknown side effect.
7. Records every recovery decision in `events.jsonl` before more provider work starts.

If the journal proves that the last provider turn and tool result were committed, the Worker can continue from that persisted session. If a tool started without a durable result, Continue run stops at that Worker and asks for an explicit recovery decision instead of guessing whether the side effect happened.

Same-session completion fallback remains available while the original runtime session is alive. After process loss, reopening the workflow-owned Pi JSONL preserves the Worker conversation and logical identity, but it does not pretend that an uncommitted provider request completed.

### Session shutdown

On `session_shutdown`, the extension:

1. Stops admitting new Workers.
2. Records a shutdown event in `events.jsonl` and releases or expires the run lease.
3. Aborts active runtime sessions.
4. Marks affected runs and Workers as `interrupted`, unless the user explicitly aborted them.
5. Flushes Worker JSONL files, the journal, and the final snapshot.
6. Clears the workflow activity status.

The workflow run folder remains available to another Pi process for **Continue run** or inspection. Background work is no longer dependent on a nested Pi session folder.

---

## 15. Workflow data model

The main persisted shape is `WorkflowDetails`:

```ts
interface WorkflowDetails {
    runId: string;
    parentSessionId?: string; // correlation only, not a persistence location
    projectCwd: string; // canonical working directory
    projectDir: string; // encoded Pi-style folder name
    artifactDir: string; // human-readable run folder
    source?: {
        kind: "inline" | "builtin" | "global" | "project";
        name?: string;
        path?: string;
        version?: string;
        hash?: string;
    };
    name?: string;
    description?: string;
    background: boolean;
    status: "running" | "completed" | "failed" | "aborted" | "interrupted";
    startedAt: number;
    finishedAt?: number;
    phases: Array<{ title: string; detail?: string }>;
    currentPhase?: string;
    workers: WorkerRecord[];
    result?: unknown;
    error?: string;
}
```

Each `WorkerRecord` contains:

```ts
interface WorkerRecord {
    index: number;
    label: string;
    phase?: string;
    state: "waiting" | "running" | "done" | "error" | "interrupted";
    profile?: string;
    route?: string;
    provider?: string;
    model?: string;
    sessionId?: string; // active runtime session ID
    sessionFile?: string; // workflow-owned workers/<index>/transcript.jsonl
    isolation?: "shared" | "worktree";
    cwd?: string;
    worktreePath?: string;
    baseCommit?: string;
    changedFiles?: string[];
    diffPath?: string;
    systemPrompt?: string;
    contextWindow?: number;
    startedAt: number;
    finishedAt?: number;
    error?: string;
    preview: string;
    result?: unknown;
    usage: WorkerUsage;
    transcript: TranscriptEntry[];
}
```

The Summary is represented by the same `WorkerRecord` shape. Its profile is `summary`, its phase is `Summary`, and its transcript contains the Summary source prompt and final text when successful.

---

## 16. Failure and cancellation semantics

### Individual assignment failure

`runWorker()` is designed to settle into a `WorkerOutcome` rather than throw a provider or session failure into the workflow script. The parent converts the outcome into the script envelope.

An individual failure:

- Marks the Worker Record as `error`.
- Includes an error string.
- Leaves the rest of the workflow script in control.
- Is included in the Summary source data.

The script may choose to continue, stop by throwing, or launch a later recovery assignment.

### Script failure

A script can fail because of:

- Invalid source or metadata.
- Sandbox protocol violation.
- Source, argument, result, or request limits.
- An unawaited or unsettled Worker request.
- A thrown runtime error in the workflow script.

The run becomes failed, but the Summary is attempted unless the controller was aborted.

### User abort

The `/wf` dashboard can abort a running workflow or an individual active child assignment. The corresponding AbortSignal reaches the child session and sandbox cleanup.

Aborted runs are distinct from failed and interrupted runs in the persisted status. Aborted work is not continued automatically. An interrupted run may be continued through the recovery policy described in the persistence section.

### Process interruption and Continue run

A process shutdown, lost lease, or provider runtime loss marks active work as `interrupted`, not `aborted`. The run remains inspectable and eligible for **Continue run**. Continue run reopens the workflow-owned Pi JSONL for each eligible Worker, preserves completed results, and never silently repeats a Worker whose last side effect is unknown.

### Tool timeout

A child tool call that exceeds three minutes is aborted with a tool-specific timeout error. The assignment then settles as failed unless the parent abort path supersedes it.

There is no single configured wall-clock timeout for the entire workflow sandbox. The controller waits for task settlement and applies an eight-second cleanup deadline at run shutdown.

### Persistence failure

If the final artifact flush fails, the run is changed to failed and the persistence error is surfaced. Live UI rendering remains best effort and must not hide the final persistence failure.

---

## 17. User interface and delivery surfaces

The UI is a projection of the same `WorkflowDetails` state used by the runner and persistence layer.

### Inline workflow tool card

The workflow tool renderer displays:

- Name and description.
- Run status.
- Settled Worker count.
- Elapsed time.
- Current phase.
- Per-Worker state.
- Model and context utilization.
- Usage and cost when available.
- Previews and errors.
- Structured result data when expanded.

Live blocking updates are throttled to 500 ms. Background cards use live state invalidation while the run remains active.

### Background delivery

A background run immediately returns a launch message containing the run ID and artifact directory. When the run settles, the extension sends a follow-up custom message containing:

- Run status.
- Worker counts.
- Phase and Worker report.
- Errors.
- Artifact directory.
- Final result when available.

The parent session may trigger another turn after receiving the follow-up. Delivery failures during shutdown are caught so cleanup is not blocked by UI state.

### Activity indicator

The parent status area shows counts of running, completed, failed, and interrupted workflows until `/wf` acknowledges the settled counts.

### `/wf` dashboard

The dashboard provides:

- Run list filtered to the current project's encoded working-directory folder, with optional cross-project navigation.
- Run status and phase progress.
- **Continue run** for interrupted or recoverable runs.
- Worker selection.
- Worker transcript inspection.
- Tool-call and tool-result display.
- Thinking visibility toggle.
- System-prompt visibility toggle.
- Copy transcript.
- Copy the workflow artifact path.
- Inspect, retain, discard, or explicitly apply a Worker's captured worktree diff.
- Save a Markdown report.
- Abort an active child.
- Abort a running workflow.
- Summary model and thinking settings.
- Alternate terminal-screen support in regular TUI mode.
- Fullscreen viewport compatibility.
- Mouse-wheel transcript scrolling.

The dashboard reads live records when a run is active and reloads `workflow.json`, workflow-owned JSONL transcripts, Worker artifacts, and recovery journal entries for recovered runs.

### Observability contract

Observability is a projection of durable workflow state, not a separate opaque logging system. Live UI state and recovered UI state use the same snapshot, journal, Worker records, and Pi-compatible transcripts.

The run view shows:

- Canonical project path and human-readable workflow artifact folder.
- Workflow name, start time, elapsed time, and status.
- Current phase and phase progress.
- Completed, running, waiting, failed, and interrupted Worker counts.
- Global and route-specific concurrency usage.
- Lease owner, heartbeat, and recovery state.
- **Continue run** when the run is interrupted or recoverable.

The Worker view shows:

- Label, task prompt, phase, profile, route, provider, and model.
- Isolation mode, working directory, base commit, worktree path, changed files, and diff.
- State, queue time, start time, finish time, and duration.
- Retry attempts, repair prompts, fallback routes, and fallback models.
- Input, output, cache, total tokens, cost, and context-window utilization.
- Tool calls, tool arguments, tool results, and tool errors.
- The full Pi-compatible `transcript.jsonl` path and transcript contents.
- Structured result, bounded preview, and failure details.

`events.jsonl` provides the durable timeline. Each event has a sequence number, timestamp, run ID, optional Worker index, optional phase, event type, and bounded event data. Target event types include:

```text
run_started
phase_started
worker_queued
worker_started
worker_tool_call
worker_tool_result
worker_retry
worker_fallback
worker_completed
worker_failed
worker_interrupted
continue_run_started
continue_run_decision
summary_started
summary_completed
run_completed
run_failed
```

Live updates use the same event model as recovered runs. The UI may throttle rendering, but it must not drop durable state transitions. Full transcripts remain in `transcript.jsonl`; the timeline stores bounded metadata and pointers so `events.jsonl` stays inspectable.

A recovery view must show the last durable event, lease status, stop reason, unresolved side-effect warning, and the exact decision required before more provider work can start.

### `/workers` profile editor

The profile editor can:

- List built-in, global, and project profiles.
- Enable or disable profiles.
- Create a profile.
- Edit profile metadata.
- Edit the profile system prompt.
- Select tools.
- Select default route, exact model, and thinking values.
- Configure fallback routes and exact fallback models.
- Save profiles to the global Pi profile directory.
- Delete user-created profile files.

`structured_output` remains locked into the Workflow Worker tool policy. Recursive workflow and interactive-question tools remain disabled.

---

## 18. Settings and configuration

Workflow settings are stored at:

```text
~/.pi/agent/.ext-config/workflows.json
```

Current settings are:

| Setting            | Meaning                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `summaryModel`     | Provider/model identifier for the final Summary. Omitted means the active Parent Session model.                   |
| `summaryThinking`  | Thinking level for the Summary. Omitted means the active level.                                                   |
| `routes`           | Named logical model routes. Each route resolves to a provider/model and may define thinking and fallback routes.  |
| `routeConcurrency` | Maximum active Workers for each route, bounded by the global concurrency limit.                                   |
| `limits`           | Default scale and completion-attempt limits: 16 active Workers, 1,000 regular Workers, and 3 attempts per Worker. |
| `fallbackModels`   | Ordered exact provider/model identifiers used when route fallbacks are exhausted, plus Summary retries.           |

The `/wf` settings view can select the Summary model, Summary thinking level, model routes, and fallback models. Model pickers read from the active model registry.

Worker profiles are stored in the normal Pi profile locations. The editor writes global profiles under the active Pi profile directory and removes project copies when saving a global profile.

---

## 19. Module responsibilities

| Module                                  | Responsibility                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                              | Extension registration, workflow tool and library command handlers, run lifecycle, records, background delivery, settings UI, and command wiring.                                                                           |
| `runner.ts`                             | Workflow Worker session creation, profile, route and isolation resolution, Git worktree lifecycle, structured output, context caps, progress, transcripts, same-session fallback behavior, Summary completion, and cleanup. |
| `sandbox.ts`                            | Parent-side sandbox process startup, IPC authentication, validation, byte limits, abort handling, and termination.                                                                                                          |
| `sandbox-child.cjs`                     | Restricted VM bootstrap, DSL implementation, pending-request tracking, and child-side IPC bridge.                                                                                                                           |
| `controller.ts`                         | Semaphore, maximum call budget, run signals, invocation signals, and bounded settlement.                                                                                                                                    |
| `artifacts.ts`                          | Workflow-folder persistence, coalesced snapshots, atomic flushes, `events.jsonl` journaling, backups, leases, and recovery transformation.                                                                                  |
| `model.ts`                              | Workflow and Worker state types, usage aggregation, phase grouping, formatting, and result bounding for display.                                                                                                            |
| `meta.ts`                               | Static Acorn parsing, literal-only metadata decoding, metadata sanitization, phase route defaults, reusable-source metadata, and executable-source preparation.                                                             |
| `prompt.ts`                             | Workflow tool guidance, Worker profile and route guidance, Summary prompt, Summary record, phase result collection, and rendered reports.                                                                                   |
| `settings.ts`                           | Summary model, thinking-level, logical route, and fallback-model configuration.                                                                                                                                             |
| `dashboard.ts`                          | Run loading, observability views, recovery display, Continue run, transcript/timeline loading, fullscreen/alternate-screen TUI, report/copy actions, and live run navigation.                                               |
| `agents-panel.ts`                       | Worker profile list, profile editing, profile creation, tool selection, and profile persistence interactions. The filename is a legacy storage name pending migration.                                                      |
| `activity-status.ts`                    | Compact parent-session activity indicator formatting.                                                                                                                                                                       |
| `context-utilization.ts`                | Shared context occupancy formatting.                                                                                                                                                                                        |
| `serialization.ts`                      | Re-export of bounded serialization helpers used at the workflow boundary.                                                                                                                                                   |
| `tool-call-timeout.ts`                  | Re-export of shared child tool timeout helpers.                                                                                                                                                                             |
| `child-session.ts`                      | Re-export of shared child-session resource helpers.                                                                                                                                                                         |
| `extensions/shared/child-session.ts`    | No-extension child resource creation, trust, workflow-owned session directory selection, tool denylist, and bounded shutdown.                                                                                               |
| `extensions/shared/agent-profiles.ts`   | Built-in Worker profiles, profile file loading, merge precedence, serialization, saving, and deletion. The filename remains a legacy compatibility path.                                                                    |
| `extensions/shared/model-resolution.ts` | Exact model and logical route selection, registry validation, fallback resolution, and Parent Session model inheritance.                                                                                                    |
| `extensions/shared/compaction.ts`       | Child auto-compaction policy and retry-aware completion state.                                                                                                                                                              |
| `extensions/shared/timeouts.ts`         | Three-minute per-tool timeout guard.                                                                                                                                                                                        |
| `extensions/shared/serialization.ts`    | Inert JSON conversion, truncation, and atomic file replacement.                                                                                                                                                             |
| `extensions/shared/usage.ts`            | Provider usage aggregation for child sessions.                                                                                                                                                                              |
| `extensions/shared/transcript.ts`       | Generic bounded transcript helper used by shared infrastructure.                                                                                                                                                            |

---

## 20. Core invariants

The target design relies on these invariants.

1. **The active Parent process owns execution.** The sandbox and Workflow Workers cannot mutate live or durable run state directly; durable recovery state belongs to the workflow folder.
2. **The sandbox has a narrow capability surface.** It can report phases and request Workers, but it cannot access host resources directly.
3. **Every Worker Assignment has a bounded record.** A Worker Record is created before the child session starts and is updated through completion or cleanup.
4. **The Summary Worker record is always present.** It is created at run start and remains the final record.
5. **There are at most 1,000 regular Workers by default.** The Summary is a separate final synthesis and is not deducted from that regular-Worker budget.
6. **At most 16 Workers execute concurrently by default.** This is enforced both in the sandbox DSL and the parent controller.
7. **Workflow Workers do not inherit ambient extensions.** Child resource loaders use `noExtensions: true`.
8. **Workflow Workers cannot recursively orchestrate.** `workflow` and interactive `ask_user` tools are excluded.
9. **A successful Worker has a structured result.** The default result is `{ output: string }`; custom schemas define custom machine-readable data.
10. **Late structured payloads are not discarded automatically.** A captured result may be accepted after a late provider error unless the Worker was aborted.
11. **Worker fallback preserves the session.** A fallback changes only the model route and never restarts the whole task.
12. **Worker retries have a separate completion budget.** Retry attempts do not increase the logical Worker count.
13. **A Worker never succeeds without a schema-valid structured payload.** Prose JSON extraction is not part of the design.
14. **The Summary is plain text.** It has no tools and does not use the structured-output protocol.
15. **Persistence is workflow-folder canonical.** Snapshots, workflow journals, Pi-compatible Worker JSONL, leases, and backups live under the encoded project folder, never under Pi's global session directory.
16. **Continue run preserves logical Worker identity.** It skips completed Workers, reopens eligible persisted Worker JSONL, and never silently duplicates an unknown side effect.
17. **Cleanup is bounded and idempotent.** Child sessions, controller tasks, and sandbox processes have explicit shutdown paths.
18. **Observability is replayable.** Every durable lifecycle transition has an ordered `events.jsonl` entry, and live and recovered views use the same persisted state.
19. **Reusable source has no extra authority.** Built-in, global, project, and inline workflows use the same sandbox, Worker policy, structured-result contract, persistence, and Summary path.
20. **Editing Workers are isolated by default.** A worktree Worker cannot modify the parent working directory, and parallel editing Workers never share a checkout.

---

## 21. Current limits and known gaps

These are current limitations, not implemented features.

### No Continue run implementation

The design now defines journal replay and **Continue run**, but the current extension still marks recovered runs aborted. Completed assignments are visible, but the source does not yet reopen Worker JSONL or continue only unfinished assignments.

### No durable workflow manager

Run ownership lives in the extension instance and `activeRuns`. The artifact directory is a compact audit record, not a cross-process lease or job manager.

### No pause state

The dashboard supports abort. It does not pause a run and later continue it.

### Current concurrency implementation gap

The approved default is 16 concurrent Workers and 1,000 regular Workers per run. The current source still uses the older fixed four-Worker concurrency and 31-regular-Worker budget, with a separate Summary record. The implementation must migrate to the bounded 16-slot queue and 1,000-Worker regular budget.

### Target routing is not implemented yet

The target design allows a Worker to select a logical route or an exact model while the profile continues to define the Worker type. The current implementation still exposes only profile-based selection and must be migrated to the route precedence described in the Worker design.

### No worktree isolation implementation

The target design gives editing profiles dedicated Git worktrees under each Worker artifact directory. The current source still uses the parent working directory for every Worker and has no worktree creation, diff capture, apply, retain, or cleanup flow.

### No built-in quality primitives

The current DSL has no first-class `verify()`, `judgePanel()`, `gate()`, or `retry()` helper. The target design defines these helpers and the built-in workflow catalog, but the source still requires authors to build the patterns manually with `worker()` and `parallel()`.

### No reusable workflow library

The current extension has no global or project workflow library, `/workflows` browser, source precedence, or source snapshot metadata. The target design adds project-over-global-over-built-in resolution and records the selected source hash in `workflow.json`.

### Summary is a separate failure surface

The Workers can all complete while the direct Summary request fails. The Worker results remain available, but the run is still marked failed until a future retry or manual inspection path is added.

### Same-session fallback and retry budget are target behaviors

The current runner only changes Worker models before tool activity starts. The target Worker completion policy allows a bounded fallback after structured-output failure, but only by reusing the existing child session. It must ask the fallback model to finish or submit `structured_output`; it must not replay the complete task. If the runtime cannot establish that same-session continuation is safe, it must fail visibly instead of guessing.

### Background runs are session-bound

A background run continues after its tool invocation returns, but session shutdown aborts active runs. The extension does not maintain a daemon manager that continues work after Pi exits.

### Current artifact scope is session-oriented

The current dashboard filters persisted runs to the current Parent Session or runs referenced in its session history. The target dashboard scans the encoded project folder under `~/.pi/agent/workflows/` and can navigate runs across Parent Session restarts.

### Error taxonomy is mostly string-based

The script contract exposes `ok` and an error string. The extension does not currently expose a stable public error-code enum for timeout, provider usage limits, schema failure, persistence failure, and other categories.

### Whole-workflow deadline is absent

Child tool calls have a three-minute timeout, and shutdown settlement has an eight-second deadline. There is no configured maximum duration for a full workflow or for a model request independent of provider behavior.

---

## 22. Testing and verification

Workflow behavior is covered by local Node test files under the repository's gitignored `tests/` directory. The tests use native `node:test` and import the extension modules through the repository's runtime setup.

Current workflow-focused test areas include:

- Abort rendering.
- Worker profile panel state and persistence.
- Child tool filtering.
- `/wf` command behavior.
- Clipboard/report rendering.
- Observability timeline and Worker detail rendering.
- Continue run and recovery state rendering.
- Git worktree creation, diff capture, and cleanup rendering.
- Model resolution and context inheritance.
- Sandbox profile behavior.
- Profile loading from disk.
- Recovery behavior.
- Serialization bounds.
- Shared helpers.
- Built-in quality helpers and reusable-source resolution.
- Summary behavior and fallback models.
- System-prompt capture.
- Transcript and usage rendering.
- TUI viewport behavior.
- Background tool rendering.

The repository verification order for code changes is:

```text
pnpm lint
pnpm typecheck
pnpm fmt
```

The workflow scratch tests can be run directly, for example:

```text
node --test tests/workflows-fallback.mjs tests/workflows-summary.mjs tests/workflows-tool-render.mjs
```

The `tests/` files are intentionally scratch verification artifacts for this repository workflow and are not part of the extension package distribution.

---

## 23. Design decisions

### Separate orchestration process

The workflow script is model-authored and therefore receives a separate process boundary instead of executing directly inside the parent extension runtime. The VM adds deterministic restrictions, but the process and Node permission boundary are the primary isolation mechanism.

### No ambient child extensions

Loading every host extension into every Workflow Worker would make behavior depend on unrelated installed extensions and could introduce recursive tools or long-lived listeners. Child sessions therefore use `noExtensions: true` and receive only the intended profile tools plus the structured output tool.

### Structured work results, plain Summary

Work phases need machine-readable data so later phases and the final Summary can consume bounded, explicit results. The final Summary is a writing step, so its public result is plain text and it has no tools.

### Worktree isolation for editing

Editing-capable Workers use dedicated Git worktrees by default. This protects the parent working directory and prevents parallel Workers from overwriting one another. The workflow captures diffs and status before cleanup, and only an explicit user action can apply changes to the parent project.

### No-throw assignment contract

An individual assignment failure should not destroy the orchestration script's ability to report partial work. `worker()` returns an envelope with `ok` and `error`, allowing the script to decide whether to continue or stop.

### Built-ins and reuse are ordinary workflows

Built-in and saved workflows are source selection features, not new execution modes. They use the same static metadata parser, sandbox process, Worker profiles, model routes, structured results, persistence, observability, and Summary phase as inline scripts. Project and global libraries improve discovery and reuse without granting library authors extra capabilities.

### Reserve Summary capacity

The final synthesis is part of the workflow contract. Reserving one call prevents a workflow that uses the full Worker budget from silently skipping synthesis.

### Artifact-first inspection

Every run writes its source, arguments, status, and result metadata to a predictable directory. This keeps failures inspectable even when the TUI is unavailable or the parent session ends.

### Same-session side-effect fallback

Changing models after a child has begun tool activity must not repeat writes or other side effects. The target fallback changes the model on the existing Worker session and asks it to finish the current task. It never creates a second Worker to replay the assignment.

---

## 24. Future implementation and evolution boundaries

The following target behaviors are not implemented in code yet. Same-session completion, profile-defined Worker types, and flexible model routes are approved design work. The remaining items are future extensions beyond this design:

1. A journal and resumable run manager while preserving compatibility with existing `wf_*` artifacts.
2. Stable typed error codes while retaining the script-level `{ ok, output, structured, error }` contract.
3. Same-session structured-output repair, fallback-model continuation, and explicit completion-attempt accounting.
4. Per-Worker timeout, retry, budget, and explicit route options.
5. Phase-level model routing and model tiers.
6. Git worktree isolation for editing assignments, including diff capture, cleanup, retain, and user-controlled apply actions.
7. First-class verification and review helpers plus the built-in workflow catalog, all built on the existing structured result protocol.
8. A manager-backed control tool for pause, Continue run, status, and stop.
9. Project and global saved workflow scripts with `/workflows` browsing and source precedence.

Those additions should preserve the current core properties:

- The orchestration process remains isolated.
- Child sessions remain extension-free by default.
- The Parent Session remains the lifecycle owner.
- Worker side effects are not silently duplicated by retries.
- Structured work results remain available for machine processing.
- The final Summary remains visible as a distinct phase.

---

## 25. Related documentation

- [Workflow README](../README.md)
- [Repository architecture context](../../../CONTEXT.md)
- [Run controller](../controller.ts)
- [Workflow runner](../runner.ts)
- [Sandbox bridge](../sandbox.ts)
- [Sandbox child](../sandbox-child.cjs)
- [Workflow tool and lifecycle](../index.ts)
- [Workflow model](../model.ts)
- [Workflow persistence](../artifacts.ts)
- [Workflow dashboard](../dashboard.ts)
- [Profile implementation](../../shared/agent-profiles.ts)
- [Child session implementation](../../shared/child-session.ts)
