#!/usr/bin/env python3
"""
Persistent benchmark suite for pi-code-embedding.

Measures indexing throughput (files, chunks, elapsed, ch/s) across
multiple repositories, saves results to results/ for trend tracking.

Usage:
    # Benchmark all enabled repos
    python extensions/pi-code-embedding/benchmarks/bench_index.py

    # Benchmark specific repos by name
    python extensions/pi-code-embedding/benchmarks/bench_index.py --repo pi-code-embedding --repo nest

    # Benchmark a local path directly
    python extensions/pi-code-embedding/benchmarks/bench_index.py --path /some/repo

    # Compare two saved results
    python extensions/pi-code-embedding/benchmarks/bench_index.py --compare results/2026-07-30T12-00-00.json results/2026-07-31T12-00-00.json

    # List saved results
    python extensions/pi-code-embedding/benchmarks/bench_index.py --list
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
REPOS_JSON = SCRIPT_DIR / "repos.json"
RESULTS_DIR = SCRIPT_DIR / "results"
FIXTURES_DIR = SCRIPT_DIR / "fixtures"

# Relative to repo root
EXTENSION_DIR = Path("extensions/pi-code-embedding")

# Auto-detect repo root (two levels up from script dir since we're at
# extensions/pi-code-embedding/benchmarks/)
REPO_ROOT = SCRIPT_DIR.parents[2]

# Sidecar binary path (release build)
SIDECAR_BIN = (
    REPO_ROOT
    / EXTENSION_DIR
    / "rust-embedder"
    / "target"
    / "release"
    / "pi-embedder.exe"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fmt(s: float) -> str:
    """Format seconds as human-readable string."""
    if s < 1.0:
        return f"{s * 1000:.0f}ms"
    return f"{s:.1f}s"


def stamp() -> str:
    """ISO-like timestamp safe for filenames."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")


def system_info() -> dict[str, Any]:
    """Gather system metadata for the benchmark result."""
    info: dict[str, Any] = {"platform": sys.platform}

    # CPU
    try:
        import multiprocessing
        info["cpu_count"] = multiprocessing.cpu_count()
    except Exception:
        info["cpu_count"] = os.cpu_count()

    # CPU name (Windows)
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["powershell", "-Command",
                 "(Get-CimInstance Win32_Processor).Name"],
                text=True, timeout=5
            )
            name = out.strip()
            if name:
                info["cpu_name"] = name
        except Exception:
            pass

    # GPU (Windows via nvidia-smi)
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            text=True, timeout=10,
        )
        info["gpu"] = out.strip()
    except Exception:
        info["gpu"] = None

    # RAM
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["powershell", "-Command",
                 "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"],
                text=True, timeout=5
            )
            total = int(out.strip())
            info["ram_gb"] = round(total / (1024**3), 1)
        except Exception:
            pass

    return info


