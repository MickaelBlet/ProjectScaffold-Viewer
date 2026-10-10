// On-disk format (YAML/JSON). Source of truth for the published JSON Schema.
import { z } from 'zod'
import {
  ACCESS_LEVELS,
  INT_PRIMITIVES,
  MODULE_KINDS,
  PARAM_DIRECTIONS,
  PERFORMANCE_CLASSES,
  PRIMITIVES,
  UNSIGNED_PRIMITIVES,
  type TypeRefOf
} from './types'

export const SCHEMA_VERSION = 1

export type FileTypeRef = TypeRefOf<{ name: string }>

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid identifier')
const QualifiedName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, 'must be a dot-separated module path')
/** A module path, or `Dependency/Module.Path` for a placed module of a dependency. */
const ModulePath = z
  .string()
  .regex(
    /^([A-Za-z_][A-Za-z0-9_]*\/)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    'must be a dot-separated module path, with its dependency name and a slash for a module of a dependency'
  )
/** A type: `Name`, `Core.Sensor.Mode` for a type of a module, `Dependency/Core.Sensor.Mode` for one of a dependency's module. */
const TypeName = z
  .string()
  .regex(
    /^([A-Za-z_][A-Za-z0-9_]*\/)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    'must be a type name, with its module path for a type of a module (and its dependency name and a slash for a module of a dependency)'
  )
const Description = z.string().optional().describe('free text documenting it')
const Metadata = z
  .record(z.string(), z.string().describe('value of this metadata entry'))
  .optional()
  .describe('free key: value pairs, passed to generators')

const Max = z.int().positive().optional()

/**
 * A described reference to the type below: wrapped, so that the type keeps its name in the JSON
 * Schema (a described copy of it would share its content, extracted under another name).
 */
const typeRef = (description: string) => z.lazy(() => FileTypeRefSchema).describe(description)

export const FileTypeRefSchema: z.ZodType<FileTypeRef> = z
  .lazy(() =>
    z.union([
      z.object({
        kind: z.literal('primitive').describe('a built-in type'),
        name: z.enum(PRIMITIVES).describe('the built-in type'),
        max: Max.describe('string, bytes: most UTF-8 bytes')
      }),
      z.object({
        kind: z.literal('array').describe('a fixed number of items'),
        of: typeRef('type of the items'),
        size: z.int().positive().describe('number of items')
      }),
      z.object({
        kind: z
          .enum(['vector', 'list', 'set'])
          .describe('vector, list: items in order, any number; set: distinct items'),
        of: typeRef('type of the items'),
        max: Max.describe('most items')
      }),
      z.object({
        kind: z.literal('optional').describe('a value or none (null)'),
        of: typeRef('type of the value')
      }),
      z.object({
        kind: z.literal('map').describe('entries from keys to values'),
        key: typeRef('type of the keys'),
        value: typeRef('type of the values'),
        max: Max.describe('most entries')
      }),
      z.object({
        kind: z.literal('ref').describe('a type defined in the project, a module or a dependency'),
        name: TypeName.describe(
          'type name; a type of a module: Module.Path.Name (Dependency/Module.Path.Name for a module of a dependency)'
        )
      })
    ])
  )
  .meta({ id: 'TypeRef' })

const Field = z.object({
  name: Identifier.describe('name of the field'),
  type: typeRef('type of the field'),
  description: Description
})

const ValueField = Field.extend({
  default: z
    .json()
    .optional()
    .describe(
      'default value: a mapping for a struct or map, a list for an array, vector, list or set, null for an empty optional, an enum value name, a list of bitmask flag names, a one-entry mapping `case: value` for a union; any value for a custom primitive'
    )
})

