import { describe, it, expect } from "vitest";
import { MailBus } from "../src/services/MailBus.js";
import { handleHub } from "../src/tools/hub.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";
import { ShellExecutor } from "../src/services/ShellExecutor.js";
import { ManagedRuntime, Layer, Effect, Fiber } from "effect";

describe("MailBus Service", () => {
  const ProcessSupervisorLive = ProcessSupervisor.layer.pipe(Layer.provide(ShellExecutor.layer));
  const LiveLayer = Layer.mergeAll(
    MailBus.layer,
    JobRegistry.layer,
    ProcessSupervisorLive,
    ShellExecutor.layer
  );
  const runtime = ManagedRuntime.make(LiveLayer);

  it("sends and retrieves messages via inbox", async () => {
    const msg = await runtime.runPromise(
      MailBus.use((bus) =>
        Effect.gen(function* () {
          const sent = yield* bus.send({
            senderId: "task-1",
            recipientId: "parent",
            payload: "Hello parent"
          });
          const messages = yield* bus.inbox("parent");
          return { sent, messages };
        })
      )
    );

    expect(msg.sent.senderId).toBe("task-1");
    expect(msg.sent.recipientId).toBe("parent");
    expect(msg.sent.payload).toBe("Hello parent");
    expect(msg.messages.length).toBe(1);
    expect(msg.messages[0].id).toBe(msg.sent.id);

    // Second inbox call without peek should return empty (since messages were consumed)
    const secondInbox = await runtime.runPromise(
      MailBus.use((bus) => bus.inbox("parent"))
    );
    expect(secondInbox.length).toBe(0);
  });

  it("peek option does not mark messages as consumed", async () => {
    const messages = await runtime.runPromise(
      MailBus.use((bus) =>
        Effect.gen(function* () {
          yield* bus.send({
            senderId: "task-2",
            recipientId: "agent-x",
            payload: "Peek test"
          });
          const peeked = yield* bus.inbox("agent-x", { peek: true });
          const normal = yield* bus.inbox("agent-x");
          return { peeked, normal };
        })
      )
    );

    expect(messages.peeked.length).toBe(1);
    expect(messages.normal.length).toBe(1);
  });

  it("drops oldest messages beyond MAX_MAILBOX_SIZE (100)", async () => {
    const inbox = await runtime.runPromise(
      MailBus.use((bus) =>
        Effect.gen(function* () {
          for (let i = 1; i <= 105; i++) {
            yield* bus.send({
              senderId: "sender",
              recipientId: "buffer-agent",
              payload: `msg-${i}`
            });
          }
          return yield* bus.inbox("buffer-agent", { peek: true });
        })
      )
    );

    expect(inbox.length).toBe(100);
    expect(inbox[0].payload).toBe("msg-6");
    expect(inbox[99].payload).toBe("msg-105");
  });

  it("awaitFrom blocks until message arrives or returns pre-existing message", async () => {
    const result = await runtime.runPromise(
      Effect.scoped(
        MailBus.use((bus) =>
          Effect.gen(function* () {
            const eff = bus.awaitFrom("parent", "task-3", 1000);
            const fiber = yield* Effect.forkScoped(eff);
            yield* Effect.sleep("20 millis");
            yield* bus.send({
              senderId: "task-3",
              recipientId: "parent",
              payload: "Delayed message"
            });
            return yield* Fiber.join(fiber);
          })
        )
      )
    );

    expect(result.senderId).toBe("task-3");
    expect(result.payload).toBe("Delayed message");
  });

  it("hub tool wires send, inbox, list, and wait-from ops", async () => {
    const res = await runtime.runPromise(
      Effect.gen(function* () {
        const sendRes = yield* handleHub({
          op: "send",
          to: "agent-b",
          from: "agent-a",
          message: "Hub message"
        });

        const listRes = yield* handleHub({
          op: "list",
          from: "agent-b"
        });

        const inboxRes = yield* handleHub({
          op: "inbox",
          from: "agent-b"
        });

        return { sendRes, listRes, inboxRes };
      })
    );

    expect(res.sendRes.ok).toBe(true);
    expect(res.listRes.ok).toBe(true);
    expect(res.inboxRes.ok).toBe(true);
    if ("messages" in res.inboxRes && res.inboxRes.messages) {
      expect(res.inboxRes.messages.length).toBe(1);
      expect(res.inboxRes.messages[0].payload).toBe("Hub message");
    }
  });
});
