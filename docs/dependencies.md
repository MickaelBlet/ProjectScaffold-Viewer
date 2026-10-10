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

### Linking to a dependency's modules

A dependency's top-level module is placed on the canvas from the Explorer (double-click it in the dependency's _Modules_) or the dependency's right-click menu (_Place a module on the canvas…_). Add the project as a dependency first (_Insert › Add dependency…_).

- The module is drawn in the project view (dashed, see-through, `↗ Project`, resizable), with its attributes and methods (read-only, also in its inspector) and ports linked to like any other.
- Its header buttons, as a module's: → drags a link to a module or port of this project through one of its ports (it gets no new port: a menu picks one when several fit), the lock keeps its position and size (Ctrl+L; `editor.dependencies.<Dependency>.<Module>.locked`), ⤢ opens it in its own view (Alt+Enter): it with its content and the modules of this project linked to them (compact). That view keeps nothing of its own (it cannot be kept): what is moved or resized there is moved in the project view too, the outside modules stay in line.
- It comes with all the modules inside it, drawn where its project puts them; move and resize them in it (it grows to hold them; kept on refresh), they are removed with it; their ports are linked to as well. A module placed alone by an earlier version is placed with its top-level module on the next refresh, its links kept.
- Double-click a placed module to switch to its project's tab.
- A module of this project may derive from a placed module (Inspector, _Bases_): its methods, as last read, are those overridden or implemented, its public types named by their own name in the derived module; removing the placed module removes it from the bases. Written `bases: [Robot/Core.Sensor]`.

### Indirect dependencies

The dependencies of a dependency come with it (`indirect`). They are read from their own files when they can be (an open tab, or next to the document in VS Code), else as that dependency last read them.

### Keeping up to date

- Edits made in a dependency's open tab reach the documents using it at once.
- Files that are not open catch up on _Refresh dependencies_. Types and interfaces no longer there but still used here stay, as own ones; links to removed ports are dropped.

### Explorer and Inspector

- The Explorer shows a dependency's content in folding groups: _Constants_, _Types_, _Interfaces_, _Modules_. Modules are listed as a tree, each under its parent with its types and constants (in _Types_ and _Constants_ by path while the module is not listed), placed on the canvas, or dimmed when not (when its file can be read: open in a tab, next to the document in VS Code; in the browser, an IDL file picked in the session or open as text, e.g. by its _Open_ entry after a reload); double-click a top-level one to place it with its content.
- Clicking the dependency shows it in the Inspector: where it comes from, the dependencies it uses and is used by, its types and interfaces with their members and uses, filtered.
- Its right-click menu opens it, refreshes it, places a module on the canvas, removes it (when nothing here uses it) or _detaches_ it: its types and interfaces become this project's own.

## Name clashes

- A name defined both here and in a dependency is taken only when both definitions are the same: the entity becomes the dependency's.
- Two dependencies defining a name the same way share it.
- A different definition is left out, with a warning.

## Renames stay in sync

Renaming a module (or a parent), a port, a type or constant (of a module too) or an interface in one project renames it in the open projects depending on it. Each document gets the change as its own undoable edit (and becomes unsaved).

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
    moduleTypes: # the types of its modules, by module path (optional): the public ones are used as Robot/Core.Sensor.Filter
      - module: Core.Sensor
        types: [...]
    moduleConstants: # the constants of its modules, by module path (optional)
      - module: Core.Sensor
        constants: [...]
    modules: # its modules placed on this canvas, with their attributes, methods and ports (optional): top-level ones with their content
      - module: Core
        ports: [{ name: control, role: in, interface: Control }]
      - module: Core.Sensor
        attributes: [...] # as in `modules[].attributes` (optional)
        methods: [...] # as in `modules[].methods` (optional)
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
- This project uses the public types of a dependency's modules by their path after the dependency's name: `Robot/Core.Sensor.Filter`.
- A dependency's types and interfaces only reference their own dependency's and those of the dependencies it `uses`.
- A placed port's interface is matched by name with those of this project and its dependencies.
- The types of placed attributes and methods are named as in this project: `Mode`, `Robot/Core.Sensor.Filter`.
- One end of a link must be in this project.

Generated code: the types and interfaces of dependencies are included from their own generated code; `scaffold-gen -d` generates the dependencies too ([ProjectScaffold-Generator › Command line](https://github.com/MickaelBlet/ProjectScaffold-Generator/blob/master/docs/code-generation.md#command-line)).

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
