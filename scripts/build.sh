#!/usr/bin/env bash
# Rebuild Linux and Windows distributables into dist/.
# Usage: scripts/build.sh [linux|win|all]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-all}"
case "$target" in
  linux | win | all) ;;
  *) echo "usage: $0 [linux|win|all]" >&2; exit 1 ;;
esac

[ -d node_modules ] || npm ci
npm run build

if [ "$target" != win ]; then
  npx electron-builder --linux
fi

if [ "$target" != linux ]; then
  if [ "$(uname -s)" = Linux ] && ! command -v wine >/dev/null; then
    # NSIS/portable need wine to edit the .exe; fall back to an unsigned zip.
    echo "wine not found: building Windows zip only" >&2
    npx electron-builder --win zip --x64 -c.win.signAndEditExecutable=false
  else
    npx electron-builder --win
  fi
fi

ls -1 dist | grep -E '\.(AppImage|tar\.gz|exe|zip)$' || true
