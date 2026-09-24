#!/usr/bin/env bash
# Rebuild the browser version into dist-web/index.html (single self-contained file).
# Usage: scripts/build_web.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d node_modules ] || npm ci
npm run build:web

ls -lh dist-web/index.html
