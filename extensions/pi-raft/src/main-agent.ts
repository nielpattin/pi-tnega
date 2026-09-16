import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface RaftHostIdentity {
  id: string;
  name: string;
  kind: "main" | "agent";
  sessionId?: string;
}

const MAIN_AGENT_ALIAS = "main";
type RaftAgentMessageDelivery = "steer" | "followUp";

export interface RaftMainAgentInfo {
  id: string;
  name: "Main";
  kind: "main";
  status: "idle" | "running" | "remote";
  runner: "pi";
  transport: "host";
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt?: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: boolean;
}

export interface RaftMainAgentDeliveryRequest {
  from: RaftHostIdentity;
  message: string;
  delivery: RaftAgentMessageDelivery;
  triggerTurn?: boolean;
  data?: unknown;
}

export interface RaftAgentMessageResult {
  queued: true;
  messageId: string;
  routed: "local" | "main";
  acknowledged?: boolean;
}

export interface RaftMainModelSwitchResult {
  ok: boolean;
  error?: string;
}

interface RaftMainAgentTarget {
  readonly id: string;
  readonly local: boolean;
  matches(id: string): boolean;
  info(context?: ExtensionContext): RaftMainAgentInfo;
  deliverAgent(request: RaftMainAgentDeliveryRequest): RaftAgentMessageResult;
  // Switch Main's live session model in place. Only local hosts hold the pi
  // extension session required for the mutation, so remote targets omit it.
  switchModel?(
    target: { provider: string; id: string },
    context: ExtensionContext,
  ): Promise<RaftMainModelSwitchResult>;
}

export interface RaftIdentityResolution {
  identity: RaftHostIdentity;
  mainAgentId: string;
}

export const resolveRaftIdentity = (
  sessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): RaftIdentityResolution => {
  const parentAgentId = environment.PI_RAFT_PARENT_RUN?.trim();
  const identity: RaftHostIdentity = parentAgentId
    ? {
        id: parentAgentId,
        name: environment.PI_RAFT_AGENT_NAME?.trim() || parentAgentId.slice(0, 8),
        kind: "agent",
        sessionId,
      }
    : { id: `session:${sessionId}`, name: "main", kind: "main", sessionId };
  const inheritedMainAgentId = environment.PI_RAFT_MAIN_AGENT_ID?.trim();
  return {
    identity,
    mainAgentId:
      inheritedMainAgentId || (identity.kind === "main" ? identity.id : `session:${sessionId}`),
  };
};

const escapeXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const serializableData = (value: unknown): unknown => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : (JSON.parse(serialized) as unknown);
  } catch {
    return { raftUnserializable: true };
  }
};

export class MainAgentController implements RaftMainAgentTarget {
  readonly startedAt = Date.now();

  constructor(
    readonly pi: ExtensionAPI,
    readonly id: string,
    readonly local: boolean,
    readonly cwd: string,
    readonly sessionId?: string,
  ) {}

  matches(id: string): boolean {
    const target = id.trim();
    return target === MAIN_AGENT_ALIAS || target === this.id;
  }

  info(context?: ExtensionContext): RaftMainAgentInfo {
    const model =
      this.local && context?.model ? `${context.model.provider}/${context.model.id}` : undefined;
    const thinking = this.local ? this.pi.getThinkingLevel() : undefined;
    return {
      id: this.id,
      name: "Main",
      kind: "main",
      status: this.local ? (context?.isIdle() === false ? "running" : "idle") : "remote",
      runner: "pi",
      transport: "host",
      ...(this.local ? { cwd: this.cwd, startedAt: this.startedAt } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      updatedAt: Date.now(),
      pendingMessages: this.local ? (context?.hasPendingMessages() ?? false) : false,
      local: this.local,
    };
  }

  async switchModel(
    target: { provider: string; id: string },
    context: ExtensionContext,
  ): Promise<RaftMainModelSwitchResult> {
    if (!this.local) {
      return { ok: false, error: `Main agent ${this.id} is owned by another Raft process` };
    }
    const key = `${target.provider}/${target.id}`;
    const model = context.modelRegistry.find(target.provider, target.id);
    if (!model) return { ok: false, error: `Model is not available: ${key}` };
    const switched = await this.pi.setModel(model);
    if (!switched) return { ok: false, error: `No authentication configured for model: ${key}` };
    return { ok: true };
  }

  deliverAgent(request: RaftMainAgentDeliveryRequest): RaftAgentMessageResult {
    if (!this.local) throw new Error(`Main agent ${this.id} is owned by another Raft process`);
    const message = request.message.trim();
    if (!message) throw new Error("Main agent message must not be empty");
    const messageId = randomUUID();
    const data = request.data === undefined ? undefined : serializableData(request.data);
    this.pi.sendMessage(
      {
        customType: "pi-raft-agent-message",
        content: [
          `<raft-agent-message from_name=${JSON.stringify(request.from.name)} from_id=${JSON.stringify(request.from.id)} from_kind=${JSON.stringify(request.from.kind)}>`,
          escapeXmlText(message),
          data === undefined ? undefined : `<data>${escapeXmlText(JSON.stringify(data))}</data>`,
          "</raft-agent-message>",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        display: true,
        details: {
          id: messageId,
          from: structuredClone(request.from),
          delivery: request.delivery,
          triggerTurn: request.triggerTurn ?? true,
          ...(data === undefined ? {} : { data }),
        },
      },
      { deliverAs: request.delivery, triggerTurn: request.triggerTurn ?? true },
    );
    return { queued: true, messageId, routed: "main" };
  }
}
