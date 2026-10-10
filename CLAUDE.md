# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ProjectScaffold-Viewer: browser editor for software architecture (modules, ports, typed interfaces, constrained links) that saves a language-agnostic YAML/JSON project file meant to feed code skeleton generators. One React web build (`dist-web/index.html`, a single self-contained file) runs in the browser, in Electron, in Tauri and in VS Code webviews. Sibling repository: ProjectScaffold-VsCode (the extension, with this repository as a submodule).

## Commands

```sh
npm run dev                          # Vite dev server
npm run build                        # typecheck (web) + single-file dist-web/index.html
npm run typecheck                    # node + web tsconfigs
npm test                             # vitest, tests/**/*.test.ts
npx vitest run tests/validate.test.ts          # one file
npx vitest run -t 'part of a test name'        # one test
npm run lint                         # eslint, type-checked rules + react-hooks
npm run schema                       # regenerate schema/*.schema.json from model/schema.ts
scripts/build_web.sh --check         # lint + test + build
scripts/build_desktop.sh             # Tauri + Electron in Docker (docker buildx bake)
scripts/build_all.sh [--check] [web|desktop]...   # all of the above (default: all)
```

- `--check` runs lint, tests and build in parallel. ESLint (`--cache`) and `tsc` (`incremental`) cache in `node_modules/.cache/`; the ESLint cache does not see type changes in imported files, so delete it when type-aware results look stale.
- `tests/serialize.test.ts` fails when `schema/scaffold.schema.json` is stale: run `npm run schema` after changing `model/schema.ts`.
- Prettier: no semicolons, single quotes, width 110, no trailing commas.
- `@/` aliases `src/renderer/src/`.

## Architecture

### Model (`src/renderer/src/model/`, pure, no React)

- Two representations: the in-memory `Project` (`types.ts`) references entities by **id**; the file format (`schema.ts`, zod, source of the published JSON Schema) references them by **qualified name** (`Core.Sensor`). `serialize.ts` converts between them and YAML/JSON text; the `editor` section holds layout/view data, stripped on export.
- `validate.ts`: semantic checks; errors block export, warnings do not. `locate.ts` maps problems to text lines, `outline.ts` reads an outline from the raw YAML (both used by the text editor and the VS Code extension).
- `dependencies.ts`: other project files a project uses. Their types/interfaces are copied into the project's `types` / `interfaces` with `dependency` set (snapshot, so files stay self-contained for generators); placed modules of dependencies are "imported modules". `sync.ts` carries renames to dependent projects.
- `reuse.ts`: reloading from text keeps existing entity ids so selection, editors and views survive text edits.
- Tests exercise the model and pure helpers only (`tsconfig.node.json` includes `tests/` and `model/`).

### State (`src/renderer/src/store/`)

- `documents.ts`: open tabs; each document has its own zustand project store with a zundo undo history (`projectStore.ts`; edits within 400 ms merge into one undo step).
- Projects are updated immutably (immer); canvas and lists rely on unchanged objects keeping their identity (`canvas/reuseUnchanged.ts`) to avoid re-rendering.
- `store/sync.ts` pushes a document's renames and definitions to the open documents depending on it, each as an undoable edit of its own.
- `textFiles.ts`: IDL files edited in tabs beside a document.

### Commands and UI

- `commands.ts` is the single command registry behind menus (`shell/MenuBar.tsx`), context menus, the command palette and shortcuts; `actions.ts` holds the editing actions on the active document. `shell/controllers.ts` gives commands handles on mounted canvases and dock layouts.
- `canvas/`: React Flow (`@xyflow/react`). `flowGraph.ts` builds nodes/edges from the project; `portSides.ts` / `linkRoute.ts` place ports and route links; layout via ELK (`model/autoLayout.ts`).
- Panels are dockview panels (`panels/`, `shell/DockShell.tsx`).
- `panels/ExplorerPanel.tsx`: one tree of every entity (views, binaries, dependencies, constants, types, interfaces, modules, links); module tree helpers (re-parent, hide in view) in `panels/moduleTree.ts`.
- All styles in one global `src/renderer/src/styles.css`.

### Hosts

- `host.ts` detects the host (`IN_VSCODE`, preview, side panel). `main.tsx` installs the file API (`api.d.ts` `Api`) from `webApi.ts` (browser: File System Access API, IndexedDB recents; also used by Electron and Tauri) or `vscodeApi.ts`.
- Preferences go through `storage.ts` (localStorage, or the extension's global state in VS Code), not `localStorage` directly.
- Desktop window controls: `window.desktop` from `electron/preload.cjs`, or `tauriDesktop.ts`; both frameless, drawn by `shell/WindowFrame.tsx`.
- VS Code: `vscodeProtocol.ts` types the messages between the pages and the extension (ProjectScaffold-VsCode `src/session.ts`, which imports this file through its submodule): types only, no imports. A protocol change needs a matching change in the extension. Commands not available in VS Code are left out of the registry, and menus drop them.

## Conventions

- Update `CHANGELOG.md` `[Unreleased]` (Keep a Changelog) and the user documentation (`README.md`, `docs/*.md`) for user-visible changes; update `examples/` and the schema when the file format changes. A release removes the `[Unreleased]` heading: add it back above the latest version (its compare link at the bottom stays).
- Build scripts install with `npm ci` when `node_modules` is older than the lockfile.
- Commit each finished feature or fix with the `commit-gpg` skill (GPG-signed commit, CHANGELOG checked).
