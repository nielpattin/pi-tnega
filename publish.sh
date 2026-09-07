#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$script_dir"

usage() {
  cat <<'USAGE'
Usage:
  ./publish.sh <package> --tag <tag>

Example:
  ./publish.sh pi-reference --tag '@nielpattin/pi-reference@0.2.1'
USAGE
}

extensions_dir="$script_dir/extensions"
package=""
tag=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$package" ]; then
        echo "error: only one package can be published per tag" >&2
        exit 1
      fi
      package="$1"
      shift
      ;;
  esac
done

if [ -z "$package" ] || [ -z "$tag" ]; then
  usage >&2
  exit 1
fi

manifest="$extensions_dir/$package/package.json"
if [ ! -f "$manifest" ]; then
  echo "error: package not found: $package" >&2
  exit 1
fi

echo "=== triggering publish: $package from $tag ==="
gh workflow run publish.yml -f "package=$package" -f "tag=$tag"
echo "=== done ==="
