# Building and running

ProjectScaffold is one React web build that runs in the browser, in two desktop shells (Tauri, Electron) and in VS Code. Every target is built from the same `dist-web/index.html`. The VS Code extension ([ProjectScaffold-VsCode](https://github.com/MickaelBlet/ProjectScaffold-VsCode)) and the code generator ([ProjectScaffold-Generator](https://github.com/MickaelBlet/ProjectScaffold-Generator)) are built in their own repositories.

- [Web app](#web-app)
- [Desktop apps](#desktop-apps)
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

Local development windows:

```sh
npm run tauri dev           # needs Rust + webkit2gtk-4.1
npm run electron            # from the web build
```

## Checks

```sh
npm test                     # unit tests (model, serialization, validation, canvas geometry)
npm run lint
npm run typecheck
npm run schema               # regenerate schema/*.schema.json from the model
scripts/build_all.sh         # web, desktop (Docker); args: [--check] [web|desktop]...
```
