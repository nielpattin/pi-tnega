import { Effect, Layer, ManagedRuntime } from "effect";
import { AgyBackend } from "../../src/backends/agy.js";
import { PiBackend, PI_BACKEND_CAPABILITIES } from "../../src/backends/pi.js";
import { AgentsStore } from "../../src/services/AgentsStore.js";
import { JobRegistry } from "../../src/services/JobRegistry.js";
import { MailBus } from "../../src/services/MailBus.js";
import { ProcessSupervisor } from "../../src/services/ProcessSupervisor.js";
import { SchemaValidator } from "../../src/services/SchemaValidator.js";
import { ShellExecutor } from "../../src/services/ShellExecutor.js";
import { TaskManager } from "../../src/services/TaskManager.js";
import { VibeState } from "../../src/services/VibeState.js";
import { ParentSessionGate } from "../../src/services/ParentSessionGate.js";
import { HarborJobPersistence } from "../../src/services/HarborJobPersistence.js";

export const FakePiBackend = Layer.succeed(
  PiBackend,
  PiBackend.of({
    capabilities: PI_BACKEND_CAPABILITIES,
    spawnSession: async () => ({
      session: {},
      abort: () => Effect.void,
      control: () => Effect.void
    })
  })
);

export const FakeAgyBackend = Layer.succeed(
  AgyBackend,
  AgyBackend.of({
    runOneShot: () => Effect.die("Fake Agy runOneShot is not used"),
    createFsmSession: () => ({
      state: "running" as const,
      pendingFollowUps: [],
      pendingSteerText: undefined,
      start: () => Effect.void,
      control: () => Effect.void,
      abort: () => Effect.void
    })
  })
);

export function makeFakeHarborRuntime(
  agyLayer = FakeAgyBackend,
  piLayer = FakePiBackend,
  agentsLayer = AgentsStore.layer,
  persistenceLayer: Layer.Layer<HarborJobPersistence> = HarborJobPersistence.layer
) {
  const base = Layer.mergeAll(
    JobRegistry.layer,
    ShellExecutor.layer,
    SchemaValidator.layer,
    agentsLayer,
    MailBus.layer,
    VibeState.layer,
    ParentSessionGate.layer,
    persistenceLayer
  );
  const taskManager = TaskManager.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(base, piLayer, agyLayer))
  );
  return ManagedRuntime.make(
    Layer.mergeAll(
      taskManager,
      ProcessSupervisor.layer.pipe(Layer.provideMerge(base)),
      piLayer,
      agyLayer,
      base
    )
  );
}
