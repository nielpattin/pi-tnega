import { describe, expect, test } from "vitest";

import { buildHandoffInstructions, buildNewSessionPrompt, shouldShowHandoffWidget } from "./index";

describe("pi-handoff", () => {
   test("shows widget only when context reaches threshold", () => {
      expect(shouldShowHandoffWidget(undefined, 200_000)).toBe(false);
      expect(shouldShowHandoffWidget({ tokens: 199_999 }, 200_000)).toBe(false);
      expect(shouldShowHandoffWidget({ tokens: 200_000 }, 200_000)).toBe(true);
   });

   test("builds a high-signal handoff instruction", () => {
      const instructions = buildHandoffInstructions("C:/repo/project", "C:/sessions/session.jsonl");

      expect(instructions).toContain("fresh coding agent");
      expect(instructions).toContain("Do not write a transcript summary");
      expect(instructions).toContain("C:/repo/project");
      expect(instructions).toContain("C:/sessions/session.jsonl");
      expect(instructions).toContain("Verification status");
      expect(instructions).toContain("Immediate next steps");
   });

   test("builds a new-session prompt from the generated handoff", () => {
      const prompt = buildNewSessionPrompt("# Handoff\n- Continue here");

      expect(prompt).toContain("Read this handoff completely");
      expect(prompt).toContain("# Handoff\n- Continue here");
      expect(prompt).toContain("first concrete next step");
   });
});
