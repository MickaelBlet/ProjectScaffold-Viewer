#!/usr/bin/env bash
# Build the desktop app (Tauri) for Linux amd64 and Windows amd64 in Docker.
# Output: dist-tauri/linux/{*.deb,*.rpm,*.AppImage}, dist-tauri/windows/{*-setup.exe,*-portable.exe}
exec "$(dirname "$0")/build_desktop.sh" tauri
