//! On-disk format (YAML/JSON), read side. Port of `model/schema.ts`; the published JSON Schema
//! (`schema/scaffold.schema.json`) stays generated from the TypeScript source. Writing builds
//! ordered JSON values directly (see `serialize`), so that keys keep the order of the web build.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::types::{
    Access, Accessors, ActiveOverflow, Derive, Instantiation, IntPrimitive, LockKind, ModuleKind, NoteKind,
    Orientation, Ownership, ParamDirection, PortRole, Side, SpecialMember, TypeConstraint, TypeRefOf,
    UnsignedPrimitive, Value,
};

pub const SCHEMA_VERSION: u64 = 1;

/// File reference target: a type, interface or module by (qualified) name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NameRef {
    pub name: String,
}

pub type FileTypeRef = TypeRefOf<NameRef>;

pub type Record<V> = IndexMap<String, V>;

pub type FileConstraints = crate::types::Constraints;
pub type FileRemoteDefaults = crate::types::RemoteDefaults;
pub type FileLinkConstraints = crate::types::LinkConstraints;

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileField {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FileTypeRef,
    #[serde(default)]
    pub description: Option<String>,
}

/// Qualifier flags as written (`static: true`…), each optional.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQualifiers {
    #[serde(default, rename = "static")]
    pub is_static: Option<bool>,
    #[serde(default, rename = "const")]
    pub is_const: Option<bool>,
    #[serde(default, rename = "virtual")]
    pub is_virtual: Option<bool>,
    #[serde(default)]
    pub pure: Option<bool>,
    #[serde(default, rename = "override")]
    pub is_override: Option<bool>,
    #[serde(default, rename = "final")]
    pub is_final: Option<bool>,
    #[serde(default)]
    pub noexcept: Option<bool>,
    #[serde(default)]
    pub nodiscard: Option<bool>,
    #[serde(default)]
    pub thread_safe: Option<bool>,
    #[serde(default)]
    pub mutable: Option<bool>,
    #[serde(default)]
    pub atomic: Option<bool>,
}

