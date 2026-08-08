import * as net from "node:net";

export function checkLogReady(logText: string, pattern?: string): boolean {
   if (!pattern) return true;
   try {
      const regex = new RegExp(pattern);
      return regex.test(logText);
   } catch {
      return logText.includes(pattern);
   }
}

export function checkPortReady(port: number, host = "127.0.0.1"): Promise<boolean> {
   return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let resolved = false;

      const cleanup = () => {
         socket.removeAllListeners();
         socket.destroy();
      };

      socket.setTimeout(200);
      socket.once("connect", () => {
         if (!resolved) {
            resolved = true;
            cleanup();
            resolve(true);
         }
      });

      socket.once("error", () => {
         if (!resolved) {
            resolved = true;
            cleanup();
            resolve(false);
         }
      });

      socket.once("timeout", () => {
         if (!resolved) {
            resolved = true;
            cleanup();
            resolve(false);
         }
      });

      socket.connect(port, host);
   });
}
