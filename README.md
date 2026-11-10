# ProjectScaffold-Viewer

Browser editor for software architecture: modules, ports, typed interfaces and constrained links.
Saves a language-agnostic project file, in [Scaffold text](docs/scaffold-text.md) (`*.scaffold`, a compact `.proto`-like syntax) by default or in YAML / JSON, meant to feed code skeleton generators, such as [ProjectScaffold-Generator](https://github.com/MickaelBlet/ProjectScaffold-Generator).

![ProjectScaffold editor with the fleet drone example](docs/demo.png)

## Features

- **Diagram editor**: nested modules with ports, attributes, methods and types of their own, C++-like classes and inheritance with access levels, links with constraints (direction, acknowledgement, performance, transport), ELK auto-layout, views per module.
- **Scaffold text**: `.scaffold` project files, about three times shorter than YAML, read by the generator; YAML and JSON hold the same data (_File › Export as YAML…_).
- **Text and diagram together**: the project is editable as text (Scaffold text or YAML) beside the diagram, with completion, folding and live validation.
- **Multi-project architectures**: projects depend on each other's types, interfaces and modules; renames follow; workspace files open them all at once.
- **IDL import**: OMG IDL 4.2 files (CORBA, CCM, DDS / XTypes) as imports or dependencies.
- **Everywhere**: one self-contained `index.html` for the browser, desktop apps (Tauri, Electron), and the pages of the VS Code extension ([ProjectScaffold-VsCode](https://github.com/MickaelBlet/ProjectScaffold-VsCode)).

Code is generated from the project files by [ProjectScaffold-Generator](https://github.com/MickaelBlet/ProjectScaffold-Generator) (C++, Python, SCA).

## Quick start

```sh
npm install
npm run dev     # open the editor, then File › Open… examples/robot.scaffold
```

[`examples/`](examples) holds sample projects, listed with what each shows in [`examples/README.md`](examples/README.md): start with [`hello.scaffold`](examples/hello.scaffold); [`examples/fleet/fleet.scaffold-workspace.yaml`](examples/fleet/fleet.scaffold-workspace.yaml) opens a multi-project one.

## Scaffold text

```
syntax = "scaffold1";

/// Smallest useful project, a starting point - two modules, one interface, one link
project "Hello";

/// Says hello to someone
interface Greeting {
  string greet(string who);
}

/// Asks for greetings
module Client {
  out Greeting greeter;
}

/// Answers them
module Server {
  string prefix = Hello;

  in Greeting greeting;
}

link client_to_server: Client.greeter <-> Server.greeting;
```

[`examples/hello.scaffold`](examples/hello.scaffold), without its `editor = { … }` layout block. Syntax and grammar: [Scaffold text](docs/scaffold-text.md); the data model, shown in YAML: [File format](docs/file-format.md).

## Documentation

| Guide                                    | Content                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| [Scaffold text](docs/scaffold-text.md)   | the `.scaffold` syntax of project files (default format), its grammar     |
| [File format](docs/file-format.md)       | types, constants, interfaces, modules, ports, links, binaries, transports |
| [Building and running](docs/building.md) | web, desktop, checks                                                      |
| [Editor](docs/editor.md)                 | documents, panels, views, text editor, diagram, binaries, settings        |
| [Keyboard shortcuts](docs/shortcuts.md)  | every shortcut, by menu                                                   |
| [Dependencies](docs/dependencies.md)     | projects using other project files, importing projects, workspace files   |
| [IDL files](docs/idl.md)                 | importing OMG IDL and how it maps to the model                            |

Changes: [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE)
