#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 0 && "$1" != -* ]]; then
  extension="$1"
  shift
  exec pnpm test "extensions/${extension}" "$@"
fi

exec pnpm test "$@"
