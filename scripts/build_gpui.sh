#!/usr/bin/env bash
# Build the native GPUI version into gpui/target/release/project-scaffold.
# Usage: scripts/build_gpui.sh [--check] [--package]
#   --check    run rustfmt, clippy and tests first
#   --package  also pack the binary, a desktop entry and the icon into
#              gpui/target/package/project-scaffold-<version>-<os>-<arch>.tar.gz
# Linux needs libxkbcommon-x11-dev and Vulkan or OpenGL drivers (mesa-vulkan-drivers).
set -euo pipefail
cd "$(dirname "$0")/../gpui"

check=false
package=false
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    --package) package=true ;;
    *) echo "usage: $0 [--check] [--package]" >&2; exit 1 ;;
  esac
done

if $check; then
  cargo fmt --check
  cargo clippy --all-targets -- -D warnings
  cargo test
fi

cargo build --release
echo "built gpui/target/release/project-scaffold"

if $package; then
  version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
  name="project-scaffold-$version-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  dir="target/package/$name"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp target/release/project-scaffold "$dir/"
  cp ../src-tauri/icons/128x128.png "$dir/project-scaffold.png"
  cat > "$dir/project-scaffold.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=ProjectScaffold
Comment=Software architecture editor (modules, ports, typed interfaces)
Exec=project-scaffold %F
Icon=project-scaffold
Categories=Development;
MimeType=application/x-yaml;application/json;
DESKTOP
  tar -czf "target/package/$name.tar.gz" -C target/package "$name"
  echo "packed gpui/target/package/$name.tar.gz"
fi
