import {
   projectSessionMessage,
   searchSessionEntries,
   type RecallMessage,
   type SessionFileEntry,
   type SessionRecall
} from "./session-search.js";

/** Summary of one root-to-leaf path in a session tree. */
export type SessionBranch = {
   readonly id: string;
   readonly leafMessageId: string;
   readonly forkMessageId?: string;
   readonly messageCount: number;
   readonly active: boolean;
   readonly lastMessage?: RecallMessage;
};

/** Structural overview used to begin incremental session inspection. */
export type SessionOverview = {
   readonly entryCount: number;
   readonly messageCount: number;
   readonly activeBranchId?: string;
   readonly branches: ReadonlyArray<SessionBranch>;
   readonly recentMessages: ReadonlyArray<RecallMessage>;
};

/** A bounded page from one session branch. */
export type BranchPage = {
   readonly branchId: string;
   readonly messages: ReadonlyArray<RecallMessage>;
   readonly previousCursor?: string;
   readonly nextCursor?: string;
};

/** Bounded context surrounding an exact session message. */
export type MessageContext = {
   readonly branchId: string;
   readonly messages: ReadonlyArray<RecallMessage>;
};

/** Incremental navigation operations over a parsed session tree. */
export type SessionNavigator = {
   readonly overview: () => SessionOverview;
   readonly readBranch: (
      branchId: string,
      options: { readonly cursor?: string; readonly limit: number; readonly direction: "before" | "after" }
   ) => BranchPage;
   readonly around: (messageId: string, options: { readonly before: number; readonly after: number }) => MessageContext;
   readonly message: (messageId: string) => RecallMessage | undefined;
   readonly search: (query: string, branchId: string | undefined, maxResults: number) => SessionRecall;
};

type BranchRecord = SessionBranch & { readonly entries: ReadonlyArray<SessionFileEntry> };

function branchId(leafId: string): string {
   return `branch:${leafId}`;
}

function pathToRoot(
   leaf: SessionFileEntry,
   byId: ReadonlyMap<string, SessionFileEntry>
): ReadonlyArray<SessionFileEntry> {
   const path: SessionFileEntry[] = [];
   let current: SessionFileEntry | undefined = leaf;
   while (current) {
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
   }
   return path.toReversed();
}

function sourceReferences(entry: SessionFileEntry): ReadonlyArray<string> {
   if (!entry.message || typeof entry.message !== "object") return [];
   const message = entry.message as Record<string, unknown>;
   const role = message.role;
   const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
   if (role === "user" && timestamp !== undefined) return [`u:${timestamp}`];
   if (role === "toolResult" && typeof message.toolCallId === "string") return [`r:${message.toolCallId}`];
   if (role === "assistant" && Array.isArray(message.content)) {
      return message.content.flatMap((part, index) => {
         if (!part || typeof part !== "object") return [];
         const block = part as Record<string, unknown>;
         if ((block.type === "toolCall" || block.type === "tool_use") && typeof block.id === "string") {
            return [`c:${block.id}`];
         }
         if (block.type === "text" || block.type === "thinking") {
            const anchor =
               typeof message.responseId === "string"
                  ? message.responseId
                  : timestamp === undefined
                    ? undefined
                    : `t${timestamp}`;
            return anchor ? [`a:${anchor}:p${index}`] : [];
         }
         return [];
      });
   }
   return timestamp === undefined ? [] : [`s:${timestamp}`];
}

function messagesIn(entries: ReadonlyArray<SessionFileEntry>): ReadonlyArray<RecallMessage> {
   return entries.flatMap((entry) => {
      const message = projectSessionMessage(entry);
      return message ? [message] : [];
   });
}

function withOptionalCursor(key: "previousCursor" | "nextCursor", value: string | undefined): object {
   return value ? { [key]: value } : {};
}

