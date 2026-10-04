# Dependencies

A large architecture is split into project files depending on each other. A dependency is another project file (or an [IDL file](idl.md)) whose types and interfaces this project uses by name, as if they were its own (one namespace), and whose modules its links may reach.

- [Example](#example)
- [In the editor](#in-the-editor)
- [Name clashes](#name-clashes)
- [Renames stay in sync](#renames-stay-in-sync)
- [Importing projects](#importing-projects)
- [File format](#file-format)
- [Workspace files](#workspace-files)

## Example

- [`examples/common.scaffold.yaml`](../examples/common.scaffold.yaml): types and interfaces only;
- [`examples/robot.scaffold.yaml`](../examples/robot.scaffold.yaml) uses it;
- [`examples/station.scaffold.yaml`](../examples/station.scaffold.yaml) uses both and links to a module of the robot.

A larger one, opened at once through a [workspace file](#workspace-files): [`examples/fleet/`](../examples/fleet).

## In the editor

### Adding a dependency

_Insert › Add dependency…_ (or + in the Explorer's _Dependencies_) picks an open document, or several project files and IDL files at once (_Open files…_). Their types and interfaces are then used read-only, like this project's own ones.

### Linking to another project's modules

_Insert › Link to another project…_ (or the canvas menu) picks a dependency or another project, then one of its modules.

- The module is drawn in the project view (dashed, `↗ Project`, resizable), with ports linked to like any other.
- The project becomes a dependency if it was not one, so the interfaces of its ports are used here, not copied.
- Double-click a placed module to switch to its project's tab.

### Indirect dependencies

The dependencies of a dependency come with it (`indirect`). They are read from their own files when they can be (an open tab, or next to the document in VS Code), else as that dependency last read them.

### Keeping up to date

- Edits made in a dependency's open tab reach the documents using it at once.
- Files that are not open catch up on _Refresh dependencies_. Types and interfaces no longer there but still used here stay, as own ones; links to removed ports are dropped.

### Explorer and Inspector

- The Explorer shows a dependency's content in folding groups: _Constants_, _Types_, _Interfaces_, _Modules_. Modules are listed placed on the canvas, or dimmed when not (when its file can be read); double-click one to place it.
- Clicking the dependency shows it in the Inspector: where it comes from, the dependencies it uses and is used by, its types and interfaces with their members and uses, filtered.
- Its right-click menu opens it, refreshes it, places a module on the canvas, removes it (when nothing here uses it) or _detaches_ it: its types and interfaces become this project's own.

## Name clashes

- A name defined both here and in a dependency is taken only when both definitions are the same: the entity becomes the dependency's.
- Two dependencies defining a name the same way share it.
- A different definition is left out, with a warning.

## Renames stay in sync

Renaming a module (or a parent), a port, a type or an interface in one project renames it in the open projects depending on it. Each document gets the change as its own undoable edit (and becomes unsaved).

Files that are not open catch up on _Refresh dependencies_: a placed module no longer found by its path is matched to the only other module with the same name (moved) or the same ports (renamed). The dialog lists what was renamed.

## Importing projects

_Import projects or IDL files_ (_Insert_ menu, or right click the canvas / a module) copies, rather than references, the whole content of an open document or of several project files at once into the selected module (or the top level), one below the other:

- their modules with their links, their notes at the top level;
- the types and interfaces this project lacks — the others are matched by name.

The copy is not linked to those projects, but their dependencies become this project's (a picked project another one depends on is copied first and stands for that dependency). Importing IDL files: [IDL files](idl.md).

## File format

Each dependency keeps a copy of what is used, as last read, so the file stays self-contained for generators:

```yaml
dependencies:
  - name: Robot # referenced by `uses` and link ends
    file: robot.scaffold.yaml # relative to this file
    uses: [Common] # dependencies of this list that its types and interfaces use (optional)
    types: [...] # its own types, as in `types`
    interfaces: [...] # its own interfaces, as in `interfaces`
    constants: [...] # its own constants, as in `constants` (optional)
    modules: # its modules placed on this canvas, with their ports (optional)
      - module: Core.Sensor
        ports: [{ name: out, role: out, interface: Telemetry }]
  - name: Common
    file: common.scaffold.yaml
    indirect: true # only here because another dependency uses it (optional)
    shared: [Vec3] # defined the same way by another dependency of this list, listed there (optional)
    types: [...]
    interfaces: [...]
links:
  - name: sensor_to_monitor
    from: { project: Robot, module: Core.Sensor, port: out }
    to: { module: Monitor, port: telemetry }
    constraints: { ... }
```

- Generators read the project's `types` and `interfaces` plus those of every dependency.
- A dependency's types and interfaces only reference their own dependency's and those of the dependencies it `uses`.
- A placed port's interface is matched by name with those of this project and its dependencies.
- One end of a link must be in this project.

Generated code: the types and interfaces of dependencies are included from their own generated code; `scaffold-gen -d` generates the dependencies too ([Code generation › Command line](code-generation.md#command-line)).

## Workspace files

A workspace file (`*.scaffold-workspace.yaml`, schema [`schema/scaffold-workspace.schema.json`](../schema/scaffold-workspace.schema.json)) lists project files, to open them all at once:

```yaml
schemaVersion: 1
workspace: { name, description? }
projects: # relative to the workspace file, opened in tabs in this order (the first one shown)
  - ground.scaffold.yaml
  - drone.scaffold.yaml
  - shared/units.scaffold.yaml
```

- _File › Open…_ on a workspace file opens its projects. The browser and desktop apps then ask for the folder holding it, to read them; files outside that folder cannot be read.
- Folders picked this way are remembered: a workspace file inside one of them, at any depth, opens without asking again (at most a permission prompt after a restart). Picking a parent folder once covers all the workspaces under it.
- Projects already open with unsaved changes are kept.
- _File › Save workspace_ rewrites the workspace last opened or saved with the open project files; _Save workspace as…_ writes a new one.
- Not in VS Code, which opens project files one by one.

Example: [`examples/fleet/fleet.scaffold-workspace.yaml`](../examples/fleet/fleet.scaffold-workspace.yaml).
