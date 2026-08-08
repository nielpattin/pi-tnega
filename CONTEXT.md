# Pi Workers

Pi Workers coordinates delegated agent work, supervised processes, and parent-led worker-session follow-up inside Pi. Its domain separates terminal worker outcomes from externally supervised commands and transcript-based takeover.

## Participants and Work

**Parent session**:
The interactive session that delegates work, receives worker outcomes, and can take over worker sessions.
_Avoid_: controller, manager

**Worker**:
A child agent session responsible for carrying out one delegated assignment.
_Avoid_: subagent, child worker

**Worker assignment**:
A unit of agent work delegated by a parent session. A worker assignment runs independently of the parent and eventually reaches one terminal status.
_Avoid_: background job, process

**Job**:
A Workers-tracked unit of work with an identity, owner, lifecycle, and outcome. Worker assignments and supervised processes are distinct job kinds.
_Avoid_: worker when referring to a supervised process, process when referring to agent work

**Process**:
An external command that Workers supervises independently of worker assignment execution.
_Avoid_: worker when referring to a supervised process

**Harness**:
The execution environment used to run a worker session, such as Pi or Agy.
_Avoid_: agent, worker

## Lifecycle and Outcomes

**Pending**:
The worker assignment or process has been accepted but has not started executing.

**Spawned**:
An immediate worker-tool acknowledgement that a worker job was created and handed off for execution. It is an acknowledgement state, not a lifecycle state used by job inspection.
_Avoid_: running, completed

**Running**:
The worker assignment or process is currently executing.

**Completed**:
The worker assignment or process reached its intended terminal outcome successfully.
_Avoid_: delivered, because delivery is separate from completion

**Failed**:
The worker assignment or process reached a terminal outcome because execution or validation could not succeed.
_Avoid_: cancelled

**Cancelled**:
Execution was intentionally stopped before normal completion.
_Avoid_: failed

**Worker result**:
The terminal outcome submitted by a worker for its assignment. It is separate from progress messages and is delivered once the worker settles.
_Avoid_: update

**Cancellation**:
An intentional request to stop a running or pending job. Cancellation is a lifecycle outcome, not an execution error.

## Completion and Interaction

**Submit**:
The worker's final act of providing a worker result or worker error. Submit is the only terminal worker-result channel.
_Avoid_: progress update, transcript entry

**Parent delivery**:
Automatic presentation of a settled worker result to the parent session after the worker completes.
_Avoid_: polling

**Takeover**:
A parent-led continuation of a worker session through its transcript, used when the parent needs to inspect, steer, or follow up on work.
_Avoid_: worker result, new worker

## Identity and History

**Owner session**:
The parent session that created and owns a job's lifecycle and delivery boundary.
_Avoid_: current session, worker session

**Session**:
A conversation identity for a parent or worker participant. Session identity determines which participant may observe and control a job.
_Avoid_: job, transcript

**Transcript**:
The readable activity history of a worker session, expressed as user messages, tool use, tool results, and assistant messages. A transcript describes how work progressed; it is not the worker result.
_Avoid_: result log, output JSON

**Worker identity**:
The stable Workers identity used to refer to one delegated worker assignment throughout its lifecycle.
_Avoid_: worker name

**Worker name**:
A short human-readable label for a worker assignment. It helps people recognize an assignment but does not identify it uniquely.
_Avoid_: worker ID, agent

## Coordination Modes

**Hub**:
The coordination surface for inspecting jobs and processes and supervising commands according to the participant's permissions.
_Avoid_: worker runner

**Agent profile**:
A named worker capability selected when a worker assignment is delegated. The profile describes how the worker should approach its assignment; it is not the worker's runtime identity.
_Avoid_: worker name, worker ID
