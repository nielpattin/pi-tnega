import { spawn, execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Cause, Data, Effect, Exit } from "effect";

export class ClipboardError extends Data.TaggedError("ClipboardError")<{
   readonly message: string;
   readonly cause: Error;
}> {}

export interface ClipboardCommand {
   command: string;
   args: string[];
   options?: { windowsHide?: boolean; shell?: boolean };
}

function hasCommand(command: string): boolean {
   try {
      const isWin = process.platform === "win32";
      const checkCmd = isWin ? `where ${command}` : `which ${command}`;
      execSync(checkCmd, { stdio: "ignore" });
      return true;
   } catch {
      return false;
   }
}

export function resolveClipboardCommand(
   platform: string = process.platform,
   env: Record<string, string | undefined> = process.env,
   checker: (cmd: string) => boolean = hasCommand
): ClipboardCommand {
   if (platform === "win32") {
      if (checker("powershell")) {
         // `$input` + InputEncoding still mangles UTF-8 stdin under some code pages.
         // StreamReader with explicit UTF-8 preserves CJK / emoji.
         return {
            command: "powershell",
            args: [
               "-NoProfile",
               "-Command",
               "$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8); $text = $reader.ReadToEnd(); $reader.Close(); Set-Clipboard -Value $text"
            ],
            options: { windowsHide: true }
         };
      }
      return {
         command: "clip",
         args: [],
         options: { windowsHide: true }
      };
   }

   if (platform === "darwin") {
      return { command: "pbcopy", args: [] };
   }

   if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
      if (env.WAYLAND_DISPLAY && checker("wl-copy")) {
         return { command: "wl-copy", args: [] };
      }
      if (checker("xclip")) {
         return { command: "xclip", args: ["-selection", "clipboard"] };
      }
      if (checker("xsel")) {
         return { command: "xsel", args: ["-b"] };
      }
      return { command: "wl-copy", args: [] };
   }

   return { command: "pbcopy", args: [] };
}

export function textFromContent(content: unknown) {
   if (typeof content === "string") return content;
   if (!Array.isArray(content)) return "";

   return content
      .map((block) => {
         if (!block || typeof block !== "object") return "";
         if (!("type" in block)) return "";

         if (block.type === "text" && "text" in block && typeof block.text === "string") {
            return block.text;
         }

         if (block.type === "image") return "[image]";

         return "";
      })
      .filter(Boolean)
      .join("\n");
}

export function copyToClipboard(
   text: string,
   platform: string = process.platform,
   env: Record<string, string | undefined> = process.env,
   checker: (cmd: string) => boolean = hasCommand,
   spawnImpl = spawn
) {
   return Effect.callback<void, ClipboardError>((resume) => {
      const cmdSpec = resolveClipboardCommand(platform, env, checker);
      const child = spawnImpl(cmdSpec.command, cmdSpec.args, {
         stdio: ["pipe", "ignore", "pipe"],
         ...cmdSpec.options
      });
      let stderr = "";

      child.stderr?.on("data", (chunk: any) => {
         stderr += String(chunk);
      });

      child.on("error", (error: Error) =>
         resume(Effect.fail(new ClipboardError({ message: error.message, cause: error })))
      );
      child.on("close", (code: number) => {
         if (code === 0) {
            resume(Effect.void);
         } else {
            resume(
               Effect.fail(
                  new ClipboardError({
                     message: stderr.trim() || `${cmdSpec.command} exited with code ${code}`,
                     cause: new Error(stderr.trim() || `${cmdSpec.command} exited with code ${code}`)
                  })
               )
            );
         }
      });

      // Always write UTF-8 bytes so Windows PowerShell can decode with Encoding.UTF8.
      child.stdin?.end(Buffer.from(text, "utf8"));

      return Effect.sync(() => {
         if (child.exitCode === null && typeof child.kill === "function") {
            child.kill();
         }
      });
   });
}

async function runClipboardCopy(text: string, signal: AbortSignal | undefined) {
   const exit = await Effect.runPromiseExit(copyToClipboard(text), signal ? { signal } : undefined);
   if (Exit.isSuccess(exit)) return;
   if (Cause.hasInterruptsOnly(exit.cause)) {
      throw new Error("Copy was cancelled.");
   }
   const [first] = Cause.prettyErrors(exit.cause);
   throw new Error(first?.message ?? Cause.pretty(exit.cause));
}

export default function (pi: ExtensionAPI) {
   pi.registerCommand("copy-all", {
      description: "Copy all previous user and assistant messages in this thread to the clipboard",
      handler: async (_args, ctx) => {
         await ctx.waitForIdle();

         const sections = ctx.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message)
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({
               role: message.role,
               content: textFromContent(message.content).trim()
            }))
            .filter(({ content }) => content)
            .map(({ role, content }) => `${role.toUpperCase()}:\n${content}`);

         if (sections.length === 0) {
            ctx.ui.notify("No user or assistant messages to copy", "info");
            return;
         }

         await runClipboardCopy(sections.join("\n\n---\n\n"), ctx.signal);
         ctx.ui.notify(`Copied ${sections.length} messages to clipboard`, "info");
      }
   });
}
