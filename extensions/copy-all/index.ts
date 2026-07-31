import { spawn, execSync } from "node:child_process";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
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

/**
 * Format compaction-aware context entries for clipboard copy.
 *
 * Callers should pass `sessionManager.buildContextEntries()` so pre-compaction
 * history is already dropped. Includes the latest compaction summary (if any)
 * plus user/assistant messages in the active window.
 */
export function formatCopySections(entries: readonly SessionEntry[]): string[] {
   const sections: string[] = [];

   for (const entry of entries) {
      if (entry.type === "compaction") {
         const summary = entry.summary.trim();
         if (summary) sections.push(`COMPACTION:\n${summary}`);
         continue;
      }

      if (entry.type !== "message") continue;

      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") continue;

      const content = textFromContent(message.content).trim();
      if (!content) continue;

      sections.push(`${message.role.toUpperCase()}:\n${content}`);
   }

   return sections;
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
      description:
         "Copy the compaction summary and user/assistant messages from the last compaction to the active leaf",
      handler: async (_args, ctx) => {
         await ctx.waitForIdle();

         // buildContextEntries drops pre-compaction history; getBranch() does not.
         const sections = formatCopySections(ctx.sessionManager.buildContextEntries());

         if (sections.length === 0) {
            ctx.ui.notify("No user or assistant messages to copy", "info");
            return;
         }

         await runClipboardCopy(sections.join("\n\n---\n\n"), ctx.signal);
         ctx.ui.notify(`Copied ${sections.length} sections to clipboard`, "info");
      }
   });
}
