/** Format elapsed time: if <1s show ms, else show seconds with one decimal. */
export function fmtTime(seconds: number): string {
   if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
   return `${seconds.toFixed(1)}s`;
}

/** Format a byte count human-readably: B, KB, or MB. */
export function fmtBytes(bytes: number): string {
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Detect whether a query looks like code (identifiers, symbols) or natural language. */
const CODE_QUERY_RE = /[_\\\\.:]|\\.\\w+|[a-z][A-Z]|[A-Z]{2,}|->|=>/;
const EXACT_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** Detect a standalone code identifier that should use the lexical lane. */
export function isExactIdentifierQuery(query: string): boolean {
   return EXACT_IDENTIFIER_RE.test(query.trim());
}

export function detectKeywordWeight(query: string): number {
   if (isExactIdentifierQuery(query)) return 1;
   const hasCodePattern = CODE_QUERY_RE.test(query);
   if (hasCodePattern && query.length < 40) return 0.7;
   const words = query.trim().split(/\s+/).length;
   if (words > 4) return 0.2;
   if (hasCodePattern) return 0.5;
   return 0.3;
}