/** Type definitions, with `extra` properties (a module's types: their access). */
const typeDefs = <E extends z.ZodRawShape>(extra: E) =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('struct').describe('struct: named fields'),
      ...extra,
      name: Identifier.describe('name of the type'),
      description: Description,
      fields: z.array(ValueField).describe('fields of the struct, in order')
    }),
    z.object({
      kind: z.literal('enum').describe('enum: named integer values'),
      ...extra,
      name: Identifier.describe('name of the type'),
      description: Description,
      underlying: z.enum(INT_PRIMITIVES).describe('integer type holding the values'),
      values: z
        .array(
          z.object({
            name: Identifier.describe('name of the value'),
            value: z.int().describe('integer value')
          })
        )
        .describe('values of the enum')
    }),
    z
      .object({
        kind: z.literal('exception').describe('exception: named fields, raised by messages and methods'),
        ...extra,
        name: Identifier.describe('name of the type'),
        description: Description,
        fields: z.array(ValueField).describe('fields of the exception, in order')
      })
      .describe('raised by messages and methods (their `raises`), never used as a type'),
    z
      .object({
        kind: z.literal('bitmask').describe('bitmask: named flags, combined with |'),
        ...extra,
        name: Identifier.describe('name of the type'),
        description: Description,
        underlying: z.enum(UNSIGNED_PRIMITIVES).describe('unsigned integer type holding the flags'),
        flags: z
          .array(
            z.object({
              name: Identifier.describe('name of the flag'),
              bit: z.int().nonnegative().describe('value: 1 << bit')
            })
          )
          .describe('flags of the bitmask')
      })
      .describe('set of flags, combined with |'),
    z
      .object({
        kind: z.literal('union').describe('union: one of its cases, selected by the discriminator'),
        ...extra,
        name: Identifier.describe('name of the type'),
        description: Description,
        discriminator: typeRef('integer primitive, bool, char or enum'),
        cases: z
          .array(
            Field.extend({
              labels: z
                .array(z.union([z.int(), z.string(), z.boolean()]))
                .optional()
                .describe(
                  'discriminator values selecting the case: integers, characters, booleans, enum value names'
                ),
              default: z.boolean().optional().describe('held for the discriminator values no case lists')
            })
          )
          .describe('cases of the union, each holding a value of its type')
      })
      .describe('discriminated union: one of its cases, selected by the discriminator'),
    z.object({
      kind: z.literal('alias').describe('alias: another name for a type'),
      ...extra,
      name: Identifier.describe('name of the type'),
      description: Description,
      type: typeRef('the type it names')
    }),
    z
      .object({
        kind: z.literal('primitive').describe('custom primitive: an opaque type mapped to a native type'),
        ...extra,
        name: Identifier.describe('name of the type'),
        description: Description
      })
      .describe('custom primitive: an opaque type that generators map to a native type')
  ])

const TypeDef = typeDefs({}).meta({ id: 'TypeDef' })

const ModuleAccess = z
  .enum(ACCESS_LEVELS)
  .optional()
  .describe(
    'public (default): used anywhere; protected: by the module and the modules deriving from it; private: by the module'
  )

const ModuleTypeDef = typeDefs({ access: ModuleAccess }).meta({ id: 'ModuleTypeDef' })

const Constant = z
  .object({
    name: Identifier.describe('name of the constant'),
    description: Description,
    type: typeRef('type of the value'),
    value: z.json().describe('checked against the type, as default values are')
  })
  .meta({ id: 'Constant' })

const ModuleConstant = Constant.extend({ access: ModuleAccess }).meta({ id: 'ModuleConstant' })

const Param = Field.extend({
  name: Identifier.describe('name of the parameter'),
  type: typeRef('type of the parameter'),
  direction: z
    .enum(PARAM_DIRECTIONS)
    .optional()
    .describe('in (default): caller → callee; out: callee → caller; inout: both ways')
})

const Message = z.object({
  name: Identifier.describe('name of the message'),
  description: Description,
  params: z.array(Param).describe('parameters, in order'),
  returns: z
    .lazy(() => FileTypeRefSchema)
    .nullable()
    .describe('type of the returned value; null: none'),
  raises: z.array(TypeName).optional().describe('exceptions it may raise (names of exception types)')
})

const Access = z.enum(ACCESS_LEVELS).optional()

const Attribute = ValueField.extend({
  name: Identifier.describe('name of the attribute'),
  type: typeRef('type of the attribute'),
  access: Access.describe(
    'public (default): public accessors; protected: accessors for derived modules; private: no accessors'
  ),
  static: z.boolean().optional().describe('shared by all instances of the module'),
  const: z.boolean().optional().describe('not changed after initialization')
})

