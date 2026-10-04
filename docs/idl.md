# IDL files

ProjectScaffold reads OMG IDL files (IDL 4.2: CORBA, CCM, DDS / XTypes) in three ways:

- **Import**: _Insert › Import projects or IDL files_ (or right click the canvas / a module) adds one of their interfaces or components, or all, with the types they use (files without interfaces nor components: all their types). Types and interfaces this project has by name are used as they are.
- **Dependency**: an IDL file can be a [dependency](dependencies.md). It stands for a project named after the file (types, interfaces, constants, components as modules to place), the files it includes being its dependencies. `scaffold-gen -d` generates it like a project file.
- **Text**: see [Editing IDL files](#editing-idl-files).

The import dialog lists what was approximated.

## Examples

In [`examples/idl/`](../examples/idl):

| File                | Shows                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `robot_control.idl` | CORBA-style interfaces, attributes, inheritance, exceptions                                                             |
| `sensors_dds.idl`   | DDS types only: annotations, bitmask, union, bounded sequences, maps                                                    |
| `tank_ccm.idl`      | CCM components, porttypes and events; includes `sensors_dds.idl`                                                        |
| `navigation.idl`    | uses `Pose` and `Vec3` without defining them: import it into `examples/robot.scaffold.yaml` to see them matched by name |

## Preprocessor

- `#include` and IDL `import "file";`. VS Code reads included files next to the IDL file and in its parent folders; elsewhere, pick them along with it.
- `#define` (function-like, `#`, `##`), `#undef`, `#if` / `#ifdef` / `#ifndef` / `#elif` / `#else`, `#error`.
- `#pragma` is ignored.

## Mapping to the model

### Scopes

- Modules are flattened: entities keep their simple name, qualified with their modules (`Robot_Status`) when several share it.
- Scoped names (`::A::B`, inherited scopes) are resolved.
- Template modules are instantiated (`module Buffers<long, 8> Longs;`).

### Types

| IDL                                      | Model                                                       |
| ---------------------------------------- | ----------------------------------------------------------- |
| `struct`                                 | struct (base fields included)                               |
| `exception`                              | exception (a struct)                                        |
| `union`                                  | struct of its discriminator and one optional field per case |
| `enum`                                   | enum                                                        |
| `bitmask`                                | enum of flags                                               |
| `bitset`                                 | struct of its bitfields                                     |
| `typedef`, `native`                      | alias, custom primitive                                     |
| `sequence<octet>`                        | `bytes`                                                     |
| sequences, maps, arrays, bounded strings | `vector`, `map`, `array`, bounded `string`                  |
| constant expressions                     | evaluated                                                   |
| valuetypes, eventtypes                   | structs of their state members                              |
| abstract valuetypes                      | interfaces                                                  |
| value boxes                              | optional aliases                                            |
| `Object`, interface names as types       | `<Name>Ref` custom primitives                               |
| names defined nowhere                    | custom primitives (empty interfaces for ports)              |

Annotations: `@optional`, `@default` (field default), `@value`, `@position`, `@bit_bound` (underlying type), `@unit` and `@range` / `@min` / `@max` (in the description). Doc comments become descriptions.

### Interfaces

- Operations become messages: `in` / `out` / `inout`, `void`: no return; raised exceptions in the description, imported with them.
- Attributes become `get_<name>` / `set_<name>` messages.
- Base interfaces' operations are copied in.

### Components

Components and connectors become modules:

- `provides` / `consumes` are `in` ports; `uses` / `emits` / `publishes` are `out` ports. Events go through a `<Event>Consumer` interface with a `push` message.
- `port` / `mirrorport` expand their porttype.
- Attributes become module attributes, supported interfaces module methods, the base component the module's base.
- Homes are left out.

## Editing IDL files

_File › Open IDL file as text…_ edits IDL files in a tab of the code editor: syntax colors, errors and what the model cannot express shown on their lines. Ctrl+S saves them. VS Code opens them in its own editor.

## Generating IDL

The [`sca-cpp98`](sca.md) template set writes the project as IDL.
