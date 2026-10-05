# Editor

- [Workspace](#workspace): documents, panels, views, text editor, search, command palette
- [Diagram](#diagram): modules, ports, links, classes, layout, binaries
- [Model panels](#model-panels): types, interfaces, problems, output
- [Files and settings](#files-and-settings)

Projects using other project files, importing projects and IDL files: [Dependencies](dependencies.md), [IDL files](idl.md). Every shortcut: [Keyboard shortcuts](shortcuts.md).

## Workspace

### Documents

Several projects open at once, in tabs, each with its own undo history.

- Alt+N new, Alt+W close, Alt+1…9 or Alt+PageUp / Alt+PageDown to switch, middle click to close, drag to reorder.
- Open documents and their unsaved edits are restored after a page reload.

### Panels

Explorer, Inspector, Problems, Output, Search, Settings and Code generation are dockable panels.

- Drag a tab to dock it on any side, stack it with others or float it. The layout is kept; _Window › Reset panel layout_ restores the default one.
- The Explorer's sections are reordered by dragging their header (or Alt+↑ / Alt+↓) and hidden from their right-click menu (_Reset sections_ restores them).
- In the Explorer's _Modules_, dragging a module onto another (or onto the list) moves it inside (or to the top level). The modules of dependencies placed on the canvas follow the project's own.

### Views

Each document has a _Project_ view plus any number of stored views, opened as tabs and splittable side by side.

- _Open module in its own view_ (Alt+Enter, or ⤢ on a container) shows one module's content, with stand-ins for the outside modules it is linked to and a breadcrumb back to the parents.
- It opens in a temporary tab (italic title, not saved in the file). _Keep view_ (double-click the tab, its right-click menu, the breadcrumb or _View › Keep view_) stores it with the document; closing the tab discards it.
- Modules can be hidden per view: H, or _Hide in view_ in the right-click menu of a module in the Explorer; Shift+H shows them again.

### Editor tabs

Double-click a type or interface in the Explorer (or ↗ in the Inspector) to edit it in a tab of its own.

### Text editor

_View › Edit as text_ (Alt+U) opens the project file's YAML (or JSON) in a code editor (CodeMirror).

- Syntax colors, folding, multiple cursors.
- Search and replace in a floating widget like VS Code's (Ctrl+F, Ctrl+H): match case, whole word, regular expression, match count.
- Completion of the keys, values and names the file allows (Ctrl+Space).
- Load and validation errors and warnings marked on their lines and listed below the text.
- Changes since the last save shown in the text, the minimap and the scrollbar (_Changes_, on by default), with a button to revert each.
- A minimap on the right (_View › Text minimap_): the lines in view, selections, search matches, matching brackets, problems, changes and section headers.
- Valid edits apply to the project after a pause, one undo step each.
- _Sync selection_: the element under the cursor is selected in the diagram; the cursor moves to the element selected in the diagram or a list.

Font, tab size, whitespace, word wrap (_View › Word wrap_, Alt+Z), the minimap and the editor's helpers are set in _Settings › Text editor_.

IDL files can be edited as text too: see [IDL files](idl.md#editing-idl-files).

### Search

Ctrl+Shift+F searches names, descriptions and metadata of the project, then the templates and generated files by name and content. A matching line opens its file with the match selected.

### Command palette

- Ctrl+Shift+P (or F1) runs any command.
- Ctrl+P goes to a module, type, interface, constant, link, dependency (and what it defines), view, template or generated file.
- `?` lists every shortcut.

## Diagram

### Canvas

- Right click the canvas for its menu; right click anything for its actions.
- Double-click the canvas to zoom in, Shift+double-click to zoom out.
- **+ Module** (Ctrl+M) adds a module. Drop a module onto another to nest it; drag it out to move it up.
- F2 or double-click a module name to rename it in place.

### Selection

- Click, Ctrl+click to add, Shift+drag for a box.
- Arrows move the selection (Shift: further); F fits it, Shift+F fits everything.
- With _Select before moving_ (setting, on by default) only selected items move when dragged; dragging others pans the view.

### Ports and links

- `in` ports on the left, `out` ports on the right — or `in` on top, `out` at the bottom in vertical orientation.
- Drag between an `out` port and an `in` port to create a link. A container's `in` port links to an `in` port inside it; an `out` port inside links to the container's `out` port.
- Or link modules directly: drag the → in a module's header onto another module (or one of its `in` ports), or drag a port onto a module. The missing `out` / `in` ports are added, typed with the other end's interface.
- Ports follow their links: on a module without submodules, each port (dot and name) moves to the edge facing the modules it is linked to — top / bottom for modules one above the other, left / right otherwise. Containers keep their ports on the default edges and their links leave from the facing side (_View › Auto-orient link ends_).

### Link shape

Like draw.io; saved in `editor.links`.

- Select a link, then drag its line to add a bend, drag a bend to move it (snaps to the grid and in line with its neighbours; Alt: free), double-click a bend to remove it.
- Drag an end square along its module's border to attach the link there; double-click it to attach at the port again.
- _Reset shape_ in the link's menu. _Arrange_ clears the bends.
- Bends move with the module holding both ends, and with both ends when they are moved together.

### Copy and paste

Ctrl+C / X / V / D copy, cut, paste and duplicate several items at once: modules with their content and the links between them, notes, types and interfaces — within a document, between document tabs, and between browser windows (system clipboard). Interfaces and types are matched by name when pasted into another project.

### Attributes and methods

- **Attributes** are listed as `name: type = default` in a compartment below the module's header, apart from the ports on its border where links attach. Edit them in the module's inspector, with their default value: a choice for `bool` and enums, a YAML flow literal checked against the type otherwise (the placeholder shows the expected shape).
- **Methods** are prototypes listed as `static name(const a: T, out b: U): R const` in a compartment below the attributes. Edit them in the module's inspector like interface messages: parameters with their direction, an optional return type, `const` on `in` parameters.
- Both can be `static` and `const` (checkboxes in the inspector), shown before their name on the canvas.

### Classes and inheritance

Modules work as C++-like classes:

- _Kind_: `class` (concrete, default), `abstract` or `interface` (only pure methods, no attributes), shown as `«interface» Name` in italics.
- _Bases_: modules it derives from, shown as `Name : Base` and as UML arrows from the module to each base (hollow triangle, dashed to an interface). Clicking an arrow selects the module; right click goes to or removes the base. _View › Inheritance arrows_ hides them.
- Methods can be `virtual`, `pure` (`= 0`) and `override`, shown as `virtual name(): R const override = 0`.
- _Implement_ in the Methods section adds the pure methods a module inherits and lacks, as overrides.

### Arrange

- _Auto-arrange_ (Ctrl+Alt+L) lays out the selected container's content, the view's module, or everything, with ELK (layered, port aware, nested modules).
- _Arrange horizontally_ (Ctrl+Alt+H) and _vertically_ (Ctrl+Alt+V) also set the document's orientation: ports on the sides with links flowing right, or ports and their names on the top / bottom edges with links flowing down (saved in `editor.orientation`).
- Align, distribute, same size and _Group into a module_ (Ctrl+G) act on the selection.
- Alignment guides and snap to grid while dragging.

### Binaries

Binaries are the executables the project is split into.

- Add them in the Explorer's _Binaries_ (+) or the project inspector (name, color).
- Pick each top-level module's _Binary_ in its inspector or its menu (_Binary ›_, for the whole selection). A module shows its binary in its header.
- Links between two binaries become remote (dashed): choose their transport. Links back inside one binary become local again when they have none.
- A module moved into a container runs in the container's binary; one moved out keeps running where it ran.

Generated code for links between binaries: [Links between binaries](remote.md).

### Notes, frames, colors

Module colors, sticky notes and titled frames (right click the canvas) help organize the diagram; dragging a frame moves what lies fully inside it. They are editor data only.

### Export

The diagram exports as PNG or SVG from the _File_ menu.

## Model panels

- **Explorer**: types (struct / exception / enum / bitmask / union / alias / custom primitive), constants (edited in the project inspector) and interfaces (messages with typed `in` / `out` / `inout` parameters and optional return). Type fields accept expressions with completion (`map<string, vector<uint16>>`), or the structured editor (⋮). Inspectors list where a type or interface is used.
- **Problems**: validates live (filter by severity or text). Errors block export, warnings do not.
- **Output** (Ctrl+Shift+U): logs code generation file by file (click a generated file to open it) and every status message and dialog, with their time; filter by source, level or text.
- **Code generation**: see [Code generation › Code generation panel](code-generation.md#code-generation-panel).

## Files and settings

- **Save** writes the project file: the [file format](file-format.md) plus the `editor` section, which generators ignore.
- **Recent ▾** (toolbar) lists the last 10 opened / saved projects (exports excluded). Stored in IndexedDB (file handle + last content; reopening asks for file access again when needed).
- **Settings** are kept per browser; the filter at the top of the panel matches their labels, hints and section titles:
  - theme: system, light, dark or a color theme (black, red, orange, yellow, green, pink, violet);
  - link style and badges, port style (dots, arrows, hollow, shapes) to tell `in` from `out`;
  - grid, guides, select before moving, Inspector shown on selection, minimap, arrange on open;
  - text editor: font, tab size, whitespace, indentation guides, word wrap, minimap, line numbers, folding, brackets, suggestions…
- _File › Export settings…_ / _Import settings…_ carry the settings to another browser, app or VS Code as a JSON file.
- _Help › Reset app data…_ deletes everything the app stores in the browser (settings, panel layout, recent files, open documents, caches) and reloads it.
