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
generation: { templates? } # built-in template set generating the code (optional, default cpp17)
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
- Module path = dot-separated names (`Core.Sensor`); names are unique among siblings.

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
| `ref`                 | `name`                | user type (struct, enum or alias)                                                                                                     |

```yaml
type: { kind: map, key: { kind: primitive, name: string }, value: { kind: ref, name: Reading }, max: 8 }
```

Bounds (`max`, optional) are written `string<16>`, `bytes<4>`, `vector<T, 8>`, `map<K, V, 8>` in the editor's type expressions; default values are checked against them.

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

- **Attributes** (optional): typed properties, `{ name, static?, const?, type, description?, default? }` like struct fields. `static`: shared by all instances of the module; `const`: not changed after initialization.
- **Methods** (optional): prototypes, `{ name, description?, static?, const?, virtual?, pure?, override?, params, returns, raises? }` like interface messages. Names are unique among the module's methods and attributes.
  - `static`: called without a module instance; `const`: leaves the module's state unchanged (not both).
  - `virtual`: can be overridden by derived modules (not `static`); `pure`: pure virtual, `= 0`; `override`: overrides a virtual method of a base, with the same parameters (types, directions, `const`), return type and `const`. `pure` and `override` require `virtual`.
  - Parameters take `const: true` too, `in` parameters only.
- **Kind** (optional): `class` (default, left out), `abstract` or `interface`. A `class` has no pure methods and implements every pure method it inherits; an `interface` has only pure methods and no attributes.
- **Bases** (optional): `bases: [IShape, Core.Base]`, paths of modules of this project it derives from, in order; no cycles, no repeats. A method redefining a virtual one of a base without `override` is a warning.
- **Ports** and **submodules** (`modules`): see below.

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

In a struct value, unknown and missing fields are errors, except fields with their own default, `optional` fields and structs whose fields all have one. In the editor, write values as one-line flow literals: `{ position: { x: 1, y: 2 }, samples: [ 1, 2, 3 ] }`.

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

What the generated code does with them: [Links between binaries](remote.md).
