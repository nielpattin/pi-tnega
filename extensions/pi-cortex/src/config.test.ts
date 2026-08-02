import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setActiveCwd, getActiveCwd, getAgentDir, encodeCwd, getProjectDir, getDbPath, getModelsDir, resolveProjectPaths } from "./config.js";

describe("config paths", () => {
   const agentDir = mkdtempSync(join(tmpdir(), "pi-cortex-agent-"));
   const projA = join(agentDir, "work", "project-a");
   const projB = join(agentDir, "work", "project-a", "src");

   beforeEach(() => {
      // The agent dir is derived from the pi session dir (two levels up).
      setActiveCwd(projA, join(agentDir, "sessions", encodeCwd(projA)));
   });

   afterEach(() => {
      rmSync(agentDir, { recursive: true, force: true });
   });

   it("encodes a cwd the same way pi names session folders", () => {
      expect(encodeCwd("C:\\Users\\niel\\.pi\\agent")).toBe("--C--Users-niel-.pi-agent--");
      // Relative paths resolve first (pi does the same before encoding).
      expect(encodeCwd("/home/user/repo")).toBe(encodeCwd(resolve("/home/user/repo")));
   });

   it("derives the agent dir from the session dir", () => {
      expect(getAgentDir()).toBe(agentDir);
   });

   it("places the DB in the session folder of the active cwd, not in the project", () => {
      expect(getProjectDir()).toBe(join(agentDir, "sessions", encodeCwd(projA)));
      expect(getDbPath()).toBe(join(agentDir, "sessions", encodeCwd(projA), "pi-cortex.db"));
   });

   it("keys the DB by the exact cwd: an inner folder gets its own DB", () => {
      setActiveCwd(projB, join(agentDir, "sessions", encodeCwd(projB)));
      expect(getDbPath()).toBe(join(agentDir, "sessions", encodeCwd(projB), "pi-cortex.db"));
      expect(getActiveCwd()).toBe(projB);
   });

   it("keeps the model cache global, shared by every project", () => {
      setActiveCwd(projB, join(agentDir, "sessions", encodeCwd(projB)));
      const before = getModelsDir();
      setActiveCwd(projA, join(agentDir, "sessions", encodeCwd(projA)));
      expect(getModelsDir()).toBe(before);
      expect(getModelsDir()).toBe(join(agentDir, ".pi", "cortex", "models"));
   });

   it("resolveProjectPaths resolves a sub-path to its own DB without disturbing the active cwd", () => {
      const r = resolveProjectPaths("sub", projA);
      expect(r.base).toBe(join(projA, "sub"));
      expect(r.dbPath).toBe(join(agentDir, "sessions", encodeCwd(join(projA, "sub")), "pi-cortex.db"));
      expect(getActiveCwd()).toBe(projA);
   });
});
