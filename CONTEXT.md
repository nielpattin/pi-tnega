# Delegated work domain glossary

This context defines the canonical language for delegated work in this repository. Prefer these terms in code, tests, documentation, and worker prompts.

## Sessions and ownership

**Session**:
A Pi conversation and its retained history. A Parent Session and a Worker Session have different ownership and execution roles.

**Parent Session**:
The interactive Pi conversation that starts work and receives outcomes. It may own a Workflow Run or one or more direct Tasks.
_Avoid_: Controller, manager, current session

**Owner Session**:
The session responsible for a Task's lifecycle and result delivery. It is usually the Parent Session, but the term makes ownership explicit when discussing a Task independently.
_Avoid_: Worker Session

**Worker Session**:
An isolated Pi conversation in which a Worker performs delegated work. A recoverable Task resumes its existing Worker Session instead of creating a replacement.
_Avoid_: Child worker, worker process

## Workers and tasks

**Worker**:
A delegated executor selected through a Worker Profile and run in a Worker Session. A Worker is not the Task it performs or the Session in which it runs.
_Avoid_: Subagent, child worker, agent as a role noun

**Worker Profile**:
A named role and capability definition for a Worker. It determines the Worker's instructions, permitted tools, model preferences, and thinking level.
_Avoid_: Worker type when the profile is meant

**Task**:
One tracked request for a direct Worker. It has an identity, an Owner Session, a Worker Profile, a lifecycle state, and an eventual result or error.
_Avoid_: Job, assignment, process

**Worker Specification**:
The request that describes one proposed Task before the system accepts and tracks it. It includes the work prompt, display name, and Worker Profile.
_Avoid_: Task result

**Worker Batch**:
A group of Worker Specifications submitted together. Each specification becomes its own Task; the batch is not one combined Task.

**Direct Worker**:
A Worker started outside a Workflow Run. Direct Workers have no Workflow phases or mandatory Summary.
_Avoid_: Standalone job

**Workflow Worker**:
A Worker created by a Workflow Run and associated with one of that run's phases. It is distinct from a Direct Worker even though both use Worker Profiles and Worker Sessions.

**Task Result**:
The terminal output or error associated with a direct Task. It is distinct from progress updates and Parent Delivery.

**Background Task**:
A direct Task whose Owner Session receives a spawn acknowledgement before execution settles. Its settled result is sent to the Owner Session automatically.
_Avoid_: Detached task

**Parent Delivery**:
The automatic presentation of a settled Background Task result to its Owner Session. Delivery is an interaction outcome, not a Task lifecycle state.
_Avoid_: Completion, delivered status

## Workflows

**Workflow**:
A model-authored orchestration that coordinates Workers through named phases and produces a final synthesis. A Workflow is not a Worker Session.
_Avoid_: Job queue, parent worker

**Orchestrator**:
The coordination role that selects phases, delegates Workers, and carries results forward. It is not an additional Worker or a separate owner.
_Avoid_: Controller, manager

**Workflow Run**:
One execution of a Workflow. It owns the run's phases, Workflow Workers, final Summary, lifecycle, and aggregate result.
_Avoid_: Task, direct worker run

**Phase**:
A named stage in a Workflow Run that organizes Workflow Workers and their result handoff. A Phase is not a Task lifecycle state.
_Avoid_: Step when referring to a named workflow stage

**Summary**:
The mandatory final synthesis of a Workflow Run. It receives the preceding work's results and supplies the run's final public text.
_Avoid_: Worker result, report when referring to the final synthesis

**Workflow Result**:
The final text produced by a Workflow Run's Summary. It is distinct from the results of individual Workflow Workers.

## Task lifecycle

**Pending**:
The Task has been accepted and tracked, but its Worker has not started.

**Spawned**:
An acknowledgement that work was accepted and handed off. Spawned is not a persisted Task lifecycle state.

**Running**:
The Worker is actively performing the Task in its Worker Session.

**Completed**:
The Task reached its intended successful terminal outcome.

**Failed**:
The Task stopped without a successful outcome and is terminal. Work that can continue in the existing Worker Session is represented as Recoverable instead.

**Recoverable**:
The Task stopped while retaining enough Worker Session history to resume in place. It is Settled but not Terminal.

**Cancelled**:
The Task was intentionally stopped before successful completion. It is terminal.

**Settled**:
The Task's active execution has stopped. Completed, Failed, Recoverable, and Cancelled are settled outcomes.

**Terminal**:
The Task will not change state through ordinary execution. Completed, Failed, and Cancelled are terminal; Recoverable is not.

## Boundary concepts

**Process**:
An external command or service supervised independently from Worker execution. A Process is not a Worker, Task, or Worker Session.
_Avoid_: Worker when referring to an external command or service

**Side Chat**:
An independent conversation used for exploration and explicit handoff to the Parent Session. A Side Chat is not a Worker Session and does not participate in Task ownership.

**Compaction**:
A change to the historical context of a Pi Session. Compaction does not change Task identity or Task lifecycle.

**Session Inspection**:
Reading retained session history or compacted context to understand prior work. Session Inspection is not Worker execution or Task recovery.

## Terms to avoid

**Agent**:
An ambiguous label for a delegated executor or coordinator. Use Worker for delegated execution and Orchestrator for coordination; retain `agent` only when referring to an existing compatibility or API name.

**Job**:
A legacy label for a tracked Task.

**Assignment**:
An ambiguous label for work. Use Task for direct Worker work and Workflow Worker for work created by a Workflow Run.

**Paused**:
A removed Task state. Use Recoverable when work stopped but can resume in place.

**Continue**:
An ambiguous recovery action. Use Recover or resume in place when referring to a Recoverable Task.

**Delivered**:
A delivery outcome, not a lifecycle state. Use Completed, Failed, Recoverable, or Cancelled for Task state, and Parent Delivery for automatic result presentation.
