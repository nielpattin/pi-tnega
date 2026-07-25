import { Context, Deferred, Effect, Layer } from "effect";
import type { MailboxMessage } from "../domain.js";

export interface MailBusShape {
   readonly send: (message: Omit<MailboxMessage, "id" | "timestamp" | "consumed">) => Effect.Effect<MailboxMessage>;
   readonly inbox: (
      recipientId: string,
      options?: { peek?: boolean; limit?: number }
   ) => Effect.Effect<ReadonlyArray<MailboxMessage>>;
   readonly listPeers: Effect.Effect<ReadonlyArray<string>>;
   readonly awaitFrom: (
      recipientId: string,
      senderId: string,
      timeoutMs?: number
   ) => Effect.Effect<MailboxMessage, Error>;
}

const MAX_MAILBOX_SIZE = 100;

interface Waiter {
   readonly recipientId: string;
   readonly senderId: string;
   readonly deferred: Deferred.Deferred<MailboxMessage>;
}

export class MailBus extends Context.Service<MailBus, MailBusShape>()("harbor/MailBus") {
   static readonly layer = Layer.effect(
      MailBus,
      Effect.gen(function* () {
         yield* Effect.void;
         const mailboxes = new Map<string, MailboxMessage[]>();
         const waiters = new Set<Waiter>();
         let messageIdCounter = 0;

         const getMailbox = (recipientId: string): MailboxMessage[] => {
            let box = mailboxes.get(recipientId);
            if (!box) {
               box = [];
               mailboxes.set(recipientId, box);
            }
            return box;
         };

         const send = Effect.fn("MailBus.send")((params: Omit<MailboxMessage, "id" | "timestamp" | "consumed">) =>
            Effect.gen(function* () {
               messageIdCounter++;
               const message: MailboxMessage = {
                  id: `msg-${Date.now()}-${messageIdCounter}`,
                  senderId: params.senderId,
                  recipientId: params.recipientId,
                  payload: params.payload,
                  replyTo: params.replyTo,
                  timestamp: Date.now(),
                  consumed: false
               };

               const box = getMailbox(params.recipientId);
               box.push(message);
               if (box.length > MAX_MAILBOX_SIZE) {
                  box.splice(0, box.length - MAX_MAILBOX_SIZE);
               }

               // Notify matching waiters
               for (const waiter of Array.from(waiters)) {
                  if (waiter.recipientId === params.recipientId && waiter.senderId === params.senderId) {
                     const idx = box.findIndex((m) => m.id === message.id);
                     if (idx !== -1) {
                        box[idx] = { ...box[idx], consumed: true };
                     }
                     waiters.delete(waiter);
                     yield* Deferred.succeed(waiter.deferred, message);
                     break;
                  }
               }

               return message;
            })
         );

         const inbox = Effect.fn("MailBus.inbox")((recipientId: string, options?: { peek?: boolean; limit?: number }) =>
            Effect.sync(() => {
               const box = getMailbox(recipientId);
               const peek = options?.peek ?? false;
               const limit = options?.limit;

               let unconsumed = box.filter((m) => !m.consumed);
               if (limit && limit > 0) {
                  unconsumed = unconsumed.slice(0, limit);
               }

               if (!peek) {
                  const idsToConsume = new Set(unconsumed.map((m) => m.id));
                  for (let i = 0; i < box.length; i++) {
                     if (idsToConsume.has(box[i].id)) {
                        box[i] = { ...box[i], consumed: true };
                     }
                  }
               }

               return unconsumed;
            })
         );

         const listPeers = Effect.sync(() => {
            const peers = new Set<string>();
            for (const [recipient, box] of mailboxes.entries()) {
               peers.add(recipient);
               for (const msg of box) {
                  peers.add(msg.senderId);
               }
            }
            return Array.from(peers);
         });

         const awaitFrom = Effect.fn("MailBus.awaitFrom")((recipientId: string, senderId: string, timeoutMs?: number) =>
            Effect.gen(function* () {
               const box = getMailbox(recipientId);

               // 1. Check inbox first
               const existingIdx = box.findIndex((m) => !m.consumed && m.senderId === senderId);
               if (existingIdx !== -1) {
                  const msg = box[existingIdx];
                  box[existingIdx] = { ...msg, consumed: true };
                  return msg;
               }

               // 2. Register waiter
               const deferred = yield* Deferred.make<MailboxMessage>();
               const waiter: Waiter = { recipientId, senderId, deferred };
               waiters.add(waiter);

               // 3. Recheck inbox after registration
               const recheckIdx = box.findIndex((m) => !m.consumed && m.senderId === senderId);
               if (recheckIdx !== -1) {
                  waiters.delete(waiter);
                  const msg = box[recheckIdx];
                  box[recheckIdx] = { ...msg, consumed: true };
                  return msg;
               }

               // 4. Await with ensuring for cleanup
               return yield* Effect.gen(function* () {
                  if (timeoutMs && timeoutMs > 0) {
                     return yield* Deferred.await(deferred).pipe(
                        Effect.timeout(`${timeoutMs} millis`),
                        Effect.catchTag("TimeoutError", () =>
                           Effect.fail(new Error(`Timeout waiting for message from ${senderId}`))
                        )
                     );
                  }
                  return yield* Deferred.await(deferred);
               }).pipe(
                  Effect.ensuring(
                     Effect.sync(() => {
                        waiters.delete(waiter);
                     })
                  )
               );
            })
         );

         return MailBus.of({
            send,
            inbox,
            listPeers,
            awaitFrom
         });
      })
   );

   static override use<A, E, R>(fn: (svc: MailBusShape) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R | MailBus> {
      return Effect.gen(function* () {
         const svc = yield* MailBus;
         return yield* fn(svc);
      });
   }
}