impl FileQualifiers {
    pub fn qualifiers(&self) -> crate::types::Qualifiers {
        use crate::types::Qualifier as Q;
        let mut q = crate::types::Qualifiers::default();
        let flags = [
            (Q::Static, self.is_static),
            (Q::Const, self.is_const),
            (Q::Virtual, self.is_virtual),
            (Q::Pure, self.pure),
            (Q::Override, self.is_override),
            (Q::Final, self.is_final),
            (Q::Noexcept, self.noexcept),
            (Q::Nodiscard, self.nodiscard),
            (Q::ThreadSafe, self.thread_safe),
            (Q::Mutable, self.mutable),
            (Q::Atomic, self.atomic),
        ];
        for (k, v) in flags {
            q.set(k, v == Some(true));
        }
        q
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileValueField {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FileTypeRef,
    #[serde(default)]
    pub description: Option<String>,
    /// Present (possibly null) or absent.
    #[serde(default, deserialize_with = "present")]
    pub default: Option<Value>,
    #[serde(default)]
    pub constraints: Option<FileConstraints>,
    #[serde(default)]
    pub ownership: Option<Ownership>,
}

/// Deserializes a field that may be present with a null value: `Some(Value::Null)`.
pub fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileEnumValue {
    pub name: String,
    pub value: i64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileBitmaskFlag {
    pub name: String,
    pub bit: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileUnionCase {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FileTypeRef,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<Value>>,
    #[serde(default)]
    pub default: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileTypeBody {
    Struct {
        #[serde(default)]
        derives: Option<Vec<Derive>>,
        fields: Vec<FileValueField>,
    },
    Enum {
        underlying: IntPrimitive,
        values: Vec<FileEnumValue>,
    },
    Exception {
        fields: Vec<FileValueField>,
    },
    Bitmask {
        underlying: UnsignedPrimitive,
        flags: Vec<FileBitmaskFlag>,
    },
    Union {
        discriminator: FileTypeRef,
        cases: Vec<FileUnionCase>,
    },
    Alias {
        #[serde(rename = "type")]
        ty: FileTypeRef,
    },
    Primitive {},
}

/// A type definition; `access` only for the types of a module.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileTypeDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub access: Option<Access>,
    #[serde(flatten)]
    pub body: FileTypeBody,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileConstant {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub ty: FileTypeRef,
    #[serde(default, deserialize_with = "present")]
    pub value: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileParam {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FileTypeRef,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub direction: Option<ParamDirection>,
    #[serde(flatten)]
    pub qualifiers: FileQualifiers,
    #[serde(default, deserialize_with = "present")]
    pub default: Option<Value>,
}

/// A message of an interface, or a method of a module (with its qualifiers and conditions).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileMethod {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub access: Option<Access>,
    #[serde(flatten)]
    pub qualifiers: FileQualifiers,
    pub params: Vec<FileParam>,
    pub returns: Option<FileTypeRef>,
    #[serde(default)]
    pub raises: Option<Vec<String>>,
    #[serde(default)]
    pub pre: Option<Vec<String>>,
    #[serde(default)]
    pub post: Option<Vec<String>>,
}

pub type FileMessage = FileMethod;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttribute {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FileTypeRef,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub default: Option<Value>,
    #[serde(default)]
    pub constraints: Option<FileConstraints>,
    #[serde(default)]
    pub ownership: Option<Ownership>,
    #[serde(default)]
    pub access: Option<Access>,
    #[serde(flatten)]
    pub qualifiers: FileQualifiers,
    #[serde(default)]
    pub accessors: Option<Accessors>,
    #[serde(default)]
    pub guarded_by: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileConstructor {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub access: Option<Access>,
    #[serde(default)]
    pub explicit: Option<bool>,
    #[serde(default)]
    pub defaulted: Option<bool>,
    #[serde(default)]
    pub deleted: Option<bool>,
    pub params: Vec<FileParam>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileDestructor {
    #[serde(default)]
    pub access: Option<Access>,
    #[serde(default, rename = "virtual")]
    pub is_virtual: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTypeParam {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub constraint: Option<TypeConstraint>,
    #[serde(default)]
    pub derives_from: Option<String>,
    #[serde(default)]
    pub default: Option<FileTypeRef>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileLock {
    pub name: String,
    pub kind: LockKind,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActiveSettings {
    #[serde(default)]
    pub queue: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub overflow: Option<ActiveOverflow>,
}

/// `true` (the defaults), `false` (not active) or the settings.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum FileActive {
    Flag(bool),
    Settings(FileActiveSettings),
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileState {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub exit: Option<String>,
    #[serde(default, rename = "final")]
    pub is_final: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileTransition {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub guard: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileStateMachine {
    #[serde(default)]
    pub initial: Option<String>,
    pub states: Vec<FileState>,
    pub transitions: Vec<FileTransition>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileInterface {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub messages: Vec<FileMessage>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FilePort {
    pub name: String,
    pub role: PortRole,
    pub interface: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileModule {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: Option<ModuleKind>,
    #[serde(default)]
    pub type_params: Option<Vec<FileTypeParam>>,
    #[serde(default)]
    pub bases: Option<Vec<String>>,
    #[serde(default)]
    pub implements: Option<Vec<String>>,
    #[serde(default, rename = "final")]
    pub is_final: Option<bool>,
    #[serde(default)]
    pub derives: Option<Vec<Derive>>,
    #[serde(default)]
    pub instantiation: Option<Instantiation>,
    #[serde(default)]
    pub copy: Option<SpecialMember>,
    #[serde(default, rename = "move")]
    pub is_move: Option<SpecialMember>,
    #[serde(default)]
    pub locks: Option<Vec<FileLock>>,
    #[serde(default)]
    pub active: Option<FileActive>,
    #[serde(default)]
    pub invariants: Option<Vec<String>>,
    #[serde(default)]
    pub metadata: Option<Record<String>>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub binary: Option<String>,
    #[serde(default)]
    pub types: Option<Vec<FileTypeDef>>,
    #[serde(default)]
    pub attributes: Option<Vec<FileAttribute>>,
    #[serde(default)]
    pub constructors: Option<Vec<FileConstructor>>,
    #[serde(default)]
    pub destructor: Option<FileDestructor>,
    #[serde(default)]
    pub methods: Option<Vec<FileMethod>>,
    #[serde(default)]
    pub state_machine: Option<FileStateMachine>,
    pub ports: Vec<FilePort>,
    #[serde(default)]
    pub modules: Option<Vec<FileModule>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileBinary {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileEndpoint {
    #[serde(default)]
    pub project: Option<String>,
    pub module: String,
    pub port: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileModuleTypes {
    pub module: String,
    pub types: Vec<FileTypeDef>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FilePlacedModule {
    pub module: String,
    #[serde(default, rename = "final")]
    pub is_final: Option<bool>,
    #[serde(default)]
    pub attributes: Option<Vec<FileAttribute>>,
    #[serde(default)]
    pub methods: Option<Vec<FileMethod>>,
    pub ports: Vec<FilePort>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDependency {
    pub name: String,
    pub file: String,
    #[serde(default)]
    pub uses: Option<Vec<String>>,
    #[serde(default)]
    pub indirect: Option<bool>,
    #[serde(default)]
    pub shared: Option<Vec<String>>,
    pub types: Vec<FileTypeDef>,
    pub interfaces: Vec<FileInterface>,
    #[serde(default)]
    pub constants: Option<Vec<FileConstant>>,
    #[serde(default)]
    pub module_types: Option<Vec<FileModuleTypes>>,
    #[serde(default)]
    pub modules: Option<Vec<FilePlacedModule>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileLink {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub from: FileEndpoint,
    pub to: FileEndpoint,
    pub constraints: FileLinkConstraints,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileNote {
    pub kind: NoteKind,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub locked: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct FileAnchor {
    pub side: Side,
    pub at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct FilePoint {
    pub x: f64,
    pub y: f64,
}

/// Shape of a link (or, without `label`, of an inheritance line).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileLinkShape {
    #[serde(default)]
    pub points: Option<Vec<FilePoint>>,
    #[serde(default)]
    pub from: Option<FileAnchor>,
    #[serde(default)]
    pub to: Option<FileAnchor>,
    #[serde(default)]
    pub label: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct FilePlace {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileView {
    pub name: String,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub hidden: Option<Vec<String>>,
    #[serde(default)]
    pub layout: Option<Record<FileRect>>,
    #[serde(default)]
    pub links: Option<Record<FileLinkShape>>,
    #[serde(default)]
    pub labels: Option<Record<Record<Side>>>,
    #[serde(default)]
    pub notes: Option<Vec<FileNote>>,
    #[serde(default)]
    pub outside: Option<Record<FilePlace>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileStyle {
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub labels: Option<Record<Side>>,
    #[serde(default)]
    pub bases: Option<Record<FileLinkShape>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FilePlacedEditor {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub labels: Option<Record<Side>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileEditor {
    pub layout: Record<FileRect>,
    #[serde(default)]
    pub views: Option<Vec<FileView>>,
    #[serde(default)]
    pub style: Option<Record<FileStyle>>,
    #[serde(default)]
    pub notes: Option<Vec<FileNote>>,
    #[serde(default)]
    pub dependencies: Option<Record<Record<FilePlacedEditor>>>,
    #[serde(default)]
    pub orientation: Option<Orientation>,
    #[serde(default)]
    pub links: Option<Record<FileLinkShape>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FileProjectInfo {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub metadata: Option<Record<String>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProject {
    pub schema_version: u64,
    pub project: FileProjectInfo,
    #[serde(default)]
    pub transports: Option<Vec<String>>,
    #[serde(default)]
    pub remote_defaults: Option<FileRemoteDefaults>,
    #[serde(default)]
    pub binaries: Option<Vec<FileBinary>>,
    pub types: Vec<FileTypeDef>,
    pub interfaces: Vec<FileInterface>,
    #[serde(default)]
    pub constants: Option<Vec<FileConstant>>,
    pub modules: Vec<FileModule>,
    pub links: Vec<FileLink>,
    #[serde(default)]
    pub dependencies: Option<Vec<FileDependency>>,
    #[serde(default)]
    pub editor: Option<FileEditor>,
}
