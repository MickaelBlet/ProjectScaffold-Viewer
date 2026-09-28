#!/usr/bin/env bash
# Build the portable Electron app for Linux x64 and Windows x64 in Docker.
# Output: dist-electron/linux/{*.AppImage,*.tar.gz}, dist-electron/windows/{*-portable.exe,*.zip}
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist-electron
DOCKER_BUILDKIT=1 docker build --platform linux/amd64 -f Dockerfile.electron --target export \
  --output type=local,dest=dist-electron .

ls -lh dist-electron/*
