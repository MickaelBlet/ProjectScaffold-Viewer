# syntax=docker/dockerfile:1
# Desktop builds, one stage per OS so BuildKit runs them in parallel on top of a single web build:
#   tauri:    Linux amd64 (deb, rpm, AppImage), Windows amd64 (NSIS + portable exe, cargo-xwin)
#   electron: Linux x64 (AppImage, tar.gz), Windows x64 (portable exe, zip; Wine stamps icon and version)
# Usage: scripts/build_desktop.sh (both), scripts/build_tauri.sh, scripts/build_electron.sh
# Base images and downloaded tools are pinned by digest or checksum: bump them on purpose.

# ---------- web: dist-web/index.html, shared by every desktop target ----------
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app
# electron-builder downloads its own Electron zips; the npm package binary is unused here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS web
# Only the build inputs: docs, tests or desktop sources changes keep this layer cached.
COPY tsconfig*.json vite.config.ts ./
COPY src src
# Vite only: typechecking is done by scripts/build_web.sh, run beside this build.
RUN npx vite build

# ---------- tauri ----------
# Ubuntu 22.04: oldest base with webkit2gtk-4.1, keeps the AppImage glibc requirement low.
FROM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401 AS tauri-toolchain
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file wget pkg-config xdg-utils \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      clang lld llvm nsis \
    && rm -rf /var/lib/apt/lists/*
# Node and npm of the web stage's image (official binaries, glibc 2.28+).
COPY --from=deps /usr/local/bin /usr/local/bin
COPY --from=deps /usr/local/lib/node_modules /usr/local/lib/node_modules

# Jammy ships NSIS 3.08, Tauri's installer script includes Win/RestartManager.nsh (NSIS >= 3.09).
ARG NSIS_DEB=nsis-common_3.09-4ubuntu1_all.deb
ARG NSIS_SHA256=49471b9debdee4751ebb4caf6b705cc4c678eebfaecefbe56362258893f85859
RUN cd /tmp && curl -fsSLO https://archive.ubuntu.com/ubuntu/pool/universe/n/nsis/${NSIS_DEB} \
    && echo "${NSIS_SHA256}  ${NSIS_DEB}" | sha256sum -c - \
    && dpkg-deb -x ${NSIS_DEB} nsis \
    && cp nsis/usr/share/nsis/Include/Win/RestartManager.nsh /usr/share/nsis/Include/Win/ \
    && rm -rf /tmp/nsis*

ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
# llvm-14/bin: clang-cl, lld-link, llvm-lib, llvm-rc used by cargo-xwin.
ENV PATH=/usr/local/cargo/bin:/usr/lib/llvm-14/bin:$PATH
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
RUN curl -fsSLo /tmp/rustup-init \
      https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --profile minimal --default-toolchain stable \
      --target x86_64-unknown-linux-gnu --target x86_64-pc-windows-msvc \
    && rm /tmp/rustup-init \
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
FROM electronuserland/builder:24-wine@sha256:41ae540902461b6cbc988987db79547fcc10cda04d2a6c6367504f59d4b37c64 AS electron-src
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
