import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { RaftConfig } from "../config.js";
import type { ResolvedRaftAction } from "./action-registry.js";
import {
  ApprovalController,
  RaftSessionApprovals,
  type RaftAutoApprovalAudit,
} from "./approval-controller.js";
import {
  RaftAutoApprovalClassifier,
  type RaftAutoApprovalDecision,
} from "./auto-approval-classifier.js";
import { defaultToolRisk, resolveToolRisk } from "./tool-risk.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const addUsage = (left: Usage, right: Usage): Usage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
    ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
    : {}),
  ...(left.reasoning !== undefined || right.reasoning !== undefined
    ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
    : {}),
  totalTokens: left.totalTokens + right.totalTokens,
  cost: {
    input: left.cost.input + right.cost.input,
    output: left.cost.output + right.cost.output,
    cacheRead: left.cost.cacheRead + right.cost.cacheRead,
    cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
    total: left.cost.total + right.cost.total,
  },
});

export const mergeRaftApprovalUsage = (existing: Usage | undefined, approval: Usage): Usage =>
  existing ? addUsage(existing, approval) : approval;

export class RaftDirectToolApproval {
  readonly #pendingUsage = new Map<string, Usage>();

  constructor(
    readonly pi: Pick<ExtensionAPI, "getAllTools">,
    readonly getConfig: () => RaftConfig,
    readonly sessionApprovals: RaftSessionApprovals,
    readonly classifier = new RaftAutoApprovalClassifier(),
    readonly onAutoDecision?: (
      audit: RaftAutoApprovalAudit,
      decision?: RaftAutoApprovalDecision,
    ) => void,
  ) {}

  async approve(event: ToolCallEvent, context: ExtensionContext): Promise<void> {
    const config = this.getConfig();
    const action = this.#resolve(event.toolName, config.safety.toolRisks);
    const controller = new ApprovalController(
      config.safety.approvals,
      context,
      this.sessionApprovals,
      this.classifier,
      (audit, decision) => {
        this.onAutoDecision?.(audit, decision);
        if (decision) this.#pendingUsage.set(event.toolCallId, decision.usage);
      },
    );
    await controller.approve(action, isRecord(event.input) ? event.input : {});
  }

  takeUsage(toolCallId: string): Usage | undefined {
    const usage = this.#pendingUsage.get(toolCallId);
    this.#pendingUsage.delete(toolCallId);
    return usage;
  }

  clear(): void {
    this.#pendingUsage.clear();
  }

  #resolve(toolName: string, riskOverrides: RaftConfig["safety"]["toolRisks"]): ResolvedRaftAction {
    const metadata = this.pi.getAllTools().find((tool) => tool.name === toolName);
    const builtin = metadata?.sourceInfo.source === "builtin";
    const provider = builtin ? "pi" : "extensions";
    const ref = provider + "." + toolName;
    return {
      ref,
      provider,
      name: toolName,
      description: metadata?.description ?? "Direct Pi tool: " + toolName,
      inputSchema: isRecord(metadata?.parameters) ? metadata.parameters : {},
      risk: resolveToolRisk(ref, defaultToolRisk(ref), riskOverrides),
    };
  }
}
