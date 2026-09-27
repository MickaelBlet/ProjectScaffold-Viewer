#!/usr/bin/env bash
# Build the desktop app (Tauri) for Linux amd64 and Windows amd64 in Docker.
# Output: dist-tauri/linux/{*.deb,*.rpm,*.AppImage}, dist-tauri/windows/{*-setup.exe,*-portable.exe}
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist-tauri
DOCKER_BUILDKIT=1 docker build --platform linux/amd64 --target export --output type=local,dest=dist-tauri .

ls -lh dist-tauri/*
