import { spawn } from "node:child_process";
// Local alias — recent @types/node marks ChildProcess as a deprecated
// "error" type. Use the inferred spawn return type instead.
type ChildProcess = ReturnType<typeof spawn>;

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
