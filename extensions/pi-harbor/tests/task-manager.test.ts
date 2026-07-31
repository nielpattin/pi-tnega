import { describe, it, expect, vi } from "vitest";
import { TaskManager } from "../src/services/TaskManager.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { AgentsStore } from "../src/services/AgentsStore.js";
import { SchemaValidator } from "../src/services/SchemaValidator.js";
import { AgyBackend } from "../src/backends/agy.js";
import { PiBackend, PI_BACKEND_CAPABILITIES } from "../src/backends/pi.js";
import { ShellExecutor } from "../src/services/ShellExecutor.js";
import { ConcurrencyLimitError } from "../src/domain.js";
import { Effect, ManagedRuntime, Layer } from "effect";
import { FakeAgyBackend, FakePiBackend } from "./helpers/fake-backends.js";

describe("TaskManager Service", () => {
  const LiveLayer = TaskManager.layer.pipe(
    Layer.provideMerge(JobRegistry.layer),
    Layer.provideMerge(AgentsStore.layer),
    Layer.provideMerge(SchemaValidator.layer),
    Layer.provideMerge(FakeAgyBackend),
    Layer.provideMerge(FakePiBackend),
    Layer.provideMerge(ShellExecutor.layer)
  );
  const runtime = ManagedRuntime.make(LiveLayer);

  it("names Pi sessions and persists actual runtime model, thinking, and cwd", async () => {
    let receivedSessionName: string | undefined;
    const RecordingPi = Layer.succeed(
      PiBackend,
      PiBackend.of({
        capabilities: PI_BACKEND_CAPABILITIES,
        spawnSession: async (options) => {
          receivedSessionName = options.sessionName;
          await options.onSessionReady?.({
            model: "proxy/resolved-model",
            thinking: "high",
            cwd: "C:/resolved/project"
          });
          return {
            session: {},
            abort: () => Effect.void,
            control: () => Effect.void
          };
        }
      })
    );
    const testRuntime = ManagedRuntime.make(
      TaskManager.layer.pipe(Layer.provideMerge(JobRegistry.layer), Layer.provideMerge(RecordingPi))
    );

    const job = await testRuntime.runPromise(
      TaskManager.use((svc) => svc.spawnTask({ task: "Inspect copy-all", name: "investigate-copy-all" }))
    );
    const stored = await testRuntime.runPromise(JobRegistry.use((registry) => registry.get(job.id)));

    expect(receivedSessionName).toBe(`task: investigate-copy-all ${job.id}`);
    expect(stored).toMatchObject({
      model: "proxy/resolved-model",
      thinking: "high",
      cwd: "C:/resolved/project"
    });
  });

  it("runs worker tools with the TaskManager service context", async () => {
    let workerVisibleJobId: string | undefined;
    const RecordingPi = Layer.succeed(
      PiBackend,
      PiBackend.of({
        capabilities: PI_BACKEND_CAPABILITIES,
        spawnSession: async (options) => {
          const visibleJob = await options.runEffect(JobRegistry.use((registry) => registry.get(options.jobId)));
          workerVisibleJobId = visibleJob?.id;
          return {
            session: {},
            abort: () => Effect.void,
            control: () => Effect.void
          };
        }
      })
    );
    const testRuntime = ManagedRuntime.make(
      TaskManager.layer.pipe(Layer.provideMerge(JobRegistry.layer), Layer.provideMerge(RecordingPi))
    );

    const job = await testRuntime.runPromise(TaskManager.use((svc) => svc.spawnTask({ task: "Submit result" })));

    expect(workerVisibleJobId).toBe(job.id);
  });

  it("forwards the resolved agent model and parent model registry to the Pi backend", async () => {
    const modelRegistry = { find: vi.fn(), getAll: vi.fn(() => []) };
    let receivedOptions: Parameters<PiBackend["Service"]["spawnSession"]>[0] | undefined;
    const RecordingPi = Layer.succeed(
      PiBackend,
      PiBackend.of({
        capabilities: PI_BACKEND_CAPABILITIES,
        spawnSession: async (options) => {
          receivedOptions = options;
          return { session: {}, abort: () => Effect.void, control: () => Effect.void };
        }
      })
    );
    const TestAgents = Layer.succeed(
      AgentsStore,
      AgentsStore.of({
        getAgent: () =>
          Effect.succeed({
            name: "light-task",
            description: "Light task",
            tools: ["read", "submit"],
            harness: "pi" as const,
            enabled: true,
            source: "global" as const,
            body: "Light task body",
            model: "proxy/cfai/@cf/moonshotai/kimi-k2.7-code",
            thinking: "high"
          }),
        listAgents: () => Effect.succeed([]),
        getVibeProfiles: () => Effect.die("unused"),
        updateAgent: () => Effect.die("unused"),
        deleteAgent: () => Effect.die("unused"),
        updateVibeProfile: () => Effect.die("unused")
      })
    );
    const testRuntime = ManagedRuntime.make(
      TaskManager.layer.pipe(
        Layer.provideMerge(JobRegistry.layer),
        Layer.provideMerge(RecordingPi),
        Layer.provideMerge(TestAgents)
      )
    );

    await testRuntime.runPromise(
      TaskManager.use((svc) =>
        svc.spawnTask(
          { task: "Inspect copy-all", name: "inspect-copy-all", agent: "light-task" },
          {
            modelRegistry,
            inheritedModel: { provider: "parent", id: "parent-model" }
          }
        )
      )
    );

    expect(receivedOptions?.agentDef?.model).toBe("proxy/cfai/@cf/moonshotai/kimi-k2.7-code");
    expect(receivedOptions?.modelRegistry).toBe(modelRegistry);
    expect(receivedOptions?.inheritedModel).toEqual({ provider: "parent", id: "parent-model" });
  });

  it("uses the detailed final assistant answer when submit only refers to text above", async () => {
    const detailed = [
      "## Complete investigation",
      "The extension copies the full conversation transcript to the clipboard.",
      "It supports Windows, macOS, and Linux clipboard commands.",
      "The public API registers the copy-all command and preserves Unicode text."
    ].join("\n\n");
    const RecordingPi = Layer.succeed(
      PiBackend,
      PiBackend.of({
        capabilities: PI_BACKEND_CAPABILITIES,
        spawnSession: async (options) => {
          options.onOutput?.(detailed);
          options.onTranscript?.([
            { type: "assistant", text: detailed },
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit",
              arguments: { result: { data: "See detailed investigation above." } }
            }
          ]);
          options.onSettled?.("completed", "See detailed investigation above.");
          return { session: {}, abort: () => Effect.void, control: () => Effect.void };
        }
      })
    );
    const testRuntime = ManagedRuntime.make(
      TaskManager.layer.pipe(Layer.provideMerge(JobRegistry.layer), Layer.provideMerge(RecordingPi))
    );

    const job = await testRuntime.runPromise(
      TaskManager.use((svc) => svc.spawnTask({ task: "Investigate copy-all", name: "investigate-copy-all" }))
    );
    await vi.waitFor(async () => {
      const stored = await testRuntime.runPromise(JobRegistry.use((registry) => registry.get(job.id)));
      expect(stored?.status).toBe("completed");
    });
    const stored = await testRuntime.runPromise(JobRegistry.use((registry) => registry.get(job.id)));

    expect(stored?.resultData).toBe(detailed);
  });

  it("fails instead of using a default model when an explicitly selected agent does not exist", async () => {
    await expect(
      runtime.runPromise(
        TaskManager.use((svc) =>
          svc.spawnTask({
            task: "Do not silently fall back",
            name: "missing-agent",
            agent: "harbor-agent-that-does-not-exist"
          })
        )
      )
    ).rejects.toMatchObject({
      _tag: "AgentNotFoundError",
      agent: "harbor-agent-that-does-not-exist"
    });
  });

  it("fails before spawning when the selected Pi backend is unavailable", async () => {
    const isolatedRuntime = ManagedRuntime.make(
      TaskManager.layer.pipe(Layer.provideMerge(JobRegistry.layer))
    );

    const job = await isolatedRuntime.runPromise(
      TaskManager.use((svc) => svc.spawnTask({ task: "Must not create a real session" }))
    );
    const stored = await isolatedRuntime.runPromise(JobRegistry.use((registry) => registry.get(job.id)));

    expect(stored?.status).toBe("failed");
    expect(stored?.errorText).toBe("Pi backend is unavailable. The task was not started.");
  });

  it("spawns a task and sets status to running using reservation window", async () => {
    const job = await runtime.runPromise(
      TaskManager.use((svc) =>
        svc.spawnTask({
          task: "Run research task",
          name: "Research"
        })
      )
    );

    expect(job.id).toBeDefined();
    expect(job.id).toMatch(/^task-\d+$/);
    expect(job.status).toBe("running");
  });

  it("rejects when MAX_RUNNING_AGENTS (4) cap is exceeded", async () => {
    const testRuntime = ManagedRuntime.make(LiveLayer);
    const jobs: string[] = [];

    // Spawn 4 running tasks (sequential so the cap check sees a deterministic count)
    await Array.from({ length: 4 }, (_, index) => index + 1).reduce(
      async (prev, i) => {
        await prev;
        const j = await testRuntime.runPromise(
          TaskManager.use((svc) =>
            svc.spawnTask({
              task: `Task ${i}`
            })
          )
        );
        jobs.push(j.id);
      },
      Promise.resolve()
    );

    // 5th task spawn must fail with ConcurrencyLimitError
    const exit = await testRuntime.runPromiseExit(
      TaskManager.use((svc) =>
        svc.spawnTask({
          task: "Task 5"
        })
      )
    );

    expect(exit._tag).toBe("Failure");
    const _tagNarrowed = exit as Extract<typeof exit, { _tag: "Failure" }>;
   expect(JSON.stringify(_tagNarrowed.cause)).toContain("ConcurrencyLimitError");
  });

  it("cancelJob aborts backend and updates job status to cancelled", async () => {
    const testRuntime = ManagedRuntime.make(LiveLayer);
    const job = await testRuntime.runPromise(
      TaskManager.use((svc) =>
        svc.spawnTask({
          task: "Task to cancel"
        })
      )
    );

    expect(job.status).toBe("running");

    const cancelledJob = await testRuntime.runPromise(
      TaskManager.use((svc) => svc.cancelJob(job.id))
    );

    expect(cancelledJob?.status).toBe("cancelled");
  });

  it("disposeAll cancels all running jobs", async () => {
    const testRuntime = ManagedRuntime.make(LiveLayer);
    const j1 = await testRuntime.runPromise(
      TaskManager.use((svc) => svc.spawnTask({ task: "Task 1" }))
    );
    const j2 = await testRuntime.runPromise(
      TaskManager.use((svc) => svc.spawnTask({ task: "Task 2" }))
    );

    await testRuntime.runPromise(TaskManager.use((svc) => svc.disposeAll));

    const registry = await testRuntime.runPromise(JobRegistry.use((r) => r.list()));
    const j1Updated = registry.find((j) => j.id === j1.id);
    const j2Updated = registry.find((j) => j.id === j2.id);

    expect(j1Updated?.status).toBe("cancelled");
    expect(j2Updated?.status).toBe("cancelled");
  });

  it("persists live Agy tool events in the running job transcript", async () => {
    const Registry = JobRegistry.layer;
    const FakeAgy = Layer.succeed(
      AgyBackend,
      AgyBackend.of({
        runOneShot: () => Effect.die("unused"),
        createFsmSession: (options) => ({
          state: "running" as const,
          pendingFollowUps: [],
          pendingSteerText: undefined,
          start: () =>
            Effect.sync(() =>
              options.onEvent?.({
                _tag: "ToolStart",
                toolCallId: "agy-1-0",
                toolName: "list_dir",
                argsPreview: '{"DirectoryPath":"C:\\\\work"}'
              })
            ),
          control: () => Effect.void,
          abort: () => Effect.void
        })
      })
    );
    const testRuntime = ManagedRuntime.make(
      TaskManager.layer.pipe(Layer.provideMerge(Registry), Layer.provideMerge(FakeAgy))
    );

    const job = await testRuntime.runPromise(
      TaskManager.use((svc) => svc.spawnTask({ task: "Inspect files", harness: "agy" }))
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await testRuntime.runPromise(JobRegistry.use((r) => r.get(job.id))))?.transcript).toEqual([
      {
        type: "tool-call",
        toolCallId: "agy-1-0",
        toolName: "list_dir",
        arguments: { DirectoryPath: "C:\\work" }
      }
    ]);
  });

  it("preserves prior Agy chat and records the user prompt across post-result continuation", async () => {
    let optionsRef: any;
    const FakeAgy = Layer.succeed(
      AgyBackend,
      AgyBackend.of({
        runOneShot: () => Effect.die("unused"),
        createFsmSession: (options) => {
          optionsRef = options;
          return {
            state: "running" as const,
            conversationId: "conv-chat",
            pendingFollowUps: [],
            pendingSteerText: undefined,
            start: () =>
              Effect.sync(() => {
                options.onOutput?.("first answer");
                options.onSettled?.({ status: "completed", finalText: "first answer", rawText: "first answer" });
              }),
            control: (text) =>
              Effect.sync(() => {
                options.onOutput?.("second answer");
                options.onSettled?.({ status: "completed", finalText: "second answer", rawText: "second answer" });
              }),
            abort: () => Effect.void
          };
        }
      })
    );
    const testRuntime = ManagedRuntime.make(
      TaskManager.layer.pipe(Layer.provideMerge(JobRegistry.layer), Layer.provideMerge(FakeAgy))
    );

    const job = await testRuntime.runPromise(
      TaskManager.use((svc) => svc.spawnTask({ task: "Initial prompt", harness: "agy" }))
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await testRuntime.runPromise(TaskManager.use((svc) => svc.controlJob(job.id, "Continue please", "followUp")));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(optionsRef).toBeDefined();
    expect((await testRuntime.runPromise(JobRegistry.use((registry) => registry.get(job.id))))?.transcript).toEqual([
      { type: "assistant", text: "first answer" },
      { type: "user", text: "Continue please" },
      { type: "assistant", text: "second answer" }
    ]);
  });

  it.each(["steer", "followUp"] as const)(
    "resumes the same completed Agy job for post-result %s control",
    async (mode) => {
      let settle: ((result: any) => void) | undefined;
      let controlStatus: string | undefined;
      const Registry = JobRegistry.layer;
      const FakeAgy = Layer.effect(
        AgyBackend,
        Effect.gen(function* () {
          const registry = yield* JobRegistry;
          const control = vi.fn((text: string, receivedMode: "steer" | "followUp") =>
            Effect.gen(function* () {
              controlStatus = (yield* registry.get("task-1"))?.status;
              settle?.({ status: "completed", finalText: `continued: ${text}` });
              expect(receivedMode).toBe(mode);
            })
          );
          return AgyBackend.of({
            runOneShot: () => Effect.die("unused"),
            createFsmSession: (options) => {
              settle = options.onSettled;
              return {
                state: "running" as const,
                conversationId: "conv-retained",
                pendingFollowUps: [],
                pendingSteerText: undefined,
                start: () => Effect.sync(() => options.onSettled?.({ status: "completed", finalText: "initial" })),
                control,
                abort: () => Effect.void
              };
            }
          });
        })
      ).pipe(Layer.provideMerge(Registry));
      const testRuntime = ManagedRuntime.make(
        TaskManager.layer.pipe(Layer.provideMerge(Registry), Layer.provideMerge(FakeAgy))
      );
      const job = await testRuntime.runPromise(
        TaskManager.use((svc) => svc.spawnTask({ task: "Initial", harness: "agy" }))
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const initiallyCompleted = await testRuntime.runPromise(JobRegistry.use((r) => r.get(job.id)));
      expect(initiallyCompleted?.status).toBe("completed");
      const firstSettledAt = initiallyCompleted?.settledAt;
      await new Promise((resolve) => setTimeout(resolve, 5));

      await testRuntime.runPromise(TaskManager.use((svc) => svc.controlJob(job.id, "more", mode)));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const resumed = await testRuntime.runPromise(JobRegistry.use((r) => r.get(job.id)));
      expect(controlStatus).toBe("running");
      expect(resumed?.status).toBe("completed");
      expect(resumed?.settledAt).toBeGreaterThan(firstSettledAt ?? 0);
      expect(resumed?.resultData).toEqual({ data: "continued: more" });
      expect(await testRuntime.runPromise(JobRegistry.use((r) => r.list()))).toHaveLength(1);
    }
  );

  it("controlJob routes message to backend session for running job", async () => {
    const testRuntime = ManagedRuntime.make(LiveLayer);
    const job = await testRuntime.runPromise(
      TaskManager.use((svc) =>
        svc.spawnTask({
          task: "Task to control"
        })
      )
    );

    const controlRes = await testRuntime.runPromiseExit(
      TaskManager.use((svc) => svc.controlJob(job.id, "steer text", "steer"))
    );

    expect(controlRes._tag).toBe("Success");
  });

  describe("harness resolution", () => {
    it("resolves default harness ('pi') when neither spec nor agent harness is specified", async () => {
      const testRuntime = ManagedRuntime.make(LiveLayer);
      const job = await testRuntime.runPromise(
        TaskManager.use((svc) =>
          svc.spawnTask({
            task: "Default harness test"
          })
        )
      );

      expect(job.harness).toBe("pi");
    });

    it("resolves explicit harness from task spec", async () => {
      const testRuntime = ManagedRuntime.make(LiveLayer);
      const job = await testRuntime.runPromise(
        TaskManager.use((svc) =>
          svc.spawnTask({
            task: "Explicit harness test",
            harness: "agy"
          })
        )
      );

      expect(job.harness).toBe("agy");
    });

    it("inherits harness from AgentDefinition in AgentsStore when spec.harness is undefined", async () => {
      const FakeStore = Layer.succeed(
        AgentsStore,
        AgentsStore.of({
          listAgents: () => Effect.succeed([]),
          getAgent: (name: string) =>
            Effect.succeed(
              name === "custom-agy"
                ? { name: "custom-agy", description: "", enabled: true, source: "builtin" as const, harness: "agy" as const, tools: [], body: "" }
                : { name: "custom-pi", description: "", enabled: true, source: "builtin" as const, harness: "pi" as const, tools: [], body: "" }
            ),
          getVibeProfiles: () => Effect.die("unused"),
          updateAgent: (agent) => Effect.succeed(agent),
          deleteAgent: () => Effect.succeed({ success: true }),
          updateVibeProfile: (_name, profile) => Effect.succeed(profile)
        })
      );
      const testRuntime = ManagedRuntime.make(
        TaskManager.layer.pipe(
          Layer.provideMerge(JobRegistry.layer),
          Layer.provideMerge(FakeStore),
          Layer.provideMerge(SchemaValidator.layer),
          Layer.provideMerge(FakeAgyBackend),
          Layer.provideMerge(FakePiBackend),
          Layer.provideMerge(ShellExecutor.layer)
        )
      );

      const job = await testRuntime.runPromise(
        TaskManager.use((svc) =>
          svc.spawnTask({
            task: "Agent definition harness test",
            agent: "custom-agy"
          })
        )
      );

      expect(job.harness).toBe("agy");
    });

    it("spec.harness overrides AgentDefinition harness", async () => {
      const FakeStore = Layer.succeed(
        AgentsStore,
        AgentsStore.of({
          listAgents: () => Effect.succeed([]),
          getAgent: () =>
            Effect.succeed({
              name: "custom-agy",
              description: "",
              enabled: true,
              source: "builtin" as const,
              harness: "agy" as const,
              tools: [],
              body: ""
            }),
          getVibeProfiles: () => Effect.die("unused"),
          updateAgent: (agent) => Effect.succeed(agent),
          deleteAgent: () => Effect.succeed({ success: true }),
          updateVibeProfile: (_name, profile) => Effect.succeed(profile)
        })
      );
      const testRuntime = ManagedRuntime.make(
        TaskManager.layer.pipe(
          Layer.provideMerge(JobRegistry.layer),
          Layer.provideMerge(FakeStore),
          Layer.provideMerge(SchemaValidator.layer),
          Layer.provideMerge(FakeAgyBackend),
          Layer.provideMerge(FakePiBackend),
          Layer.provideMerge(ShellExecutor.layer)
        )
      );

      const job = await testRuntime.runPromise(
        TaskManager.use((svc) =>
          svc.spawnTask({
            task: "Override agent harness test",
            agent: "custom-agy",
            harness: "pi"
          })
        )
      );

      expect(job.harness).toBe("pi");
    });
  });
});


