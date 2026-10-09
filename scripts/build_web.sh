#!/usr/bin/env bash
# Rebuild the browser version into dist-web/index.html (single self-contained file).
# Usage: scripts/build_web.sh [--check]   (--check: run lint and unit tests first)
set -euo pipefail
cd "$(dirname "$0")/.."

check=false
case "${1:-}" in
  --check) check=true ;;
  '') ;;
  *) echo "usage: $0 [--check]" >&2; exit 1 ;;
esac

# Install when missing or older than the lockfile (dependencies added since the last install).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

if $check; then
  npm run lint
  npm test
fi
npm run build # typecheck + vite build

ls -lh dist-web/index.html
