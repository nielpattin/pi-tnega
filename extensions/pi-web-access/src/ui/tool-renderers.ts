import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { FetchResult, ResearchResponse, SearchResponse, SiteOutlineResponse } from "../domain.ts";
import { formatBytes, formatDuration } from "../utils/text.ts";
import { formatStatusBadge, formatUrlSummary } from "./formatters.ts";

interface ToolResultLike {
   readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
   readonly details?: unknown;
}

interface RenderOptions {
   readonly expanded: boolean;
   readonly isPartial?: boolean;
}

function formatExpandHint(): string {
   try {
      return keyHint("app.tools.expand", "to expand");
   } catch {
      return "Ctrl+O to expand";
   }
}

export function renderSearchCall(args: unknown, theme: Theme): Component {
   const params = (args ?? {}) as {
      query?: string;
      queries?: string[];
      provider?: string;
      mode?: string;
      limit?: number;
      category?: string;
      freshness?: string;
   };
   const queryText = params.query
      ? `"${params.query}"`
      : params.queries && params.queries.length > 0
        ? `[${params.queries.length} queries: "${params.queries[0]}", ...]`
        : "";
   const providerText = params.provider && params.provider !== "auto" ? ` [p:${params.provider}]` : "";
   const modeText = params.mode && params.mode !== "auto" ? ` [m:${params.mode}]` : "";
   const categoryText = params.category ? ` [c:${params.category}]` : "";
   const freshnessText = params.freshness ? ` [f:${params.freshness}]` : "";
   const limitText = params.limit ? ` [limit:${params.limit}]` : "";

   return new Text(
      theme.fg("toolTitle", theme.bold("web_search ")) +
         theme.fg("muted", `${queryText}${providerText}${modeText}${categoryText}${freshnessText}${limitText}`),
      0,
      0
   );
}

export function renderSearchResult(result: ToolResultLike, options: RenderOptions, theme: Theme): Component {
   if (options.isPartial) {
      return new Text(theme.fg("warning", "Searching web..."), 0, 0);
   }

   const details = result.details as SearchResponse | undefined;
   const provider = details?.provider ?? "search";

   if (details?.error) {
      return new Text(theme.fg("error", `✗ Search failed (${provider}): ${details.error}`), 0, 0);
   }

   const results = details?.results ?? [];
   const count = results.length;
   const countLabel = count === 1 ? "1 result" : `${count} results`;
   const hint = formatExpandHint();
   const durationText = details?.durationMs !== undefined ? ` · ${formatDuration(details.durationMs)}` : "";
   const costText = details?.cost ? ` · Cost: ${details.cost}` : "";
   const modeLabel = details?.mode ? ` [${details.mode}]` : "";

   // Collapsed View (Default in transcript)
   if (!options.expanded) {
      if (count === 0 && !details?.answer) {
         return new Text(theme.fg("muted", `No results found for "${details?.query ?? ""}" via ${provider}`), 0, 0);
      }

      const lines: string[] = [
         `${theme.fg("success", "✓")} ${theme.fg("accent", `Found ${countLabel} via ${provider}${modeLabel}`)}${durationText}${costText} ${theme.fg("muted", `(${hint})`)}`
      ];

      if (details?.answer) {
         const answerSnippet = details.answer.length > 90 ? `${details.answer.slice(0, 87)}...` : details.answer;
         lines.push(theme.fg("toolOutput", `💡 Answer: ${answerSnippet}`));
      }

      const previewCount = Math.min(2, count);
      for (let i = 0; i < previewCount; i++) {
         const item = results[i];
         if (!item) continue;
         const title = item.title.length > 55 ? `${item.title.slice(0, 52)}...` : item.title;
         const url = formatUrlSummary(item.url, 45);
         lines.push(`${i + 1}. ${theme.fg("toolOutput", title)} ${theme.fg("dim", `· ${url}`)}`);
      }

      if (count > previewCount) {
         lines.push(theme.fg("dim", `... (${count - previewCount} more results, ${hint})`));
      }

      return new Text(lines.join("\n"), 0, 0);
   }

   // Expanded View (Full details when expanded with Ctrl+O)
   const text = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

   const expandedLines: string[] = [
      `${theme.fg("success", "✓")} ${theme.fg("accent", `Web Search (${provider}${modeLabel}): ${countLabel}`)}${durationText}`
   ];

   const metaItems: string[] = [];
   if (details?.mode) {
      metaItems.push(`Mode: ${details.mode}`);
   }
   if (details?.cost) {
      metaItems.push(`Cost: ${details.cost}`);
   }
   if (details?.serverTimeMs !== undefined) {
      metaItems.push(`Server: ${Math.round(details.serverTimeMs)}ms`);
   }
   if (details?.requestId) {
      metaItems.push(`Req ID: ${details.requestId}`);
   }
   if (metaItems.length > 0) {
      expandedLines.push(theme.fg("dim", metaItems.join(" · ")));
   }
   expandedLines.push("");

   if (details?.answer) {
      expandedLines.push(theme.fg("toolTitle", "Summary Answer:"));
      expandedLines.push(theme.fg("toolOutput", details.answer));
      expandedLines.push("");
   }

   expandedLines.push(text);
   return new Text(expandedLines.join("\n"), 0, 0);
}