const MethodParam = Param.extend({
  const: z.boolean().optional().describe('not changed by the method (in parameters only)')
})

const Method = Message.extend({
  name: Identifier.describe('name of the method'),
  access: Access.describe(
    'public (default): called by anyone; protected: by the module and derived modules; private: by the module'
  ),
  params: z.array(MethodParam).describe('parameters, in order'),
  static: z.boolean().optional().describe('called without a module instance'),
  const: z.boolean().optional().describe("leaves the module's state unchanged"),
  virtual: z.boolean().optional().describe('can be overridden by derived modules'),
  pure: z
    .boolean()
    .optional()
    .describe('pure virtual (`= 0`): not implemented by this module (virtual only)'),
  override: z.boolean().optional().describe('overrides a virtual method of a base module (virtual only)')
})

const Interface = z
  .object({
    name: Identifier.describe('name of the interface'),
    description: Description,
    messages: z.array(Message).describe('messages exchanged through the ports of this interface')
  })
  .meta({ id: 'Interface' })

const Port = z.object({
  name: Identifier.describe('name of the port, unique in its module'),
  role: z.enum(['out', 'in']).describe('out: initiates / sends; in: receives / serves'),
  interface: Identifier.nullable().describe('name of the interface it carries; null: none yet'),
  description: Description
})

export interface FileModule {
  name: string
  description?: string
  kind?: (typeof MODULE_KINDS)[number]
  bases?: string[]
  metadata?: Record<string, string>
  color?: string
  binary?: string
  types?: z.infer<typeof ModuleTypeDef>[]
  constants?: z.infer<typeof ModuleConstant>[]
  attributes?: z.infer<typeof Attribute>[]
  methods?: FileMethod[]
  ports: z.infer<typeof Port>[]
  modules?: FileModule[]
}

const Module: z.ZodType<FileModule> = z
  .lazy(() =>
    z.object({
      name: Identifier.describe('name of the module, unique among its siblings'),
      description: Description,
      kind: z
        .enum(MODULE_KINDS)
        .optional()
        .describe(
          'class (default): concrete; abstract: may have pure methods; interface: only pure methods, no attributes'
        ),
      bases: z
        .array(ModulePath)
        .optional()
        .describe(
          'paths of the modules it derives from, in order: of this project, or `Dependency/Module.Path` for a module of a dependency placed on the canvas'
        ),
      metadata: Metadata,
      color: z.string().optional().describe('accent color (CSS color)'),
      binary: Identifier.optional().describe(
        "name of the binary (`binaries`) it runs in: top-level modules only, inner ones run in their ancestor's"
      ),
      types: z
        .array(ModuleTypeDef)
        .optional()
        .describe(
          'types of the module, like types nested in a class (or in an IDL module), named Module.Path.Name'
        ),
      constants: z
        .array(ModuleConstant)
        .optional()
        .describe('constants of the module, like constants nested in a class, named Module.Path.Name'),
      attributes: z.array(Attribute).optional().describe('typed properties of the module'),
      methods: z.array(Method).optional().describe('method prototypes of the module'),
      ports: z.array(Port).describe('ports of the module, which links connect'),
      modules: z.array(Module).optional().describe('modules inside this one')
    })
  )
  .meta({ id: 'Module' })

const Binary = z
  .object({
    name: Identifier.describe('name of the binary'),
    description: Description,
    color: z.string().optional().describe('accent color (CSS color)')
  })
  .describe('An executable of the project, holding some of its top-level modules')

const Endpoint = z.object({
  project: Identifier.optional().describe('name of a dependency: the module belongs to that other project'),
  module: QualifiedName.describe('path of the module (in the dependency `project` when set)'),
  port: Identifier.describe('name of the port')
})

