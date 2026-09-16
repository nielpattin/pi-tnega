import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piRaft from "../src/index.js";
import { RAFT_COMPONENT_REGISTER_EVENT } from "../src/protocol.js";

type ExtensionHandler = (...args: never[]) => unknown;

describe("Pi Raft extension shutdown", () => {
  it("unsubscribes the shared component listener across reloads", async () => {
    const componentListeners = new Set<(value: unknown) => void>();
    const events = {
      emit: vi.fn(),
      on: vi.fn((channel: string, handler: (value: unknown) => void) => {
        if (channel === RAFT_COMPONENT_REGISTER_EVENT) componentListeners.add(handler);
        return () => componentListeners.delete(handler);
      }),
    };

    for (let reload = 0; reload < 3; reload++) {
      const handlers = new Map<string, ExtensionHandler[]>();
      const pi = {
        events,
        getActiveTools: vi.fn(() => []),
        getAllTools: vi.fn(() => []),
        on: vi.fn((event: string, handler: ExtensionHandler) => {
          const registered = handlers.get(event) ?? [];
          registered.push(handler);
          handlers.set(event, registered);
        }),
        registerCommand: vi.fn(),
        registerMessageRenderer: vi.fn(),
        registerTool: vi.fn(),
        setActiveTools: vi.fn(),
      } as unknown as ExtensionAPI;

      await piRaft(pi);
      expect(componentListeners.size).toBe(1);

      const shutdownHandlers = handlers.get("session_shutdown") ?? [];
      expect(shutdownHandlers.length).toBeGreaterThan(0);
      for (const shutdownHandler of shutdownHandlers) await shutdownHandler();
      expect(componentListeners.size).toBe(0);
    }
  });
});
