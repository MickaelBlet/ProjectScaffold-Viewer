//! Core model types. The in-memory project references entities by id; the file
//! format (see `schema`) references them by (qualified) name.
//! Port of `model/types.ts`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub type Id = String;
pub type Metadata = IndexMap<String, String>;
/// Plain data value, as in YAML / JSON.
pub type Value = serde_json::Value;

macro_rules! string_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($text => Some($name::$variant),)+ _ => None }
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

string_enum!(
    /// Built-in types.
    Primitive {
        Bool = "bool",
        Char = "char",
        Int8 = "int8",
        Int16 = "int16",
        Int32 = "int32",
        Int64 = "int64",
        Uint8 = "uint8",
        Uint16 = "uint16",
        Uint32 = "uint32",
        Uint64 = "uint64",
        Float32 = "float32",
        Float64 = "float64",
        String = "string",
        Bytes = "bytes",
    }
);

string_enum!(
    IntPrimitive {
        Int8 = "int8",
        Int16 = "int16",
        Int32 = "int32",
        Int64 = "int64",
        Uint8 = "uint8",
        Uint16 = "uint16",
        Uint32 = "uint32",
        Uint64 = "uint64",
    }
);

string_enum!(
    UnsignedPrimitive {
        Uint8 = "uint8",
        Uint16 = "uint16",
        Uint32 = "uint32",
        Uint64 = "uint64",
    }
);

impl IntPrimitive {
    /// Lowest and highest value.
    pub fn range(self) -> (i128, i128) {
        match self {
            IntPrimitive::Int8 => (i8::MIN as i128, i8::MAX as i128),
            IntPrimitive::Int16 => (i16::MIN as i128, i16::MAX as i128),
            IntPrimitive::Int32 => (i32::MIN as i128, i32::MAX as i128),
            IntPrimitive::Int64 => (i64::MIN as i128, i64::MAX as i128),
            IntPrimitive::Uint8 => (0, u8::MAX as i128),
            IntPrimitive::Uint16 => (0, u16::MAX as i128),
            IntPrimitive::Uint32 => (0, u32::MAX as i128),
            IntPrimitive::Uint64 => (0, u64::MAX as i128),
        }
    }
    pub fn primitive(self) -> Primitive {
        Primitive::parse(self.as_str()).expect("integer primitive")
    }
}

impl UnsignedPrimitive {
    pub fn int(self) -> IntPrimitive {
        IntPrimitive::parse(self.as_str()).expect("unsigned primitive")
    }
}

impl Primitive {
    pub fn int(self) -> Option<IntPrimitive> {
        IntPrimitive::parse(self.as_str())
    }
    /// May be bounded (`string<16>`).
    pub fn bounded(self) -> bool {
        matches!(self, Primitive::String | Primitive::Bytes)
    }
}

/// Kinds of container type references.
pub const CONTAINERS: &[&str] = &["array", "vector", "list", "set", "optional", "map"];

string_enum!(
    /// Sequence containers sharing one shape.
    SeqKind { Vector = "vector", List = "list", Set = "set" }
);