const Dependency = z
  .object({
    name: Identifier.describe('referenced by `uses` of other dependencies and by link endpoints (`project`)'),
    file: z.string().describe('file of the other project (project file or IDL file), relative to this one'),
    uses: z
      .array(Identifier)
      .optional()
      .describe('dependencies of this list whose types and interfaces this one uses'),
    indirect: z.boolean().optional().describe('only listed because another dependency uses it'),
    shared: z
      .array(Identifier)
      .optional()
      .describe(
        'types, interfaces and constants it defines like another dependency of this list, listed there'
      ),
    types: z.array(TypeDef).describe('its own types, as last read from it'),
    interfaces: z.array(Interface).describe('its own interfaces, as last read from it'),
    constants: z.array(Constant).optional().describe('its own constants, as last read from it'),
    moduleTypes: z
      .array(
        z.object({
          module: QualifiedName.describe('path of the module in the dependency'),
          types: z.array(ModuleTypeDef).describe('types of the module')
        })
      )
      .optional()
      .describe(
        'types of its modules, as last read from it, by module path: its public ones are used by this project as Dependency/Module.Path.Name'
      ),
    moduleConstants: z
      .array(
        z.object({
          module: QualifiedName.describe('path of the module in the dependency'),
          constants: z.array(ModuleConstant).describe('constants of the module')
        })
      )
      .optional()
      .describe('constants of its modules, as last read from it, by module path'),
    modules: z
      .array(
        z.object({
          module: QualifiedName.describe('path of the module in the dependency'),
          attributes: z.array(Attribute).optional().describe('attributes of the module'),
          methods: z.array(Method).optional().describe('methods of the module'),
          ports: z.array(Port).describe('ports of the module')
        })
      )
      .optional()
      .describe(
        'its modules placed on this canvas so that links reach them, with their attributes, methods and ports as last read (types named as in this project): top-level modules, each with all the modules inside it'
      )
  })
  .describe(
    "Another project this one uses: its types and interfaces share the namespace of the project's own ones, which reference them by name, and links may reach its modules"
  )

const Host = z.string().min(1).describe('host name or IP address')
const NetPort = z.int().min(1).max(65535).describe('port number')
const HostPort = z.object({ host: Host.optional(), port: NetPort.optional() })

const TransportSettings = z
  .object({
    client: HostPort.optional().describe('where the caller connects (tcp, udp, http, websocket, grpc)'),
    server: HostPort.optional().describe('where the callee listens (tcp, udp, http, websocket, grpc)'),
    path: z.string().min(1).optional().describe('request path (http, websocket; default /<link>)'),
    name: z.string().min(1).optional().describe('shared memory segment (shm; default <project>_<link>)'),
    capacity: z.int().positive().optional().describe('bytes of each ring (shm; default 1048576)'),
    socket: z.string().min(1).optional().describe('unix socket path (ipc)'),
    broker: HostPort.optional().describe('broker (mqtt)'),
    topic: z.string().min(1).optional().describe('topic (mqtt)'),
    interface: z.string().min(1).optional().describe('network interface (can)'),
    id: z.int().nonnegative().optional().describe('frame id (can)'),
    device: z.string().min(1).optional().describe('device path (serial)'),
    baud: z.int().positive().optional().describe('baud rate (serial)'),
    options: z
      .record(z.string(), z.string().describe('value of this setting'))
      .optional()
      .describe('free settings, for any transport')
  })
  .meta({ id: 'TransportSettings' })

const RemoteDefaults = z
  .object({
    client: z.object({ host: Host.optional() }).optional().describe('host the callers connect to'),
    server: z.object({ host: Host.optional() }).optional().describe('host the callees listen on'),
    basePort: NetPort.optional().describe(
      'port of the first remote link, the next ones following (default 47000)'
    )
  })
  .describe('defaults of the addresses of the remote links (default host 127.0.0.1)')

