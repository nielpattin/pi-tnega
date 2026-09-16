import path from "node:path";
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readRaftExecutionTraceV1 } from "../audit/index.js";
import { NESTED_TOOL_CALL_ID_PREFIX } from "./action-registry.js";

export interface RaftTopLevelToolAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
}

export interface RaftTopLevelToolApprover {
  approve(event: ToolCallEvent, context: ExtensionContext): Promise<void>;
}

const RAFT_TOOL_NAME = "raft_exec";
const TOP_LEVEL_SCHEMA_REF_PREFIX = "schema.top_level_tool.";

export const ownsRaftToolSource = (
  tools: Array<{ name: string; sourceInfo: { path: string } }>,
  extensionEntryPath: string,
): boolean =>
  tools.some(
    (tool) =>
      tool.name === RAFT_TOOL_NAME &&
      path.resolve(tool.sourceInfo.path) === path.resolve(extensionEntryPath),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finalRaftDetailsFailed = (details: unknown): boolean => {
  if (!isRecord(details)) return false;
  if (details.success === false) return true;
  const trace = readRaftExecutionTraceV1(details.trace);
  return trace !== undefined && trace.outcome !== "succeeded";
};

export class RaftToolLifecycle {
  readonly #outerCalls = new Set<string>();

  constructor(
    readonly ownsRaftTool: () => boolean,
    readonly authorizer: () => RaftTopLevelToolAuthorizer | undefined,
    readonly approver: () => RaftTopLevelToolApprover | undefined = () => undefined,
  ) {}

  async toolCall(
    event: ToolCallEvent,
    context?: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> {
    if (event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)) {
      if (this.#outerCalls.size > 0) return undefined;
      await this.#authorizeTopLevel(event);
      return undefined;
    }
    if (event.toolName === RAFT_TOOL_NAME && this.ownsRaftTool()) {
      this.#outerCalls.add(event.toolCallId);
      return undefined;
    }
    await this.#authorizeTopLevel(event);
    const approver = this.approver();
    if (approver) {
      if (!context) throw new Error("Raft direct tool approval needs an extension context");
      await approver.approve(event, context);
    }
    return undefined;
  }

  toolResult(event: ToolResultEvent): { isError: true } | undefined {
    if (
      event.toolName !== RAFT_TOOL_NAME ||
      event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX) ||
      !this.#outerCalls.delete(event.toolCallId)
    ) {
      return undefined;
    }
    return !event.isError && finalRaftDetailsFailed(event.details) ? { isError: true } : undefined;
  }

  clear(): void {
    this.#outerCalls.clear();
  }

  async #authorizeTopLevel(event: ToolCallEvent): Promise<void> {
    await this.authorizer()?.authorize(
      `${TOP_LEVEL_SCHEMA_REF_PREFIX}${event.toolName}`,
      event.toolCallId,
    );
  }
}
