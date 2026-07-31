import { describe, it, expect } from "vitest";
import { AgentsStore } from "../src/services/AgentsStore.js";
import { ManagedRuntime } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";

/** Backup real global agent file so tests never wipe user overrides permanently. */
function withGlobalAgentBackup(name: string, run: (globalPath: string) => Promise<void> | void) {
   return async () => {
      const { getGlobalAgentsDir } = await import("../src/services/AgentsStore.js");
      const globalPath = path.join(getGlobalAgentsDir(), `${name}.md`);
      const existed = fs.existsSync(globalPath);
      const backup = existed ? fs.readFileSync(globalPath, "utf-8") : null;
      try {
         await run(globalPath);
      } finally {
         if (backup !== null) {
            fs.writeFileSync(globalPath, backup, "utf-8");
         } else if (fs.existsSync(globalPath)) {
            try {
               fs.unlinkSync(globalPath);
            } catch {}
         }
      }
   };
}

describe("AgentsStore Service", () => {
   const runtime = ManagedRuntime.make(AgentsStore.layer);

   it("returns built-in agents (scout & task) by default", async () => {
      const agents = await runtime.runPromise(AgentsStore.use((svc) => svc.listAgents()));

      expect(agents.length).toBeGreaterThanOrEqual(2);
      const scout = agents.find((a) => a.name === "scout");
      const task = agents.find((a) => a.name === "task");

      expect(scout).toBeDefined();
      expect(scout?.harness).toBe("pi");
      expect(task).toBeDefined();
      expect(task?.harness).toBe("pi");
   });

   it("getAgent returns definition for known agent name", async () => {
      const taskDef = await runtime.runPromise(AgentsStore.use((svc) => svc.getAgent("task")));

      expect(taskDef).toBeDefined();
      expect(taskDef?.name).toBe("task");
      expect(taskDef?.tools).toContain("read");
   });

   it("getVibeProfiles returns fast and good profiles", async () => {
      const profiles = await runtime.runPromise(AgentsStore.use((svc) => svc.getVibeProfiles()));

      expect(profiles.fast).toBeDefined();
      expect(profiles.good).toBeDefined();
      expect(profiles.fast.harness).toBe("pi");
      expect(profiles.good.harness).toBe("pi");
   });

   it("built-in vibe agents inherit model and thinking", async () => {
      const { BUILTIN_AGENTS, DEFAULT_VIBE_PROFILES } = await import("../src/services/AgentsStore.js");

      expect(BUILTIN_AGENTS.fast.model).toBeUndefined();
      expect(BUILTIN_AGENTS.fast.thinking).toBeUndefined();
      expect(BUILTIN_AGENTS.good.model).toBeUndefined();
      expect(BUILTIN_AGENTS.good.thinking).toBeUndefined();
      expect(DEFAULT_VIBE_PROFILES.fast.pi?.model).toBeUndefined();
      expect(DEFAULT_VIBE_PROFILES.fast.pi?.reasoning_effort).toBeUndefined();
      expect(DEFAULT_VIBE_PROFILES.good.pi?.model).toBeUndefined();
      expect(DEFAULT_VIBE_PROFILES.good.pi?.reasoning_effort).toBeUndefined();
   });

   it(
      "saveAgentToDisk creates global override file for builtin agent",
      withGlobalAgentBackup("scout", async (savedPath) => {
         const { saveAgentToDisk, loadAllAgentsFromDisk, BUILTIN_AGENTS, getGlobalAgentsDir } =
            await import("../src/services/AgentsStore.js");

         const builtinScout = BUILTIN_AGENTS.scout;
         const overrideScout = {
            ...builtinScout,
            description: "Custom scout override test description",
            model: "gemini-3.6-flash-high"
         };

         const written = saveAgentToDisk(overrideScout);
         expect(fs.existsSync(written)).toBe(true);
         expect(written).toBe(path.join(getGlobalAgentsDir(), "scout.md"));
         expect(written).toBe(savedPath);

         const loaded = loadAllAgentsFromDisk();
         const loadedScout = loaded.find((a) => a.name === "scout");
         expect(loadedScout).toBeDefined();
         expect(loadedScout?.isOverride).toBe(true);
         expect(loadedScout?.description).toBe("Custom scout override test description");
      })
   );

   it(
      "listAgents keeps disk override for builtin after fresh store (reload)",
      withGlobalAgentBackup("scout", async (savedPath) => {
         const { saveAgentToDisk, BUILTIN_AGENTS } = await import("../src/services/AgentsStore.js");

         const overrideScout = {
            ...BUILTIN_AGENTS.scout,
            description: "Reload-surviving scout override",
            thinking: "medium"
         };
         saveAgentToDisk(overrideScout);

         // Fresh runtime = cold reload: agentsRef re-seeded from BUILTIN_AGENTS only
         const freshRuntime = ManagedRuntime.make(AgentsStore.layer);
         try {
            const agents = await freshRuntime.runPromise(AgentsStore.use((svc) => svc.listAgents()));
            const scout = agents.find((a) => a.name === "scout");
            expect(scout).toBeDefined();
            expect(scout?.isOverride).toBe(true);
            expect(scout?.description).toBe("Reload-surviving scout override");
            expect(scout?.thinking).toBe("medium");
            expect(scout?.filePath).toBe(savedPath);
         } finally {
            await freshRuntime.dispose();
         }
      })
   );
});
