/** Format elapsed time: if <1s show ms, else show seconds with one decimal. */
export function fmtTime(seconds: number): string {
   if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
   return `${seconds.toFixed(1)}s`;
}

/** Detect whether a query looks like code (identifiers, symbols) or natural language. */
const CODE_QUERY_RE = /[_\\\\.:]|\\.\\w+|[a-z][A-Z]|[A-Z]{2,}|->|=>/;

export function detectKeywordWeight(query: string): number {
   const hasCodePattern = CODE_QUERY_RE.test(query);
   if (hasCodePattern && query.length < 40) return 0.7;
   const words = query.trim().split(/\s+/).length;
   if (words > 4) return 0.2;
   if (hasCodePattern) return 0.5;
   return 0.3;
}
