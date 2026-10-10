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

if ! $check; then
  npm run build # typecheck + vite build
else
  # Lint, tests and build in parallel; each output is printed once its step ends.
  logs=$(mktemp -d)
  trap 'rm -rf "$logs"' EXIT
  declare -A pids
  for step in lint test build; do
    npm run "$step" >"$logs/$step" 2>&1 &
    pids[$step]=$!
  done
  failed=()
  for step in lint test build; do
    status=0
    wait "${pids[$step]}" || status=$?
    echo "=== npm run $step (exit $status)"
    cat "$logs/$step"
    [ "$status" -eq 0 ] || failed+=("$step")
  done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "failed: ${failed[*]}" >&2
    exit 1
  fi
fi

ls -lh dist-web/index.html
