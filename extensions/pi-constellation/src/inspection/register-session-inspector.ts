import { readFileSync } from "node:fs";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createSessionNavigator, type SessionBranch } from "./navigator.js";
import type { RecallMessage, SessionFileEntry } from "./session-search.js";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
let sessionsCache:
   | { readonly loadedAt: number; readonly promise: ReturnType<typeof SessionManager.listAll> }
   | undefined;

function readEntries(path: string): ReadonlyArray<SessionFileEntry> {
   return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
         if (!line.trim()) return [];
         try {
            return [JSON.parse(line) as SessionFileEntry];
         } catch {
            return [];
         }
      });
}

async function loadSessions(): ReturnType<typeof SessionManager.listAll> {
   if (!sessionsCache || Date.now() - sessionsCache.loadedAt >= 60_000) {
      sessionsCache = { loadedAt: Date.now(), promise: SessionManager.listAll() };
   }
   try {
      return await sessionsCache.promise;
   } catch (error) {
      sessionsCache = undefined;
      throw error;
   }
}

function clip(text: string, maxChars = 2_000): string {
   return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

function renderMessage(message: RecallMessage, marker = ""): string {
   const timestamp = message.timestamp ? ` | ${message.timestamp}` : "";
   return `${marker}${message.id} [${message.role}${timestamp}]\n${clip(message.text)}`;
}

function renderBranch(branch: SessionBranch): string {
   return [
      `${branch.id}${branch.active ? " [ACTIVE]" : ""}`,
      `  Messages: ${branch.messageCount}`,
      `  Forked after: ${branch.forkMessageId ?? "root"}`,
      `  Leaf: ${branch.leafMessageId}`,
      branch.lastMessage ? `  Last: ${clip(branch.lastMessage.text, 180)}` : ""
   ]
      .filter(Boolean)
      .join("\n");
}

function errorResult(text: string) {
   return { content: [{ type: "text" as const, text }], isError: true, details: undefined };
}

function firstLine(text: string): string {
   return (
      text
         .split(/\r?\n/)
         .find((line) => line.trim())
         ?.trim() || "Inspection complete"
   );
}

/** Register incremental, deterministic session transcript navigation. */
export function registerSessionInspector(pi: ExtensionAPI): void {
   pi.registerTool({
      name: "session_inspect",
      label: "Inspect Session",
      description:
         "Navigate a session incrementally. Show its overview and branches, page through a branch, inspect around a message, retrieve one message, or search for message IDs.",
      promptSnippet: "Inspect a session by its ID without loading the complete transcript",
      promptGuidelines: [
         "Start with action=overview when the user provides a session ID without a precise target.",
         "Navigate with branch, around, and message actions. Use search only to locate message IDs.",
         "Never request the whole session at once. Follow returned cursors and message IDs incrementally."
      ],
      renderCall(args, theme) {
         const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
         const action = typeof args.action === "string" ? args.action : "overview";
         const target = sessionId ? theme.fg("accent", clip(sessionId, 24)) : theme.fg("muted", "(session)");
         return new Text(
            `${theme.fg("toolTitle", theme.bold("session_inspect"))} ${theme.fg("muted", action)} ${theme.fg("dim", "·")} ${target}`,
            0,
            0
         );
      },
      renderResult(result, { expanded, isPartial }, theme, context) {
         const text = result.content.find((part) => part.type === "text")?.text ?? "";
         if (isPartial) return new Text(theme.fg("warning", `↳ ${text || "Inspecting session..."}`), 0, 0);
         if (context.isError) return new Text(theme.fg("error", text || "Session inspection failed"), 0, 0);
         if (expanded) return new Text(text || "(empty result)", 0, 0);

         const title = clip(firstLine(text).replace(/^#+\s*/, ""), 160);
         return new Text(
            `${theme.fg("dim", "↳")} ${theme.fg("toolOutput", title)} ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`,
            0,
            0
         );
      },
      parameters: Type.Object({
         sessionId: Type.String({ description: "Raw session ID" }),
         action: Type.Optional(
            Type.Union(
               [
                  Type.Literal("overview"),
                  Type.Literal("branches"),
                  Type.Literal("branch"),
                  Type.Literal("around"),
                  Type.Literal("message"),
                  Type.Literal("search")
               ],
               { description: "Inspection operation. Defaults to overview." }
            )
         ),
         branchId: Type.Optional(
            Type.String({ description: "Branch ID returned by overview, or active/all where supported" })
         ),
         messageId: Type.Optional(Type.String({ description: "Message ID returned by another inspection action" })),
         query: Type.Optional(Type.String({ description: "Search words or phrase" })),
         cursor: Type.Optional(Type.String({ description: "Message cursor returned by a branch page" })),
         direction: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
         limit: Type.Optional(
            Type.Integer({
               minimum: 1,
               maximum: MAX_LIMIT,
               description: "Page or result size. Default 12, maximum 30."
            })
         ),
         before: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })),
         after: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 }))
      }),
      async execute(_toolCallId, params, _signal, onUpdate) {
         const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
         if (!sessionId) return errorResult("session_inspect requires a sessionId.");
         const action = params.action ?? "overview";
         onUpdate?.({
            content: [{ type: "text" as const, text: `Inspecting ${sessionId}: ${action}...` }],
            details: undefined
         });

         try {
            const session = (await loadSessions()).find((item) => item.id === sessionId);
            if (!session) return errorResult(`Session not found: ${sessionId}`);
            const navigator = createSessionNavigator(readEntries(session.path));
            const limit = typeof params.limit === "number" ? params.limit : DEFAULT_LIMIT;
            let text: string;

            if (action === "overview" || action === "branches") {
               const overview = navigator.overview();
               text = [
                  `# Session ${action === "overview" ? "Overview" : "Branches"}`,
                  `Session: ${sessionId}`,
                  `Messages: ${overview.messageCount}`,
                  `Entries: ${overview.entryCount}`,
                  `Branches: ${overview.branches.length}`,
                  `Active branch: ${overview.activeBranchId ?? "none"}`,
                  "## Branches",
                  ...overview.branches.map(renderBranch),
                  ...(action === "overview"
                     ? [
                          "## Recent active-branch messages",
                          ...overview.recentMessages.map((message) => renderMessage(message))
                       ]
                     : []),
                  "## Next actions",
                  "Use action=branch with a branchId, action=around with a messageId, or action=search with a query."
               ].join("\n\n");
            } else if (action === "branch") {
               const selectedBranch = params.branchId ?? "active";
               const page = navigator.readBranch(selectedBranch, {
                  ...(params.cursor ? { cursor: params.cursor } : {}),
                  limit,
                  direction: params.direction ?? "after"
               });
               if (page.messages.length === 0) return errorResult(`No branch page found for: ${selectedBranch}`);
               text = [
                  `# Branch ${page.branchId}`,
                  `Direction: ${params.direction ?? "after"}`,
                  `Messages shown: ${page.messages.length}`,
                  ...page.messages.map((message) => renderMessage(message)),
                  `Previous cursor: ${page.previousCursor ?? "none"}`,
                  `Next cursor: ${page.nextCursor ?? "none"}`
               ].join("\n\n");
            } else if (action === "around") {
               if (!params.messageId) return errorResult("action=around requires messageId.");
               const context = navigator.around(params.messageId, {
                  before: params.before ?? 5,
                  after: params.after ?? 8
               });
               if (context.messages.length === 0) return errorResult(`Message not found: ${params.messageId}`);
               const matchedEntryId = navigator.message(params.messageId)?.id;
               text = [
                  `# Context around ${params.messageId}`,
                  `Branch: ${context.branchId}`,
                  ...context.messages.map((message) =>
                     renderMessage(message, message.id === matchedEntryId ? ">>> MATCH " : "")
                  )
               ].join("\n\n");
            } else if (action === "message") {
               if (!params.messageId) return errorResult("action=message requires messageId.");
               const message = navigator.message(params.messageId);
               if (!message) return errorResult(`Message not found: ${params.messageId}`);
               text = [`# Message ${params.messageId}`, renderMessage(message)].join("\n\n");
            } else {
               const query = params.query?.trim();
               if (!query) return errorResult("action=search requires query.");
               const recall = navigator.search(query, params.branchId, limit);
               text =
                  recall.results.length === 0
                     ? `No matches found in ${sessionId} for: ${query}`
                     : [
                          `# Session Search`,
                          `Session: ${sessionId}`,
                          `Query: ${query}`,
                          `Matches: ${recall.totalMatches}`,
                          ...recall.results.map((result, index) =>
                             [
                                `## Result ${index + 1} (score ${result.score})`,
                                renderMessage(result.matched),
                                `Inspect with action=around, messageId=${result.matched.id}`
                             ].join("\n\n")
                          )
                       ].join("\n\n");
            }

            return {
               content: [{ type: "text" as const, text }],
               details: { sessionId, sessionPath: session.path, action }
            };
         } catch (error) {
            return errorResult(`session_inspect failed: ${error instanceof Error ? error.message : String(error)}`);
         }
      }
   });
}