const LinkConstraints = z.object({
  direction: z
    .enum(['unidirectional', 'bidirectional'])
    .describe(
      'unidirectional: requests only; bidirectional: replies too (messages returning a value need it)'
    ),
  ack: z
    .object({
      required: z.boolean().describe('the receiver acknowledges each message'),
      timeoutMs: z.number().positive().optional().describe('how long to wait for the acknowledgement (ms)')
    })
    .describe('acknowledgement of the messages'),
  performance: z
    .object({
      class: z.enum(PERFORMANCE_CLASSES).describe('realtime, low (latency), normal or bulk traffic'),
      maxLatencyMs: z.number().positive().optional().describe('highest acceptable latency (ms)'),
      rateHz: z.number().positive().optional().describe('expected message rate (Hz)')
    })
    .describe('expected performance of the link'),
  remote: z
    .object({
      enabled: z.boolean().describe('the link crosses processes or machines through a transport'),
      transport: z
        .string()
        .optional()
        .describe(
          'transport carrying it: ipc, shm, tcp, udp, http, websocket, grpc, mqtt, can, serial, or one of `transports`'
        ),
      settings: TransportSettings.optional().describe(
        'settings of the transport; the fields that apply depend on it'
      )
    })
    .describe('remote link: between binaries, through a transport')
})

const Link = z.object({
  name: Identifier.describe('name of the link, unique in the project'),
  description: Description,
  from: Endpoint.describe(
    "initiator side (an `out` port; a container's `in` port into its content, an inner `out` port out of it)"
  ),
  to: Endpoint.describe(
    "receiver side (an `in` port; an inner `in` port from its container, the container's `out` port from its content)"
  ),
  constraints: LinkConstraints.describe('how messages travel along the link')
})

const X = z.number().describe('left edge')
const Y = z.number().describe('top edge')
const Width = z.number().describe('width')
const Height = z.number().describe('height')
const Rect = z.object({ x: X, y: Y, width: Width, height: Height })
const Locked = z.boolean().optional().describe('not moved or resized on the canvas')

const EditorNote = z.object({
  kind: z
    .enum(['note', 'frame'])
    .describe('note: sticky note; frame: titled area, moving what lies inside it'),
  text: z.string().describe('text of the note, title of the frame'),
  x: X,
  y: Y,
  width: Width,
  height: Height,
  color: z.string().optional().describe('color (CSS color)'),
  locked: Locked
})

const Side = z.enum(['left', 'right', 'top', 'bottom'])

const Anchor = z.object({
  side: Side.describe('side of the module'),
  at: z.number().min(0).max(1).describe('position along the side: 0 left / top, 1 right / bottom')
})

const PortLabels = z
  .record(Identifier, Side.describe("direction from the port's handle where its name is drawn"))
  .optional()
  .describe("direction from each port's handle where its name is drawn, by port name")

const EditorLink = z.object({
  points: z
    .array(z.object({ x: z.number().describe('x'), y: z.number().describe('y') }))
    .optional()
    .describe('bend points, relative to the innermost module holding both ends (absolute at the top level)'),
  from: Anchor.optional().describe('attachment of the source end on its module'),
  to: Anchor.optional().describe('attachment of the target end on its module'),
  label: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('where the badges sit along the link: 0 source, 1 target (default: the middle)')
})

const ModuleRect = Rect.describe('position and size of the module')
const LinkShape = EditorLink.describe('shape of the link')

const EditorView = z.object({
  name: z.string().describe('name of the view'),
  root: QualifiedName.optional().describe('module shown with its content; the whole project when absent'),
  hidden: z
    .array(ModulePath)
    .optional()
    .describe(
      'modules hidden in this view, with their content, by path (Dependency/Module for modules of dependencies)'
    ),
  layout: z
    .record(QualifiedName, ModuleRect)
    .optional()
    .describe('rects of modules in this view (parent-relative), in place of their `layout` entries'),
  links: z
    .record(Identifier, LinkShape)
    .optional()
    .describe('link shapes in this view (with a root), by link name; others are drawn automatically'),
  labels: z
    .record(
      ModulePath,
      z
        .record(Identifier, Side.describe("direction from the port's handle where its name is drawn"))
        .describe('directions of the port names of the module, by port name')
    )
    .optional()
    .describe(
      'direction where port names are drawn in this view (with a root), by module path (Dependency/Module for modules of dependencies) and port name'
    ),
  notes: z.array(EditorNote).optional().describe('notes and frames of this view (with a root)'),
  outside: z
    .record(
      ModulePath,
      z
        .object({ x: X, y: Y, width: Width.optional(), height: Height.optional() })
        .describe('place (and size) of the stand-in of the module')
    )
    .optional()
    .describe(
      'places (and sizes) of the stand-ins of outside modules linked to the content (with a root), by module path (Dependency/Module for modules of dependencies); others are lined up along the view'
    )
})

