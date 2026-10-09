#!/usr/bin/env bash
# Build every distributable: web, standalone code generator, VS Code extension, desktop apps (Docker).
# Usage: scripts/build_all.sh [--check] [web|cli|vscode|desktop]...   (default: all;
# --check: run lint and unit tests first)
# Output: dist-web/, dist-cli/, dist-vscode/, dist-tauri/, dist-electron/
set -euo pipefail
cd "$(dirname "$0")/.."

check=false
targets=()
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    web | cli | vscode | desktop) targets+=("$arg") ;;
    *) echo "usage: $0 [--check] [web|cli|vscode|desktop]..." >&2; exit 1 ;;
  esac
done
[ ${#targets[@]} -gt 0 ] || targets=(web cli vscode desktop)

has() { [[ " ${targets[*]} " == *" $1 "* ]]; }

# Install when missing or older than the lockfile (dependencies added since the last install).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

if $check; then
  npm run lint
  npm test
fi

if has web; then scripts/build_web.sh; fi
if has cli; then scripts/build_cli.sh; fi
if has vscode; then scripts/build_vscode.sh; fi
if has desktop; then scripts/build_desktop.sh; fi
