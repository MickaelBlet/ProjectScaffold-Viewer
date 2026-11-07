#!/usr/bin/env bash
# Build the native GPUI version into gpui/target/release/project-scaffold.
# Usage: scripts/build_gpui.sh [--check]   (--check: run rustfmt, clippy and tests first)
# Linux needs libxkbcommon-x11-dev and Vulkan or OpenGL drivers (mesa-vulkan-drivers).
set -euo pipefail
cd "$(dirname "$0")/../gpui"

case "${1:-}" in
  --check)
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo test
    ;;
  '') ;;
  *) echo "usage: $0 [--check]" >&2; exit 1 ;;
esac

cargo build --release
echo "built gpui/target/release/project-scaffold"
