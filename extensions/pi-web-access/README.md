# @nielpattin/pi-web-access

Fast, secure web search, content extraction, and deep research extension for the Pi coding agent.

## Features

- **Deep Web & Academic Research**: Conducts multi-query search decomposition, scientific literature indexing (~43M papers via Firecrawl Research covering arXiv, PubMed, bioRxiv, DOI), citation graph expansion, passage extraction, and synthesized analysis.
- **Smart Content Scraping & Extraction**: Fetches web pages, remote/local PDFs, HTML, or raw GitHub files with automatic headless browser fallback (Firecrawl/Exa) for SPAs and Cloudflare-protected pages.
- **High-Performance PDF Parsing**: Uses Firecrawl's `@firecrawl/pdf-inspector` (native Rust engine) for spatial multi-column layout detection, tables, and Markdown extraction.
- **Multi-provider web search**: Queries Firecrawl, Exa, or Tavily with automatic sequential error fallback.
- **Domain & Category Filters**: Scopes queries with `includeDomains`, `excludeDomains`, and Exa's `category` filters (`company`, `publication`, `news`, `personal site`, etc.).
- **Steering & Localization**: Supports `systemPrompt` to guide reasoning/summaries and `userLocation` (two-letter ISO country code) for geo-specific results.
- **GitHub URL routing**: Direct access to raw files, README files, and repository content.
- **SSRF protection**: Validates destination IP addresses against private, loopback, link-local, and cloud metadata networks.
- **Bounded output**: Enforces byte budgets and provides clean truncation notices.

## Tools

### `web_research`

Conducts in-depth web and academic research on a complex topic by decomposing questions into multi-angle search queries, fetching and evaluating passages across search providers or scientific literature indexes, and synthesizing the findings using Pi's authenticated LLMs with source citations.

Parameters:

- `query` (string, optional): Main topic, question, or assertion to research.
- `queries` (array of strings, optional): 2-4 varied query angles searched in parallel.
- `scope` (string, optional): Research scope (`general` for open-web intelligence, `academic` for scientific paper indexing covering ~43M papers across arXiv, PubMed, bioRxiv, and DOI citations via Firecrawl Research Index). Defaults to `general`.
- `depth` (string, optional): Research effort and rigor (`fast`, `deep`, `exhaustive`). Defaults to `deep`.
- `authors` (string, optional): Author filter for academic research (e.g. `Vaswani`, `Dhariwal`).
- `categories` (array of strings, optional): Academic category filters (e.g. `['cs.LG', 'cs.CV', 'stat.ML']`).
- `includeDomains` (array of strings, optional): Restricts research to specified domains.
- `excludeDomains` (array of strings, optional): Excludes specified domains from research.
- `systemPrompt` (string, optional): Steering guidance for the research synthesis.
- `userLocation` (string, optional): Two-letter ISO country code.

#### Academic Research Pipeline (`scope: "academic"`)

When `scope: "academic"` is selected, `web_research` runs a dedicated literature discovery and citation analysis pipeline:

1. **Seed Paper Discovery**: Queries Firecrawl's Research Index (`GET /v2/search/research/papers`) across 43M+ paper abstracts matching topic queries, authors, and arXiv/PubMed categories.
2. **Citation Graph Expansion**: For `depth: "deep"` or `"exhaustive"`, expands citation graphs (`GET /v2/search/research/papers/{id}/similar`) to discover co-cited literature, foundational precursors (`references`), and follow-up work (`citers`).
3. **Passage Extraction**: Extracts targeted full-text passages (`GET /v2/search/research/papers/{id}?query=...`) to verify methodologies, datasets, and benchmark metrics without parsing full PDF files.
4. **Synthesis & Citation Lineage**: Synthesizes a structured literature review with problem taxonomy, methodology comparison, empirical benchmarks, and canonical links (`arxiv:`, `doi:`, `pmid:`).

### `web_search`

Searches the web for technical documentation, articles, and references using single or multi-angle queries.

