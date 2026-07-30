# pi-cortex

Code intelligence for Pi: search, AST analysis, call graph triples, and agent memory.

- **Semantic + keyword code search** with auto-blended mode
- **AST pattern search** (grep + replace) over indexed code
- **Call graph** with triple store queries
- **Agent memory** for remembering conversations and facts
- **Local embedding** via Rust + ONNX Runtime (DirectML GPU accelerated)
- **File watcher** auto-starts after indexing, runs in background

---

## Tools

**Read-only tools** (agent-callable):

| Tool                 | Purpose                                                         | UI                                    |
| -------------------- | --------------------------------------------------------------- | ------------------------------------- |
| `code_search`        | Semantic / keyword / hybrid search. Auto-blends based on query. | Collapse/expand + elapsed time (ms/s) |
| `code_symbol_search` | Look up functions, classes, or variables by name.               | Collapse/expand + elapsed time (ms/s) |
| `code_call_graph`    | Find callers, callees, or all calls in a file.                  | Collapse/expand + elapsed time (ms/s) |

Indexing and file watching are manual — use the commands below.

---

## Commands

| Command          | Description                                                                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ce-index`      | Index files in the current project. Optionally pass paths (e.g. `/ce-index src/`). After indexing, the Rust sidecar auto-starts a file watcher on the project. The watcher polls every 2 seconds for mtime/size changes and re-indexes incrementally until the sidecar exits. |
| `/cleanup-embed` | Delete the cortex database (index.db + WAL). Run `/ce-index` to rebuild.                                                                                                                                                                                                      |
| `/ce-status`     | Show model, provider, files/chunks indexed, DB size, watcher status, and storage paths.                                                                                                                                                                                       |

---

## How it works

```mermaid
flowchart TD
    User[User / LLM] --> code_search
    User --> code_symbol_search
    User --> code_call_graph

    subgraph TS[TypeScript extension]
        code_search
        code_symbol_search
        code_call_graph
    end

    subgraph Rust[Rust sidecar]
        Walk[Walk + Read + Chunk]
        Embed[ONNX inference]
        SQLite[(SQLite:\n  chunks\n  files\n  FTS5 index\n  call graph\n  triples\n  memories)]
        Watcher[Polling Watcher]
        Walk -->|local| Embed
        Walk --> SQLite
        Embed --> SQLite
        Watcher -->|mtime check| Walk
    end

    subgraph HTTP[Remote API]
        API[embeddings endpoint]
    end

    subgraph Manual[Manual commands]
        INDEX[/ce-index]
        STATUS[/ce-status]
        CLEANUP[/cleanup-embed]
    end

    INDEX -->|scan + index| Rust
    INDEX -->|chunk only| Walk
    INDEX -->|store chunks| Rust
    INDEX -->|chunk texts| API
    API -->|embeddings| Rust
    INDEX -.->|auto-starts| Watcher
    STATUS -->|stats| SQLite
    CLEANUP -->|deletes| SQLite
    code_search -->|embed query| Embed
    code_search -->|hybrid search| SQLite
    code_symbol_search -->|regex lookup| SQLite
    code_call_graph -->|caller/callee query| SQLite
```

1. **Indexing** is triggered manually via `/ce-index`. The command sends target paths to the Rust sidecar, which walks directories, reads files, tree-sitter chunks, and either embeds locally or returns chunks for the remote provider path. Unchanged files (mtime + size match) are skipped automatically.
2. **After indexing**, the Rust sidecar auto-starts a polling file watcher on the project directory. The watcher scans every 2 seconds, comparing mtime and size. Changed, new, or deleted files are re-indexed incrementally.
3. The Rust sidecar manages all state in a per-project SQLite database (`<project>/.pi/cortex/index.db`): chunks with embeddings, file metadata, FTS5 keyword index, call graph edges, **triple store** (subject-predicate-object), and **memories** (conversation recall).
4. `code_search` embeds the query, then sends a `search` command with an auto-detected blend weight. Code-like queries (identifiers with `_`, `.`, `::`, camelCase) lean keyword; full sentences lean semantic. Cosine similarity + FTS5 BM25 are blended together, then deterministic reranking. Optional cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) for improved relevance.
5. `code_symbol_search` extracts symbols via regex on stored chunks.
6. `code_call_graph` queries caller/callee edges and the triple store.

---

## Search mode

`code_search` has a single mode that blends semantic (cosine similarity) and keyword (FTS5 BM25) automatically:

| Query looks like    | Keyword weight | Semantic weight |
| ------------------- | -------------- | --------------- |
| Code identifiers    | 0.7            | 0.3             |
| Short code-ish      | 0.5            | 0.5             |
| Full sentences      | 0.2            | 0.8             |
| Default (ambiguous) | 0.3            | 0.7             |

All scoring runs entirely in the Rust sidecar.

---

## Building the Rust sidecar

```bash
cd extensions/pi-cortex/rust-embedder
cargo build --release
```

The binary is expected at `rust-embedder/target/release/pi-embedder.exe` (Windows).

---

## Configuration

Config resolution: `<project>/.pi/cortex/config.json` (created from defaults if missing). Environment variables expanded in `model`, `baseUrl`, `apiKey` via `$VAR` or `${VAR}`.

### Default config

```json
{
    "model": "Xenova/all-MiniLM-L6-v2",
    "provider": "local",
    "baseUrl": "",
    "apiKey": "",
    "chunkSize": 80,
    "overlap": 20,
    "topK": 5,
    "indexBatchSize": 256,
    "queryPrefix": "query: ",
    "documentPrefix": "passage: "
}
```

---

## Storage layout

```text
<repo>/.pi/cortex/
  config.json
  models/
    Xenova--all-MiniLM-L6-v2/

<project>/.pi/cortex/
  config.json
  index.db
```

---

## Testing

```bash
cd extensions/pi-cortex
cargo build --release
pnpx vitest run --config vitest.config.ts
```

Tests create fixtures in `.test-tmp/` — they never touch files outside the extension directory.

---

## Benchmark suite

```bash
python extensions/pi-cortex/benchmarks/bench_index.py --repo pi-cortex
python extensions/pi-cortex/benchmarks/bench_index.py --compare results/old.json results/latest.json
```