const Editor = z
  .object({
    layout: z
      .record(QualifiedName, ModuleRect)
      .describe(
        'canvas position and size of the modules, by module path (nested ones: relative to their parent)'
      ),
    views: z.array(EditorView).optional().describe('views of the canvas besides the Project view'),
    style: z
      .record(
        QualifiedName,
        z
          .object({
            color: z.string().optional().describe('deprecated: use the module `color`'),
            locked: Locked,
            labels: PortLabels
          })
          .describe('look of the module on the canvas')
      )
      .optional()
      .describe('look of the modules on the canvas, by module path'),
    notes: z.array(EditorNote).optional().describe('notes and frames of the Project view'),
    dependencies: z
      .record(
        Identifier,
        z
          .record(
            QualifiedName,
            z
              .object({
                x: X,
                y: Y,
                width: Width.optional(),
                height: Height.optional(),
                locked: Locked,
                labels: PortLabels
              })
              .describe('position and size of the placed module')
          )
          .describe('placed modules of the dependency, by module path')
      )
      .optional()
      .describe(
        'canvas position and size of the placed modules of dependencies, by dependency and module path (the modules inside a placed one: relative to their parent)'
      ),
    orientation: z
      .enum(['horizontal', 'vertical'])
      .optional()
      .describe('port placement: in left / out right (default), or in top / out bottom'),
    links: z.record(Identifier, LinkShape).optional().describe('hand-set link shapes, by link name')
  })
  .describe('Editor-only data, ignored by generators')

export const FileProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).describe('version of the file format'),
    project: z
      .object({
        name: z.string().describe('name of the project'),
        description: Description,
        metadata: Metadata
      })
      .describe('name and documentation of the project'),
    generation: z
      .object({
        templates: z
          .string()
          .min(1)
          .optional()
          .describe(
            'built-in template set generating the code (cpp17 by default): cpp98, cpp11, cpp14, cpp17, cpp20, python, sca-cpp98'
          )
      })
      .optional()
      .describe('code generation settings'),
    transports: z
      .array(z.string().min(1))
      .optional()
      .describe('custom transports offered for remote links, besides the built-in ones'),
    remoteDefaults: RemoteDefaults.optional(),
    binaries: z
      .array(Binary)
      .optional()
      .describe(
        'executables the top-level modules are split into (each names its own); links between two of them must be remote'
      ),
    types: z
      .array(TypeDef)
      .describe('types of the project: struct, enum, exception, bitmask, union, alias, custom primitive'),
    interfaces: z.array(Interface).describe('message sets the ports carry'),
    constants: z
      .array(Constant)
      .optional()
      .describe('named values; their names share the namespace of the types and interfaces'),
    modules: z.array(Module).describe('top-level modules of the architecture'),
    links: z.array(Link).describe('connections between ports of modules'),
    dependencies: z
      .array(Dependency)
      .optional()
      .describe('other projects (project or IDL files) whose types, interfaces and modules this one uses'),
    editor: Editor.optional()
  })
  .meta({ id: 'ScaffoldProject', title: 'ProjectScaffold architecture file' })

export type FileProject = z.infer<typeof FileProjectSchema>
export type FileTypeDef = z.infer<typeof TypeDef>
export type FileModuleTypeDef = z.infer<typeof ModuleTypeDef>
export type FileMessage = z.infer<typeof Message>
export type FileInterface = z.infer<typeof Interface>
export type FileMethod = z.infer<typeof Method>
export type FileAttribute = z.infer<typeof Attribute>
export type FileLink = z.infer<typeof Link>
export type FileEditor = z.infer<typeof Editor>
export type FileDependency = z.infer<typeof Dependency>
export type FileConstant = z.infer<typeof Constant>
export type FileModuleConstant = z.infer<typeof ModuleConstant>
