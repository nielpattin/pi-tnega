import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_CONFIG, normalizePermissionSystemConfig } from "#src/extension-config";
import { PermissionPrompter } from "#src/permission-prompter";
import { getPermissionSystemStatus } from "#src/status";
import {
   canResolveAskPermissionRequest,
   getPermissionMode,
   isAutoModeEnabled,
   isYoloModeEnabled,
   shouldAutoApprovePermissionState,
} from "#src/yolo-mode";
import type { PermissionPromptDecision } from "#src/permission-dialog";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("PermissionMode Configuration & Migration", () => {
   it("defaults to 'default' mode when permissionMode and yoloMode are absent", () => {
      const config = normalizePermissionSystemConfig({});
      expect(config.permissionMode).toBe("default");
      expect(config.yoloMode).toBe(false);
      expect(getPermissionMode(config)).toBe("default");
      expect(isYoloModeEnabled(config)).toBe(false);
      expect(isAutoModeEnabled(config)).toBe(false);
   });

   it("migrates legacy yoloMode: true to permissionMode: 'yolo'", () => {
      const config = normalizePermissionSystemConfig({ yoloMode: true });
      expect(config.permissionMode).toBe("yolo");
      expect(config.yoloMode).toBe(true);
      expect(getPermissionMode(config)).toBe("yolo");
      expect(isYoloModeEnabled(config)).toBe(true);
      expect(isAutoModeEnabled(config)).toBe(false);
   });

   it("migrates legacy yoloMode: false to permissionMode: 'default'", () => {
      const config = normalizePermissionSystemConfig({ yoloMode: false });
      expect(config.permissionMode).toBe("default");
      expect(config.yoloMode).toBe(false);
      expect(getPermissionMode(config)).toBe("default");
      expect(isYoloModeEnabled(config)).toBe(false);
      expect(isAutoModeEnabled(config)).toBe(false);
   });

   it("respects explicit permissionMode: 'auto'", () => {
      const config = normalizePermissionSystemConfig({ permissionMode: "auto" });
      expect(config.permissionMode).toBe("auto");
      expect(config.yoloMode).toBe(false);
      expect(getPermissionMode(config)).toBe("auto");
      expect(isYoloModeEnabled(config)).toBe(false);
      expect(isAutoModeEnabled(config)).toBe(true);
   });

   it("respects explicit permissionMode: 'yolo'", () => {
      const config = normalizePermissionSystemConfig({ permissionMode: "yolo" });
      expect(config.permissionMode).toBe("yolo");
      expect(config.yoloMode).toBe(true);
      expect(getPermissionMode(config)).toBe("yolo");
      expect(isYoloModeEnabled(config)).toBe(true);
      expect(isAutoModeEnabled(config)).toBe(false);
   });

   it("updates status display string according to active mode", () => {
      expect(getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "default" })).toBe("default");
      expect(getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "auto" })).toBe("auto");
      expect(getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "yolo" })).toBe("yolo");
   });
});

describe("Ask Permission Resolution Options across modes", () => {
   it("shouldAutoApprovePermissionState returns true ONLY in yolo mode for 'ask'", () => {
      const defaultConfig = { ...DEFAULT_EXTENSION_CONFIG, permissionMode: "default" as const };
      const autoConfig = { ...DEFAULT_EXTENSION_CONFIG, permissionMode: "auto" as const };
      const yoloConfig = { ...DEFAULT_EXTENSION_CONFIG, permissionMode: "yolo" as const };

      expect(shouldAutoApprovePermissionState("ask", defaultConfig)).toBe(false);
      expect(shouldAutoApprovePermissionState("ask", autoConfig)).toBe(false);
      expect(shouldAutoApprovePermissionState("ask", yoloConfig)).toBe(true);

      // deny and allow are never auto-approved by yolo
      expect(shouldAutoApprovePermissionState("deny", yoloConfig)).toBe(false);
      expect(shouldAutoApprovePermissionState("allow", yoloConfig)).toBe(false);
   });

   it("canResolveAskPermissionRequest behavior in auto vs yolo vs default", () => {
      const defaultConfig = { ...DEFAULT_EXTENSION_CONFIG, permissionMode: "default" as const };
      const autoConfig = { ...DEFAULT_EXTENSION_CONFIG, permissionMode: "auto" as const };
      const yoloConfig = { ...DEFAULT_EXTENSION_CONFIG, permissionMode: "yolo" as const };

      // In default: needs UI or subagent
      expect(canResolveAskPermissionRequest({ config: defaultConfig, hasUI: false, isSubagent: false })).toBe(false);
      expect(canResolveAskPermissionRequest({ config: defaultConfig, hasUI: true, isSubagent: false })).toBe(true);

      // In auto or yolo: can resolve even without UI or subagent
      expect(canResolveAskPermissionRequest({ config: autoConfig, hasUI: false, isSubagent: false })).toBe(true);
      expect(canResolveAskPermissionRequest({ config: yoloConfig, hasUI: false, isSubagent: false })).toBe(true);
   });
});

