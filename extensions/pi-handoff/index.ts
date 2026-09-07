import { createHash, randomBytes } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

const HANDOFF_DIRECTORY = "/tmp";
const HANDOFF_HASH_LENGTH = 12;

export interface HandoffMetadata {
   readonly cwd?: string;
}

export interface HandoffResult {
   readonly path: string;
   readonly document: string;
   readonly hash: string;
   readonly entryCount: number;
}

type HandoffWriter = (document: string) => Promise<string>;
type HandoffReader = (path: string) => Promise<string>;
type UserMessageSender = (content: string, options: { expandPromptTemplates: false }) => Promise<void> | void;
type HandoffContext = Pick<ExtensionCommandContext, "waitForIdle" | "sessionManager" | "ui">;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
   return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function stringValue(value: unknown): string | undefined {
   return typeof value === "string" ? value : undefined;
}

function argumentValue(value: unknown): string {
   if (typeof value === "string") return value;
   if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
   if (Array.isArray(value)) return value.map(argumentValue).join(", ");
   const object = record(value);
   if (!object) return "";
   return Object.entries(object)
      .map(([key, item]) => `${key}: ${argumentValue(item)}`)
      .filter(Boolean)
      .join(", ");
}

function toolArguments(name: string, value: unknown): string {
   const object = record(value);
   if (!object) return argumentValue(value);
   if (name === "read" || name === "write") {
      const path = stringValue(object.path);
      return path ? `Path: ${path}` : "";
   }
   if (typeof object.command === "string") return object.command;
   return argumentValue(object);
}

function renderContent(content: unknown, includeToolCalls: boolean): string[] {
   if (typeof content === "string") return content.trim() ? [content.trim()] : [];
   if (!Array.isArray(content)) return [];

   const parts: string[] = [];
   for (const blockValue of content) {
      const block = record(blockValue);
      if (!block) continue;
      if (block.type === "text") {
         const text = stringValue(block.text);
         if (text?.trim()) parts.push(text.trim());
         continue;
      }
      if (block.type === "toolCall" && includeToolCalls) {
         const name = stringValue(block.name) ?? "unknown";
         const argumentsText = toolArguments(name, block.arguments);
         const label = `### Tool call: \`${name}\``;
         const details =
            name === "read" || name === "write" ? argumentsText : argumentsText ? `Arguments: ${argumentsText}` : "";
         parts.push([label, details].filter(Boolean).join("\n\n"));
         continue;
      }
      if (block.type === "image") parts.push("[image omitted from handoff]");
   }
   return parts;
}

function renderMessage(messageValue: unknown): string | undefined {
   const message = record(messageValue);
   if (!message) return undefined;
   const role = message.role;

   if (role === "user") {
      const parts = renderContent(message.content, false);
      return parts.length ? `### User\n\n${parts.join("\n\n")}` : undefined;
   }

   if (role === "assistant") {
      const parts = renderContent(message.content, true);
      if (parts.length === 0) return undefined;
      const hasText =
         typeof message.content === "string" ||
         (Array.isArray(message.content) &&
            message.content.some((blockValue: unknown) => {
               const block = record(blockValue);
               return block?.type === "text" && stringValue(block.text)?.trim();
            }));
      return hasText ? `### Assistant\n\n${parts.join("\n\n")}` : parts.join("\n\n");
   }

   if (role === "toolResult") return undefined;
   if (role === "compactionSummary" || role === "branchSummary") {
      const summary = stringValue(message.summary);
      if (!summary?.trim()) return undefined;
      const heading = role === "compactionSummary" ? "### Compaction summary" : "### Branch summary";
      return `${heading}\n\n${summary.trim()}`;
   }
   if (role === "custom") {
      const parts = renderContent(message.content, false);
      return parts.length ? `### Custom message\n\n${parts.join("\n\n")}` : undefined;
   }
   if (role === "bashExecution") {
      const command = stringValue(message.command) ?? "";
      const output = stringValue(message.output) ?? "";
      const lines = ["### Bash execution", `Command: ${command}`];
      if (output) lines.push(`Output:\n\n${output}`);
      if (typeof message.exitCode === "number") lines.push(`Exit code: ${message.exitCode}`);
      if (message.cancelled === true) lines.push("Cancelled: yes");
      return lines.join("\n\n");
   }

   return undefined;
}

