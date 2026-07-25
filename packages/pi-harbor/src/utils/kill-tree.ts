import { spawn, type ChildProcess } from "node:child_process";

export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
   if (process.platform === "win32" && child.pid) {
      try {
         const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true
         });
         killer.on("error", () => {
            try {
               child.kill(signal);
            } catch {
               // ignore
            }
         });
         killer.unref();
         return;
      } catch {
         // Fall through
      }
   }
   if (process.platform !== "win32" && child.pid) {
      try {
         process.kill(-child.pid, signal);
         return;
      } catch {
         // Fall through
      }
   }
   try {
      child.kill(signal);
   } catch {
      // ignore
   }
}
