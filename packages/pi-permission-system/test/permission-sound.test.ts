import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PermissionDecisionUi } from "#src/permission-dialog";
import { createAudiblePermissionDecisionRequester } from "#src/permission-sound";

const tempDirs: string[] = [];

afterEach(() => {
   for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
   }
});

describe("permission request sound", () => {
   it("plays the configured permission sound before opening the prompt", async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "pi-permission-sound-"));
      tempDirs.push(agentDir);
      mkdirSync(join(agentDir, "assets"), { recursive: true });
      writeFileSync(
         join(agentDir, "settings.json"),
         JSON.stringify({ piPermissionSystem: { sound: "assets/custom-permission.mp3", volume: 42 } }),
         "utf8",
      );

      const order: string[] = [];
      const exec = vi.fn(async () => {
         order.push("sound");
      });
      const requestPermissionDecisionFromUi = vi.fn(async () => {
         order.push("prompt");
         return { approved: true, state: "approved" as const };
      });
      const request = createAudiblePermissionDecisionRequester({
         agentDir,
         exec,
         requestPermissionDecisionFromUi,
         warn: vi.fn(),
      });

      const decision = await request({} as PermissionDecisionUi, "Permission Required", "Allow this command?");

      expect(decision).toEqual({ approved: true, state: "approved" });
      expect(order).toEqual(["sound", "prompt"]);
      expect(exec).toHaveBeenCalledWith("ffplay", [
         "-nodisp",
         "-autoexit",
         "-loglevel",
         "error",
         "-volume",
         "42",
         join(agentDir, "assets", "custom-permission.mp3"),
      ]);
   });

   it("boosts permission sound above ffplay startup volume with an audio filter", async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "pi-permission-sound-"));
      tempDirs.push(agentDir);
      writeFileSync(
         join(agentDir, "settings.json"),
         JSON.stringify({ piPermissionSystem: { sound: "assets/custom-permission.mp3", volume: 150 } }),
         "utf8",
      );

      const exec = vi.fn();
      const requestPermissionDecisionFromUi = vi.fn(async () => ({ approved: true, state: "approved" as const }));
      const request = createAudiblePermissionDecisionRequester({
         agentDir,
         exec,
         requestPermissionDecisionFromUi,
      });

      await request({} as PermissionDecisionUi, "Permission Required", "Allow this command?");

      expect(exec).toHaveBeenCalledWith("ffplay", [
         "-nodisp",
         "-autoexit",
         "-loglevel",
         "error",
         "-volume",
         "100",
         "-af",
         "volume=1.5",
         join(agentDir, "assets", "custom-permission.mp3"),
      ]);
   });
});