/// Type reference, parameterised by how user types are referenced (`{id}` in memory, `{name}` on
/// disk). `max`: bound of a string or bytes (UTF-8 bytes), or of the items of a vector, list, set
/// or map.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TypeRefOf<R> {
    Primitive {
        name: Primitive,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
    Array {
        of: Box<TypeRefOf<R>>,
        size: u64,
    },
    Vector {
        of: Box<TypeRefOf<R>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
    List {
        of: Box<TypeRefOf<R>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
    Set {
        of: Box<TypeRefOf<R>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
    Optional {
        of: Box<TypeRefOf<R>>,
    },
    Map {
        key: Box<TypeRefOf<R>>,
        value: Box<TypeRefOf<R>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
    Ref {
        #[serde(flatten)]
        target: R,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<TypeRefOf<R>>>,
    },
}

/// In-memory reference target: a type, interface or module by id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct IdRef {
    pub id: Id,
}

pub type TypeRef = TypeRefOf<IdRef>;

impl<R> TypeRefOf<R> {
    pub fn primitive(name: Primitive) -> Self {
        TypeRefOf::Primitive { name, max: None }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            TypeRefOf::Primitive { .. } => "primitive",
            TypeRefOf::Array { .. } => "array",
            TypeRefOf::Vector { .. } => "vector",
            TypeRefOf::List { .. } => "list",
            TypeRefOf::Set { .. } => "set",
            TypeRefOf::Optional { .. } => "optional",
            TypeRefOf::Map { .. } => "map",
            TypeRefOf::Ref { .. } => "ref",
        }
    }
    /// Item type of an array, vector, list, set or optional.
    pub fn item(&self) -> Option<&TypeRefOf<R>> {
        match self {
            TypeRefOf::Array { of, .. }
            | TypeRefOf::Vector { of, .. }
            | TypeRefOf::List { of, .. }
            | TypeRefOf::Set { of, .. }
            | TypeRefOf::Optional { of } => Some(of),
            _ => None,
        }
    }
    /// Bound (`max`) of a primitive or container, if any.
    pub fn max(&self) -> Option<u64> {
        match self {
            TypeRefOf::Primitive { max, .. }
            | TypeRefOf::Vector { max, .. }
            | TypeRefOf::List { max, .. }
            | TypeRefOf::Set { max, .. }
            | TypeRefOf::Map { max, .. } => *max,
            _ => None,
        }
    }
}

impl TypeRef {
    pub fn to(id: impl Into<Id>) -> Self {
        TypeRefOf::Ref {
            target: IdRef { id: id.into() },
            args: None,
        }
    }
    /// Id of a reference.
    pub fn ref_id(&self) -> Option<&str> {
        match self {
            TypeRefOf::Ref { target, .. } => Some(&target.id),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub id: Id,
    pub name: String,
    #[serde(rename = "type")]
    pub ty: TypeRef,
    pub description: String,
}

/// Bounds and form of a value (of each item of a container): checked on default values.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Constraints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

impl Constraints {
    pub fn is_empty(&self) -> bool {
        self.min.is_none() && self.max.is_none() && self.unit.is_none() && self.pattern.is_none()
    }
}

string_enum!(
    /// How a field referencing modules holds them.
    Ownership { Owned = "owned", Shared = "shared", Weak = "weak", Borrowed = "borrowed" }
);

/// Field with a default value: struct field or module attribute.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ValueField {
    pub id: Id,
    pub name: String,
    #[serde(rename = "type")]
    pub ty: TypeRef,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Constraints>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership: Option<Ownership>,
}

string_enum!(
    /// Operations derived from the fields or attributes.
    Derive { Equality = "equality", Ordering = "ordering", Hash = "hash", String = "string" }
);

impl Derive {
    pub fn label(self) -> &'static str {
        match self {
            Derive::Equality => "==",
            Derive::Ordering => "<",
            Derive::Hash => "hash",
            Derive::String => "string",
        }
    }
}

string_enum!(
    /// C++-like access level.
    Access { Public = "public", Protected = "protected", Private = "private" }
);

impl Access {
    /// UML-like marker.
    pub fn marker(self) -> &'static str {
        match self {
            Access::Public => "+",
            Access::Protected => "#",
            Access::Private => "-",
        }
    }
}

string_enum!(
    /// Access level as stored: absent for public.
    StoredAccess { Protected = "protected", Private = "private" }
);

impl StoredAccess {
    pub fn access(self) -> Access {
        match self {
            StoredAccess::Protected => Access::Protected,
            StoredAccess::Private => Access::Private,
        }
    }
    pub fn stored(a: Access) -> Option<StoredAccess> {
        match a {
            Access::Public => None,
            Access::Protected => Some(StoredAccess::Protected),
            Access::Private => Some(StoredAccess::Private),
        }
    }
}

string_enum!(TypeConstraint { Numeric = "numeric", Integral = "integral" });

/// Type parameter of a generic module: `T` in `Box<T>`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeParam {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraint: Option<TypeConstraint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derives_from: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<TypeRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnumValue {
    pub id: Id,
    pub name: String,
    pub value: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BitmaskFlag {
    pub id: Id,
    pub name: String,
    pub bit: u32,
}

/// Case of a union.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnionCase {
    pub id: Id,
    pub name: String,
    #[serde(rename = "type")]
    pub ty: TypeRef,
    pub description: String,
    pub labels: Vec<Value>,
    pub is_default: bool,
}

