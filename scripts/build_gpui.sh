#!/usr/bin/env bash
# Build the native GPUI version into gpui/target/release/project-scaffold.
# Usage: scripts/build_gpui.sh [--check] [--package] [--windows] [--no-linux]
#   --check     run rustfmt, clippy and tests first
#   --package   also pack each build into gpui/target/package/:
#               project-scaffold-<version>-linux-<arch>.tar.gz (binary, desktop entry, icon),
#               project-scaffold-<version>-windows-x86_64.zip (exe, icon)
#   --windows   also cross-compile the Windows build with cargo-xwin (MSVC target) into
#               gpui/target/x86_64-pc-windows-msvc/release/project-scaffold.exe
#   --no-linux  skip the Linux build (with --windows: the Windows build only)
# Linux needs libxkbcommon-x11-dev and Vulkan or OpenGL drivers (mesa-vulkan-drivers).
# Windows needs `cargo install cargo-xwin`, clang, lld and llvm-rc (it downloads the MSVC SDK on
# first use), and fxc.exe for gpui's DirectX shaders: GPUI_FXC_PATH, else the newest Windows SDK
# of the Windows host under WSL. The target is added with rustup when missing.
set -euo pipefail
cd "$(dirname "$0")/../gpui"

WIN_TARGET=x86_64-pc-windows-msvc
check=false
package=false
windows=false
linux=true
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    --package) package=true ;;
    --windows) windows=true ;;
    --no-linux) linux=false ;;
    *) echo "usage: $0 [--check] [--package] [--windows] [--no-linux]" >&2; exit 1 ;;
  esac
done

if $check; then
  cargo fmt --check
  cargo clippy --all-targets -- -D warnings
  cargo test
fi

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
mkdir -p target/package

if $linux; then
  cargo build --release
  echo "built gpui/target/release/project-scaffold"
  if $package; then
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
fi

if $windows; then
  command -v cargo-xwin >/dev/null || { echo "cargo-xwin missing: cargo install cargo-xwin" >&2; exit 1; }
  rustup target list --installed | grep -qx "$WIN_TARGET" || rustup target add "$WIN_TARGET"
  # gpui embeds Windows resources with llvm-rc, often only in the versioned LLVM folders.
  if ! command -v llvm-rc >/dev/null; then
    rc=$(ls -d /usr/lib/llvm-*/bin 2>/dev/null | sort -V | while read -r d; do [ -x "$d/llvm-rc" ] && echo "$d"; done | tail -1)
    [ -n "$rc" ] || { echo "llvm-rc missing: install llvm" >&2; exit 1; }
    export PATH="$PATH:$rc"
  fi
  # gpui compiles its DirectX shaders with fxc.exe in its build script, on a Windows host only:
  # cross-compiling, they are compiled here into the build script's output folder.
  win_shaders() {
    local fxc="${GPUI_FXC_PATH:-}"
    if [ -z "$fxc" ]; then
      fxc=$(ls "/mnt/c/Program Files (x86)/Windows Kits/10/bin/"*/x64/fxc.exe 2>/dev/null | sort -V | tail -1)
    fi
    [ -n "$fxc" ] && [ -e "$fxc" ] || { echo "fxc.exe not found: set GPUI_FXC_PATH" >&2; exit 1; }
    local version src out tmp
    version=$(grep -A1 '^name = "gpui-pre-windows"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p')
    src=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"gpui-pre-windows-$version" | head -1)/src
    # fxc.exe reads and writes Windows paths: work in the Windows temp folder.
    tmp="$(wslpath "$(cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")/gpui-shaders-$$"
    mkdir -p "$tmp"
    cp "$src"/*.hlsl "$tmp/"
    for out in target/"$WIN_TARGET"/release/build/gpui-pre-windows-*/out; do
      [ -f "$out/shaders_bytes.rs" ] && continue
      local binding="$tmp/shaders_bytes.rs"
      : > "$binding"
      for module in quad shadow path_rasterization path_sprite underline monochrome_sprite \
        subpixel_sprite polychrome_sprite emojirasterization; do
        local file=shaders.hlsl name=$module
        if [ "$module" = emojirasterization ]; then file=color_text_raster.hlsl; name=emoji_rasterization; fi
        for stage in vertex:vs fragment:ps; do
          local entry=${stage%%:*} kind=${stage##*:} upper
          upper=$(echo "$name" | tr '[:lower:]' '[:upper:]')_$(echo "$entry" | tr '[:lower:]' '[:upper:]')_BYTES
          "$fxc" /nologo /T "${kind}_4_1" /E "${name}_$entry" /Fh "$(wslpath -w "$tmp/$name.h")" \
            /Vn "$upper" /O3 "$(wslpath -w "$tmp/$file")" >/dev/null
          python3 - "$tmp/$name.h" "$upper" >> "$binding" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
body = text[text.index('const BYTE'):]
values = body[body.index('{') + 1:body.index('}')]
print(f"const {sys.argv[2]}: &[u8] = &[{values.strip()}];")
PY
        done
      done
      cp "$binding" "$out/shaders_bytes.rs"
      echo "compiled gpui's DirectX shaders into gpui/$out"
    done
    rm -rf "$tmp"
  }
  # The first build runs gpui's build script, which makes the folder the shaders go to.
  if ! cargo xwin build --release --target "$WIN_TARGET" -p project-scaffold; then
    win_shaders
    cargo xwin build --release --target "$WIN_TARGET" -p project-scaffold
  fi
  exe="target/$WIN_TARGET/release/project-scaffold.exe"
  echo "built gpui/$exe"
  if $package; then
    name="project-scaffold-$version-windows-x86_64"
    dir="target/package/$name"
    rm -rf "$dir" "target/package/$name.zip"
    mkdir -p "$dir"
    cp "$exe" "$dir/"
    cp ../src-tauri/icons/icon.ico "$dir/project-scaffold.ico"
    (cd target/package && zip -qr "$name.zip" "$name")
    echo "packed gpui/target/package/$name.zip"
  fi
fi