describe("PermissionPrompter Guardian Routing in Auto Mode", () => {
   const dummyCtx = {
      cwd: "/test",
      hasUI: true,
      ui: { select: vi.fn() },
      sessionManager: {
         getSessionDir: () => "/tmp/session",
      },
   } as unknown as ExtensionContext;

   it("does NOT run guardian in 'default' mode for bash", async () => {
      const writeReviewLog = vi.fn();
      const reviewGuardian = vi.fn();
      const requestPermissionDecisionFromUi = vi.fn().mockResolvedValue({ approved: true, state: "approved" });

      const prompter = new PermissionPrompter({
         getConfig: () => ({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "default" }),
         writeReviewLog,
         subagentSessionsDir: "/tmp/subagents",
         forwardingDir: "/tmp/forwarding",
         requestPermissionDecisionFromUi,
         reviewGuardian,
      });

      const decision = await prompter.prompt(dummyCtx, {
         requestId: "req-1",
         source: "tool_call",
         agentName: null,
         message: "Allow bash?",
         toolName: "bash",
         command: "git status",
      });

      expect(reviewGuardian).not.toHaveBeenCalled();
      expect(requestPermissionDecisionFromUi).toHaveBeenCalled();
      expect(decision.approved).toBe(true);
   });

   it("does NOT run guardian in 'yolo' mode for bash", async () => {
      const writeReviewLog = vi.fn();
      const reviewGuardian = vi.fn();
      const requestPermissionDecisionFromUi = vi.fn();

      const prompter = new PermissionPrompter({
         getConfig: () => ({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "yolo" }),
         writeReviewLog,
         subagentSessionsDir: "/tmp/subagents",
         forwardingDir: "/tmp/forwarding",
         requestPermissionDecisionFromUi,
         reviewGuardian,
      });

      const decision = await prompter.prompt(dummyCtx, {
         requestId: "req-2",
         source: "tool_call",
         agentName: null,
         message: "Allow bash?",
         toolName: "bash",
         command: "git status",
      });

      expect(reviewGuardian).not.toHaveBeenCalled();
      expect(requestPermissionDecisionFromUi).not.toHaveBeenCalled();
      expect(decision.approved).toBe(true);
      expect(decision.autoApproved).toBe(true);
   });

   it("runs guardian in 'auto' mode for bash and auto-approves when verdict is 'approve'", async () => {
      const writeReviewLog = vi.fn();
      const reviewGuardian = vi.fn().mockResolvedValue({ decision: "approve", reason: "Safe git status command" });
      const requestPermissionDecisionFromUi = vi.fn();

      const prompter = new PermissionPrompter({
         getConfig: () => ({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "auto" }),
         writeReviewLog,
         subagentSessionsDir: "/tmp/subagents",
         forwardingDir: "/tmp/forwarding",
         requestPermissionDecisionFromUi,
         reviewGuardian,
      });

      const details = {
         requestId: "req-3",
         source: "tool_call" as const,
         agentName: null,
         message: "Allow bash?",
         toolName: "bash",
         command: "git status",
      };

      const decision = await prompter.prompt(dummyCtx, details);

      expect(reviewGuardian).toHaveBeenCalledWith(details, dummyCtx);
      expect(requestPermissionDecisionFromUi).not.toHaveBeenCalled();
      expect(decision.approved).toBe(true);
      expect(decision.autoApproved).toBe(true);
      expect(writeReviewLog).toHaveBeenCalledWith(
         "permission_request.auto_approved",
         expect.objectContaining({ requestId: "req-3", toolName: "bash", command: "git status" }),
      );
   });

   it("runs guardian in 'auto' mode for bash and blocks when verdict is 'revise'", async () => {
      const writeReviewLog = vi.fn();
      const reviewGuardian = vi.fn().mockResolvedValue({ decision: "revise", reason: "Commit message must be lowercase" });
      const requestPermissionDecisionFromUi = vi.fn();

      const prompter = new PermissionPrompter({
         getConfig: () => ({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "auto" }),
         writeReviewLog,
         subagentSessionsDir: "/tmp/subagents",
         forwardingDir: "/tmp/forwarding",
         requestPermissionDecisionFromUi,
         reviewGuardian,
      });

      const details = {
         requestId: "req-4",
         source: "tool_call" as const,
         agentName: null,
         message: "Allow bash?",
         toolName: "bash",
         command: 'git commit -m "Fix bug"',
      };

      const decision = await prompter.prompt(dummyCtx, details);

      expect(reviewGuardian).toHaveBeenCalledWith(details, dummyCtx);
      expect(requestPermissionDecisionFromUi).not.toHaveBeenCalled();
      expect(decision.approved).toBe(false);
      expect(decision.state).toBe("denied");
      expect(decision.denialReason).toContain("Auto Permissions requested revision: Commit message must be lowercase");
   });

   it("falls through to user prompt when guardian verdict is 'ask_user'", async () => {
      const writeReviewLog = vi.fn();
      const reviewGuardian = vi.fn().mockResolvedValue({ decision: "ask_user", reason: "High risk push" });
      const requestPermissionDecisionFromUi = vi.fn().mockResolvedValue({ approved: true, state: "approved" });

      const prompter = new PermissionPrompter({
         getConfig: () => ({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "auto" }),
         writeReviewLog,
         subagentSessionsDir: "/tmp/subagents",
         forwardingDir: "/tmp/forwarding",
         requestPermissionDecisionFromUi,
         reviewGuardian,
      });

      const details = {
         requestId: "req-5",
         source: "tool_call" as const,
         agentName: null,
         message: "Allow bash push?",
         toolName: "bash",
         command: "git push origin main",
      };

      const decision = await prompter.prompt(dummyCtx, details);

      expect(reviewGuardian).toHaveBeenCalledWith(details, dummyCtx);
      expect(requestPermissionDecisionFromUi).toHaveBeenCalled();
      expect(decision.approved).toBe(true);
   });

   it("does NOT run guardian in 'auto' mode for non-bash tools", async () => {
      const writeReviewLog = vi.fn();
      const reviewGuardian = vi.fn();
      const requestPermissionDecisionFromUi = vi.fn().mockResolvedValue({ approved: true, state: "approved" });

      const prompter = new PermissionPrompter({
         getConfig: () => ({ ...DEFAULT_EXTENSION_CONFIG, permissionMode: "auto" }),
         writeReviewLog,
         subagentSessionsDir: "/tmp/subagents",
         forwardingDir: "/tmp/forwarding",
         requestPermissionDecisionFromUi,
         reviewGuardian,
      });

      const details = {
         requestId: "req-6",
         source: "tool_call" as const,
         agentName: null,
         message: "Allow read?",
         toolName: "read",
         path: "/file.txt",
      };

      const decision = await prompter.prompt(dummyCtx, details);

      expect(reviewGuardian).not.toHaveBeenCalled();
      expect(requestPermissionDecisionFromUi).toHaveBeenCalled();
      expect(decision.approved).toBe(true);
   });
});