/// Body of a type definition, by kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TypeBody {
    Struct {
        fields: Vec<ValueField>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        derives: Option<Vec<Derive>>,
    },
    Enum {
        underlying: IntPrimitive,
        values: Vec<EnumValue>,
    },
    Bitmask {
        underlying: UnsignedPrimitive,
        flags: Vec<BitmaskFlag>,
    },
    Union {
        discriminator: TypeRef,
        cases: Vec<UnionCase>,
    },
    Exception {
        fields: Vec<ValueField>,
    },
    Alias {
        #[serde(rename = "type")]
        ty: TypeRef,
    },
    Primitive {
        #[serde(default, rename = "typeParam", skip_serializing_if = "Option::is_none")]
        type_param: Option<TypeParam>,
    },
}

impl TypeBody {
    pub fn kind(&self) -> &'static str {
        match self {
            TypeBody::Struct { .. } => "struct",
            TypeBody::Enum { .. } => "enum",
            TypeBody::Bitmask { .. } => "bitmask",
            TypeBody::Union { .. } => "union",
            TypeBody::Exception { .. } => "exception",
            TypeBody::Alias { .. } => "alias",
            TypeBody::Primitive { .. } => "primitive",
        }
    }
}

/// Type definition: common part (`Owned` and `Scoped` in TS) and the body of its kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeDef {
    pub id: Id,
    pub name: String,
    pub description: String,
    /// Dependency the entity comes from (read-only here).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<Id>,
    /// Module of this project owning it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<Id>,
    /// Path of the module owning it in its dependency (with `dependency`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<StoredAccess>,
    #[serde(flatten)]
    pub body: TypeBody,
}

impl TypeDef {
    pub fn kind(&self) -> &'static str {
        self.body.kind()
    }
    /// Owned by a module (of this project or of a dependency).
    pub fn is_module_type(&self) -> bool {
        self.module.is_some() || self.module_path.is_some()
    }
    pub fn type_param(&self) -> Option<&TypeParam> {
        match &self.body {
            TypeBody::Primitive { type_param } => type_param.as_ref(),
            _ => None,
        }
    }
}

string_enum!(ParamDirection { In = "in", Out = "out", Inout = "inout" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Param {
    pub id: Id,
    pub name: String,
    #[serde(rename = "type")]
    pub ty: TypeRef,
    pub description: String,
    pub direction: ParamDirection,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: Id,
    pub name: String,
    pub description: String,
    pub params: Vec<Param>,
    pub returns: Option<TypeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raises: Option<Vec<Id>>,
}

string_enum!(
    /// C++-like qualifiers, in the order they are written.
    Qualifier {
        Static = "static",
        Const = "const",
        Virtual = "virtual",
        Pure = "pure",
        Override = "override",
        Final = "final",
        Noexcept = "noexcept",
        Nodiscard = "nodiscard",
        ThreadSafe = "threadSafe",
        Mutable = "mutable",
        Atomic = "atomic",
    }
);

pub const QUALIFIERS: &[Qualifier] = &[Qualifier::Static, Qualifier::Const];
pub const ATTRIBUTE_QUALIFIERS: &[Qualifier] = &[
    Qualifier::Static,
    Qualifier::Const,
    Qualifier::Mutable,
    Qualifier::Atomic,
];
pub const METHOD_QUALIFIERS: &[Qualifier] = &[
    Qualifier::Static,
    Qualifier::Const,
    Qualifier::Virtual,
    Qualifier::Pure,
    Qualifier::Override,
    Qualifier::Final,
    Qualifier::Noexcept,
    Qualifier::Nodiscard,
    Qualifier::ThreadSafe,
];

/// Set of qualifiers (bit per `Qualifier`), stored as `true` flags in files.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Qualifiers(u16);

impl Qualifiers {
    pub fn has(self, q: Qualifier) -> bool {
        self.0 & (1 << q as u16) != 0
    }
    pub fn set(&mut self, q: Qualifier, on: bool) {
        if on {
            self.0 |= 1 << q as u16
        } else {
            self.0 &= !(1 << q as u16)
        }
    }
    pub fn with(mut self, q: Qualifier) -> Self {
        self.set(q, true);
        self
    }
    pub fn iter(self) -> impl Iterator<Item = Qualifier> {
        Qualifier::ALL.iter().copied().filter(move |q| self.has(*q))
    }
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl Serialize for Qualifiers {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(None)?;
        for q in self.iter() {
            m.serialize_entry(q.as_str(), &true)?;
        }
        m.end()
    }
}

impl<'de> Deserialize<'de> for Qualifiers {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m = IndexMap::<String, Value>::deserialize(d)?;
        let mut out = Qualifiers::default();
        for (k, v) in m {
            if let (Some(q), Some(true)) = (Qualifier::parse(&k), v.as_bool()) {
                out.set(q, true);
            }
        }
        Ok(out)
    }
}

string_enum!(Accessors { Read = "read", None = "none" });
string_enum!(LockKind { Mutex = "mutex", Shared = "shared", Recursive = "recursive" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lock {
    pub id: Id,
    pub name: String,
    pub kind: LockKind,
}

/// Module attribute: a value field with C++-like qualifiers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribute {
    #[serde(flatten)]
    pub field: ValueField,
    /// `static`, `const`, `mutable`, `atomic`.
    #[serde(flatten)]
    pub qualifiers: Qualifiers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<StoredAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessors: Option<Accessors>,
    /// Lock of the module held to use it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guarded_by: Option<Id>,
}

/// Parameter of a module method.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MethodParam {
    #[serde(flatten)]
    pub param: Param,
    /// `const` only.
    #[serde(flatten)]
    pub qualifiers: Qualifiers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}

/// Method prototype of a module: a message with C++-like qualifiers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Method {
    pub id: Id,
    pub name: String,
    pub description: String,
    pub params: Vec<MethodParam>,
    pub returns: Option<TypeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raises: Option<Vec<Id>>,
    #[serde(flatten)]
    pub qualifiers: Qualifiers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<StoredAccess>,
}