Parameters:

- `query` (string, optional): Search query keywords.
- `queries` (array of strings, optional): Multiple search queries run in parallel.
- `mode` (string, optional): Search mode (`search` default for link retrieval/docs, `answer` for direct factual answer synthesis).
- `category` (string, optional): Exa/Firecrawl category filter (`developer`, `research`, `pdf`, `company`, `publication`, `news`, `personal site`, `financial report`, `people`).
- `freshness` (string, optional): Recency filter restricting results to published/updated time windows (`day` for 24h, `week` for 7 days, `month` for 30 days, `year` for 365 days).
- `includeDomains` (array of strings, optional): Scopes results to specific domains or paths.
- `excludeDomains` (array of strings, optional): Excludes specific domains from results.
- `userLocation` (string, optional): Two-letter ISO country code.
- `systemPrompt` (string, optional): Steering guidance for search ranking and synthesis.
- `limit` (number, optional): Maximum results (1 to 20, default: 5).

### `fetch_content`

Fetches and extracts readable Markdown or text from web pages, local or remote PDF documents, HTML files, articles, documentation, or raw GitHub files.

Parameters:

- `url` (string, required): Web page, documentation, local/remote PDF path, or GitHub URL.
- `provider` (string, optional): Scraping provider (`auto`, `local`, `firecrawl`, `exa`). Defaults to `auto` (fast local with automatic headless fallback on blocked/SPA pages).
- `format` (string, optional): Output format (`markdown`, `text`, `html`, default: `markdown`).
- `include_links` (boolean, optional): Appends external page links to the result.

## Commands

- `/websearch <query>`: Executes a web search directly from the interactive session.

## UI Badge Reference

Tool headers in the TUI transcript use compact key-prefixed badges for readability:

| Prefix      | Description             | Example Values                                        |
| :---------- | :---------------------- | :---------------------------------------------------- |
| `[s:...]`   | Research Scope          | `[s:academic]`, `[s:general]`                         |
| `[e:...]`   | Research Effort / Depth | `[e:fast]`, `[e:deep]`, `[e:exhaustive]`              |
| `[p:...]`   | Provider Backend        | `[p:firecrawl]`, `[p:exa]`, `[p:tavily]`              |
| `[m:...]`   | Search Mode             | `[m:search]`, `[m:answer]`                            |
| `[c:...]`   | Category / arXiv Filter | `[c:developer]`, `[c:cs.LG,cs.CV]`, `[c:publication]` |
| `[f:...]`   | Freshness Window        | `[f:day]`, `[f:week]`, `[f:month]`, `[f:year]`        |
| `[a:...]`   | Author Filter           | `[a:Vaswani]`                                         |
| `[q:...]`   | Search Path Filter      | `[q:docs/api]`                                        |
| `[limit:N]` | Result Limit            | `[limit:10]`                                          |

## Configuration

Extension configuration is stored under `~/.pi/agent/.ext-config/`:

File: `~/.pi/agent/.ext-config/pi-web-access.json`

```json
{
    "search": {
        "defaultProvider": "firecrawl",
        "userLocation": "US",
        "limit": 5
    },
    "research": {
        "provider": "llm",
        "model": "google/gemini-3.6-flash",
        "modelFallbacks": ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"],
        "depth": "deep",
        "searchProvider": "firecrawl",
        "fetchProvider": "auto"
    },
    "fetch": {
        "provider": "auto",
        "maxBytes": 50000,
        "timeoutMs": 20000
    },
    "keys": {
        "firecrawl": "your-firecrawl-key",
        "exa": "your-exa-key",
        "tavily": "your-tavily-key"
    }
}
```

---

### Configuration Reference & Available Values

#### `search` Object

