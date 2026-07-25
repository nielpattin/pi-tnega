import { describe, it, expect } from "vitest";
import { AgentsStore } from "../src/services/AgentsStore.js";
import { ManagedRuntime } from "effect";

describe("AgentsStore Service", () => {
  const runtime = ManagedRuntime.make(AgentsStore.layer);

  it("returns built-in agents (scout & task) by default", async () => {
    const agents = await runtime.runPromise(
      AgentsStore.use((svc) => svc.listAgents())
    );

    expect(agents.length).toBeGreaterThanOrEqual(2);
    const scout = agents.find((a) => a.name === "scout");
    const task = agents.find((a) => a.name === "task");

    expect(scout).toBeDefined();
    expect(scout?.harness).toBe("pi");
    expect(task).toBeDefined();
    expect(task?.harness).toBe("pi");
  });

  it("getAgent returns definition for known agent name", async () => {
    const taskDef = await runtime.runPromise(
      AgentsStore.use((svc) => svc.getAgent("task"))
    );

    expect(taskDef).toBeDefined();
    expect(taskDef?.name).toBe("task");
    expect(taskDef?.tools).toContain("read");
  });

  it("getVibeProfiles returns fast and good profiles", async () => {
    const profiles = await runtime.runPromise(
      AgentsStore.use((svc) => svc.getVibeProfiles())
    );

    expect(profiles.fast).toBeDefined();
    expect(profiles.good).toBeDefined();
    expect(profiles.fast.harness).toBe("pi");
    expect(profiles.good.harness).toBe("pi");
  });
});
