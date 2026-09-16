import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";
import { RaftSessionApprovals } from "../src/core/approval-controller.js";
import type { RaftAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import {
  RaftDirectToolApproval,
  mergeRaftApprovalUsage,
} from "../src/core/direct-tool-approval.js";

const tool = (name: string, source = "builtin") => ({
  name,
  description: "Run " + name,
  parameters: { type: "object", properties: {} },
  sourceInfo: {
    path: source === "builtin" ? "<builtin:" + name + ">" : "/extensions/example.ts",
    source,
    scope: "temporary" as const,
    origin: "top-level" as const,
  },
});

const event = (toolName: string, input: Record<string, unknown> = {}): ToolCallEvent => ({
  type: "tool_call",
  toolCallId: "call-" + toolName,
  toolName,
  input,
});

const noUiContext = { cwd: process.cwd(), hasUI: false, mode: "print" } as ExtensionContext;

const usage: Usage = {
  input: 20,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 28,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};

describe("direct Pi tool approvals", () => {
  it("routes core tools by their built-in class and everything else to execute", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.execute = "deny";
    config.safety.approvals.network = "deny";
    const approval = new RaftDirectToolApproval(
      { getAllTools: () => [tool("bash"), tool("deploy", "example")] } as never,
      () => config,
      new RaftSessionApprovals(),
    );

    await expect(
      approval.approve(event("bash", { command: "echo safe" }), noUiContext),
    ).rejects.toThrow("pi.bash is denied by the Raft execute policy");
    await expect(
      approval.approve(event("deploy", { target: "production" }), noUiContext),
    ).rejects.toThrow("extensions.deploy is denied by the Raft execute policy");
  });

  it("gates reads with the read policy instead of execute", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.read = "deny";
    config.safety.approvals.write = "deny";
    const approval = new RaftDirectToolApproval(
      { getAllTools: () => [tool("read"), tool("edit")] } as never,
      () => config,
      new RaftSessionApprovals(),
    );

    await expect(approval.approve(event("read"), noUiContext)).rejects.toThrow(
      "pi.read is denied by the Raft read policy",
    );
    await expect(approval.approve(event("edit"), noUiContext)).rejects.toThrow(
      "pi.edit is denied by the Raft write policy",
    );
    expect(config.safety.approvals.execute).toBe("allow");
  });

  it("keeps extension tools and MCP actions on execute", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.execute = "deny";
    config.safety.approvals.read = "deny";
    const approval = new RaftDirectToolApproval(
      { getAllTools: () => [tool("browser", "example")] } as never,
      () => config,
      new RaftSessionApprovals(),
    );

    await expect(approval.approve(event("browser"), noUiContext)).rejects.toThrow(
      "extensions.browser is denied by the Raft execute policy",
    );
    await expect(approval.approve(event("ghost"), noUiContext)).rejects.toThrow(
      "extensions.ghost is denied by the Raft execute policy",
    );
  });

  it("uses configured risk overrides for direct native tools", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.execute = "deny";
    config.safety.approvals.read = "auto";
    config.safety.approvals.network = "auto";
    config.safety.toolRisks = { "pi.read": "read", "extensions.browser": "network" };
    const classify = vi.fn(async () => ({
      decision: "allow" as const,
      reason: "Read-only inspection",
      model: "anthropic/classifier",
      usage,
    }));
    const approval = new RaftDirectToolApproval(
      { getAllTools: () => [tool("read"), tool("browser", "example")] } as never,
      () => config,
      new RaftSessionApprovals(),
      { classify } as unknown as RaftAutoApprovalClassifier,
    );
    await approval.approve(event("read"), noUiContext);
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "pi.read", risk: "read" }),
      {},
      noUiContext,
      undefined,
    );
    await approval.approve(event("browser", { url: "https://example.com" }), noUiContext);
    expect(classify).toHaveBeenLastCalledWith(
      expect.objectContaining({ ref: "extensions.browser", risk: "network" }),
      { url: "https://example.com" },
      noUiContext,
      undefined,
    );
  });

  it("classifies auto calls with the native action and retains classifier usage", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.execute = "auto";
    const classify = vi.fn(async () => ({
      decision: "allow" as const,
      reason: "Bounded command",
      model: "anthropic/classifier",
      usage,
    }));
    const approval = new RaftDirectToolApproval(
      { getAllTools: () => [tool("bash")] } as never,
      () => config,
      new RaftSessionApprovals(),
      { classify } as unknown as RaftAutoApprovalClassifier,
    );
    const call = event("bash", { command: "pnpm test" });

    await approval.approve(call, noUiContext);

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "pi.bash", risk: "execute" }),
      { command: "pnpm test" },
      noUiContext,
      undefined,
    );
    expect(approval.takeUsage(call.toolCallId)).toEqual(usage);
    expect(approval.takeUsage(call.toolCallId)).toBeUndefined();
  });

  it("shares session-wide risk grants across direct calls", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.write = "ask";
    const select = vi.fn(async () => "Allow write access for this session");
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "rpc",
      ui: { select, notify: vi.fn() },
    } as unknown as ExtensionContext;
    const approval = new RaftDirectToolApproval(
      { getAllTools: () => [tool("edit"), tool("write")] } as never,
      () => config,
      new RaftSessionApprovals(),
    );

    await approval.approve(event("edit", { path: "a.ts" }), context);
    await approval.approve(event("write", { path: "b.ts" }), context);

    expect(select).toHaveBeenCalledOnce();
  });

  it("adds classifier usage to existing native tool usage", () => {
    const merged = mergeRaftApprovalUsage(
      {
        ...usage,
        input: 3,
        output: 4,
        totalTokens: 10,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      usage,
    );
    expect(merged).toEqual(
      expect.objectContaining({
        input: 23,
        output: 9,
        cacheRead: 4,
        cacheWrite: 2,
        totalTokens: 38,
        cost: { input: 1.01, output: 2.02, cacheRead: 3.001, cacheWrite: 4.002, total: 10.033 },
      }),
    );
  });
});
