#!/usr/bin/env bash
# Build the Tauri and Electron desktop apps in parallel in Docker (shared web build).
# Usage: scripts/build_desktop.sh [tauri|electron]...   (default: both)
# Output: dist-tauri/{linux,windows}/, dist-electron/{linux,windows}/
set -euo pipefail
cd "$(dirname "$0")/.."

targets=("$@")
[ $# -gt 0 ] || targets=(tauri electron)
for t in "${targets[@]}"; do
  case "$t" in
    tauri | electron) rm -rf "dist-$t" ;;
    *) echo "usage: $0 [tauri|electron]..." >&2; exit 1 ;;
  esac
done

docker buildx bake "${targets[@]}"

for t in "${targets[@]}"; do ls -lh "dist-$t"/*; done
