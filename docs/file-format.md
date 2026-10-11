# File format

A project file is language-agnostic YAML or JSON, described by [`schema/scaffold.schema.json`](../schema/scaffold.schema.json) (JSON Schema 2020-12). Example: [`examples/robot.scaffold.yaml`](../examples/robot.scaffold.yaml).

- [Top level](#top-level)
- [Names](#names)
- [Types](#types)
- [Constants](#constants)
- [Interfaces](#interfaces)
- [Modules](#modules)
- [Default values](#default-values)
- [Ports and links](#ports-and-links)
- [Binaries and transports](#binaries-and-transports)

Dependencies on other project files and workspace files: [Dependencies](dependencies.md).

## Top level

```yaml
schemaVersion: 1
project: { name, description?, metadata? }
binaries: [...] # executables the top-level modules are split into (optional)
remoteDefaults: { ... } # addresses of the links between binaries without settings (optional)
types: [...] # struct | exception | enum | bitmask | union | alias | primitive
interfaces: [...] # named sets of messages
constants: [...] # named values (optional)
modules: [...] # recursive (modules[].modules)
links: [...]
dependencies: [...] # other project files whose types, interfaces and modules this one uses (optional)
editor: { layout, views?, style?, notes?, dependencies?, orientation?, links? } # editor only, ignored by generators
```

The `editor` section holds layout and view data only; it is stripped on export.

## Names

- All names are identifiers: `[A-Za-z_][A-Za-z0-9_]*`.
- Types, interfaces and constants share one namespace (with those of the [dependencies](dependencies.md)).
- Module path = dot-separated names (`Core.Sensor`); names are unique among siblings. A top-level module is named apart from the types, interfaces and constants (a type of the same name hides it in type references: a warning).

## Types

### Type references

A type reference is always structured, never a string:

| kind                  | fields                | notes                                                                                                                                 |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `primitive`           | `name`, `max`         | `bool char int8 int16 int32 int64 uint8 uint16 uint32 uint64 float32 float64 string bytes`; `max` (string, bytes): most bytes (UTF-8) |
| `array`               | `of`, `size`          | fixed size                                                                                                                            |
| `vector` `list` `set` | `of`, `max`           | `max`: most items                                                                                                                     |
| `optional`            | `of`                  |                                                                                                                                       |
| `map`                 | `key`, `value`, `max` | key: primitive or enum; `max`: most entries                                                                                           |
| `ref`                 | `name`                | user type (struct, enum or alias), or module (see [Modules as types](#modules-as-types))                                              |

```yaml
type: { kind: map, key: { kind: primitive, name: string }, value: { kind: ref, name: Reading }, max: 8 }
```

Bounds (`max`, optional) are written `string<16>`, `bytes<4>`, `vector<T, 8>`, `map<K, V, 8>` in the editor's type expressions; default values are checked against them.

### Modules as types

A `ref` may name a module by its path: a reference to an instance of the module (a pointer or a reference for generators), anywhere a type is used (struct fields, union cases, aliases, constants, interface messages, attributes, method parameters and returns), in containers too (`vector<Core.Sensor>`, a map key).

```yaml
attributes:
  - { name: log, type: { kind: ref, name: Logger } }
  - { name: sensors, type: { kind: vector, of: { kind: ref, name: Core.Sensor } } }
  - { name: imu, type: { kind: ref, name: Robot/Drivers.Imu } } # a module of dependency Robot
```

- A type's name comes first: `Sensor` names the type when a type and a top-level module share it (a warning).
- `Dependency/Module.Path` names a module of a dependency, placed on the canvas or not; the dependency's own types and interfaces name its modules that way too.
- A module has no value: a `default` or constant value of a module is `null` (an empty `optional`), and a struct value leaves its module fields out. A union discriminator cannot be a module.

### User types

| kind        | fields                                                                           | values                               |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| `struct`    | `fields`, each with an optional `default` (as for [attributes](#default-values)) | mapping of the fields                |
| `exception` | `fields`, as a struct's                                                          | never used as a type: only raised    |
| `enum`      | `underlying` integer primitive, `values`: `name` and `value`                     | value name                           |
| `bitmask`   | `underlying` unsigned primitive, `flags`: `name` and `bit` (value `1 << bit`)    | list of flag names, `[Read, Write]`  |
| `union`     | `discriminator` (integer primitive, `bool`, `char` or enum), `cases`             | one-entry mapping, `{ radius: 2.5 }` |
| `alias`     | `type`                                                                           | those of the type                    |
| `primitive` | custom primitive, opaque                                                         | passed as is to generators           |

- A union case has `labels`, the discriminator values selecting it, or `default: true`.
- An exception is listed by the `raises` of messages and methods: `raises: [Busy]`.
- Modules have [types of their own](#types-of-modules), named `Core.Sensor.Filter`.

## Constants

```yaml
constants: # { name, description?, type, value }
  - { name: MaxSpeed, type: { kind: primitive, name: float32 }, value: 2.5 }
```

A constant's value is checked against its type, as [default values](#default-values) are.

## Interfaces

An interface is a named set of messages:

```yaml
interfaces: # { name, description?, messages }
  - name: Greeting
    messages: # { name, description?, params, returns, raises? }
      - name: greet
        params: # { name, type, direction? }: in (default, caller → callee), out (callee → caller), inout
          - { name: who, type: { kind: primitive, name: string } }
        returns: { kind: primitive, name: string } # null: no return value
        raises: [Busy] # exception types (optional)
```

## Modules

- **Attributes** (optional): typed properties, `{ name, access?, static?, const?, mutable?, atomic?, type, description?, default?, constraints?, ownership?, accessors?, guardedBy? }` like struct fields (see [Constraints and ownership](#constraints-and-ownership)). `static`: shared by all instances of the module; `const`: not changed after initialization; `mutable`: changed by const methods too (not `static` nor `const`); `atomic`: read and written atomically (booleans, characters, numbers, enums, bitmasks; no `guardedBy`).
  - `accessors`: `read` (a getter only) or `none`; absent: a getter and a setter (no setter when `const`).
  - `guardedBy`: name of a lock of the module, held to use the attribute.
- **Invariants** (optional): `invariants: [count <= Limit]`, expressions on the attributes holding between calls of the public methods, checked like method conditions.
- **Locks** (optional): `locks: [{ name, kind }]`, `kind` `mutex`, `shared` (readers-writer) or `recursive`; names apart from the module's attributes and methods.
- **Methods** (optional): prototypes, `{ name, description?, access?, static?, const?, virtual?, pure?, override?, final?, noexcept?, nodiscard?, params, returns, raises? }` like interface messages. Methods may share a name (overloads) when their parameter types (with directions) or `const` differ; an override matches the method of the same parameters. Method and attribute names differ.
  - `access`: `public` (default, left out), `protected` (the module and the modules deriving from it) or `private` (the module). An attribute's member stays private: its access is that of its getter and setter (none when `private`). An override with another access than the method it overrides is a warning.
  - `static`: called without a module instance; `const`: leaves the module's state unchanged (not both).
  - `virtual`: can be overridden by derived modules (not `static`); `pure`: pure virtual, `= 0`; `override`: overrides a virtual method of a base, with the same parameters (types, directions, `const`), return type and `const`. `final`: cannot be overridden by derived modules (an override of it is an error). `pure`, `override` and `final` require `virtual`; `pure` excludes `final`.
  - `threadSafe`: may be called from several threads at once.
  - `pre` / `post`: preconditions and postconditions, lists of expressions in the notation of your choice, on the parameters, attributes, constants, types and enum values (`result`: the returned value, in `post`). A name they use that names none of these is a warning (members after `.` or `::`, and usual words — `and`, `or`, `not`, `old`, `len`, `size`, `min`, `max`… — are not checked). Generators: comments, or assertions.
  - `noexcept`: raises no exception (an override of a `noexcept` method without it is a warning); `nodiscard`: its result must be used (a warning without `returns`). Generators: C++ `noexcept`, `[[nodiscard]]` (C++17), `final`.
  - Parameters take `const: true` too, `in` parameters only, and a `default` value (checked against the type as attribute defaults; `in` parameters only, and the parameters after one with a default have one too).
- **Kind** (optional): `class` (default, left out), `abstract` or `interface`. A `class` has no pure methods and implements every pure method it inherits; an `interface` has only pure methods and no attributes.
- **Final** (optional): `final: true`, no module may derive from it (C++ `class Name final`); a `class` only.
- **Constructors** (optional, absent: the implicit default constructor): `{ description?, access?, explicit?, defaulted?, deleted?, params }`, parameters as those of methods (`const`, `default`). A parameter named like an attribute sets it: same type, an `in` parameter, not a `static` attribute. Every constructor not `deleted` sets each `const` attribute without a default (an error otherwise; a warning when there are no constructors). `defaulted` (`= default`) has no parameters; `explicit` forbids implicit conversions; no two constructors have the same parameter types; an `interface` has none.
- **Destructor** (optional, absent: implicit): `{ access?, virtual? }`; `virtual` absent: virtual when the module has virtual methods. A public destructor with `virtual: false` beside virtual methods is a warning.
- **Copy** and **move** (optional, absent: implicit): `default` (by the compiler), `delete` (not copyable / movable) or `custom` (written by hand): C++ copy / move constructor and assignment.
- **Instantiation** (optional, absent: free): `singleton` (constructors not public, `copy` / `move` `delete` when set), `utility` (static attributes and methods only, no constructors, no ports), `value` (a `class` without virtual methods, not `copy: delete`; ports are a warning).
- **Bases** (optional): `bases: [IShape, Core.Base, Robot/Core.Sensor]`, paths of the modules it derives from, in order: of this project, or `Dependency/Module.Path` for a module of a dependency placed on the canvas (`dependencies[].modules`, whose methods are those overridden or implemented); no cycles, no repeats. A method redefining a virtual one of a base without `override` is a warning.
- **Types** (optional): see [Types of modules](#types-of-modules).
- **Ports** and **submodules** (`modules`): see below.

### Types of modules

A module has types of its own, like types nested in a C++ class (or in an IDL module): user types (as in `types`) with an `access`. A constant of a module is a `static` `const` attribute with a `default`.

```yaml
modules:
  - name: Core
    modules:
      - name: Sensor
        types:
          - {
              kind: enum,
              name: Filter,
              underlying: uint8,
              values: [{ name: None, value: 0 }, { name: LowPass, value: 1 }]
            }
          - { kind: struct, name: Sample, access: protected, fields: [...] }
        attributes:
          - { name: HISTORY, static: true, const: true, type: { kind: primitive, name: uint16 }, default: 64 }
          - { name: filter, type: { kind: ref, name: Core.Sensor.Filter }, default: LowPass }
```

- They are named by their module's path: `Core.Sensor.Filter`; `Robot/Core.Sensor.Filter` for one of a module of dependency `Robot` (in `raises` too).
- Their names are unique in their module, and apart from its attributes, methods, ports and submodules.
- `access`: `public` (default, left out) for anyone, by path (the project's types, interfaces and constants too); `protected` for the module and those deriving from it; `private` for the module. A public member (or type of a module) using a less accessible type is a warning.

## Constraints and ownership

Struct fields, exception fields and module attributes take:

- `constraints: { min?, max?, unit?, pattern? }`, of the value, or of each item of an array, vector, list, set or optional (aliases followed). `min`, `max` and `unit` apply to numbers (integers within the range of their type), `pattern` to text (a regular expression the whole value matches). Default values are checked against them.
- `ownership`: how a field whose type references modules holds them: `owned` (only owner; not with `copy: default`), `shared` (one of the owners), `weak` (no ownership, may expire: a warning when no field holds the module as `shared`) or `borrowed` (no ownership, outlived by them). Generators: C++ `std::unique_ptr`, `std::shared_ptr`, `std::weak_ptr`, a reference or plain pointer.

## Default values

`default` (attributes and struct fields) is a YAML value checked against the type, aliases followed:

| Type                    | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| `bool`                  | `true` / `false`                                     |
| integers                | an integer in range                                  |
| `float32`, `float64`    | a number                                             |
| `char`                  | one character                                        |
| `string`, `bytes`       | text (quoted when it reads as something else: `"5"`) |
| enum                    | a value name                                         |
| `array`                 | a list of exactly its size                           |
| `vector`, `list`, `set` | a list (no duplicates for `set`)                     |
| `map`                   | a mapping (keys read as the key type)                |
| struct                  | a mapping naming its fields                          |
| `optional`              | `null` when empty                                    |
| custom primitive        | opaque, passed as is to generators                   |
| module                  | none (`null`)                                        |

In a struct value, unknown and missing fields are errors, except fields with their own default, `optional` fields, modules and structs whose fields all have one. In the editor, write values as one-line flow literals: `{ position: { x: 1, y: 2 }, samples: [ 1, 2, 3 ] }`.

## Ports and links

- **Port**: `role` `out` (initiates / sends) or `in` (receives / serves), `interface` name.
- **Link**: `from` (an `out` port) → `to` (an `in` port), same interface — or, between a module and its content, `in` → `in` into it and `out` → `out` out of it — with `constraints`:

```yaml
links:
  - name: sensor_to_monitor
    from: { module: Core.Sensor, port: out }
    to: { module: Monitor, port: telemetry }
    constraints:
      direction: unidirectional | bidirectional # messages returning a value need bidirectional
      ack: { required: bool, timeoutMs? }
      performance: { class: realtime | low | normal | bulk, maxLatencyMs?, rateHz? }
      remote: { enabled: bool, transport?, settings? } # e.g. ipc, shm, tcp, udp, grpc, mqtt, can
```

Links to modules of other projects: [Dependencies › File format](dependencies.md#file-format).

## Binaries and transports

```yaml
binaries:
  - { name: Onboard, description?, color? }
  - { name: Ground }
modules:
  - name: Camera
    binary: Onboard # top-level modules only; inner modules run in their ancestor's
remoteDefaults: { client?: { host? }, server?: { host? }, basePort? } # optional
```

- With binaries, every top-level module names the one it runs in, and a link between modules of two binaries must be remote, with a transport (errors otherwise). Without binaries, the project is one executable.
- `remoteDefaults`: hosts of both ends (default `127.0.0.1`) and port of the first link between binaries (default 47000), for the links without settings of their own.

### Transport settings

`remote.settings` (optional), by transport:

| Transport            | Settings                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| tcp, udp, grpc       | `client`, `server`: `{ host?, port? }` — where the caller connects, where the callee listens   |
| http, websocket      | the same, plus `path` (default `/<link>`)                                                      |
| shm                  | `name` (segment, default `<project>_<link>`), `capacity` (bytes of each ring, default 1048576) |
| ipc                  | `socket`                                                                                       |
| mqtt                 | `broker` (`{ host?, port? }`), `topic`                                                         |
| can                  | `interface`, `id`                                                                              |
| serial               | `device`, `baud`                                                                               |
| any, custom included | `options` (string map), for the templates                                                      |

- A field not applying to the transport is a warning.
- An http path not starting with `/` and an invalid shared memory name are errors.
- Two links listening on the same port, or sharing a segment, are warnings.

What the generated code does with them: [ProjectScaffold-Generator › Links between binaries](https://github.com/MickaelBlet/ProjectScaffold-Generator/blob/master/docs/remote.md).
