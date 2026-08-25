import { spawn } from "node:child_process";

export async function copyToClipboard(text: string): Promise<boolean> {
   return new Promise((resolve) => {
      let command = "";
      let args: string[] = [];

      if (process.platform === "win32") {
         command = "powershell";
         args = [
            "-NoProfile",
            "-Command",
            "$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8); $text = $reader.ReadToEnd(); $reader.Close(); Set-Clipboard -Value $text"
         ];
      } else if (process.platform === "darwin") {
         command = "pbcopy";
      } else {
         command = "xclip";
         args = ["-selection", "clipboard"];
      }

      try {
         const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
         child.on("error", () => resolve(false));
         child.on("close", (code) => resolve(code === 0));
         child.stdin?.end(Buffer.from(text, "utf8"));
      } catch {
         resolve(false);
      }
   });
}
