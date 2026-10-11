#!/usr/bin/env bash
# Build every distributable: web, desktop apps (Docker), in parallel.
# Usage: scripts/build_all.sh [--check] [web|desktop]...   (default: all;
# --check: also run lint and unit tests)
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

# Host steps run in the background, each output printed once it ends; the desktop build streams live.
steps=()
if has web; then
  # build_web.sh --check runs lint and tests in parallel with the build.
  if $check; then steps+=('scripts/build_web.sh --check'); else steps+=(scripts/build_web.sh); fi
elif $check; then
  steps+=('npm run lint' 'npm test')
fi

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT
pids=()
for i in "${!steps[@]}"; do
  bash -c "${steps[$i]}" >"$logs/$i" 2>&1 &
  pids[i]=$!
done

failed=()
if has desktop; then scripts/build_desktop.sh || failed+=(desktop); fi

for i in "${!steps[@]}"; do
  status=0
  wait "${pids[$i]}" || status=$?
  echo "=== ${steps[$i]} (exit $status)"
  cat "$logs/$i"
  [ "$status" -eq 0 ] || failed+=("${steps[$i]}")
done
if [ ${#failed[@]} -gt 0 ]; then
  echo "failed: ${failed[*]}" >&2
  exit 1
fi
