export type SessionFileEntry = {
   readonly type?: string;
   readonly id?: string;
   readonly parentId?: string | null;
   readonly timestamp?: string;
   readonly message?: unknown;
   readonly summary?: string;
   readonly role?: string;
   readonly content?: unknown;
   readonly command?: string;
   readonly output?: string;
};

/** A searchable message projected from a session entry. */
export type RecallMessage = {
   readonly id: string;
   readonly timestamp?: string;
   readonly role: string;
   readonly text: string;
};

/** One matching message together with its surrounding active-branch context. */
export type RecallResult = {
   readonly score: number;
   readonly matched: RecallMessage;
   readonly context: ReadonlyArray<RecallMessage>;
};

/** Results of a deterministic search over a session's active branch. */
export type SessionRecall = {
   readonly totalMatches: number;
   readonly results: ReadonlyArray<RecallResult>;
};

type SearchOptions = {
   readonly maxResults: number;
   readonly contextRadius: number;
};

function extractContent(content: unknown): string {
   if (typeof content === "string") return content.trim();
   if (!Array.isArray(content)) return "";
   return content
      .map((part) => {
         if (!part || typeof part !== "object") return "";
         const block = part as { readonly type?: unknown; readonly text?: unknown };
         return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
}

/** Project a raw session entry into searchable message text. */
export function projectSessionMessage(entry: SessionFileEntry): RecallMessage | undefined {
   const source =
      entry.type === "message" && entry.message && typeof entry.message === "object"
         ? (entry.message as SessionFileEntry)
         : entry;
   const text =
      source.role === "bashExecution"
         ? [source.command ? `Command: ${source.command}` : "", source.output ?? ""].filter(Boolean).join("\n")
         : source.role === "branchSummary" || source.role === "compactionSummary"
           ? (source.summary ?? "")
           : extractContent(source.content) || source.output?.trim() || source.summary?.trim() || "";
   if (!entry.id || !text) return undefined;
   return {
      id: entry.id,
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      role: source.role ?? entry.type ?? "entry",
      text
   };
}

function activeBranch(entries: ReadonlyArray<SessionFileEntry>): ReadonlyArray<SessionFileEntry> {
   const byId = new Map(entries.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : [])));
   let leaf = entries.findLast((entry) => entry.id !== undefined);
   const branch: SessionFileEntry[] = [];
   while (leaf) {
      branch.push(leaf);
      leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
   }
   return branch.toReversed();
}

function queryTerms(query: string): ReadonlyArray<string> {
   return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

function scoreText(text: string, query: string, terms: ReadonlyArray<string>): number {
   const normalized = text.toLocaleLowerCase();
   const phrase = query.trim().toLocaleLowerCase();
   let score = phrase && normalized.includes(phrase) ? 10 : 0;
   for (const term of terms) {
      let offset = 0;
      while ((offset = normalized.indexOf(term, offset)) >= 0) {
         score += 1;
         offset += term.length;
      }
   }
   return score;
}

/** Search the active parent-linked session branch without invoking an LLM. */
export function searchSessionEntries(
   entries: ReadonlyArray<SessionFileEntry>,
   query: string,
   options: SearchOptions
): SessionRecall {
   const terms = queryTerms(query);
   if (terms.length === 0) return { totalMatches: 0, results: [] };

   const messages = activeBranch(entries).flatMap((entry) => {
      const message = projectSessionMessage(entry);
      return message ? [message] : [];
   });
   const matches = messages
      .map((matched, index) => ({ matched, index, score: scoreText(matched.text, query, terms) }))
      .filter(({ score }) => score > 0)
      .toSorted((left, right) => right.score - left.score || right.index - left.index);

   return {
      totalMatches: matches.length,
      results: matches.slice(0, options.maxResults).map(({ matched, index, score }) => ({
         score,
         matched,
         context: messages.slice(
            Math.max(0, index - options.contextRadius),
            Math.min(messages.length, index + options.contextRadius + 1)
         )
      }))
   };
}
