# Building and running

ProjectScaffold is one React web build that runs in the browser, in two desktop shells (Tauri, Electron) and in VS Code. Every target is built from the same `dist-web/index.html`.

- [Web app](#web-app)
- [Desktop apps](#desktop-apps)
- [VS Code extension](#vs-code-extension)
- [Command-line generator](#command-line-generator)
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

## VS Code extension

```sh
scripts/build_vscode.sh     # -> dist-vscode/project-scaffold-vscode-<version>.vsix (or: docker buildx bake vscode)
code --install-extension dist-vscode/project-scaffold-vscode-*.vsix
```

Development: `npm run build && npm run vscode:compile`, then `code --extensionDevelopmentPath="$PWD/vscode" examples` opens an Extension Development Host. Using the extension: [VS Code](vscode.md).

## Command-line generator

```sh
npm run generate -- examples/robot.scaffold.yaml -d   # generate code with its dependencies
scripts/build_cli.sh                                   # standalone dist-cli/scaffold-gen (or: npm run cli)
```

See [Code generation › Command line](code-generation.md#command-line).

## Checks

```sh
npm test                     # unit tests (model, serialization, validation, code generation)
npm run lint
npm run typecheck
npm run schema               # regenerate schema/scaffold.schema.json from the model
scripts/check_templates.sh   # generate the examples with each built-in template set and build them
scripts/check_remote.sh      # calls between binaries: C++ and Python over every generated transport (cmake, python3)
scripts/build_all.sh         # web, CLI, VS Code, desktop (Docker); args: [--check] [web|cli|vscode|desktop]...
```