def get_git_hash() -> str | None:
    """Return short git hash of the current working tree."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT, text=True, timeout=10,
        )
        return out.strip()
    except Exception:
        return None


def get_sidecar_size() -> int | None:
    """Return sidecar binary size in bytes."""
    try:
        return SIDECAR_BIN.stat().st_size
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Sidecar protocol
# ---------------------------------------------------------------------------

class SidecarError(Exception):
    """Raised when the sidecar returns an error response."""


class Sidecar:
    """Manages a pi-embedder subprocess for one benchmark cycle."""

    def __init__(self, db_path: str, model_repo: str, models_dir: str):
        self.db_path = db_path
        self.model_repo = model_repo
        self.models_dir = models_dir
        self.proc: subprocess.Popen | None = None
        self.dim: int = 0

    def __enter__(self):
        # Ensure directories exist
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        os.makedirs(self.models_dir, exist_ok=True)

        # Log sidecar cold-start timing
        t0 = time.perf_counter()

        self.proc = subprocess.Popen(
            [
                str(SIDECAR_BIN),
                "--model-repo", self.model_repo,
                "--models-dir", self.models_dir,
                "--db-path", self.db_path,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
        )
        # Read the ready line
        assert self.proc.stdout is not None
        ready_line = self.proc.stdout.readline().strip()
        ready = json.loads(ready_line)
        self.dim = ready.get("dim", 0)
        self._cold_start_ms = (time.perf_counter() - t0) * 1000
        return self

    def __exit__(self, *args):
        if self.proc:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
            self.proc = None

    @property
    def cold_start_ms(self) -> float:
        return self._cold_start_ms

    def send(self, request: dict) -> dict:
        """Send a JSON request, return the response dict."""
        assert self.proc is not None
        assert self.proc.stdin is not None
        assert self.proc.stdout is not None

        line = json.dumps(request, ensure_ascii=False)
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

        resp_line = self.proc.stdout.readline().strip()
        if not resp_line:
            raise SidecarError("sidecar closed stdout")
        resp = json.loads(resp_line)

        # Error responses have an "error" field instead of the expected data
        if "error" in resp:
            raise SidecarError(resp["error"])
        return resp

    def clear(self):
        self.send({"id": 1, "clear": {}})

    def scan(self, paths: list[str]) -> list[dict]:
        resp = self.send({
            "id": 2,
            "scan": {
                "paths": paths,
                "extensions": [],
                "skip_dirs": [],
            },
        })
        return resp["files"]

    def index(self, paths: list[str], chunk_size: int = 80,
              overlap: int = 20, prefix: str = "") -> dict:
        resp = self.send({
            "id": 3,
            "index": {
                "paths": paths,
                "chunk_size": chunk_size,
                "overlap": overlap,
                "store": True,
                "prefix": prefix,
                "skip_embed": False,
            },
        })
        return resp["indexed"]

    def status(self) -> dict:
        resp = self.send({"id": 10, "status": {}})
        return {
            "files": resp.get("files", 0),
            "chunks": resp.get("chunks", 0),
            "dim": resp.get("dim", self.dim),
            "db_size": resp.get("db_size", 0),
        }


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------

def bench_repo(
    sidecar: Sidecar,
    repo_name: str,
    repo_path: str | Path,
    chunk_size: int = 80,
    overlap: int = 20,
) -> dict[str, Any]:
    """
    Benchmark indexing a single repository path.
    Returns a dict with timing breakdown.
    """
    path = Path(repo_path)
    if not path.is_absolute():
        path = REPO_ROOT / path
    assert path.exists(), f"path does not exist: {path}"

    t0 = time.perf_counter()
    files = sidecar.scan([str(path)])
    scan_elapsed = time.perf_counter() - t0
    file_paths = [f["path"] for f in files]

    if not file_paths:
        return {
            "repo": repo_name,
            "path": str(path),
            "files_found": 0,
            "files_indexed": 0,
            "chunks": 0,
            "scan_ms": scan_elapsed * 1000,
            "index_ms": 0,
            "total_ms": (time.perf_counter() - t0) * 1000,
            "chunks_per_sec": 0.0,
            "files_per_sec": 0.0,
            "error": "no files found (unsupported languages?)",
        }

    t1 = time.perf_counter()
    result = sidecar.index(file_paths, chunk_size=chunk_size, overlap=overlap)
    index_elapsed = time.perf_counter() - t1
    total_elapsed = time.perf_counter() - t0

    files_indexed = result.get("files", 0)
    chunks = result.get("chunks", 0)

    return {
        "repo": repo_name,
        "path": str(path),
        "files_found": len(file_paths),
        "files_indexed": files_indexed,
        "chunks": chunks,
        "scan_ms": round(scan_elapsed * 1000, 1),
        "index_ms": round(index_elapsed * 1000, 1),
        "total_ms": round(total_elapsed * 1000, 1),
        "chunks_per_sec": round(chunks / total_elapsed, 1) if total_elapsed > 0 else 0.0,
        "files_per_sec": round(files_indexed / total_elapsed, 1) if total_elapsed > 0 else 0.0,
    }


def load_repos() -> list[dict]:
    """Load repos from repos.json, skipping disabled entries."""
    with open(REPOS_JSON) as f:
        data = json.load(f)
    return [r for r in data.get("repos", []) if not r.get("skip")]


def ensure_repo(repo: dict) -> str | None:
    """
    Ensure a repo is available locally. Returns a local path string,
    or None if the repo cannot be obtained.
    """
    if "path" in repo:
        path = Path(repo["path"])
        if not path.is_absolute():
            path = REPO_ROOT / path
        if path.exists():
            return str(path)
        print(f"  [warn] local path not found: {path}", file=sys.stderr)
        return None

    if "git_url" in repo:
        name = repo["name"]
        dest = FIXTURES_DIR / name
        if dest.exists():
            return str(dest)
        print(f"  cloning {repo['git_url']} into {dest} ...")
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", repo["git_url"], str(dest)],
                check=True, timeout=300, capture_output=True, text=True,
            )
            return str(dest)
        except subprocess.CalledProcessError as e:
            print(f"  [error] clone failed: {e.stderr[:200]}", file=sys.stderr)
            return None

    return None


# ---------------------------------------------------------------------------
# Results storage
# ---------------------------------------------------------------------------

def save_result(data: dict[str, Any]):
    """Save a benchmark result to results/ with a timestamped filename."""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{data['timestamp']}.json"
    path = RESULTS_DIR / filename
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"\n  Saved: {path}")
    return path


def list_results() -> list[Path]:
    """Return sorted list of result JSON files (newest first)."""
    if not RESULTS_DIR.exists():
        return []
    files = sorted(
        (p for p in RESULTS_DIR.glob("*.json") if p.name != "latest.json"),
        reverse=True,
    )
    return files


def load_result(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

def print_header(text: str):
    """Print a section header."""
    print()
    print("=" * 72)
    print(f"  {text}")
    print("=" * 72)


def print_results(results: list[dict], title: str = "Benchmark Results"):
    """Print a table of benchmark results."""
    print_header(title)

    # Column widths
    name_w = max(len(r.get("repo", "")) for r in results) + 2
    name_w = max(name_w, 8)

    header = (
        f"  {'Repo':<{name_w}} {'Files':>6} {'Idx':>5} {'Chunks':>7} "
        f"{'Scan':>8} {'Index':>8} {'Total':>8} {'ch/s':>7} {'file/s':>7}"
    )
    print(header)
    print("  " + "-" * (len(header) - 2))

    total_chunks = 0
    total_time = 0.0
    for r in results:
        total_chunks += r.get("chunks", 0)
        # total_ms from the entry — aggregate end-to-end
        total_time += r.get("total_ms", 0) / 1000
        print(
            f"  {r.get('repo', '?'):<{name_w}} "
            f"{r.get('files_found', 0):>6} "
            f"{r.get('files_indexed', 0):>5} "
            f"{r.get('chunks', 0):>7} "
            f"{fmt(r.get('scan_ms', 0) / 1000):>8} "
            f"{fmt(r.get('index_ms', 0) / 1000):>8} "
            f"{fmt(r.get('total_ms', 0) / 1000):>8} "
            f"{r.get('chunks_per_sec', 0):>7.1f} "
            f"{r.get('files_per_sec', 0):>7.1f}"
        )

    print()
    if total_time > 0:
        print(f"  Aggregate: {total_chunks} chunks in {fmt(total_time)} = "
              f"{total_chunks / total_time:.0f} ch/s")

    # Highlight DirectML usage
    for r in results:
        dml = r.get("directml", False)
        if dml:
            print(f"  {r.get('repo', '?')}: DirectML GPU enabled")
        elif r.get("directml") is False:
            print(f"  {r.get('repo', '?')}: DirectML unavailable (CPU fallback)")


def print_env(env: dict[str, Any]):
    """Print environment/metadata."""
    print("  Git hash:", env.get("git_hash", "?"))
    print("  Sidecar:", env.get("sidecar_size_mb", "?"), "MB")
    print("  Model:", env.get("model", "?"))
    print("  CPU:", env.get("cpu_name", env.get("cpu_count", "?")))
    if env.get("gpu"):
        print("  GPU:", env["gpu"])
    if env.get("ram_gb"):
        print("  RAM:", env["ram_gb"], "GB")
    print("  Platform:", env.get("platform", "?"))
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="pi-code-embedding indexing benchmark",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--repo", "-r", action="append", dest="repos", default=None,
        help="Benchmark specific repo(s) by name (from repos.json). "
             "Repeatable. Default: all enabled repos.",
    )
    parser.add_argument(
        "--path", "-p", action="append", dest="paths", default=None,
        help="Benchmark a local file/directory path directly. Repeatable.",
    )
    parser.add_argument(
        "--model", default="Xenova/all-MiniLM-L6-v2",
        help="Embedding model repo name (default: Xenova/all-MiniLM-L6-v2)",
    )
    parser.add_argument(
        "--models-dir",
        default=str(Path.home() / ".pi" / "agent" / ".pi" / "code-embedding" / "models"),
        help="Model cache directory",
    )
    parser.add_argument(
        "--chunk-size", type=int, default=80,
        help="Chunk size (default: 80)",
    )
    parser.add_argument(
        "--overlap", type=int, default=20,
        help="Chunk overlap (default: 20)",
    )
    parser.add_argument(
        "--list", action="store_true", dest="list_only",
        help="List saved benchmark results",
    )
    parser.add_argument(
        "--compare", nargs=2, metavar=("OLD", "NEW"),
        help="Compare two saved result files",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be benchmarked without running",
    )
    args = parser.parse_args()

    # --list
    if args.list_only:
        results = list_results()
        if not results:
            print("No saved results.")
            return
        print(f"\n  {'Timestamp':<22} {'Repos':>5} {'Chunks':>8} {'ch/s':>7}")
        print(f"  {'-'*48}")
        for p in results:
            data = load_result(p)
            repos = len(data.get("results", []))
            total_chunks = sum(r.get("chunks", 0) for r in data.get("results", []))
            total_time = sum(r.get("total_ms", 0) for r in data.get("results", [])) / 1000
            rate = round(total_chunks / total_time, 1) if total_time > 0 else 0
            ts = data.get("timestamp", p.stem)[:19]
            print(f"  {ts:<22} {repos:>5} {total_chunks:>8} {rate:>7.1f}")
        return

    # --compare
    if args.compare:
        old = load_result(Path(args.compare[0]))
        new = load_result(Path(args.compare[1]))
        print("\n  Comparison: old vs new")
        print(f"    Old: {args.compare[0]} ({old.get('timestamp', '?')})")
        print(f"    New: {args.compare[1]} ({new.get('timestamp', '?')})")
        print()

        old_repos = {r["repo"]: r for r in old.get("results", [])}
        new_repos = {r["repo"]: r for r in new.get("results", [])}
        all_names = sorted(set(old_repos) | set(new_repos))

        if not all_names:
            print("    No repo results found in files.")
            return

        name_w = max(len(n) for n in all_names) + 2
        print(f"  {'Repo':<{name_w}} {'Old ch/s':>9} {'New ch/s':>9} {'Change':>8}")
        print(f"  {'-' * (name_w + 30)}")
        for name in all_names:
            old_r = old_repos.get(name, {})
            new_r = new_repos.get(name, {})
            old_rate = old_r.get("chunks_per_sec", 0)
            new_rate = new_r.get("chunks_per_sec", 0)
            if old_rate > 0:
                change = (new_rate - old_rate) / old_rate * 100
                change_str = f"{change:+.1f}%"
            else:
                change_str = "N/A"
            print(f"  {name:<{name_w}} {old_rate:>9.1f} {new_rate:>9.1f} {change_str:>8}")
        return

    # Ensure sidecar exists
    if not SIDECAR_BIN.exists():
        print(f"Error: sidecar not found at {SIDECAR_BIN}", file=sys.stderr)
        print("Build it first: cd rust-embedder && cargo build --release", file=sys.stderr)
        sys.exit(1)

    # Gather repos to bench
    repos_to_bench: list[tuple[str, str]] = []  # (name, path)

    # From --path
    if args.paths:
        for p in args.paths:
            abs_p = Path(p).resolve()
            if abs_p.exists():
                repos_to_bench.append((f"path:{abs_p.name}", str(abs_p)))
            else:
                print(f"  [warn] path not found: {p}", file=sys.stderr)

    # From --repo or repos.json
    all_repos = load_repos()
    if args.repos:
        selected = {r["name"] for r in all_repos if r["name"] in args.repos}
        for r in all_repos:
            if r["name"] in selected:
                local = ensure_repo(r)
                if local:
                    repos_to_bench.append((r["name"], local))
        missing = set(args.repos) - selected
        for m in missing:
            print(f"  [warn] unknown repo: {m}", file=sys.stderr)
    else:
        for r in all_repos:
            local = ensure_repo(r)
            if local:
                repos_to_bench.append((r["name"], local))

    if not repos_to_bench:
        print("No repos to benchmark.", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print_header("DRY RUN — would benchmark:")
        for name, path in repos_to_bench:
            print(f"  {name:20s} {path}")
        return

    # Create a temp DB for this benchmark run
    with tempfile.TemporaryDirectory(prefix="code-embedding-bench-") as tmpdir:
        db_path = os.path.join(tmpdir, "index.db")

        # Start sidecar
        print_header("Starting sidecar")
        with Sidecar(db_path=db_path, model_repo=args.model, models_dir=args.models_dir) as sc:
            print(f"  Model: {args.model}")
            print(f"  Dim: {sc.dim}")
            print(f"  Cold start: {sc.cold_start_ms:.0f}ms")
            print(f"  DB: {db_path}")

            # Detect DirectML from stderr by running a quick clear
            sc.clear()

            results: list[dict] = []
            total_start = time.perf_counter()

            for name, path in repos_to_bench:
                print_header(f"Benchmarking: {name}")
                r = bench_repo(sc, name, path, chunk_size=args.chunk_size, overlap=args.overlap)
                results.append(r)
                if r.get("error"):
                    print(f"  Error: {r['error']}")
                else:
                    print(f"  {r['files_found']} files found, {r['files_indexed']} indexed, "
                          f"{r['chunks']} chunks, "
                          f"{r['chunks_per_sec']:.0f} ch/s")

            total_elapsed = time.perf_counter() - total_start

            # Get final status
            status = sc.status()

    # Check sidecar stderr for DirectML indicators
    dml_detected = False
    if sc.proc and sc.proc.stderr:
        stderr_text = sc.proc.stderr.read()
        dml_detected = "DirectML GPU EP enabled" in stderr_text

    # Environment metadata
    env = {
        "timestamp": stamp(),
        "git_hash": get_git_hash(),
        "sidecar_size_mb": round(get_sidecar_size() / (1024 * 1024), 1) if get_sidecar_size() else None,
        "model": args.model,
        "chunk_size": args.chunk_size,
        "overlap": args.overlap,
        "cold_start_ms": round(sc.cold_start_ms, 1),
        "directml": dml_detected,
        "system": system_info(),
    }

    # Aggregate
    total_chunks = sum(r.get("chunks", 0) for r in results)
    total_indexed = sum(r.get("files_indexed", 0) for r in results)
    aggregate_ch_per_s = round(total_chunks / total_elapsed, 1) if total_elapsed > 0 else 0.0

    data: dict[str, Any] = {
        **env,
        "total_elapsed_s": round(total_elapsed, 1),
        "total_files_indexed": total_indexed,
        "total_chunks": total_chunks,
        "aggregate_ch_per_s": aggregate_ch_per_s,
        "results": results,
    }

    # Save
    saved = save_result(data)

    # Display
    print_results(results)
    print("  Environment:")
    print_env(env)
    print(f"  Aggregate: {total_chunks} chunks / {total_indexed} files "
          f"in {fmt(total_elapsed)} = {aggregate_ch_per_s:.0f} ch/s")

    # Also update a latest.json symlink (or copy)
    latest = RESULTS_DIR / "latest.json"
    try:
        if latest.exists():
            latest.unlink()
    except Exception:
        pass
    try:
        # Use copy since Windows doesn't support symlinks well
        shutil.copy2(saved, latest)
        print(f"  Updated: {latest}")
    except Exception:
        pass

    print()


if __name__ == "__main__":
    main()
