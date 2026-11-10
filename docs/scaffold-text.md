# Scaffold text (`*.scaffold`)

A compact, `.proto`-like syntax for project files: the same data as YAML or JSON ([file format](file-format.md)), written about three times shorter. Open, edit and save `.scaffold` files like the other formats; [ProjectScaffold-Generator](https://github.com/MickaelBlet/ProjectScaffold-Generator) reads them too.

```
syntax = "scaffold1";

project "Plant Demo";

enum State : int8 {
  Off = -1;
  On = 1;
}

/// One sample
struct Reading {
  float64 value = 1.5 [constraints = { min: 0, unit: m }];
  State state = On;
  map<string, int32> tags = { a: 1 };
  optional<string> note = null;
}

interface Query {
  bool get(string key, out float64 value);
}

abstract module Device : Base {
  static uint32 instances = 0;
  virtual string describe(string prefix) const = 0;
}

module Plant {
  in Sink feed;
  in Query query;

  module Store {
    in Sink in;
    in Query query;
  }
}

link plant_query: Plant.query <-> Plant.Store.query;
link ask_store: Client.ask <-> Plant.Store.query ack 20 low latency 5 remote tcp;
```

The editor's text view completes keywords, types and names as you type (Ctrl+Space) and folds `{ … }` blocks.

## Lexical rules

- Comments: `// …` and `/* … */`. `/// …` lines are documentation: they set the `description` of the definition that follows (several lines join with line breaks; one space after `///` is dropped). Plain comments are not kept when the editor saves the file.
- Names: `[A-Za-z_][A-Za-z0-9_]*`. A name that is also a word of the syntax is written between backquotes where a type is expected: `` `vector` `` is a type named vector. Names after a type (a field, a port…) need none: `in Sink in;`.
- Strings: JSON strings (`"say \"hi\""`). Numbers: JSON numbers (`-1`, `1.5`, `2e3`); integers too large for a JavaScript number stay as their decimal text, as in YAML.

## Values

Default values, constants and generic properties are written as values: JSON with these differences:

- a bare name or dotted name is a string: `On`, `owned`, `Plant.Sensor` (`true`, `false`, `null` are not);
- mapping keys may be bare (dotted) names: `{ Plant.Sensor: { x: 0, y: 0 } }`;
- trailing commas are allowed.

## Generic properties

Every property of the file format can be written in its generic form, so any project can be written:

| Form               | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `key = value;`     | sets the property `key` of the enclosing object (file, module, struct…) |
| `key += value;`    | appends `value` to the list `key`                                       |
| `[key = value, …]` | after a definition's head: properties of that definition                |

```
transports = [lora];
remoteDefaults = { basePort: 48000 };
module Pump [copy = delete] {
  binary = controller;
  metadata = { owner: hydraulics };
}
```

The editor writes the generic form wherever the syntax below cannot express a value exactly (the `editor` section, for instance).

## Grammar

`[x]` optional, `x*` repeated, `|` choice; `name`, `string`, `number`, `value` as above; `opts` is `[key = value, …]`; `doc` is `///` lines.

### File

```
file      = ( "syntax" "=" "\"scaffold1\"" ";"           schemaVersion: 1
            | [doc] "project" string [opts] ";"
            | [doc] "binary" name [opts] ";"
            | typedef | interface | constant | module | link | dependency
            | generic )*
```

### Types

```
type      = primitive [ "(" max ")" ]                   string(64): at most 64 bytes
          | "array" "<" type "," size ">"
          | ("vector" | "list" | "set") "<" type [ "," max ] ">"
          | "optional" "<" type ">"
          | "map" "<" type "," type [ "," max ] ">"
          | [ name "/" ] name ( "." name )* [ "<" type ( "," type )* ">" ]    a reference, with type arguments
result    = "void" | type
```

`primitive` is one of `bool char int8 int16 int32 int64 uint8 uint16 uint32 uint64 float32 float64 string bytes`.

### Type definitions

```
typedef   = [doc] [access] ( "struct" | "exception" ) name [opts] "{" field* "}"
          | [doc] [access] "enum" name ":" name [opts] "{" ( name "=" number ";" )* "}"
          | [doc] [access] "bitmask" name ":" name [opts] "{" ( name "=" "1" "<<" number ";" )* "}"
          | [doc] [access] "union" name "switch" "(" type ")" [opts] "{" case* "}"
          | [doc] [access] "alias" name "=" type [opts] ";"
          | [doc] [access] "primitive" name [opts] ";"
field     = [doc] type name [ "=" value ] [opts] ";"                    default value
case      = [doc] "case" [ label ( "," label )* ] ":" type name [opts] ";"
label     = value | "default"
access    = "public" | "protected" | "private"                         types of a module only
```

### Interfaces and constants

```
interface = [doc] "interface" name [opts] "{" message* "}"
message   = [doc] result name params [ "raises" "(" [ name ( "," name )* ] ")" ] [opts] ";"
params    = "(" [ param ( "," param )* ] ")"
param     = [doc] [ "in" | "out" | "inout" ] [ "const" ] type name [ "=" value ] [opts]
constant  = [doc] "const" type name "=" value [opts] ";"
```

### Modules

```
module    = [doc] [ "class" | "abstract" | "interface" ] "module" name
            [ "<" typeParam ( "," typeParam )* ">" ] [ "final" ]
            [ ":" base ( "," base )* ] [ "implements" name ( "," name )* ] [opts]
            "{" member* "}"
typeParam = name [ ":" ( "numeric" | "integral" ) ] [ "extends" name ] [ "=" type ]
base      = module path, with type arguments for a generic module: Box<int32>
member    = [doc] ( "in" | "out" ) ( name | "?" ) name [opts] ";"    a port (`?`: no interface yet)
          | [doc] modifier* type name [ "=" value ] [opts] ";"       an attribute
          | [doc] modifier* result name params qualifier* [ "=" "0" ] [opts] ";"   a method
          | [doc] modifier* "constructor" params [ "=" ( "default" | "delete" ) ] [opts] ";"
          | modifier* "destructor" [opts] ";"
          | "lock" name ":" ( "mutex" | "shared" | "recursive" ) [opts] ";"
          | "invariant" string ";"
          | "statemachine" "{" ( "initial" name ";"
                               | [doc] [ "final" ] "state" name [opts] ";"
                               | name "->" name [ "on" name ] [ "if" string ] [ "do" name ] [opts] ";"
                               | generic )* "}"
          | typedef | module | generic
```

Modifiers and qualifiers set the flags of the same name to `true`, in C++ positions: attributes `static const mutable atomic`; methods `static virtual threadSafe nodiscard` before the result type, then after the parameters `qualifier = "const" | "noexcept" | "raises" "(" … ")" | "override" | "final"` and `= 0` for `pure`; constructors `explicit`; destructors `virtual`; and an access level for all of them. `false` values go in `opts`.

```
protected virtual uint32 latency() const noexcept override = 0;
module Equalizer final : Effect {}
```

Files of version 1.2 wrote method flags and `final` of modules before the type (`const virtual pure void run();`, `final module M`): still read, written in the new positions on save.

### Links and dependencies

```
link      = [doc] "link" name ":" endpoint ( "->" | "<->" ) endpoint clause* [opts] ";"
endpoint  = [ dependency "/" ] module.path "." port
clause    = "ack" [ number ]                       acknowledged, timeout in ms
          | "realtime" | "low" | "normal" | "bulk"  performance class (default normal)
          | "latency" number | "rate" number       maxLatencyMs, rateHz
          | "remote" [ transport ] [ value ]       remote, its transport and settings
dependency = "dependency" name string [opts] ( ";" | "{" ( typedef | interface | constant | generic )* "}" )
```

`->` is unidirectional, `<->` bidirectional. Without clauses a link is not acknowledged, of normal performance, and local.
