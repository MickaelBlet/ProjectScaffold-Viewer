# syntax=docker/dockerfile:1
# Desktop builds, one stage per OS so BuildKit runs them in parallel on top of a single web build:
#   tauri:    Linux amd64 (deb, rpm, AppImage), Windows amd64 (NSIS + portable exe, cargo-xwin)
#   electron: Linux x64 (AppImage, tar.gz), Windows x64 (portable exe, zip; Wine stamps icon and version)
#   vscode:   VS Code extension (.vsix)
# Usage: scripts/build_desktop.sh (both), scripts/build_tauri.sh, scripts/build_electron.sh,
#        scripts/build_vscode.sh

# ---------- web: dist-web/index.html, shared by every desktop target ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# electron-builder downloads its own Electron zips; the npm package binary is unused here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS web
COPY . .
RUN npm run build

# ---------- tauri ----------
# Ubuntu 22.04: oldest base with webkit2gtk-4.1, keeps the AppImage glibc requirement low.
FROM ubuntu:22.04 AS tauri-toolchain
ARG NODE_MAJOR=22
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file wget pkg-config xdg-utils \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      clang lld llvm nsis \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Jammy ships NSIS 3.08, Tauri's installer script includes Win/RestartManager.nsh (NSIS >= 3.09).
RUN cd /tmp && curl -fsSLO http://archive.ubuntu.com/ubuntu/pool/universe/n/nsis/nsis-common_3.09-4ubuntu1_all.deb \
    && dpkg-deb -x nsis-common_3.09-4ubuntu1_all.deb nsis \
    && cp nsis/usr/share/nsis/Include/Win/RestartManager.nsh /usr/share/nsis/Include/Win/ \
    && rm -rf /tmp/nsis*

ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
# llvm-14/bin: clang-cl, lld-link, llvm-lib, llvm-rc used by cargo-xwin.
ENV PATH=/usr/local/cargo/bin:/usr/lib/llvm-14/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
      --target x86_64-unknown-linux-gnu --target x86_64-pc-windows-msvc \
    && cargo install --locked cargo-xwin \
    && rm -rf $CARGO_HOME/registry

# linuxdeploy (AppImage) is itself an AppImage: no FUSE inside containers.
ENV APPIMAGE_EXTRACT_AND_RUN=1 XWIN_ACCEPT_LICENSE=1

FROM tauri-toolchain AS tauri-src
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json package-lock.json ./
COPY src-tauri src-tauri
COPY --from=web /app/dist-web dist-web
# dist-web is already built: skip beforeBuildCommand (npm run build).
RUN echo '{"build":{"beforeBuildCommand":null}}' > src-tauri/tauri.docker.json

# Separate target and tool caches per OS: the two builds run concurrently.
FROM tauri-src AS tauri-linux
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=tauri-cache-linux,target=/root/.cache \
    --mount=type=cache,id=tauri-target-linux,target=/app/src-tauri/target \
    set -eux; \
    npx tauri build --config src-tauri/tauri.docker.json --bundles deb,rpm,appimage; \
    b=src-tauri/target/release/bundle; \
    mkdir -p /out/linux; \
    cp $b/deb/*.deb $b/rpm/*.rpm $b/appimage/*.AppImage /out/linux/

FROM tauri-src AS tauri-windows
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=tauri-cache-windows,target=/root/.cache \
    --mount=type=cache,id=tauri-target-windows,target=/app/src-tauri/target \
    set -eux; \
    npx tauri build --config src-tauri/tauri.docker.json --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis; \
    t=src-tauri/target/x86_64-pc-windows-msvc/release; \
    mkdir -p /out/windows; \
    cp $t/bundle/nsis/*.exe /out/windows/; \
    cp $t/project-scaffold.exe /out/windows/ProjectScaffold-portable.exe

FROM scratch AS tauri
COPY --from=tauri-linux /out /
COPY --from=tauri-windows /out /

# ---------- electron ----------
FROM electronuserland/builder:24-wine AS electron-src
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json package-lock.json electron-builder.yml ./
COPY electron electron
COPY scripts/patch_portable.sh scripts/
COPY --from=web /app/dist-web dist-web

FROM electron-src AS electron-linux
RUN --mount=type=cache,id=electron-linux,target=/root/.cache/electron \
    --mount=type=cache,id=electron-builder-linux,target=/root/.cache/electron-builder \
    npx electron-builder --linux \
    && mkdir -p /out/linux \
    && cp dist-electron/*.AppImage dist-electron/*-linux-*.tar.gz /out/linux/

FROM electron-src AS electron-windows
RUN --mount=type=cache,id=electron-windows,target=/root/.cache/electron \
    --mount=type=cache,id=electron-builder-windows,target=/root/.cache/electron-builder \
    scripts/patch_portable.sh && npx electron-builder --win \
    && mkdir -p /out/windows \
    && cp dist-electron/*-portable.exe dist-electron/*-win-*.zip /out/windows/

FROM scratch AS electron
COPY --from=electron-linux /out /
COPY --from=electron-windows /out /

# ---------- vscode ----------
FROM web AS vscode-package
RUN npm run vscode:package

FROM scratch AS vscode
COPY --from=vscode-package /app/dist-vscode /