export function renderFetchCall(args: unknown, theme: Theme): Component {
   const params = (args ?? {}) as { url?: string; format?: string; provider?: string };
   const targetText = params.url ? formatUrlSummary(params.url, 80) : "";
   const providerText =
      params.provider && params.provider !== "auto" && params.provider !== "local" ? ` [${params.provider}]` : "";
   const formatText =
      params.format && params.format !== "markdown" && params.format !== "text" ? ` [${params.format}]` : "";

   return new Text(
      theme.fg("toolTitle", theme.bold("fetch_content ")) +
         theme.fg("muted", `${targetText}${providerText}${formatText}`),
      0,
      0
   );
}

export function renderFetchResult(result: ToolResultLike, options: RenderOptions, theme: Theme): Component {
   if (options.isPartial) {
      return new Text(theme.fg("warning", "Fetching content..."), 0, 0);
   }

   const details = result.details as FetchResult | undefined;

   if (details?.error) {
      return new Text(theme.fg("error", `✗ Fetch failed: ${details.error}`), 0, 0);
   }

   const text = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

   const contentLineCount = text.split("\n").length;
   const visibleLines = details?.lines ?? contentLineCount;
   const totalLines = details?.totalLines ?? contentLineCount;
   const linesText =
      details?.truncated && totalLines > visibleLines
         ? `· ${visibleLines} / ${totalLines} lines`
         : `· ${visibleLines} ${visibleLines === 1 ? "line" : "lines"}`;

   const sizeText = details?.byteLength
      ? details.truncated && details.fullByteLength && details.fullByteLength > details.byteLength
         ? `${formatBytes(details.byteLength)} / ${formatBytes(details.fullByteLength)}`
         : formatBytes(details.byteLength)
      : "";
   const durationText = details?.durationMs !== undefined ? formatDuration(details.durationMs) : "";
   const costText = details?.cost ? `· Cost: ${details.cost}` : "";
   const statusBadge = details?.statusCode ? formatStatusBadge(details.statusCode, theme) : "";
   const truncatedBadge = details?.truncated ? theme.fg("warning", "[truncated]") : "";
   const hint = formatExpandHint();

   // Collapsed View (Default in transcript) - Clean minimal single line summary with timing
   if (!options.expanded) {
      const parts = [
         theme.fg("success", "✓"),
         statusBadge,
         sizeText ? `· ${sizeText}` : "",
         linesText,
         durationText ? `· ${durationText}` : "",
         costText,
         truncatedBadge,
         theme.fg("muted", `(${hint})`)
      ].filter(Boolean);

      return new Text(parts.join(" "), 0, 0);
   }

   // Expanded View (Full details when expanded with Ctrl+O)
   const headerLines: string[] = [
      `${theme.fg("success", "✓")} ${statusBadge} ${sizeText ? `· ${sizeText}` : ""} ${linesText ? `${linesText} ` : ""}${durationText ? `· ${durationText}` : ""} ${truncatedBadge}`.trim(),
      theme.fg("accent", details?.url ?? ""),
      details?.title ? theme.fg("toolTitle", theme.bold(details.title)) : ""
   ].filter(Boolean);

   const metaItems: string[] = [];
   if (details?.author) {
      metaItems.push(`By: ${details.author}`);
   }
   if (details?.publishedDate) {
      metaItems.push(`Published: ${details.publishedDate}`);
   }
   if (details?.serverTimeMs) {
      metaItems.push(`Server: ${Math.round(details.serverTimeMs)}ms`);
   }
   if (details?.cost) {
      metaItems.push(`Cost: ${details.cost}`);
   }
   if (metaItems.length > 0) {
      headerLines.push(theme.fg("dim", metaItems.join(" · ")));
   }

   if (details?.tempFilePath) {
      headerLines.push(theme.fg("warning", `Full content saved to: ${details.tempFilePath}`));
   }

   headerLines.push("---");
   headerLines.push(text);

   return new Text(headerLines.join("\n"), 0, 0);
}

