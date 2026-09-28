#!/usr/bin/env bash
# Build the portable Electron app for Linux x64 and Windows x64 in Docker.
# Output: dist-electron/linux/{*.AppImage,*.tar.gz}, dist-electron/windows/{*-portable.exe,*.zip}
exec "$(dirname "$0")/build_desktop.sh" electron
