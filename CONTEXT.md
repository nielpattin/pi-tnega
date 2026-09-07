# Delegated work domain glossary

This context defines the canonical language for delegated work in this repository. Prefer these terms in code, tests, documentation, and agent prompts.

## Sessions and ownership

**Session**:
A Pi conversation and its retained history. A Parent Session and an Agent Session have different ownership and execution roles.

**Parent Session**:
The interactive Pi conversation that starts work and receives outcomes. It owns one or more direct Tasks.
_Avoid_: Controller, manager, current session

**Owner Session**:
The session responsible for a Task's lifecycle and result delivery. It is usually the Parent Session, but the term makes ownership explicit when discussing a Task independently.
_Avoid_: Agent Session

**Agent Session**:
An isolated Pi conversation in which an agent performs delegated work. A recoverable Task resumes its existing Agent Session instead of creating a replacement.
_Avoid_: Child worker, worker process

## Agents and tasks

**Agent**:
A delegated executor selected through an Agent Profile and run in an Agent Session. An agent is not the Task it performs or the Session in which it runs.
_Avoid_: Worker as a system noun. The literal profile name `worker` is a valid Agent Profile.

**Agent Profile**:
A named role and capability definition for an agent. It determines the agent's instructions, permitted tools, model preferences, and thinking level. The built-in profiles are `worker`, `planner`, `explorer`, `critic`, `gatekeeper`, and `librarian`.
_Avoid_: Worker type, agent type when the profile is meant

**Task**:
One tracked request for a direct agent. It has an identity, an Owner Session, an Agent Profile, a lifecycle state, and an eventual result or error.
_Avoid_: Job, assignment, process

**Agent Specification**:
The request that describes one proposed Task before the system accepts and tracks it. It includes the work prompt, display name, and Agent Profile.
_Avoid_: Task result

**Agent Batch**:
A group of Agent Specifications submitted together. Each specification becomes its own Task; the batch is not one combined Task.
_Avoid_: Worker batch

**Result Delivery**:
The presentation of a settled Task outcome to the Parent Session, either in the tool result or as an `agents-result` message for background work.

**Background Task**:
A direct Task whose Owner Session receives a spawn acknowledgement before execution settles. Its settled result is sent to the Owner Session automatically.
_Avoid_: Detached task

**Parent Delivery**:
The automatic presentation of a settled Background Task result to its Owner Session. Delivery is an interaction outcome, not a Task lifecycle state.
_Avoid_: Completion, delivered status

## Task lifecycle

**Pending**:
The Task has been accepted and tracked, but its agent has not started.

**Spawned**:
An acknowledgement that work was accepted and handed off. Spawned is not a persisted Task lifecycle state.

**Running**:
The agent is actively performing the Task in its Agent Session.

**Completed**:
The Task reached its intended successful terminal outcome.

**Failed**:
The Task stopped without a successful outcome and is terminal. Work that can continue in the existing Agent Session is represented as Recoverable instead.

**Recoverable**:
The Task stopped while retaining enough Agent Session history to resume in place. It is Settled but not Terminal.

**Cancelled**:
The Task was intentionally stopped before successful completion. It is terminal.

**Settled**:
The Task's active execution has stopped. Completed, Failed, Recoverable, and Cancelled are settled outcomes.

**Terminal**:
The Task will not change state through ordinary execution. Completed, Failed, and Cancelled are terminal; Recoverable is not.

## Boundary concepts

**Process**:
An external command or service supervised independently from agent execution. A Process is not an agent, Task, or Agent Session.
_Avoid_: Worker when referring to an external command or service

**Side Chat**:
An independent conversation used for exploration and explicit handoff to the Parent Session. A Side Chat is not an Agent Session and does not participate in Task ownership.

**Compaction**:
A change to the historical context of a Pi Session. Compaction does not change Task identity or Task lifecycle.

**Session Inspection**:
Reading retained session history or compacted context to understand prior work. Session Inspection is not agent execution or Task recovery.

## Terms to avoid

**Worker**:
Ambiguous as a system noun because one built-in Agent Profile is named `worker`. Use Agent for the delegated executor, Agent Session for its conversation, and Task for the tracked request. Reserve `worker` for the profile name itself.

**Job**:
A legacy label for a tracked Task.

**Assignment**:
An ambiguous label for work. Use Task for direct agent work.

**Workflow**:
A removed orchestration layer. This repository delegates through direct agent Tasks only.

**Paused**:
A removed Task state. Use Recoverable when work stopped but can resume in place.

**Continue**:
An ambiguous recovery action. Use Recover or resume in place when referring to a Recoverable Task.

**Delivered**:
A delivery outcome, not a lifecycle state. Use Completed, Failed, Recoverable, or Cancelled for Task state, and Parent Delivery for automatic result presentation.
