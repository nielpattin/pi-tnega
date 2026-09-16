import { expect, it } from "vitest";
import {
  createMemoryProvider,
  createMemorySourceClient,
  createMemorySourceRegistry,
  memoryActionSchemas,
} from "../src/memory.js";
import type { RaftInvocationContext } from "../src/protocol.js";
import { messageEntry, sessionHeader, userMessage } from "./fixtures/memory.js";

const context: RaftInvocationContext = {
  cwd: "/work/fake",
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as RaftInvocationContext["extensionContext"],
  update() {},
};
it("uses canonical descriptors and fences dispatcher results and unknown actions", async () => {
  let stopped = false;
  const provider = createMemoryProvider({
    check() {
      if (stopped) throw new Error("paused");
    },
    async dispatch() {
      stopped = true;
      return "private";
    },
  });
  for (const name of ["recall", "expand"] as const) {
    expect(await provider.describe(name, context)).toMatchObject(memoryActionSchemas[name]);
  }
  await expect(provider.invoke("walk", {}, context)).rejects.toThrow("Unknown memory action");
  await expect(provider.invoke("recall", {}, context)).rejects.toThrow("paused");
  const controller = new AbortController();
  const aborting = createMemoryProvider({
    async dispatch() {
      controller.abort();
      return "private";
    },
  });
  await expect(
    aborting.invoke("recall", {}, { ...context, signal: controller.signal }),
  ).rejects.toThrow();
});

it("observes live leaf navigation without revision changes in recall and expansion", async () => {
  let selectedLeafId: string | null = "a";
  const records = [
    sessionHeader("s", "/work/fake"),
    messageEntry("root", null, "2024-01-01", userMessage("root")),
    messageEntry("a", "root", "2024-01-02", userMessage("alpha")),
    messageEntry("b", "root", "2024-01-03", userMessage("beta")),
  ];
  const sources = createMemorySourceRegistry();
  sources.register({
    interfaceVersion: 1,
    id: "live",
    async listSessions() {
      return [{ sessionKey: "s", revision: "same" }];
    },
    async loadSession() {
      return { sessionKey: "s", revision: "same", records, selectedLeafId };
    },
  });
  const client = createMemorySourceClient({ sources });
  const recall = () =>
    client.recall({ source: "live", scope: "session:s", query: "alpha" }) as Promise<any>;
  const first = await recall();
  expect(first.hits).toHaveLength(1);
  const follow = first.hits[0].follow.args;
  const expanded = (await client.expand(follow)) as any;
  expect(expanded.entries[0].entryId).toBe("a");
  selectedLeafId = "b";
  expect((await recall()).hits).toHaveLength(0);
  expect(await client.expand(follow)).toMatchObject({
    error: { code: "stale_pointer" },
    entries: [],
  });
  expect(await client.recall({ source: "live", branches: "all", query: "alpha" })).toMatchObject({
    total: 1,
  });
  selectedLeafId = null;
  expect(await client.expand({ source: "live", session: "s" })).toMatchObject({ entryCount: 0 });
  selectedLeafId = "missing";
  expect(await client.expand({ source: "live", session: "s" })).toMatchObject({
    error: { code: "invalid_source_response" },
  });
});
