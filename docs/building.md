# Building and running

ProjectScaffold is one React web build that runs in the browser, in two desktop shells (Tauri, Electron) and in VS Code. Every target is built from the same `dist-web/index.html`. The VS Code extension ([ProjectScaffold-VsCode](https://github.com/MickaelBlet/ProjectScaffold-VsCode)) and the code generator ([ProjectScaffold-Generator](https://github.com/MickaelBlet/ProjectScaffold-Generator)) are built in their own repositories.

- [Web app](#web-app)
- [Desktop apps](#desktop-apps)
- [Native app (GPUI, preview)](#native-app-gpui-preview)
- [Checks](#checks)

## Web app

```sh
npm install
npm run dev          # dev server with hot reload
npm run build        # typecheck + single self-contained dist-web/index.html
npm run preview      # serve the production build
```

`dist-web/index.html` works from `file://` or any static host. Files are read and written through the File System Access API when available (Chrome, Edge), otherwise through a file input and a download.

## Desktop apps

| App      | Platforms                                                                                   | Notes                         |
| -------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| Tauri    | Linux amd64 (`.deb`, `.rpm`, `.AppImage`), Windows amd64 (NSIS installer + portable `.exe`) | Windows needs WebView2        |
| Electron | Linux x64 (`.AppImage`, `.tar.gz`), Windows x64 (portable `.exe`, `.zip`)                   | Bundles Chromium: no WebView2 |

Both are built in Docker:

```sh
scripts/build_tauri.sh      # -> dist-tauri/linux/, dist-tauri/windows/
scripts/build_electron.sh   # -> dist-electron/linux/, dist-electron/windows/
scripts/build_desktop.sh    # both at once (parallel, shared web build, docker buildx bake)
```

The `Dockerfile` pins its base images by digest and checks the tools it downloads (`rustup-init`, an NSIS include) against their SHA-256: update the digest or checksum along with a version.

Local development windows:

```sh
npm run tauri dev           # needs Rust + webkit2gtk-4.1
npm run electron            # from the web build
```

## Native app (GPUI, preview)

`gpui/` is a native Rust port of the editor built on [GPUI](https://www.gpui.rs/), in progress. It reads and writes the same project files (saved byte for byte as the web build saves them) and reports the same problems. So far it draws the project view and edits its layout: select (click, Shift/Ctrl+click, Shift+drag a box), move modules and notes with alignment guides (dropping a module into another makes it a submodule; a frame carries what lies inside it), resize them by their handles, draw links from a port (or the arrow handle of a selected module) to a port or a module, arrow keys, delete, undo/redo, open (with recent files) and save; a file changed by another program is reloaded. Docked panels follow the web build: Explorer, Search, Inspector (project, modules, links, types, interfaces, notes, dependencies), Settings, Problems, Output and a State machine panel (states and transitions as lists). The Source panel (Alt+U) edits the file text beside the canvas, with diagnostics, schema completion and selection sync. Views, auto-arrange (own layered layout in place of ELK), dependencies with sync between open documents, and workspace files work as in the web build. Menus, toolbar, document tabs, status bar, command palette (Ctrl+Shift+P), Go to (Ctrl+P), the canvas context menu and the shortcuts follow the web build; commands of features not ported yet show disabled.

```sh
scripts/build_gpui.sh            # -> gpui/target/release/project-scaffold
scripts/build_gpui.sh --check    # rustfmt, clippy and tests first
gpui/target/release/project-scaffold examples/robot.scaffold.yaml
```

It needs the Rust toolchain pinned in `gpui/rust-toolchain.toml` (installed by rustup), and on Linux `libxkbcommon-x11-dev` and Vulkan or OpenGL drivers (`mesa-vulkan-drivers`). Under WSL it renders in software.

## Checks

```sh
npm test                     # unit tests (model, serialization, validation, canvas geometry)
npm run lint
npm run typecheck
npm run schema               # regenerate schema/*.schema.json from the model
scripts/build_all.sh         # web, desktop (Docker) in parallel; args: [--check] [web|desktop]...
```
