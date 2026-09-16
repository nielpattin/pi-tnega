import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerRaftCommand } from "../src/commands/raft.js";
import type { RaftState } from "../src/raft-state.js";
import type { RaftUiController } from "../src/ui/controller.js";

describe("/raft command", () => {
  it("opens the dashboard when invoked without arguments", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (
          _name: string,
          definition: {
            handler: (argumentsText: string, context: ExtensionContext) => Promise<void>;
          },
        ) => {
          handler = definition.handler;
        },
      ),
    } as unknown as ExtensionAPI;
    const state = { ensure: vi.fn().mockResolvedValue(undefined) } as unknown as RaftState;
    const raftUi = {
      openDashboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as RaftUiController;
    const context = {} as ExtensionContext;

    registerRaftCommand(pi, { state, raftUi });
    expect(handler).toBeDefined();
    expect(
      (pi as unknown as { registerCommand: ReturnType<typeof vi.fn> }).registerCommand,
    ).toHaveBeenCalledWith("raft", expect.anything());

    await handler!("", context);

    expect((state as unknown as { ensure: ReturnType<typeof vi.fn> }).ensure).toHaveBeenCalledWith(
      context,
    );
    expect(
      (raftUi as unknown as { openDashboard: ReturnType<typeof vi.fn> }).openDashboard,
    ).toHaveBeenCalledWith(context);
  });

  it("keeps the /raft ui dashboard alias", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const state = { ensure: vi.fn().mockResolvedValue(undefined) } as unknown as RaftState;
    const raftUi = {
      openDashboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as RaftUiController;
    const context = {} as ExtensionContext;

    registerRaftCommand(pi, { state, raftUi });
    await handler!("ui", context);

    expect(
      (raftUi as unknown as { openDashboard: ReturnType<typeof vi.fn> }).openDashboard,
    ).toHaveBeenCalledWith(context);
  });

  it("escalates a pending kernel switch to Pi reload and returns from the old context", async () => {
    let handler: any;
    const pi = {
      registerCommand: (_name: string, definition: any) => {
        handler = definition.handler;
      },
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn(async () => {}),
      initialize: vi.fn(async () => {}),
      kernelReloadRequired: true,
    } as unknown as RaftState;
    const reload = vi.fn(async () => {});
    const notify = vi.fn();
    const refreshToolDisplay = vi.fn();
    registerRaftCommand(pi, {
      state,
      raftUi: { stop: vi.fn() } as unknown as RaftUiController,
      refreshToolDisplay,
    });
    await handler("reload", { reload, ui: { notify } });
    expect(reload).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(refreshToolDisplay).not.toHaveBeenCalled();
  });

  it("lets the activation hook own reload setup and keeps failure suspended", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, command) => {
        handler = command.handler;
      }),
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockRejectedValue(new Error("reload failed")),
    } as unknown as RaftState;
    const raftUi = { stop: vi.fn(), start: vi.fn() } as unknown as RaftUiController;
    const context = {} as ExtensionContext;

    registerRaftCommand(pi, { state, raftUi });

    await expect(handler!("reload", context)).rejects.toThrow("reload failed");
    expect((raftUi as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledTimes(2);
    expect((raftUi as unknown as { start: ReturnType<typeof vi.fn> }).start).not.toHaveBeenCalled();
  });

  it("re-renders existing cards after a successful reload so external edits apply", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, command) => {
        handler = command.handler;
      }),
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
    } as unknown as RaftState;
    const raftUi = { stop: vi.fn(), start: vi.fn() } as unknown as RaftUiController;
    const refreshToolDisplay = vi.fn();
    const notify = vi.fn();
    const context = { ui: { notify } } as unknown as ExtensionContext;

    registerRaftCommand(pi, { state, raftUi, refreshToolDisplay });

    await handler!("reload", context);
    expect(
      (state as unknown as { initialize: ReturnType<typeof vi.fn> }).initialize,
    ).toHaveBeenCalledWith(context);
    expect(notify).toHaveBeenCalledWith("Pi Raft reloaded", "info");
    expect(refreshToolDisplay).toHaveBeenCalledOnce();
  });

  it("registers no dedicated display subcommand or completion", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    let completions: ((prefix: string) => Array<{ value: string }> | null) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (
          _name: string,
          definition: { handler: typeof handler; getArgumentCompletions: typeof completions },
        ) => {
          handler = definition.handler;
          completions = definition.getArgumentCompletions;
        },
      ),
    } as unknown as ExtensionAPI;
    const state = {
      initialized: true,
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { ui: { toolDisplay: "full" } },
      reloadConfig: vi.fn(),
    } as unknown as RaftState;
    const refreshToolDisplay = vi.fn();
    const notify = vi.fn();
    const context = {
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify },
    } as unknown as ExtensionContext;

    registerRaftCommand(pi, { state, raftUi: {} as RaftUiController, refreshToolDisplay });

    expect(completions!("dis")).toBeNull();
    await handler!("display compact", context);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /raft"), "warning");
    expect(
      (state as unknown as { reloadConfig: ReturnType<typeof vi.fn> }).reloadConfig,
    ).not.toHaveBeenCalled();
    expect(refreshToolDisplay).not.toHaveBeenCalled();
  });
});