function renderEntry(entry: SessionEntry): string | undefined {
   if (entry.type === "message") return renderMessage(entry.message);
   if (entry.type === "compaction") {
      return entry.summary.trim() ? `### Compaction summary\n\n${entry.summary.trim()}` : undefined;
   }
   if (entry.type === "branch_summary") {
      return entry.summary.trim() ? `### Branch summary\n\n${entry.summary.trim()}` : undefined;
   }
   return undefined;
}

function renderContextItem(value: unknown): string | undefined {
   const item = record(value);
   if (item?.type === "message") return renderMessage(item.message);
   if (item?.type === "compaction" || item?.type === "branch_summary") {
      return renderEntry(item as unknown as SessionEntry);
   }
   return renderMessage(value);
}

function handoffSections(entries: readonly unknown[]): string[] {
   return entries.map(renderContextItem).filter((section): section is string => section !== undefined);
}

/** Format a compaction-style handoff without provider or reasoning metadata. */
export function formatHandoffDocument(
   entries: readonly unknown[],
   metadata: HandoffMetadata = {},
   summary?: string
): string {
   const sections = ["# Pi handoff", ""];
   if (metadata.cwd) sections.push(`Working directory: ${metadata.cwd}`, "");
   if (summary?.trim()) sections.push("## Summary", "", summary.trim(), "");
   sections.push("## Active context", "");
   const content = handoffSections(entries);
   sections.push(content.length ? content.join("\n\n---\n\n") : "[no transferable conversation content]");
   return `${sections.join("\n")}\n`;
}

function isAlreadyExists(error: unknown): boolean {
   return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/** Write a handoff with private permissions and avoid following pre-existing /tmp paths. */
export async function writeHandoffFile(
   document: string,
   directory = HANDOFF_DIRECTORY,
   randomBytesImpl: (size: number) => Buffer = randomBytes
): Promise<string> {
   const hash = createHash("sha256").update(document, "utf8").digest("hex").slice(0, HANDOFF_HASH_LENGTH);

   for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${randomBytesImpl(8).toString("hex")}`;
      const path = join(directory, `handoff-${hash}${suffix}.md`);
      try {
         const file = await open(path, "wx", 0o600);
         try {
            await file.writeFile(document, "utf8");
         } catch (error) {
            await file.close();
            await unlink(path).catch(() => undefined);
            throw error;
         }
         await file.close();
         return path;
      } catch (error) {
         if (!isAlreadyExists(error)) throw error;
      }
   }

   throw new Error("Could not create a unique handoff file in the temporary directory.");
}

export async function exportHandoff(
   ctx: HandoffContext,
   writeFileImpl: HandoffWriter = writeHandoffFile
): Promise<HandoffResult | null> {
   await ctx.waitForIdle();
   const activeEntries = ctx.sessionManager.buildContextEntries();
   const messages = activeEntries.flatMap(sessionEntryToContextMessages);
   const sections = handoffSections(messages);
   if (sections.length === 0) {
      ctx.ui.notify("No useful session context to export", "info");
      return null;
   }

   const document = formatHandoffDocument(messages, { cwd: ctx.sessionManager.getCwd() });
   const path = await writeFileImpl(document);
   const hash = createHash("sha256").update(document, "utf8").digest("hex").slice(0, HANDOFF_HASH_LENGTH);
   ctx.ui.notify(`use /handoff ${path} in new session to continue`, "info");
   return { path, document, hash, entryCount: sections.length };
}

const defaultReader: HandoffReader = async (path) => readFile(path, "utf8");

export async function loadHandoffFile(
   path: string,
   sendUserMessage: UserMessageSender,
   readFileImpl: HandoffReader = defaultReader
): Promise<{ path: string; bytes: number }> {
   const document = await readFileImpl(path);
   if (!document.trim()) throw new Error("Handoff file is empty.");

   const content =
      "Continue from this Pi handoff. Treat it as prior session context and continue from the latest state.\n\n" +
      document;
   await sendUserMessage(content, { expandPromptTemplates: false });
   return { path, bytes: Buffer.byteLength(document, "utf8") };
}

function errorText(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI): void {
   pi.registerCommand("handoff", {
      description: "Export useful session context or load a handoff file",
      handler: async (args, ctx) => {
         const path = args.trim();
         try {
            if (path) {
               await ctx.waitForIdle();
               await loadHandoffFile(path, (content, options) => pi.sendUserMessage(content, options));
               ctx.ui.notify(`Loaded handoff from ${path}`, "info");
            } else {
               await exportHandoff(ctx);
            }
         } catch (error) {
            ctx.ui.notify(`Handoff failed: ${errorText(error)}`, "error");
         }
      }
   });
}
