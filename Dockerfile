# syntax=docker/dockerfile:1
# Tauri desktop builds for Linux amd64 (deb, rpm, AppImage) and Windows amd64 (NSIS, cross-compiled
# with cargo-xwin). Usage: scripts/build_tauri.sh  -> dist-tauri/{linux,windows}/

# Ubuntu 22.04: oldest base with webkit2gtk-4.1, keeps the AppImage glibc requirement low.
FROM ubuntu:22.04 AS toolchain
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

FROM toolchain AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/root/.cache \
    --mount=type=cache,target=/app/src-tauri/target \
    set -eux; \
    npx tauri build --bundles deb,rpm,appimage; \
    npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis; \
    t=src-tauri/target; \
    mkdir -p /out/linux /out/windows; \
    cp $t/release/bundle/deb/*.deb $t/release/bundle/rpm/*.rpm $t/release/bundle/appimage/*.AppImage /out/linux/; \
    cp $t/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe /out/windows/; \
    cp $t/x86_64-pc-windows-msvc/release/project-scaffold.exe /out/windows/ProjectScaffold-portable.exe

FROM scratch AS export
COPY --from=build /out /
