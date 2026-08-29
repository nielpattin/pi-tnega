# @nielpattin/pi-web-access

Fast, secure web search, content extraction, and deep research extension for the Pi coding agent.

## Features

- **Deep Web Research**: Conducts multi-query, deep autonomous investigation and synthesis with Firecrawl Deep Research or Exa Deep Reasoning.
- **Smart Content Scraping & Extraction**: Fetches web pages, remote/local PDFs, HTML, or raw GitHub files with automatic headless browser fallback (Firecrawl/Exa) for SPAs and Cloudflare-protected pages.
- **High-Performance PDF Parsing**: Uses Firecrawl's `@firecrawl/pdf-inspector` (native Rust engine) for spatial multi-column layout detection, tables, and Markdown extraction.
- **Multi-provider web search**: Queries Firecrawl, Exa, Brave Search, Tavily, Gemini Grounded Search, or DuckDuckGo.
- **Domain & Category Filters**: Scopes queries with `includeDomains`, `excludeDomains`, and Exa's `category` filters (`company`, `publication`, `news`, `personal site`, etc.).
- **Steering & Localization**: Supports `systemPrompt` to guide reasoning/summaries and `userLocation` (two-letter ISO country code) for geo-specific results.
- **Zero-config fallback**: Uses DuckDuckGo search automatically when no API keys are configured.
- **GitHub URL routing**: Direct access to raw files, README files, and repository content.
- **SSRF protection**: Validates destination IP addresses against private, loopback, link-local, and cloud metadata networks.
- **Bounded output**: Enforces byte budgets and provides clean truncation notices.

## Tools

### `web_research`

Conducts in-depth web research on a complex topic using Firecrawl Deep Research or Exa Deep Reasoning, combining multi-step crawling, deep scraping, and synthesized analysis with source citations.

Parameters:

- `query` (string, required): Topic, question, or assertion to research.
- `depth` (string, optional): Research depth (`fast`, `deep`, `exhaustive`). Defaults to `deep`.
- `provider` (string, optional): Research provider (`auto`, `firecrawl`, `exa`). Defaults to `auto`.
- `includeDomains` (array of strings, optional): Restricts research to specified domains.
- `excludeDomains` (array of strings, optional): Excludes specified domains from research.
- `systemPrompt` (string, optional): Steering guidance for the research agent.
- `userLocation` (string, optional): Two-letter ISO country code.

### `web_search`

Searches the web for technical documentation, articles, and references.

Parameters:

- `query` (string, required): Search query keywords.
- `provider` (string, optional): Specific search provider (`auto`, `duckduckgo`, `exa`, `brave`, `firecrawl`, `tavily`, `gemini`). Defaults to `auto`.
- `mode` (string, optional): Search mode (`search` default for link retrieval/docs, `answer` for direct factual answer synthesis).
- `category` (string, optional): Exa category filter (`company`, `publication`, `news`, `personal site`, `financial report`, `people`).
- `includeDomains` (array of strings, optional): Scopes results to specific domains or paths.
- `excludeDomains` (array of strings, optional): Excludes specific domains from results.
- `userLocation` (string, optional): Two-letter ISO country code.
- `systemPrompt` (string, optional): Steering guidance for search ranking and synthesis.
- `limit` (number, optional): Maximum results (1 to 20, default: 5).
- `freshness` (string, optional): Recency filter (`day`, `week`, `month`, `year`).

### `fetch_content`

Fetches and extracts readable Markdown or text from web pages, local or remote PDF documents, HTML files, articles, documentation, or raw GitHub files.

Parameters:

- `url` (string, required): Web page, documentation, local/remote PDF path, or GitHub URL.
- `provider` (string, optional): Scraping provider (`auto`, `local`, `firecrawl`, `exa`). Defaults to `auto` (fast local with automatic headless fallback on blocked/SPA pages).
- `format` (string, optional): Output format (`markdown`, `text`, `html`, default: `markdown`).
- `max_bytes` (number, optional): Maximum byte limit before truncation (default: 50,000).
- `include_links` (boolean, optional): Appends external page links to the result.

## Commands

- `/websearch <query>`: Executes a web search directly from the interactive session.

## Configuration

Extension configuration is stored under `~/.pi/agent/.ext-config/`:

File: `~/.pi/agent/.ext-config/pi-web-access.json`

```json
{
    "defaultProvider": "firecrawl",
    "userLocation": "US",
    "maxBytes": 50000,
    "timeoutMs": 20000,
    "braveApiKey": "your-brave-key",
    "firecrawlApiKey": "your-firecrawl-key",
    "tavilyApiKey": "your-tavily-key"
}
```

Credentials can also be stored in `~/.pi/agent/auth.json` or provided via environment variables:

```bash
# Research & Search API keys
export FIRECRAWL_API_KEY="your-key"
export EXA_API_KEY="your-key"
export BRAVE_API_KEY="your-key"
export TAVILY_API_KEY="your-key"
export GEMINI_API_KEY="your-key"

# Optional settings
export PI_WEB_SEARCH_DEFAULT_PROVIDER="firecrawl"
export PI_WEB_ACCESS_DEFAULT_MAX_BYTES="50000"
export PI_WEB_ACCESS_TIMEOUT_MS="20000"
export PI_WEB_ACCESS_USER_LOCATION="US"
```
