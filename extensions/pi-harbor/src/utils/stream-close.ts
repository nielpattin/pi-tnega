import type { EventEmitter } from "node:events";

export function awaitStreamClose(emitter: EventEmitter, timeoutMs = 5000): Promise<boolean> {
   return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;

      const onClose = () => {
         if (timer) clearTimeout(timer);
         emitter.off("close", onClose);
         emitter.off("error", onClose);
         resolve(true);
      };

      timer = setTimeout(() => {
         emitter.off("close", onClose);
         emitter.off("error", onClose);
         resolve(false);
      }, timeoutMs);

      emitter.once("close", onClose);
      emitter.once("error", onClose);
   });
}
