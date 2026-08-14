/** Normalized usage counters retained for workflow agents. */
export interface UsageSnapshot {
   input: number;
   output: number;
   cacheRead: number;
   cacheWrite: number;
   cost: number;
   /** Latest context occupancy, when a child session reports it. */
   contextTokens?: number;
   turns: number;
}

/** Create an empty usage snapshot. */
export function emptyUsage(): UsageSnapshot {
   return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0
   };
}

/**
 * Aggregate usage from assistant messages while ignoring user and tool records.
 *
 * @param messages - Message projections containing optional provider usage.
 * @returns The normalized cumulative usage snapshot.
 */
export function computeAssistantUsage(
   messages: ReadonlyArray<{
      readonly role: string;
      readonly usage?: {
         readonly input?: number;
         readonly output?: number;
         readonly cacheRead?: number;
         readonly cacheWrite?: number;
         readonly cost?: { readonly total?: number };
      };
   }>
): UsageSnapshot {
   const usage = emptyUsage();
   for (const message of messages) {
      if (message.role !== "assistant") continue;
      usage.turns++;
      const current = message.usage;
      if (!current) continue;
      usage.input += current.input ?? 0;
      usage.output += current.output ?? 0;
      usage.cacheRead += current.cacheRead ?? 0;
      usage.cacheWrite += current.cacheWrite ?? 0;
      usage.cost += current.cost?.total ?? 0;
   }
   return usage;
}
