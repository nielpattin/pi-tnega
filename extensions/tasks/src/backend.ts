/**
 * The unified backend interface: `TaskBackend` for the pi agent runtime,
 * producing `TaskSession`.
 */

import type { Effect, Scope, Stream } from "effect";
import { Context } from "effect";
import type { BackendName, SendError, SpawnError, SpawnTask, TaskEvent, TaskMeta } from "./domain.ts";

export interface BackendCapabilities {
   /** Can send() steer a live run (vs. only starting a fresh run when idle). */
   readonly steering: boolean;
   readonly modelSelection: boolean;
   readonly reasoningEffort: boolean;
}

/**
 * A live task session. The manager is the single consumer of `events`;
 * it folds them into the `TaskSnapshot` everything else reads.
 */
export interface TaskSession {
   /** Current metadata snapshot. Updates also arrive as MetaChanged events. */
   readonly meta: Effect.Effect<TaskMeta>;
   /**
    * All activity, normalized. Ends when the session's scope closes. Every
    * run started within the session terminates with a RunSettled event.
    */
   readonly events: Stream.Stream<TaskEvent>;
   /**
    * Steer the active run, or start a fresh run when idle (v1 `manager.send`
    * semantics — the "is a run active" decision is backend-native state).
    */
   send(text: string): Effect.Effect<void, SendError>;
   /**
    * Interrupt the active run. Resolves once the backend acknowledges; the
    * corresponding RunSettled(Interrupted) arrives on `events`. Callers bound
    * this with a timeout and fall back to closing the session scope.
    */
   readonly interrupt: Effect.Effect<void>;
   /**
    * Pop the most recently queued steer/follow-up and return its text.
    * Returns undefined if nothing queued or backend has no queue.
    * Emits QueueChanged with remaining items.
    */
   popLastQueued(): Effect.Effect<string | undefined>;
}

export interface TaskBackend {
   readonly name: BackendName;
   readonly capabilities: BackendCapabilities;
   /** Probe availability (binary on PATH, SDK importable, credentials). */
   readonly available: Effect.Effect<boolean>;
   /**
    * Spawn a session. Scoped: closing the scope interrupts/kills the
    * underlying session or process and ends `events`. Fire-and-forget
    * semantics (background fibers, result delivery) live in the manager.
    */
   spawn(task: SpawnTask): Effect.Effect<TaskSession, SpawnError, Scope.Scope>;
}

/** Registry of all wired backends, keyed by name. */
export class BackendRegistry extends Context.Service<BackendRegistry, ReadonlyMap<BackendName, TaskBackend>>()(
   "tasks/BackendRegistry"
) {}