/// Constructor of a module: a parameter named like an attribute initializes it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Constructor {
    pub id: Id,
    pub description: String,
    pub params: Vec<MethodParam>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<StoredAccess>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub explicit: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub defaulted: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

string_enum!(SpecialMember { Default = "default", Delete = "delete", Custom = "custom" });

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Destructor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<StoredAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#virtual: Option<bool>,
}

string_enum!(Instantiation { Singleton = "singleton", Utility = "utility", Value = "value" });
string_enum!(ActiveOverflow { Block = "block", Drop = "drop", Error = "error" });

pub const DEFAULT_ACTIVE_QUEUE: u64 = 64;
pub const DEFAULT_ACTIVE_TIMEOUT_MS: u64 = 5000;

/// Active module settings; absent fields: defaults.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Active {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<ActiveOverflow>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub id: Id,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<Id>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub r#final: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transition {
    pub id: Id,
    pub from: Id,
    pub to: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Id>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StateMachine {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial: Option<Id>,
    pub states: Vec<State>,
    pub transitions: Vec<Transition>,
}

string_enum!(ModuleKind { Class = "class", Abstract = "abstract", Interface = "interface" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Interface {
    pub id: Id,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<Id>,
    pub messages: Vec<Message>,
}

string_enum!(
    /// `out`: initiates / sends. `in`: receives / serves.
    PortRole { Out = "out", In = "in" }
);

string_enum!(Side { Left = "left", Right = "right", Top = "top", Bottom = "bottom" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub id: Id,
    pub name: String,
    pub role: PortRole,
    pub interface_id: Option<Id>,
    pub description: String,
    /// Editor-only: direction from the port's handle where its name is drawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<Side>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub id: Id,
    pub name: String,
    pub description: String,
    pub parent_id: Option<Id>,
    /// Absent for a concrete class.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ModuleKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bases: Option<Vec<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_args: Option<IndexMap<Id, Vec<TypeRef>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub implements: Option<Vec<Id>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub r#final: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derives: Option<Vec<Derive>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constructors: Option<Vec<Constructor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<SpecialMember>,
    #[serde(default, rename = "move", skip_serializing_if = "Option::is_none")]
    pub r#move: Option<SpecialMember>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructor: Option<Destructor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instantiation: Option<Instantiation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locks: Option<Vec<Lock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<Active>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invariants: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_machine: Option<StateMachine>,
    pub metadata: Metadata,
    pub attributes: Vec<Attribute>,
    pub methods: Vec<Method>,
    pub ports: Vec<Port>,
    /// Editor layout, position relative to parent.
    pub layout: Rect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_id: Option<Id>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_routes: Option<IndexMap<Id, BaseRoute>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Binary {
    pub id: Id,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

string_enum!(PerformanceClass { Realtime = "realtime", Low = "low", Normal = "normal", Bulk = "bulk" });

/// Built-in transports.
pub const TRANSPORTS: &[&str] = &[
    "ipc",
    "shm",
    "mq",
    "tcp",
    "udp",
    "http",
    "grpc",
    "websocket",
    "mqtt",
    "can",
    "serial",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HostPort {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u64>,
}

/// Settings of a link's transport; the fields that apply depend on it (see `transports`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<HostPort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<HostPort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacity: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_messages: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker: Option<HostPort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baud: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<IndexMap<String, String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HostOnly {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

/// Defaults of the addresses of the remote links.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<HostOnly>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<HostOnly>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_port: Option<u64>,
}

impl RemoteDefaults {
    pub fn is_empty(&self) -> bool {
        self.client.is_none() && self.server.is_none() && self.base_port.is_none()
    }
}

string_enum!(Direction { Unidirectional = "unidirectional", Bidirectional = "bidirectional" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Performance {
    pub class: PerformanceClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_latency_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_hz: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Remote {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<TransportSettings>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkConstraints {
    pub direction: Direction,
    pub ack: Ack,
    pub performance: Performance,
    pub remote: Remote,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// A module of this project, or an imported module.
    pub module_id: Id,
    pub port_id: Id,
}

/// Editor-only: where a link end attaches on its module's border.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkAnchor {
    pub side: Side,
    /// Position along the side, 0 to 1.
    pub at: f64,
}

/// Editor-only shape of a link, set by hand.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LinkRoute {
    pub points: Vec<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<LinkAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<LinkAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<f64>,
}

/// Editor-only shape of an inheritance line (`label` unused).
pub type BaseRoute = LinkRoute;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub id: Id,
    pub name: String,
    pub description: String,
    pub from: Endpoint,
    pub to: Endpoint,
    pub constraints: LinkConstraints,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<LinkRoute>,
}

string_enum!(Orientation { Horizontal = "horizontal", Vertical = "vertical" });

#[allow(clippy::derivable_impls)] // The enum comes from `string_enum!`.
impl Default for Orientation {
    fn default() -> Self {
        Orientation::Horizontal
    }
}

/// Place (and size, when resized) of a stand-in of an outside module in a drill-down view.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StandIn {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// Editor-only diagram view: the whole project or the inside of one module, minus hidden modules.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: Id,
    pub name: String,
    pub root_module_id: Option<Id>,
    pub hidden: Vec<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts: Option<IndexMap<Id, Rect>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routes: Option<IndexMap<Id, LinkRoute>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_labels: Option<IndexMap<Id, Side>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stand_ins: Option<IndexMap<Id, StandIn>>,
    /// Opened from a module and not stored in the project until kept.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub temporary: bool,
}

/// Id of the implicit view showing the whole project.
pub const GLOBAL_VIEW: &str = "global";

string_enum!(NoteKind { Note = "note", Frame = "frame" });

/// Editor-only canvas annotation: a sticky note or a titled frame drawn behind modules.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: Id,
    pub kind: NoteKind,
    pub text: String,
    /// Absolute canvas position.
    pub layout: Rect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    /// Drill-down view the note is drawn in; unset: the views of the whole project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_id: Option<Id>,
}

/// Port of a module of another project, as last read from it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImportedPort {
    pub id: Id,
    pub name: String,
    pub role: PortRole,
    /// Interface name in the other project.
    pub interface: Option<String>,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<Side>,
}

/// Module of another project placed on this one's canvas.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImportedModule {
    pub id: Id,
    /// Qualified module path in the other project.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<Vec<Attribute>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub methods: Option<Vec<Method>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub r#final: bool,
    pub ports: Vec<ImportedPort>,
    /// Editor-only absolute canvas position.
    pub position: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
}

/// Named constant: a value of a type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConstDef {
    pub id: Id,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<Id>,
    #[serde(rename = "type")]
    pub ty: TypeRef,
    pub value: Value,
}

/// Another project file this one uses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Dependency {
    pub id: Id,
    pub name: String,
    /// File of the other project, relative to this one.
    pub file: String,
    pub uses: Vec<String>,
    pub indirect: bool,
    pub shared: Vec<String>,
    pub modules: Vec<ImportedModule>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub description: String,
    pub metadata: Metadata,
    pub transports: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_defaults: Option<RemoteDefaults>,
    pub binaries: Vec<Binary>,
    pub types: Vec<TypeDef>,
    pub interfaces: Vec<Interface>,
    pub consts: Vec<ConstDef>,
    pub modules: Vec<Module>,
    pub links: Vec<Link>,
    pub dependencies: Vec<Dependency>,
    pub views: Vec<View>,
    pub notes: Vec<Note>,
    pub orientation: Orientation,
}
