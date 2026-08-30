export type SearchProviderId = "duckduckgo" | "exa" | "brave" | "tavily" | "firecrawl" | "gemini";

export interface SearchItem {
   readonly title: string;
   readonly url: string;
   readonly snippet: string;
   readonly publishedDate?: string;
   readonly author?: string;
   readonly category?: string;
}

export interface SearchResponse {
   readonly query: string;
   readonly provider: SearchProviderId;
   readonly results: ReadonlyArray<SearchItem>;
   readonly answer?: string;
   readonly mode?: "answer" | "search";
   readonly durationMs?: number;
   readonly serverTimeMs?: number;
   readonly cost?: string;
   readonly requestId?: string;
   readonly error?: string;
}

export type SearchMode = "search" | "answer";

export type SearchCategory =
   | "company"
   | "publication"
   | "news"
   | "personal site"
   | "financial report"
   | "people"
   | "developer"
   | "research"
   | "pdf";

export interface SearchOptions {
   readonly query: string;
   readonly provider?: SearchProviderId | "auto";
   readonly mode?: SearchMode;
   readonly limit?: number;
   readonly freshness?: "day" | "week" | "month" | "year";
   readonly category?: SearchCategory;
   readonly includeDomains?: ReadonlyArray<string>;
   readonly excludeDomains?: ReadonlyArray<string>;
   readonly userLocation?: string;
   readonly systemPrompt?: string;
   readonly signal?: AbortSignal;
}

export type FetchFormat = "markdown" | "text" | "html";

export type FetchProviderId = "auto" | "local" | "firecrawl" | "exa";

export interface FetchOptions {
   readonly url: string;
   readonly provider?: FetchProviderId;
   readonly format?: FetchFormat;
   readonly maxBytes?: number;
   readonly includeLinks?: boolean;
   readonly timeoutMs?: number;
   readonly signal?: AbortSignal;
}

export interface ExtractedDocument {
   readonly title?: string;
   readonly content: string;
   readonly byline?: string;
   readonly excerpt?: string;
   readonly links?: ReadonlyArray<string>;
}

export interface FetchResult {
   readonly url: string;
   readonly title?: string;
   readonly author?: string;
   readonly publishedDate?: string;
   readonly content: string;
   readonly contentType: string;
   readonly statusCode: number;
   readonly truncated: boolean;
   readonly byteLength: number;
   readonly fullByteLength?: number;
   readonly lines?: number;
   readonly totalLines?: number;
   readonly tempFilePath?: string;
   readonly provider?: string;
   readonly durationMs?: number;
   readonly serverTimeMs?: number;
   readonly cost?: string;
   readonly requestId?: string;
   readonly links?: ReadonlyArray<string>;
   readonly error?: string;
}

export interface SearchProviderDefinition {
   readonly id: SearchProviderId;
   readonly name: string;
   readonly isAvailable: () => boolean;
   readonly search: (options: SearchOptions) => Promise<SearchResponse>;
}

export type ResearchDepth = "fast" | "deep" | "exhaustive";

export type ResearchProviderId = "firecrawl" | "exa";

export interface ResearchSource {
   readonly title: string;
   readonly url: string;
   readonly snippet?: string;
   readonly quality?: string;
}

export interface ResearchActivity {
   readonly type: string;
   readonly message: string;
   readonly timestamp?: string;
   readonly depth?: number;
}

export interface ResearchResponse {
   readonly query: string;
   readonly provider: string;
   readonly synthesis: string;
   readonly sources: ReadonlyArray<ResearchSource>;
   readonly activities?: ReadonlyArray<ResearchActivity>;
   readonly durationMs?: number;
   readonly serverTimeMs?: number;
   readonly cost?: string;
   readonly requestId?: string;
   readonly error?: string;
}

export interface ResearchOptions {
   readonly query: string;
   readonly provider?: ResearchProviderId | "auto";
   readonly depth?: ResearchDepth;
   readonly includeDomains?: ReadonlyArray<string>;
   readonly excludeDomains?: ReadonlyArray<string>;
   readonly userLocation?: string;
   readonly systemPrompt?: string;
   readonly maxUrls?: number;
   readonly timeoutMs?: number;
   readonly signal?: AbortSignal;
}

export interface SiteOutlineItem {
   readonly url: string;
   readonly title?: string;
   readonly description?: string;
}

export interface SiteOutlineResponse {
   readonly url: string;
   readonly search?: string;
   readonly links: ReadonlyArray<SiteOutlineItem>;
   readonly totalLinks: number;
   readonly durationMs?: number;
   readonly cost?: string;
   readonly error?: string;
}

export interface SiteOutlineOptions {
   readonly url: string;
   readonly search?: string;
   readonly limit?: number;
   readonly sitemap?: "include" | "skip" | "only";
   readonly includeSubdomains?: boolean;
   readonly ignoreQueryParameters?: boolean;
   readonly signal?: AbortSignal;
   readonly timeoutMs?: number;
}