/** Build a reusable navigator without placing the complete transcript in model context. */
export function createSessionNavigator(entries: ReadonlyArray<SessionFileEntry>): SessionNavigator {
   const identified = entries.filter((entry): entry is SessionFileEntry & { readonly id: string } => Boolean(entry.id));
   const byId = new Map(identified.map((entry) => [entry.id, entry] as const));
   const sourceToEntryId = new Map(
      identified.flatMap((entry) => sourceReferences(entry).map((sourceRef) => [sourceRef, entry.id] as const))
   );
   const resolveMessageId = (id: string): string => sourceToEntryId.get(id) ?? id;
   const parentIds = new Set(identified.flatMap((entry) => (entry.parentId ? [entry.parentId] : [])));
   const leaves = identified.filter((entry) => !parentIds.has(entry.id));
   const activeLeaf = identified.at(-1);
   const childCounts = new Map<string, number>();
   for (const entry of identified) {
      if (entry.parentId) childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
   }

   const branches: ReadonlyArray<BranchRecord> = leaves.map((leaf) => {
      const path = pathToRoot(leaf, byId);
      const projected = messagesIn(path);
      const fork = path.findLast((entry) => entry.id && (childCounts.get(entry.id) ?? 0) > 1);
      return {
         id: branchId(leaf.id),
         leafMessageId: leaf.id,
         ...(fork?.id ? { forkMessageId: fork.id } : {}),
         messageCount: projected.length,
         active: leaf.id === activeLeaf?.id,
         ...(projected.at(-1) ? { lastMessage: projected.at(-1) } : {}),
         entries: path
      };
   });
   const activeBranch = branches.find((branch) => branch.active) ?? branches.at(-1);

   function resolveBranch(id: string | undefined): BranchRecord | undefined {
      if (!id || id === "active") return activeBranch;
      return branches.find((branch) => branch.id === id || branch.leafMessageId === id);
   }

   return {
      overview: () => {
         const allMessages = messagesIn(entries);
         return {
            entryCount: entries.length,
            messageCount: allMessages.length,
            ...(activeBranch ? { activeBranchId: activeBranch.id } : {}),
            branches: branches.map(({ entries: _entries, ...branch }) => branch),
            recentMessages: activeBranch ? messagesIn(activeBranch.entries).slice(-5) : []
         };
      },
      readBranch: (id, options) => {
         const branch = resolveBranch(id);
         if (!branch) return { branchId: id, messages: [] };
         const messages = messagesIn(branch.entries);
         const cursorIndex = options.cursor ? messages.findIndex((message) => message.id === options.cursor) : -1;
         const start =
            options.direction === "before"
               ? Math.max(0, (cursorIndex < 0 ? messages.length : cursorIndex) - options.limit)
               : cursorIndex + 1;
         const end =
            options.direction === "before"
               ? cursorIndex < 0
                  ? messages.length
                  : cursorIndex
               : Math.min(messages.length, start + options.limit);
         const page = messages.slice(start, end);
         return {
            branchId: branch.id,
            messages: page,
            ...withOptionalCursor("previousCursor", start > 0 ? page.at(0)?.id : undefined),
            ...withOptionalCursor("nextCursor", end < messages.length ? page.at(-1)?.id : undefined)
         };
      },
      around: (messageId, options) => {
         const resolvedMessageId = resolveMessageId(messageId);
         const branch = activeBranch?.entries.some((entry) => entry.id === resolvedMessageId)
            ? activeBranch
            : branches.find((candidate) => candidate.entries.some((entry) => entry.id === resolvedMessageId));
         if (!branch) return { branchId: "", messages: [] };
         const messages = messagesIn(branch.entries);
         const index = messages.findIndex((message) => message.id === resolvedMessageId);
         if (index < 0) return { branchId: branch.id, messages: [] };
         return {
            branchId: branch.id,
            messages: messages.slice(Math.max(0, index - options.before), index + options.after + 1)
         };
      },
      message: (messageId) => {
         const entry = byId.get(resolveMessageId(messageId));
         return entry ? projectSessionMessage(entry) : undefined;
      },
      search: (query, id, maxResults) => {
         if (id !== "all") {
            const branch = resolveBranch(id);
            return searchSessionEntries(branch?.entries ?? [], query, { maxResults, contextRadius: 1 });
         }
         const uniqueResults = new Map<string, SessionRecall["results"][number]>();
         for (const branch of branches) {
            const recall = searchSessionEntries(branch.entries, query, { maxResults, contextRadius: 1 });
            for (const result of recall.results) {
               const existing = uniqueResults.get(result.matched.id);
               if (!existing || result.score > existing.score) uniqueResults.set(result.matched.id, result);
            }
         }
         const ranked = [...uniqueResults.values()].toSorted((left, right) => right.score - left.score);
         return { totalMatches: ranked.length, results: ranked.slice(0, maxResults) };
      }
   };
}
