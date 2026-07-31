interface CoreContextUsage {
   contextTokens: number;
   contextWindow: number;
   contextPercent: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null;
}

export function readCoreContextUsage(ctx: unknown): CoreContextUsage | null {
   if (!isRecord(ctx) || typeof ctx.getContextUsage !== "function") {
      return null;
   }

   const usage = ctx.getContextUsage();
   if (!isRecord(usage)) {
      return null;
   }

   const { tokens } = usage;
   const { contextWindow } = usage;
   if (
      typeof tokens !== "number" ||
      !Number.isFinite(tokens) ||
      typeof contextWindow !== "number" ||
      !Number.isFinite(contextWindow) ||
      contextWindow <= 0
   ) {
      return null;
   }

   const { percent } = usage;
   return {
      contextPercent:
         typeof percent === "number" && Number.isFinite(percent) ? percent : (tokens / contextWindow) * 100,
      contextTokens: tokens,
      contextWindow
   };
}