| Field             | Type     | Allowed Values                                                    | Default                        | Description                                           |
| :---------------- | :------- | :---------------------------------------------------------------- | :----------------------------- | :---------------------------------------------------- |
| `defaultProvider` | `string` | `"firecrawl"`, `"exa"`, `"tavily"`                                | `"firecrawl"` (or first keyed) | Primary web search engine used for global search.     |
| `userLocation`    | `string` | Two-letter ISO country code (e.g. `"US"`, `"GB"`, `"DE"`, `"JP"`) | `undefined`                    | Localizes search results to a specific region.        |
| `limit`           | `number` | Integer between `1` and `20`                                      | `5`                            | Default number of search results to return per query. |

#### `research` Object

| Field            | Type     | Allowed Values                                                                                                            | Default              | Description                                                                            |
| :--------------- | :------- | :------------------------------------------------------------------------------------------------------------------------ | :------------------- | :------------------------------------------------------------------------------------- |
| `provider`       | `string` | `"llm"`, `"exa"`                                                                                                          | `"llm"`              | Research mode (`llm` for in-harness synthesis, `exa` for remote hosted agent).         |
| `model`          | `string` | Any registered model identifier (e.g. `"google/gemini-3.6-flash"`, `"anthropic/claude-haiku-4-5"`, `"openai/gpt-5-mini"`) | Active session model | Specific Pi model used for query decomposition and deep synthesis.                     |
| `modelFallbacks` | `array`  | Array of model strings (e.g. `["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"]`)                                       | `[]`                 | Ordered backup models if the primary research model fails or is unauthenticated.       |
| `depth`          | `string` | `"fast"`, `"deep"`, `"exhaustive"`                                                                                        | `"deep"`             | Default research rigor and breadth.                                                    |
| `searchProvider` | `string` | `"auto"`, `"firecrawl"`, `"exa"`, `"tavily"`                                                                              | `"auto"`             | Dedicated search backend used for research queries (overrides global search provider). |
| `fetchProvider`  | `string` | `"auto"`, `"local"`, `"firecrawl"`, `"exa"`                                                                               | `"auto"`             | Dedicated content extraction engine used for research scraping.                        |

#### `fetch` Object

| Field       | Type     | Allowed Values                                  | Default        | Description                                                                                       |
| :---------- | :------- | :---------------------------------------------- | :------------- | :------------------------------------------------------------------------------------------------ |
| `provider`  | `string` | `"auto"`, `"local"`, `"firecrawl"`, `"exa"`     | `"auto"`       | Default scraping provider (`auto` runs fast local fetch with headless fallback on blocked pages). |
| `maxBytes`  | `number` | Positive integer (e.g. `50000`)                 | `50000`        | Maximum content byte budget per page before saving to temp file.                                  |
| `timeoutMs` | `number` | Positive integer in milliseconds (e.g. `20000`) | `20000`        | HTTP request timeout.                                                                             |
| `userAgent` | `string` | Custom user-agent string                        | Mozilla/5.0... | HTTP User-Agent header sent with outbound requests.                                               |

#### `keys` Object

| Field       | Type     | Description                                              |
| :---------- | :------- | :------------------------------------------------------- |
| `firecrawl` | `string` | Firecrawl Search & Scrape API Key (`FIRECRAWL_API_KEY`). |
| `exa`       | `string` | Exa Search & Deep Reasoning API Key (`EXA_API_KEY`).     |
| `tavily`    | `string` | Tavily Search API Key (`TAVILY_API_KEY`).                |

---

### Environment Variables

Environment variables take highest precedence and override configuration file values:

```bash
# Provider API Keys
export FIRECRAWL_API_KEY="your-key"
export EXA_API_KEY="your-key"
export TAVILY_API_KEY="your-key"

# Research & Search Overrides
export PI_WEB_RESEARCH_PROVIDER="llm"
export PI_WEB_RESEARCH_MODEL="google/gemini-3.6-flash"
export PI_WEB_SEARCH_DEFAULT_PROVIDER="firecrawl"
export PI_WEB_ACCESS_DEFAULT_MAX_BYTES="50000"
export PI_WEB_ACCESS_TIMEOUT_MS="20000"
export PI_WEB_ACCESS_USER_LOCATION="US"
```
