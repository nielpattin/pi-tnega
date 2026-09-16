import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import piRaft from "../../src/index.js";
// A fake model/provider + agent-loop fixture. It boots the REAL Raft
// extension against a scripted host, then replays exactly the host events a
// live Pi turn emits around one model tool call: the real registered
// raft_exec tool executes the program, its content is handed back as the
// model-visible tool result, and tool_execution_end / turn_end fire at the
// turn boundary. No provider stream, model, or network request is ever made;
// the "model" is the caller's scripted list of raft_exec programs.

type ExtensionHandler = (event: any, context: ExtensionContext) => unknown;

export interface FakeAgentToolResult {
  content: Array<{ type: string; text?: string }>;
  details: Record<string, any>;
  isError?: boolean;
}

export interface FakeAgentLoop {
  context: ExtensionContext;
  /** Replay one model turn that emits a single raft_exec tool call. */
  prompt(code: string): Promise<FakeAgentToolResult>;
  shutdown(): Promise<void>;
}

export interface FakeAgentLoopOptions {
  cwd: string;
  agentDir: string;
  sessionId?: string;
}

export const createFakeAgentLoop = async (
  options: FakeAgentLoopOptions,
): Promise<FakeAgentLoop> => {
  const handlers = new Map<string, ExtensionHandler[]>();
  const registeredTools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const events = { emit: vi.fn(), on: vi.fn(() => () => {}) };
  const pi = {
    events,
    getActiveTools: vi.fn(() => ["raft_exec"]),
    getAllTools: vi.fn(() => []),
    getThinkingLevel: vi.fn(() => "off"),
    on: vi.fn((event: string, handler: ExtensionHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
      registeredTools.set(tool.name, tool);
    }),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setActiveTools: vi.fn(),
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(() => undefined),
    setLabel: vi.fn(),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  } as unknown as ExtensionAPI;

  await piRaft(pi);

  const context = {
    mode: "code",
    cwd: options.cwd,
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "fake-agent-loop",
      getBranch: () => [],
      getSessionFile: () => undefined,
      getLeafId: () => undefined,
    },
    modelRegistry: {
      getAvailable: () => [],
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "fake-key", headers: {} })),
    },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: unknown = {}): Promise<void> => {
    for (const handler of handlers.get(name) ?? []) await handler(event, context);
  };

  await emit("session_start");
  const raftTool = registeredTools.get("raft_exec");
  if (!raftTool) throw new Error("fake agent loop: raft_exec was never registered");

  let sequence = 0;
  const prompt = async (code: string): Promise<FakeAgentToolResult> => {
    const toolCallId = `fake-model-call-${++sequence}`;
    const result = (await raftTool.execute(
      toolCallId,
      { code },
      undefined,
      undefined,
      context,
    )) as FakeAgentToolResult;
    const isError = result.isError === true || result.details?.success === false;
    await emit("tool_execution_end", {
      toolName: "raft_exec",
      toolCallId,
      isError,
      input: { code },
      result: result.content,
    });
    await emit("turn_end", {});
    return result;
  };

  const shutdown = async (): Promise<void> => {
    await emit("session_shutdown");
  };

  return { context, prompt, shutdown };
};
