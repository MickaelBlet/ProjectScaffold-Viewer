#!/usr/bin/env bash
# Build every distributable: web, desktop apps (Docker).
# Usage: scripts/build_all.sh [--check] [web|desktop]...   (default: all;
# --check: run lint and unit tests first)
# Output: dist-web/, dist-tauri/, dist-electron/
set -euo pipefail
cd "$(dirname "$0")/.."

check=false
targets=()
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    web | desktop) targets+=("$arg") ;;
    *) echo "usage: $0 [--check] [web|desktop]..." >&2; exit 1 ;;
  esac
done
[ ${#targets[@]} -gt 0 ] || targets=(web desktop)

has() { [[ " ${targets[*]} " == *" $1 "* ]]; }

# Install when missing or older than the lockfile (dependencies added since the last install).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

if has web; then
  # build_web.sh --check runs lint and tests in parallel with the build.
  if $check; then scripts/build_web.sh --check; else scripts/build_web.sh; fi
elif $check; then
  npm run lint
  npm test
fi
if has desktop; then scripts/build_desktop.sh; fi