export function renderResearchCall(args: unknown, theme: Theme): Component {
   const params = (args ?? {}) as {
      query?: string;
      queries?: string[];
      scope?: string;
      depth?: string;
      provider?: string;
      authors?: string;
      categories?: string[];
   };
   const queryText = params.query
      ? `"${params.query}"`
      : params.queries && params.queries.length > 0
        ? `[${params.queries.length} angles: "${params.queries[0]}", ...]`
        : "";
   const scopeText = params.scope ? ` [s:${params.scope}]` : " [s:general]";
   const depthText = params.depth ? ` [e:${params.depth}]` : " [e:deep]";
   const providerText = params.provider && params.provider !== "auto" ? ` [p:${params.provider}]` : "";
   const authorsText = params.authors ? ` [a:${params.authors}]` : "";
   const categoriesText =
      params.categories && params.categories.length > 0 ? ` [c:${params.categories.join(",")}]` : "";

   return new Text(
      theme.fg("toolTitle", theme.bold("web_research ")) +
         theme.fg("muted", `${queryText}${scopeText}${depthText}${providerText}${authorsText}${categoriesText}`),
      0,
      0
   );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function renderResearchResult(result: ToolResultLike, options: RenderOptions, theme: Theme): Component {
   const details = result.details as ResearchResponse | undefined;
   const provider = details?.provider ?? "research";

   if (options.isPartial) {
      const activities = details?.activities ?? [];
      const sources = details?.sources ?? [];
      const durationMs = details?.durationMs ?? 0;
      const durationText = ` (${formatDuration(durationMs)})`;
      const spinnerIndex = Math.floor(durationMs / 100) % SPINNER_FRAMES.length;
      const spinner = SPINNER_FRAMES[spinnerIndex] ?? "⟳";

      if (activities.length === 0) {
         return new Text(
            theme.fg("warning", `${spinner} Initializing deep web research...`) + theme.fg("dim", durationText),
            0,
            0
         );
      }

      const lines: string[] = [
         theme.fg("warning", `${spinner} Deep Web Research in progress...`) + theme.fg("dim", durationText)
      ];

      // Show recent activity trace (up to 4 items)
      const recentActivities = activities.slice(-4);
      for (const act of recentActivities) {
         let icon = "▸";
         if (act.type === "decompose" || act.type === "plan") icon = "◆";
         else if (act.type === "search") icon = "🔍";
         else if (act.type === "fetch") icon = "📄";
         else if (act.type === "expand") icon = "🧬";
         else if (act.type === "passages") icon = "📖";
         else if (act.type === "synthesis" || act.type === "synthesize") icon = "⚡";

         lines.push(`  ${theme.fg("accent", icon)} ${theme.fg("toolOutput", act.message)}`);
      }

      if (sources.length > 0) {
         const countLabel = sources.length === 1 ? "1 source" : `${sources.length} sources`;
         lines.push(`  ${theme.fg("dim", `Discovered ${countLabel} so far`)}`);
      }

      return new Text(lines.join("\n"), 0, 0);
   }

   if (details?.error) {
      return new Text(theme.fg("error", `✗ Research failed (${provider}): ${details.error}`), 0, 0);
   }

   const sources = details?.sources ?? [];
   const count = sources.length;
   const countLabel = count === 1 ? "1 source" : `${count} sources`;
   const hint = formatExpandHint();
   const durationText = details?.durationMs !== undefined ? ` · ${formatDuration(details.durationMs)}` : "";

   // Collapsed View (Default in transcript)
   if (!options.expanded) {
      const lines: string[] = [
         `${theme.fg("success", "✓")} ${theme.fg("accent", `Researched via ${provider}`)} ${theme.fg("muted", `· ${countLabel}${durationText} (${hint})`)}`
      ];

      const previewCount = Math.min(3, count);
      for (let i = 0; i < previewCount; i++) {
         const item = sources[i];
         if (!item) continue;
         const title = item.title.length > 55 ? `${item.title.slice(0, 52)}...` : item.title;
         const url = formatUrlSummary(item.url, 45);
         lines.push(`${i + 1}. ${theme.fg("toolOutput", title)} ${theme.fg("dim", `· ${url}`)}`);
      }

      if (count > previewCount) {
         lines.push(theme.fg("dim", `... (${count - previewCount} more sources, ${hint})`));
      }

      return new Text(lines.join("\n"), 0, 0);
   }

   // Expanded View (Full synthesis when expanded with Ctrl+O)
   const text = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

   const expandedLines: string[] = [
      `${theme.fg("success", "✓")} ${theme.fg("accent", `Deep Research Report (${provider}) · ${countLabel}`)}${durationText}`
   ];

   const metaItems: string[] = [];
   if (details?.cost) {
      metaItems.push(`Cost: ${details.cost}`);
   }
   if (details?.serverTimeMs !== undefined) {
      metaItems.push(`Server: ${Math.round(details.serverTimeMs)}ms`);
   }
   if (metaItems.length > 0) {
      expandedLines.push(theme.fg("dim", metaItems.join(" · ")));
   }
   expandedLines.push("");
   expandedLines.push(text);

   return new Text(expandedLines.join("\n"), 0, 0);
}

export function renderOutlineCall(args: unknown, theme: Theme): Component {
   const params = (args ?? {}) as { url?: string; search?: string; limit?: number };
   const targetText = params.url ? formatUrlSummary(params.url, 60) : "";
   const searchText = params.search ? ` [q:${params.search}]` : "";
   const limitText = params.limit ? ` [limit:${params.limit}]` : "";

   return new Text(
      theme.fg("toolTitle", theme.bold("outline_site ")) + theme.fg("muted", `${targetText}${searchText}${limitText}`),
      0,
      0
   );
}

export function renderOutlineResult(result: ToolResultLike, options: RenderOptions, theme: Theme): Component {
   if (options.isPartial) {
      return new Text(theme.fg("warning", "Mapping site structure..."), 0, 0);
   }

   const details = result.details as SiteOutlineResponse | undefined;

   if (details?.error) {
      return new Text(theme.fg("error", `✗ Outline failed: ${details.error}`), 0, 0);
   }

   const links = details?.links ?? [];
   const count = links.length;
   const countLabel = count === 1 ? "1 link" : `${count} links`;
   const hint = formatExpandHint();
   const durationText = details?.durationMs !== undefined ? ` · ${formatDuration(details.durationMs)}` : "";

   // Collapsed View (Default in transcript)
   if (!options.expanded) {
      const searchSuffix = details?.search ? ` matching "${details.search}"` : "";
      const lines: string[] = [
         `${theme.fg("success", "✓")} ${theme.fg("accent", `Found ${countLabel}${searchSuffix}`)}${durationText} ${theme.fg("muted", `(${hint})`)}`
      ];

      const previewCount = Math.min(3, count);
      for (let i = 0; i < previewCount; i++) {
         const item = links[i];
         if (!item) continue;
         const title = item.title ? `${item.title} · ` : "";
         const url = formatUrlSummary(item.url, 60);
         lines.push(`${i + 1}. ${theme.fg("toolOutput", title)}${theme.fg("dim", url)}`);
      }

      if (count > previewCount) {
         lines.push(theme.fg("dim", `... (${count - previewCount} more links, ${hint})`));
      }

      return new Text(lines.join("\n"), 0, 0);
   }

   // Expanded View (Full details when expanded with Ctrl+O)
   const text = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

   const expandedLines: string[] = [
      `${theme.fg("success", "✓")} ${theme.fg("accent", `Site Outline: ${details?.url ?? ""} (${countLabel})`)}${durationText}`,
      ""
   ];

   if (details?.cost) {
      expandedLines.push(theme.fg("dim", `Cost: ${details.cost}`));
      expandedLines.push("");
   }

   expandedLines.push(text);
   return new Text(expandedLines.join("\n"), 0, 0);
}
