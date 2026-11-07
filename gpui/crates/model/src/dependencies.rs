//! Dependencies: other project files this project uses. Their types, interfaces and constants are
//! kept in the project's `types`, `interfaces` and `consts` with `dependency` set, as last read from
//! the file, so that the file stays self-contained for generators. The dependencies they use are
//! listed too (flattened, `indirect`), each with its file relative to this project. Some of their
//! modules may be placed on the canvas, with a copy of their ports as last read, so that links reach
//! them. Port of `dependencies.ts`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use indexmap::IndexMap;
use serde_json::Value;

use crate::project::{
    IMPORTED_PREFIX, all_type_refs, child_modules, dependency_module_ref, find_module, for_each_ref_id_mut,
    for_each_type_ref_mut, imported_parent, is_identifier, module_path, module_paths, new_id, orphan_refs,
    parse_dependency_module_ref, ref_namer, type_usage_targets, unique_name,
};
use crate::reuse::pair;
use crate::sync::{Renames, normalize_file, resolve_relative, same_file};
use crate::typeexpr::{map_ref, walk_type_ref};
use crate::types::*;

// Entities: types, interfaces and constants.

/// Which list of the project an entity is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Types,
    Interfaces,
    Consts,
}

const KINDS: [Kind; 3] = [Kind::Types, Kind::Interfaces, Kind::Consts];

/// A type, interface or constant of a project, borrowed.
#[derive(Clone, Copy, Debug)]
pub enum EntityRef<'a> {
    Type(&'a TypeDef),
    Interface(&'a Interface),
    Const(&'a ConstDef),
}

/// A type, interface or constant, owned.
#[derive(Clone, Debug)]
enum Entity {
    Type(TypeDef),
    Interface(Interface),
    Const(ConstDef),
}

impl<'a> EntityRef<'a> {
    pub fn id(&self) -> &'a str {
        match *self {
            EntityRef::Type(t) => &t.id,
            EntityRef::Interface(i) => &i.id,
            EntityRef::Const(c) => &c.id,
        }
    }
    pub fn name(&self) -> &'a str {
        match *self {
            EntityRef::Type(t) => &t.name,
            EntityRef::Interface(i) => &i.name,
            EntityRef::Const(c) => &c.name,
        }
    }
    /// Dependency the entity comes from; None for the project's own ones.
    pub fn dependency(&self) -> Option<&'a str> {
        match *self {
            EntityRef::Type(t) => t.dependency.as_deref(),
            EntityRef::Interface(i) => i.dependency.as_deref(),
            EntityRef::Const(c) => c.dependency.as_deref(),
        }
    }
    /// Whether the entity is a type of a module (never shared between dependencies, never conflicting).
    fn scoped(&self) -> bool {
        matches!(self, EntityRef::Type(t) if t.is_module_type())
    }
    fn kind(&self) -> Kind {
        match self {
            EntityRef::Type(_) => Kind::Types,
            EntityRef::Interface(_) => Kind::Interfaces,
            EntityRef::Const(_) => Kind::Consts,
        }
    }
    fn to_entity(self) -> Entity {
        match self {
            EntityRef::Type(t) => Entity::Type(t.clone()),
            EntityRef::Interface(i) => Entity::Interface(i.clone()),
            EntityRef::Const(c) => Entity::Const(c.clone()),
        }
    }
}

impl Entity {
    fn as_ref(&self) -> EntityRef<'_> {
        match self {
            Entity::Type(t) => EntityRef::Type(t),
            Entity::Interface(i) => EntityRef::Interface(i),
            Entity::Const(c) => EntityRef::Const(c),
        }
    }
    fn set_id(&mut self, id: Id) {
        match self {
            Entity::Type(t) => t.id = id,
            Entity::Interface(i) => i.id = id,
            Entity::Const(c) => c.id = id,
        }
    }
    fn set_dependency(&mut self, dep: Option<Id>) {
        match self {
            Entity::Type(t) => t.dependency = dep,
            Entity::Interface(i) => i.dependency = dep,
            Entity::Const(c) => c.dependency = dep,
        }
    }
}

/// Types, interfaces and constants of a project, in that order.
fn entities(p: &Project) -> Vec<EntityRef<'_>> {
    p.types
        .iter()
        .map(EntityRef::Type)
        .chain(p.interfaces.iter().map(EntityRef::Interface))
        .chain(p.consts.iter().map(EntityRef::Const))
        .collect()
}

fn entities_of(p: &Project, kind: Kind) -> Vec<EntityRef<'_>> {
    match kind {
        Kind::Types => p.types.iter().map(EntityRef::Type).collect(),
        Kind::Interfaces => p.interfaces.iter().map(EntityRef::Interface).collect(),
        Kind::Consts => p.consts.iter().map(EntityRef::Const).collect(),
    }
}

fn find_entity<'a>(p: &'a Project, id: &str) -> Option<EntityRef<'a>> {
    entities(p).into_iter().find(|e| e.id() == id)
}

fn set_entity_dependency(p: &mut Project, id: &str, dep: Option<Id>) {
    if let Some(t) = p.types.iter_mut().find(|e| e.id == id) {
        t.dependency = dep;
    } else if let Some(i) = p.interfaces.iter_mut().find(|e| e.id == id) {
        i.dependency = dep;
    } else if let Some(c) = p.consts.iter_mut().find(|e| e.id == id) {
        c.dependency = dep;
    }
}

/// Put `e` in its list of `d`: in place of the entity with its id when there is one, else at the end.
fn put(d: &mut Project, e: Entity) {
    fn put_in<T>(list: &mut Vec<T>, item: T, same: impl Fn(&T) -> bool) {
        match list.iter().position(same) {
            Some(at) => list[at] = item,
            None => list.push(item),
        }
    }
    match e {
        Entity::Type(t) => {
            let id = t.id.clone();
            put_in(&mut d.types, t, |x| x.id == id)
        }
        Entity::Interface(i) => {
            let id = i.id.clone();
            put_in(&mut d.interfaces, i, |x| x.id == id)
        }
        Entity::Const(c) => {
            let id = c.id.clone();
            put_in(&mut d.consts, c, |x| x.id == id)
        }
    }
}

/// Remove the entities of `ids` from `d`.
fn remove_entities(d: &mut Project, ids: &HashSet<Id>) {
    d.types.retain(|e| !ids.contains(&e.id));
    d.interfaces.retain(|e| !ids.contains(&e.id));
    d.consts.retain(|e| !ids.contains(&e.id));
}

/// `JSON.stringify` equality of two values.
fn same<T: serde::Serialize>(a: &T, b: &T) -> bool {
    serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
}

/// Names of entities in their project: `Path.Name` for a type of a module.
struct Keyer {
    paths: HashMap<Id, String>,
}

impl Keyer {
    fn new(p: &Project) -> Self {
        Keyer {
            paths: module_paths(&p.modules, &p.dependencies),
        }
    }

    fn key(&self, e: EntityRef) -> String {
        let EntityRef::Type(t) = e else {
            return e.name().to_string();
        };
        if !e.scoped() {
            return t.name.clone();
        }
        let path = match &t.module {
            Some(m) => self.paths.get(m).map(String::as_str),
            None => t.module_path.as_deref(),
        };
        format!("{}.{}", path.unwrap_or("undefined"), t.name)
    }
}

/// An identifier made from a project name, for a new dependency.
pub fn dependency_name(name: &str) -> String {
    let mut id = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            id.push(c);
            in_run = false;
        } else if !in_run {
            id.push('_');
            in_run = true;
        }
    }
    let id = id.trim_matches('_');
    if id.is_empty() {
        return "Other".into();
    }
    if is_identifier(id) {
        id.to_string()
    } else {
        format!("_{id}")
    }
}

/// Types, interfaces and constants of a dependency, or the project's own ones (`None`).
pub fn dependency_entities<'a>(p: &'a Project, dependency: Option<&str>) -> Vec<EntityRef<'a>> {
    entities(p)
        .into_iter()
        .filter(|e| e.dependency() == dependency)
        .collect()
}

/// Dependency defining a type or interface; None for the project's own ones.
pub fn dependency_of<'a>(p: &'a Project, id: &str) -> Option<&'a Dependency> {
    let dependency = find_entity(p, id)?.dependency()?;
    p.dependencies.iter().find(|x| x.id == dependency)
}

/// Dependency of a project read from `file` (relative to it).
pub fn dependency_at<'a>(p: &'a Project, file: &str) -> Option<&'a Dependency> {
    let file = normalize_file(file);
    p.dependencies.iter().find(|x| normalize_file(&x.file) == file)
}

fn dependency_index(p: &Project, file: &str) -> Option<usize> {
    let file = normalize_file(file);
    p.dependencies
        .iter()
        .position(|x| normalize_file(&x.file) == file)
}

fn modules_by_path(p: &Project) -> IndexMap<String, &Module> {
    p.modules.iter().map(|m| (module_path(p, &m.id), m)).collect()
}

fn ports_of(source: &Project, m: &Module, previous: &[ImportedPort]) -> Vec<ImportedPort> {
    m.ports
        .iter()
        .map(|pt| {
            // Ports keep their id and name placement by name, so that links survive a refresh.
            let was = previous.iter().find(|x| x.name == pt.name);
            ImportedPort {
                id: was.map_or_else(new_id, |w| w.id.clone()),
                name: pt.name.clone(),
                role: pt.role,
                interface: source
                    .interfaces
                    .iter()
                    .find(|i| Some(&i.id) == pt.interface_id.as_ref())
                    .map(|i| i.name.clone()),
                description: pt.description.clone(),
                label: was.and_then(|w| w.label),
            }
        })
        .collect()
}

/// Attributes, methods and method parameters, copied keeping the ids a previous copy has.
trait Member: Clone {
    fn name(&self) -> &str;
    fn id(&self) -> &str;
    fn set_id(&mut self, id: Id);
    /// Take the ids of the parameters `was` has, by name.
    fn params_from(&mut self, _was: &Self) {}
}

impl Member for Attribute {
    fn name(&self) -> &str {
        &self.field.name
    }
    fn id(&self) -> &str {
        &self.field.id
    }
    fn set_id(&mut self, id: Id) {
        self.field.id = id;
    }
}

impl Member for MethodParam {
    fn name(&self) -> &str {
        &self.param.name
    }
    fn id(&self) -> &str {
        &self.param.id
    }
    fn set_id(&mut self, id: Id) {
        self.param.id = id;
    }
}

impl Member for Method {
    fn name(&self) -> &str {
        &self.name
    }
    fn id(&self) -> &str {
        &self.id
    }
    fn set_id(&mut self, id: Id) {
        self.id = id;
    }
    fn params_from(&mut self, was: &Self) {
        self.params = members_of(&self.params, &was.params);
    }
}

/// Copies of the attributes or methods (`list`) of a module, keeping the ids `previous` has by name
/// (in order for overloads).
fn members_of<T: Member>(list: &[T], previous: &[T]) -> Vec<T> {
    let prev_names: Vec<&str> = previous.iter().map(|x| x.name()).collect();
    let names: Vec<&str> = list.iter().map(|x| x.name()).collect();
    let before = pair(&prev_names, &names);
    list.iter()
        .zip(before)
        .map(|(x, was)| {
            let was = was.map(|j| &previous[j]);
            let mut copy = x.clone();
            copy.set_id(was.map_or_else(new_id, |w| w.id().to_string()));
            if let Some(w) = was {
                copy.params_from(w);
            }
            copy
        })
        .collect()
}

/// Top-level module of `source` holding `m` (`m` itself at the top level).
fn root_of<'a>(source: &'a Project, m: &'a Module) -> &'a Module {
    let mut root = m;
    let mut up = m;
    while let Some(parent) = up.parent_id.as_deref() {
        let Some(parent) = find_module(source, parent) else {
            break;
        };
        root = parent;
        up = parent;
    }
    root
}

/// Top-level module `root` of `source` placed at `position`, with its content (parents first, each
/// at its place in its parent, as in `source`). Modules `previous` has at the same path keep their
/// id, ports, attributes and methods (by name), size and, for the content, their place in their
/// parent (unless drawn at the top level before, `alone`). Types of attributes and methods are
/// those here: `id_of` the id of each type of `source`.
fn placed_tree(
    source: &Project,
    root: &Module,
    position: Point,
    previous: &HashMap<String, ImportedModule>,
    alone: &HashSet<Id>,
    id_of: &dyn Fn(&str) -> Id,
) -> Vec<ImportedModule> {
    fn visit(
        source: &Project,
        m: &Module,
        // Where a top-level module is placed; None for its content.
        position: Option<Point>,
        previous: &HashMap<String, ImportedModule>,
        alone: &HashSet<Id>,
        id_of: &dyn Fn(&str) -> Id,
        out: &mut Vec<ImportedModule>,
    ) {
        let top = position.is_some();
        let path = module_path(source, &m.id);
        let was = previous.get(&path);
        let Rect { x, y, width, height } = m.layout;
        let children: Vec<&Module> = child_modules(source, Some(&m.id)).collect();
        // A module with content is as large as in its project (unless resized here), its content too.
        let size = was.and_then(|w| w.size).or(if top && children.is_empty() {
            None
        } else {
            Some(Size { width, height })
        });
        let kept = if !top {
            was.filter(|w| !alone.contains(&w.id)).map(|w| w.position)
        } else {
            None
        };
        let attributes = members_of(
            &m.attributes,
            was.and_then(|w| w.attributes.as_deref()).unwrap_or(&[]),
        );
        let methods = members_of(&m.methods, was.and_then(|w| w.methods.as_deref()).unwrap_or(&[]));
        let mut placed = ImportedModule {
            id: was.map_or_else(|| format!("{IMPORTED_PREFIX}{}", new_id()), |w| w.id.clone()),
            path,
            position: position.unwrap_or_else(|| kept.unwrap_or(Point { x, y })),
            size,
            locked: was.is_some_and(|w| w.locked),
            r#final: m.r#final,
            attributes: (!attributes.is_empty()).then_some(attributes),
            methods: (!methods.is_empty()).then_some(methods),
            ports: ports_of(source, m, was.map_or(&[], |w| &w.ports)),
        };
        rebind_members(&mut placed, id_of);
        out.push(placed);
        for c in children {
            visit(source, c, None, previous, alone, id_of, out);
        }
    }
    let mut out = Vec::new();
    visit(source, root, Some(position), previous, alone, id_of, &mut out);
    out
}

/// Maps the id of an entity of a project (or of a module used as a type) to a name, if it has one.
type Namer = Rc<dyn Fn(&str) -> Option<String>>;

/// Keys of the modules used as types (see `is_module_ref`), the same in every project: the file of
/// their project (`file`: that of `p`, relative to the project changed) and their path.
fn module_keyer(p: &Project, file: &str) -> impl Fn(&str) -> Option<String> + use<> {
    let paths = module_paths(&p.modules, &[]);
    let files: HashMap<Id, String> = p
        .dependencies
        .iter()
        .map(|x| (x.id.clone(), normalize_file(&resolve_relative(file, &x.file))))
        .collect();
    let own_file = normalize_file(file);
    move |id: &str| {
        if let Some(own) = paths.get(id) {
            return Some(format!("{own_file}|module:{own}"));
        }
        let (dep, path) = parse_dependency_module_ref(id)?;
        let dep = files.get(dep)?;
        Some(format!("{dep}|module:{path}"))
    }
}

/// Content of entities without ids, references by name: equal for the same definition in two
/// projects.
type ModuleKey = Box<dyn Fn(&str) -> Option<String>>;

struct Shaper {
    names: HashMap<Id, String>,
    module_key: ModuleKey,
}

/// `shape` of entities of `p` (`file`: that of `p`, see `module_keyer`).
fn shaper(p: &Project, file: &str) -> Shaper {
    let key = Keyer::new(p);
    Shaper {
        names: entities(p)
            .iter()
            .map(|e| (e.id().to_string(), key.key(*e)))
            .collect(),
        module_key: Box::new(module_keyer(p, file)),
    }
}

impl Shaper {
    fn shape(&self, e: EntityRef) -> String {
        let value = match e {
            EntityRef::Type(t) => serde_json::to_value(t),
            EntityRef::Interface(i) => serde_json::to_value(i),
            EntityRef::Const(c) => serde_json::to_value(c),
        }
        .unwrap_or(Value::Null);
        let value = self.replace("", value).unwrap_or(Value::Null);
        serde_json::to_string(&value).unwrap_or_default()
    }

    /// The value of `key` as the shape holds it: None to leave it out.
    fn replace(&self, key: &str, value: Value) -> Option<Value> {
        if matches!(key, "id" | "dependency" | "module" | "modulePath") {
            return None;
        }
        let value = match value {
            Value::Array(ids) if key == "raises" => Value::Array(
                ids.iter()
                    .map(|id| {
                        let name = id
                            .as_str()
                            .and_then(|id| self.names.get(id))
                            .map_or("", String::as_str);
                        Value::String(name.to_string())
                    })
                    .collect(),
            ),
            Value::Object(o)
                if o.get("kind").and_then(Value::as_str) == Some("ref")
                    && o.get("id").is_some_and(Value::is_string) =>
            {
                let id = o["id"].as_str().unwrap_or_default();
                let name = self
                    .names
                    .get(id)
                    .cloned()
                    .or_else(|| (self.module_key)(id))
                    .unwrap_or_default();
                let mut r = serde_json::Map::new();
                r.insert("kind".into(), "ref".into());
                r.insert("name".into(), name.into());
                Value::Object(r)
            }
            v => v,
        };
        Some(match value {
            Value::Object(o) => Value::Object(
                o.into_iter()
                    .filter_map(|(k, x)| self.replace(&k, x).map(|x| (k, x)))
                    .collect(),
            ),
            Value::Array(a) => Value::Array(
                a.into_iter()
                    .map(|x| self.replace("", x).unwrap_or(Value::Null))
                    .collect(),
            ),
            v => v,
        })
    }
}

/// `t` referencing the types `id_of` maps the ids of.
fn ref_of(t: &TypeRef, id_of: &dyn Fn(&str) -> Id) -> TypeRef {
    map_ref(t, |r| IdRef { id: id_of(&r.id) })
}

fn rebind_type(t: &mut TypeRef, id_of: &dyn Fn(&str) -> Id) {
    *t = ref_of(t, id_of);
}

fn rebind_returns(returns: &mut Option<TypeRef>, raises: &mut Option<Vec<Id>>, id_of: &dyn Fn(&str) -> Id) {
    if let Some(r) = returns {
        rebind_type(r, id_of);
    }
    if let Some(r) = raises {
        for id in r {
            *id = id_of(id);
        }
    }
}

fn rebind_message(m: &mut Message, id_of: &dyn Fn(&str) -> Id) {
    for prm in &mut m.params {
        rebind_type(&mut prm.ty, id_of);
    }
    rebind_returns(&mut m.returns, &mut m.raises, id_of);
}

fn rebind_method(m: &mut Method, id_of: &dyn Fn(&str) -> Id) {
    for prm in &mut m.params {
        rebind_type(&mut prm.param.ty, id_of);
    }
    rebind_returns(&mut m.returns, &mut m.raises, id_of);
}

/// Make the attributes and methods of a placed module reference the types `id_of` maps the ids of.
fn rebind_members(m: &mut ImportedModule, id_of: &dyn Fn(&str) -> Id) {
    for a in m.attributes.iter_mut().flatten() {
        rebind_type(&mut a.field.ty, id_of);
    }
    for x in m.methods.iter_mut().flatten() {
        rebind_method(x, id_of);
    }
}

fn rebind(d: &mut Project, kind: Kind, id: &str, id_of: &dyn Fn(&str) -> Id) {
    match kind {
        Kind::Interfaces => {
            if let Some(i) = d.interfaces.iter_mut().find(|e| e.id == id) {
                for m in &mut i.messages {
                    rebind_message(m, id_of);
                }
            }
        }
        Kind::Consts => {
            if let Some(c) = d.consts.iter_mut().find(|e| e.id == id) {
                rebind_type(&mut c.ty, id_of);
            }
        }
        Kind::Types => {
            let Some(t) = d.types.iter_mut().find(|e| e.id == id) else {
                return;
            };
            match &mut t.body {
                TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => {
                    for f in fields {
                        rebind_type(&mut f.ty, id_of);
                    }
                }
                TypeBody::Union { discriminator, cases } => {
                    rebind_type(discriminator, id_of);
                    for c in cases {
                        rebind_type(&mut c.ty, id_of);
                    }
                }
                TypeBody::Alias { ty } => rebind_type(ty, id_of),
                _ => {}
            }
        }
    }
}

/// Names binding the references of the entities of `source` (saved as `file`) once copied: their
/// names, a type of a module by the file of its project and its `Path.Name`, a module used as a
/// type by its key (see `module_keyer`).
fn ref_names(source: &Project, file: &str) -> Namer {
    let paths = module_paths(&source.modules, &source.dependencies);
    let files: HashMap<&str, String> = source
        .dependencies
        .iter()
        .map(|x| (x.id.as_str(), normalize_file(&resolve_relative(file, &x.file))))
        .collect();
    let own_file = normalize_file(file);
    let names: HashMap<Id, String> = entities(source)
        .into_iter()
        .map(|e| {
            let name = match e {
                EntityRef::Type(t) if e.scoped() => match &t.module {
                    Some(m) => format!(
                        "{own_file}|{}.{}",
                        paths.get(m).map_or("undefined", String::as_str),
                        t.name
                    ),
                    None => format!(
                        "{}|{}.{}",
                        t.dependency
                            .as_deref()
                            .and_then(|d| files.get(d))
                            .map_or("undefined", String::as_str),
                        t.module_path.as_deref().unwrap_or("undefined"),
                        t.name
                    ),
                },
                _ => e.name().to_string(),
            };
            (e.id().to_string(), name)
        })
        .collect();
    let module_key = module_keyer(source, file);
    Rc::new(move |id: &str| names.get(id).cloned().or_else(|| module_key(id)))
}

/// Binding of the references of entities copied into a project: the id there of each entity named
/// by a namer (see `ref_names`), the module of a dependency there, a new one (dangling) for those
/// not there.
struct Binder {
    ids: HashMap<String, Id>,
    by_file: HashMap<String, Id>,
}

fn binder(d: &Project) -> Binder {
    let files: HashMap<&str, String> = d
        .dependencies
        .iter()
        .map(|x| (x.id.as_str(), normalize_file(&x.file)))
        .collect();
    let by_file = files
        .iter()
        .map(|(id, file)| (file.clone(), id.to_string()))
        .collect();
    let ids = entities(d)
        .into_iter()
        .filter_map(|e| match e {
            EntityRef::Type(t) if e.scoped() => {
                t.module_path.as_deref().filter(|p| !p.is_empty()).map(|mp| {
                    let file = t
                        .dependency
                        .as_deref()
                        .and_then(|x| files.get(x))
                        .map_or("undefined", String::as_str);
                    (format!("{file}|{mp}.{}", t.name), t.id.clone())
                })
            }
            _ => Some((e.name().to_string(), e.id().to_string())),
        })
        .collect();
    Binder { ids, by_file }
}

impl Binder {
    fn bind(&self, names: &dyn Fn(&str) -> Option<String>, id: &str) -> Id {
        let name = names(id).unwrap_or_default();
        if let Some(known) = self.ids.get(&name).filter(|k| !k.is_empty()) {
            return known.clone();
        }
        let dep = name
            .find("|module:")
            .and_then(|at| self.by_file.get(&name[..at]).map(|d| (d, at)));
        match dep {
            Some((dep, at)) if !dep.is_empty() => dependency_module_ref(dep, &name[at + "|module:".len()..]),
            _ => new_id(),
        }
    }
}

/// Whether something outside `inside` (ids) uses a type or interface (nothing refers to constants).
fn used_outside(p: &Project, e: EntityRef, inside: &HashSet<Id>) -> bool {
    match e {
        EntityRef::Const(_) => false,
        EntityRef::Interface(i) => {
            p.modules.iter().any(|m| {
                m.ports
                    .iter()
                    .any(|pt| pt.interface_id.as_deref() == Some(i.id.as_str()))
            }) || p.dependencies.iter().any(|x| {
                x.modules.iter().any(|m| {
                    m.ports
                        .iter()
                        .any(|pt| pt.interface.as_deref() == Some(i.name.as_str()))
                })
            })
        }
        EntityRef::Type(t) => type_usage_targets(p, &t.id)
            .iter()
            .any(|(_, u)| !inside.contains(&u.id)),
    }
}

/// Hand the entities of `list` (ids, of dependency `dep`) that another dependency defines the same
/// way (its `shared`) over to that one. Returns the entities left to `dep`.
fn hand_over(d: &mut Project, dep: &str, list: Vec<Id>) -> Vec<Id> {
    list.into_iter()
        .filter(|id| {
            let Some(e) = find_entity(d, id) else {
                return true;
            };
            let name = e.name().to_string();
            let other = if e.scoped() {
                None
            } else {
                d.dependencies
                    .iter()
                    .position(|x| x.id != dep && x.shared.contains(&name))
            };
            let Some(other) = other else {
                return true;
            };
            let other_id = d.dependencies[other].id.clone();
            set_entity_dependency(d, id, Some(other_id));
            d.dependencies[other].shared.retain(|n| *n != name);
            false
        })
        .collect()
}

/// Result of a change of dependencies.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DependencyResult {
    /// Entities not taken because this project or another dependency defines the name differently.
    pub conflicts: Vec<String>,
    /// Entities no longer in their dependency but still used here: kept as own ones.
    pub detached: Vec<String>,
    /// Renames detected and applied.
    pub renamed: Vec<String>,
    /// Placed modules no longer found in their project (left as they are).
    pub missing: Vec<String>,
}

fn leaf(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or(path)
}

fn signature<'a>(ports: impl Iterator<Item = (PortRole, &'a str)>) -> String {
    let mut v: Vec<String> = ports
        .map(|(role, name)| format!("{}:{name}", role.as_str()))
        .collect();
    v.sort();
    v.join(",")
}

/// A copied entity, to bind once every entity is in place.
struct Copied {
    kind: Kind,
    id: Id,
    /// Names of the entities of the project it comes from.
    names: Namer,
}

/// One change of dependencies: copies are bound by name once every entity is in place.
struct Sync<'a> {
    d: &'a mut Project,
    /// This project's own file name, to refuse depending on itself.
    own: Option<&'a str>,
    result: DependencyResult,
    /// Copied entities.
    copied: Vec<Copied>,
    /// Entities left by their dependency, removed at the end unless still used.
    removed: Vec<(Kind, Id)>,
    /// Dependencies brought up to date: snapshots do not overwrite them.
    fresh: HashSet<Id>,
}

impl<'a> Sync<'a> {
    fn new(d: &'a mut Project, own: Option<&'a str>) -> Self {
        Sync {
            d,
            own,
            result: DependencyResult::default(),
            copied: Vec::new(),
            removed: Vec::new(),
            fresh: HashSet::new(),
        }
    }

    fn dep(&self, id: &str) -> &Dependency {
        self.d
            .dependencies
            .iter()
            .find(|x| x.id == id)
            .expect("dependency")
    }

    fn dep_mut(&mut self, id: &str) -> &mut Dependency {
        self.d
            .dependencies
            .iter_mut()
            .find(|x| x.id == id)
            .expect("dependency")
    }

    /// Dependency on `file` (its id), added (indirect) when missing; None when it is this project.
    fn dependency_for(&mut self, file: &str, name: &str) -> Option<Id> {
        if self
            .own
            .is_some_and(|own| normalize_file(file) == normalize_file(own))
        {
            self.result
                .conflicts
                .push(format!("{file}: uses this project (cycle)"));
            return None;
        }
        if let Some(dep) = dependency_at(self.d, file) {
            return Some(dep.id.clone());
        }
        let name = unique_name(
            &dependency_name(name),
            self.d.dependencies.iter().map(|x| x.name.as_str()),
        );
        let dep = Dependency {
            id: new_id(),
            name,
            file: file.to_string(),
            uses: Vec::new(),
            indirect: true,
            shared: Vec::new(),
            modules: Vec::new(),
        };
        let id = dep.id.clone();
        self.d.dependencies.push(dep);
        Some(id)
    }

    /// Make the entities of `dep` those of `source` (saved as `file`) owned by `owner` (its own ones
    /// when None). Types of modules come with the path of their module.
    fn entities(&mut self, dep: &str, source: &Project, owner: Option<&str>, file: &str) {
        let dep_name = self.dep(dep).name.clone();
        let names = ref_names(source, file);
        let source_key = Keyer::new(source);
        let source_shape = shaper(source, file);
        let paths = module_paths(&source.modules, &source.dependencies);
        let mut shared: Vec<String> = Vec::new();
        // Entities here of other origins by name (types of modules aside), in order.
        let mut others: HashMap<String, VecDeque<Id>> = HashMap::new();
        for x in entities(self.d) {
            if !x.scoped() && x.dependency() != Some(dep) {
                others
                    .entry(x.name().to_string())
                    .or_default()
                    .push_back(x.id().to_string());
            }
        }
        for kind in KINDS {
            let here = shaper(self.d, "");
            let here_key = Keyer::new(self.d);
            let current: Vec<Entity> = entities_of(self.d, kind)
                .into_iter()
                .filter(|e| e.dependency() == Some(dep))
                .map(EntityRef::to_entity)
                .collect();
            let next: Vec<EntityRef> = entities_of(source, kind)
                .into_iter()
                .filter(|e| e.dependency() == owner)
                .collect();
            let current_keys: Vec<String> = current.iter().map(|e| here_key.key(e.as_ref())).collect();
            let next_keys: Vec<String> = next.iter().map(|e| source_key.key(*e)).collect();
            let was = pair(&current_keys, &next_keys);
            let mut kept: HashSet<Id> = HashSet::new();
            for (i, e) in next.iter().enumerate() {
                let taken = if e.scoped() {
                    None
                } else {
                    others.get(e.name()).and_then(|l| l.front()).cloned()
                };
                let target = was[i].map(|j| &current[j]);
                if let Some(taken) = taken {
                    let (alike, taken_dependency) = {
                        let t = find_entity(self.d, &taken).expect("entity");
                        (
                            target.is_none()
                                && t.kind() == e.kind()
                                && here.shape(t) == source_shape.shape(*e),
                            t.dependency().map(str::to_string),
                        )
                    };
                    // An own entity with the same definition becomes the dependency's; one of another
                    // dependency stays that one's, shared.
                    if alike && taken_dependency.is_none() {
                        set_entity_dependency(self.d, &taken, Some(dep.to_string()));
                        if let Some(l) = others.get_mut(e.name()) {
                            l.pop_front();
                        }
                    } else if alike {
                        shared.push(e.name().to_string());
                    } else {
                        self.result.conflicts.push(format!(
                            "{dep_name}: {} is already defined differently here",
                            e.name()
                        ));
                    }
                    continue;
                }
                if let Some(t) = target {
                    let t = t.as_ref();
                    kept.insert(t.id().to_string());
                    // A type of a module in a renamed module is not renamed itself.
                    if t.name() != e.name() {
                        self.result
                            .renamed
                            .push(format!("{} → {}", here_key.key(t), source_key.key(*e)));
                    } else if here_key.key(t) == source_key.key(*e) && here.shape(t) == source_shape.shape(*e)
                    {
                        continue;
                    }
                }
                let mut copy = e.to_entity();
                copy.set_id(target.map_or_else(new_id, |t| t.as_ref().id().to_string()));
                copy.set_dependency(Some(dep.to_string()));
                if let Entity::Type(t) = &mut copy {
                    if let Some(m) = t.module.take() {
                        t.module_path = paths.get(&m).cloned();
                    }
                }
                self.copied.push(Copied {
                    kind,
                    id: copy.as_ref().id().to_string(),
                    names: names.clone(),
                });
                put(self.d, copy);
            }
            self.removed.extend(
                current
                    .iter()
                    .filter(|e| !kept.contains(e.as_ref().id()))
                    .map(|e| (kind, e.as_ref().id().to_string())),
            );
        }
        let dep = self.dep_mut(dep);
        if !same(&dep.shared, &shared) {
            dep.shared = shared;
        }
    }

    /// Bring the dependencies `source` uses (its file: `file`) here, and set `dep.uses`. Those not
    /// brought up to date from their own file take the snapshot of `source`.
    fn nested(&mut self, dep: &str, source: &Project, file: &str) {
        let mut targets: HashMap<&str, Id> = HashMap::new();
        for n in &source.dependencies {
            if let Some(target) = self.dependency_for(&resolve_relative(file, &n.file), &n.name) {
                targets.insert(&n.id, target);
            }
        }
        let names_of = |this: &Self, uses: &[String]| -> Vec<String> {
            uses.iter()
                .filter_map(|u| {
                    let used = source.dependencies.iter().find(|x| x.name == *u)?;
                    let t = targets.get(used.id.as_str())?;
                    Some(this.dep(t).name.clone())
                })
                .collect()
        };
        for n in &source.dependencies {
            let Some(target) = targets.get(n.id.as_str()) else {
                continue;
            };
            if self.fresh.contains(target) {
                continue;
            }
            self.fresh.insert(target.clone());
            self.entities(target, source, Some(&n.id), file);
            let uses = names_of(self, &n.uses);
            let t = self.dep_mut(target);
            if !same(&t.uses, &uses) {
                t.uses = uses;
            }
        }
        let uses: Vec<String> = source
            .dependencies
            .iter()
            .filter(|n| !n.indirect)
            .filter_map(|n| targets.get(n.id.as_str()).map(|t| self.dep(t).name.clone()))
            .collect();
        let dep = self.dep_mut(dep);
        if !same(&dep.uses, &uses) {
            dep.uses = uses;
        }
    }

    /// Dependency `n` of `source` (saved as `file`) here (its id), from the snapshot `source` has of
    /// it, with the dependencies it uses. One already here is kept as it is.
    fn snapshot(&mut self, source: &Project, file: &str, n: &Dependency) -> Option<Id> {
        let nested_file = resolve_relative(file, &n.file);
        if let Some(known) = dependency_at(self.d, &nested_file) {
            return Some(known.id.clone());
        }
        let dep = self.dependency_for(&nested_file, &n.name)?;
        self.fresh.insert(dep.clone());
        self.entities(&dep, source, Some(&n.id), file);
        let uses: Vec<String> = n
            .uses
            .iter()
            .filter_map(|u| {
                let used = source.dependencies.iter().find(|x| x.name == *u)?;
                let t = self.snapshot(source, file, used)?;
                Some(self.dep(&t).name.clone())
            })
            .collect();
        self.dep_mut(&dep).uses = uses;
        Some(dep)
    }

    /// Read the modules of `dep` placed here again from its project: their content (added, removed,
    /// at its place) and ports. Ports are matched by name: links to removed ports and modules are
    /// dropped. A module not found by path (renamed or moved while this project was closed) is the only
    /// one not yet placed with the same name, else with the same ports.
    fn modules(&mut self, dep: &str, source: &Project) {
        let before = self.dep(dep).clone();
        if before.modules.is_empty() {
            return;
        }
        let by_path = modules_by_path(source);
        // Parents and canvas positions, before paths change.
        let has_parent: HashMap<&str, bool> = before
            .modules
            .iter()
            .map(|m| (m.id.as_str(), imported_parent(&before, m).is_some()))
            .collect();
        let absolute: HashMap<&str, Point> = before
            .modules
            .iter()
            .map(|m| {
                let Point { mut x, mut y } = m.position;
                let mut up = imported_parent(&before, m);
                while let Some(u) = up {
                    x += u.position.x;
                    y += u.position.y;
                    up = imported_parent(&before, u);
                }
                (m.id.as_str(), Point { x, y })
            })
            .collect();
        let mut mods = before.modules.clone();
        let mut taken: HashSet<String> = mods.iter().map(|m| m.path.clone()).collect();
        let mut moved: IndexMap<String, String> = IndexMap::new();
        let find = |taken: &HashSet<String>, path: &str, ports: &[ImportedPort]| -> Option<String> {
            let free: Vec<(&String, &&Module)> =
                by_path.iter().filter(|(p, _)| !taken.contains(*p)).collect();
            let same_leaf: Vec<_> = free.iter().filter(|(p, _)| leaf(p) == leaf(path)).collect();
            if same_leaf.len() == 1 {
                return Some(same_leaf[0].0.clone());
            }
            let alike: Vec<_> = if ports.is_empty() {
                Vec::new()
            } else {
                let want = signature(ports.iter().map(|pt| (pt.role, pt.name.as_str())));
                free.iter()
                    .filter(|(_, m)| signature(m.ports.iter().map(|pt| (pt.role, pt.name.as_str()))) == want)
                    .collect()
            };
            (alike.len() == 1).then(|| alike[0].0.clone())
        };
        for im in &mut mods {
            if by_path.contains_key(&im.path) {
                continue;
            }
            let Some(found) = find(&taken, &im.path, &im.ports) else {
                self.result.missing.push(format!(
                    "{}: module '{}' no longer exists in {}",
                    before.name, im.path, before.file
                ));
                continue;
            };
            self.result.renamed.push(format!("module {} → {found}", im.path));
            taken.insert(found.clone());
            moved.insert(im.path.clone(), found.clone());
            im.path = found;
        }
        follow_module_renames(self.d, dep, &moved);
        // Placed modules come with their content: a module placed alone (before modules were placed
        // whole) is placed with its top-level module, at its place.
        let previous: HashMap<String, ImportedModule> =
            mods.iter().map(|m| (m.path.clone(), m.clone())).collect();
        let mut roots: IndexMap<String, (&Module, Point)> = IndexMap::new();
        for im in &mods {
            let Some(m) = by_path.get(&im.path) else {
                continue;
            };
            let root = root_of(source, m);
            let path = module_path(source, &root.id);
            if !roots.contains_key(&path) {
                let id = previous.get(&path).unwrap_or(im).id.clone();
                // Ids of modules renamed above are those of before.
                let at = absolute.get(id.as_str()).copied().unwrap_or_default();
                roots.insert(path, (root, at));
            }
        }
        let alone: HashSet<Id> = mods
            .iter()
            .filter(|m| !has_parent.get(m.id.as_str()).copied().unwrap_or(false))
            .map(|m| m.id.clone())
            .collect();
        let names = ref_names(source, &before.file);
        let bound = binder(self.d);
        let id_of = |id: &str| bound.bind(&*names, id);
        let mut placed: Vec<ImportedModule> = roots
            .values()
            .flat_map(|(root, at)| placed_tree(source, root, *at, &previous, &alone, &id_of))
            .collect();
        // Modules no longer found stay as they were, but in the content of a module placed here.
        placed.extend(
            mods.iter()
                .filter(|m| {
                    !by_path.contains_key(&m.path)
                        && !roots.keys().any(|r| m.path.starts_with(&format!("{r}.")))
                })
                .cloned(),
        );
        let placed_ids: HashSet<&str> = placed.iter().map(|m| m.id.as_str()).collect();
        let dropped: HashSet<Id> = mods
            .iter()
            .filter(|m| !placed_ids.contains(m.id.as_str()))
            .map(|m| m.id.clone())
            .collect();
        let ports: HashSet<Id> = placed
            .iter()
            .flat_map(|m| m.ports.iter().map(|pt| pt.id.clone()))
            .collect();
        let ids: HashSet<Id> = placed.iter().map(|m| m.id.clone()).collect();
        if self.dep(dep).modules != placed {
            self.dep_mut(dep).modules = placed;
        }
        if !dropped.is_empty() {
            drop_placed_refs(self.d, &dropped);
        }
        self.d.links.retain(|l| {
            (!ids.contains(&l.from.module_id) || ports.contains(&l.from.port_id))
                && (!ids.contains(&l.to.module_id) || ports.contains(&l.to.port_id))
        });
    }

    /// Bring the entities of `dep` up to date from its project `source`; its placed modules next
    /// (`modules`), once the entities of the dependencies `source` uses are here too.
    fn take(&mut self, dep: &str, source: &Project) {
        self.fresh.insert(dep.to_string());
        let file = self.dep(dep).file.clone();
        self.entities(dep, source, None, &file);
    }

    fn finish(mut self) -> DependencyResult {
        let bound = binder(self.d);
        for c in &self.copied {
            rebind(self.d, c.kind, &c.id, &|id| bound.bind(&*c.names, id));
        }
        let mut gone: HashSet<Id> = HashSet::new();
        for (_, id) in std::mem::take(&mut self.removed) {
            let Some(e) = find_entity(self.d, &id) else {
                continue;
            };
            let dependency = e.dependency().map(str::to_string);
            let name = e.name().to_string();
            if let Some(dep) = dependency
                .as_deref()
                .filter(|dep| self.d.dependencies.iter().any(|x| x.id == *dep))
            {
                if hand_over(self.d, dep, vec![id.clone()]).is_empty() {
                    continue;
                }
            }
            let inside: HashSet<Id> = dependency_entities(self.d, dependency.as_deref())
                .iter()
                .map(|x| x.id().to_string())
                .collect();
            let e = find_entity(self.d, &id).expect("entity");
            if used_outside(self.d, e, &inside) {
                set_entity_dependency(self.d, &id, None);
                self.result.detached.push(name);
            } else {
                gone.insert(id);
            }
        }
        if !gone.is_empty() {
            remove_entities(self.d, &gone);
        }
        prune(self.d);
        self.result
    }
}

/// Places using a module of dependency `dep` as a type, outside its entities unless `all`.
fn module_ref_users(d: &Project, dep: &str, all: bool) -> Vec<String> {
    let owners: HashMap<&str, Option<&str>> = entities(d)
        .into_iter()
        .map(|e| (e.id(), e.dependency()))
        .collect();
    let mut out = Vec::new();
    for u in all_type_refs(d) {
        if !all
            && u.owner.kind != crate::project::UsageKind::Module
            && owners.get(u.owner.id.as_str()) == Some(&Some(dep))
        {
            continue;
        }
        let mut used = false;
        walk_type_ref(&u.ty, &mut |n| {
            if let TypeRefOf::Ref { target, .. } = n {
                if parse_dependency_module_ref(&target.id).is_some_and(|(x, _)| x == dep) {
                    used = true;
                }
            }
        });
        if used {
            out.push(u.r#where);
        }
    }
    out
}

/// Whether this project uses a dependency itself: its types, interfaces or modules, or its placed modules.
fn used_here(d: &Project, dep: &Dependency) -> bool {
    if !dep.modules.is_empty() || !module_ref_users(d, &dep.id, false).is_empty() {
        return true;
    }
    let own = dependency_entities(d, Some(&dep.id));
    let inside: HashSet<Id> = own.iter().map(|e| e.id().to_string()).collect();
    own.iter().any(|e| used_outside(d, *e, &inside))
}

/// Dependencies used by no other one: indirect ones this project uses become direct, the others go
/// away with their entities.
fn prune(d: &mut Project) {
    loop {
        let unused = d
            .dependencies
            .iter()
            .position(|x| x.indirect && !d.dependencies.iter().any(|o| o.uses.contains(&x.name)));
        let Some(unused) = unused else {
            return;
        };
        if used_here(d, &d.dependencies[unused]) {
            d.dependencies[unused].indirect = false;
        } else {
            let id = d.dependencies[unused].id.clone();
            remove_with_entities(d, &id);
        }
    }
}

fn remove_with_entities(d: &mut Project, dep: &str) {
    let own: Vec<Id> = dependency_entities(d, Some(dep))
        .iter()
        .map(|e| e.id().to_string())
        .collect();
    let left: HashSet<Id> = hand_over(d, dep, own).into_iter().collect();
    d.dependencies.retain(|x| x.id != dep);
    remove_entities(d, &left);
}

/// Depend on `source` (saved as `file`, relative to this project): its own types and interfaces,
/// and those of the dependencies it uses. `own`: this project's file name, if saved. Adding a
/// dependency already there refreshes it.
pub fn add_dependency(d: &mut Project, source: &Project, file: &str, own: Option<&str>) -> DependencyResult {
    add_dependencies(
        d,
        &[DependencySource {
            project: source,
            file: file.to_string(),
            indirect: false,
        }],
        own,
    )
}

/// A project read from its file (relative to the project depending on it).
pub struct DependencySource<'a> {
    pub project: &'a Project,
    pub file: String,
    /// Read for the dependencies it uses: depended on only through them (unless it already is).
    pub indirect: bool,
}

/// Depend on several projects at once (see `add_dependency`). The dependencies they use come from
/// `sources` when there, from their snapshot in the projects using them otherwise.
pub fn add_dependencies(
    d: &mut Project,
    sources: &[DependencySource],
    own: Option<&str>,
) -> DependencyResult {
    let mut sync = Sync::new(d, own);
    let mut taken: Vec<(Id, &Project)> = Vec::new();
    for s in sources {
        let Some(dep) = sync.dependency_for(&s.file, &s.project.name) else {
            continue;
        };
        if !s.indirect {
            sync.dep_mut(&dep).indirect = false;
        }
        sync.take(&dep, s.project);
        taken.push((dep, s.project));
    }
    for (dep, source) in &taken {
        let file = sync.dep(dep).file.clone();
        sync.nested(dep, source, &file);
    }
    for (dep, source) in &taken {
        sync.modules(dep, source);
    }
    sync.finish()
}

/// Depend here on the dependency `dependency_id` of `source` (saved as `file`), as `source` last read
/// it: for content copied from `source` that uses its types and interfaces.
pub fn add_dependency_of(
    d: &mut Project,
    source: &Project,
    file: &str,
    dependency_id: &str,
) -> DependencyResult {
    let mut sync = Sync::new(d, None);
    let dep = source
        .dependencies
        .iter()
        .find(|x| x.id == dependency_id)
        .and_then(|n| sync.snapshot(source, file, n));
    if let Some(dep) = dep {
        sync.dep_mut(&dep).indirect = false;
    }
    sync.finish()
}

/// Outcome of `place_module`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlacedModule {
    /// The placed module, None when it was not placed.
    pub id: Option<Id>,
    pub result: DependencyResult,
}

/// Place a module of `source` (saved as `file`) on the canvas of `d`, at an absolute position,
/// depending on `source` (refreshed when already there). Returns the placed module id (the one
/// already there for that module), or None when the module does not exist in `source` or `source`
/// is this project.
pub fn place_module(
    d: &mut Project,
    source: &Project,
    file: &str,
    module_id: &str,
    position: Point,
    own: Option<&str>,
) -> PlacedModule {
    let Some(m) = find_module(source, module_id) else {
        return PlacedModule {
            id: None,
            result: DependencyResult::default(),
        };
    };
    let result = add_dependency(d, source, file, own);
    let Some(di) = dependency_index(d, file) else {
        return PlacedModule { id: None, result };
    };
    // Top-level modules only, with their content.
    let root = root_of(source, m);
    let path = module_path(source, &root.id);
    if let Some(existing) = d.dependencies[di].modules.iter().find(|x| x.path == path) {
        return PlacedModule {
            id: Some(existing.id.clone()),
            result,
        };
    }
    let prefix = format!("{path}.");
    // Content placed alone before: its place in the module comes from its project.
    let alone: Vec<ImportedModule> = d.dependencies[di]
        .modules
        .iter()
        .filter(|x| x.path.starts_with(&prefix))
        .cloned()
        .collect();
    let names = ref_names(source, file);
    let bound = binder(d);
    let placed = placed_tree(
        source,
        root,
        // `Math.round`: halves go up.
        Point {
            x: (position.x + 0.5).floor(),
            y: (position.y + 0.5).floor(),
        },
        &alone.iter().map(|x| (x.path.clone(), x.clone())).collect(),
        &alone.iter().map(|x| x.id.clone()).collect(),
        &|id| bound.bind(&*names, id),
    );
    let id = placed.first().map(|m| m.id.clone());
    let dep = &mut d.dependencies[di];
    dep.modules.retain(|x| !x.path.starts_with(&prefix));
    dep.modules.extend(placed);
    PlacedModule { id, result }
}

/// Read dependencies again from their projects (by dependency id).
pub fn refresh_dependencies(
    d: &mut Project,
    sources: &HashMap<Id, Project>,
    own: Option<&str>,
) -> DependencyResult {
    let deps: Vec<(Id, String)> = d
        .dependencies
        .iter()
        .filter(|x| sources.contains_key(&x.id))
        .map(|x| (x.id.clone(), x.file.clone()))
        .collect();
    let mut sync = Sync::new(d, own);
    for (id, _) in &deps {
        sync.take(id, &sources[id]);
    }
    for (id, file) in &deps {
        sync.nested(id, &sources[id], file);
    }
    for (id, _) in &deps {
        sync.modules(id, &sources[id]);
    }
    sync.finish()
}

/// Remove placed modules and their links; their dependencies stay.
pub fn remove_placed(d: &mut Project, ids: &HashSet<Id>) {
    // Top-level ones with their content: content alone stays.
    let mut gone: HashSet<Id> = HashSet::new();
    for x in &mut d.dependencies {
        let roots: Vec<String> = x
            .modules
            .iter()
            .filter(|m| ids.contains(&m.id) && imported_parent(x, m).is_none())
            .map(|m| m.path.clone())
            .collect();
        if roots.is_empty() {
            continue;
        }
        let under = |path: &str| {
            roots
                .iter()
                .any(|r| path == r || path.starts_with(&format!("{r}.")))
        };
        gone.extend(x.modules.iter().filter(|m| under(&m.path)).map(|m| m.id.clone()));
        x.modules.retain(|m| !gone.contains(&m.id));
    }
    if !gone.is_empty() {
        drop_placed_refs(d, &gone);
    }
}

/// Drop the links to removed placed modules, and the bases they were.
fn drop_placed_refs(d: &mut Project, gone: &HashSet<Id>) {
    d.links
        .retain(|l| !gone.contains(&l.from.module_id) && !gone.contains(&l.to.module_id));
    for m in &mut d.modules {
        if m.bases
            .as_ref()
            .is_some_and(|bs| bs.iter().any(|b| gone.contains(b)))
        {
            if let Some(bs) = &mut m.bases {
                bs.retain(|b| !gone.contains(b));
                if bs.is_empty() {
                    m.bases = None;
                }
            }
        }
    }
}

/// Dependencies using a dependency.
fn dependents(d: &Project, dep: &Dependency) -> Vec<String> {
    d.dependencies
        .iter()
        .filter(|x| x.uses.contains(&dep.name))
        .map(|x| format!("dependency {}", x.name))
        .collect()
}

/// What keeps a dependency: the dependencies using it and its modules placed here.
fn holders(d: &Project, dep: &Dependency) -> Vec<String> {
    let mut out = dependents(d, dep);
    out.extend(
        dep.modules
            .iter()
            .filter(|m| imported_parent(dep, m).is_none())
            .map(|m| format!("module {}, placed on the canvas", m.path)),
    );
    out
}

/// Stop depending on a project. Returns why it cannot be removed (another dependency uses it, its
/// modules are placed here, or this project uses its types, interfaces or modules): then nothing changes.
/// `force` removes it unless another dependency uses it: its placed modules go with their links, and
/// the places using its types, interfaces or modules keep their names as missing references.
pub fn remove_dependency(d: &mut Project, dependency_id: &str, force: bool) -> Vec<String> {
    let Some(dep) = d.dependencies.iter().find(|x| x.id == dependency_id).cloned() else {
        return Vec::new();
    };
    // Entities another dependency also defines stay, with that one.
    let own: Vec<(Id, String)> = dependency_entities(d, Some(&dep.id))
        .iter()
        .filter(|e| {
            e.scoped()
                || !d
                    .dependencies
                    .iter()
                    .any(|x| x.shared.contains(&e.name().to_string()))
        })
        .map(|e| (e.id().to_string(), e.name().to_string()))
        .collect();
    if force {
        let users = dependents(d, &dep);
        if !users.is_empty() {
            return users;
        }
        let ref_name = ref_namer(d);
        let names: HashMap<Id, String> = own
            .iter()
            .map(|(id, name)| (id.clone(), ref_name(id).unwrap_or_else(|| name.clone())))
            .collect();
        orphan_refs(d, |id| {
            names.get(id).cloned().or_else(|| {
                if parse_dependency_module_ref(id).is_some_and(|(x, _)| x == dep.id) {
                    ref_name(id)
                } else {
                    None
                }
            })
        });
        remove_placed(d, &dep.modules.iter().map(|m| m.id.clone()).collect());
    } else {
        let mut users = holders(d, &dep);
        let inside: HashSet<Id> = dependency_entities(d, Some(&dep.id))
            .iter()
            .map(|e| e.id().to_string())
            .collect();
        users.extend(
            own.iter()
                .filter(|(id, _)| find_entity(d, id).is_some_and(|e| used_outside(d, e, &inside)))
                .map(|(_, name)| name.clone()),
        );
        users.extend(module_ref_users(d, &dep.id, false));
        if !users.is_empty() {
            return users;
        }
    }
    remove_with_entities(d, &dep.id);
    prune(d);
    Vec::new()
}

/// Make the types and interfaces of a dependency this project's own, and stop depending on it.
/// Returns what keeps it (dependencies using it, modules placed here, places using its modules as
/// types): then nothing changes.
pub fn detach_dependency(d: &mut Project, dependency_id: &str) -> Vec<String> {
    let Some(dep) = d.dependencies.iter().find(|x| x.id == dependency_id).cloned() else {
        return Vec::new();
    };
    // Modules used as types stay in the dependency.
    let mut users = holders(d, &dep);
    users.extend(module_ref_users(d, &dep.id, true));
    if !users.is_empty() {
        return users;
    }
    let own: Vec<Id> = dependency_entities(d, Some(&dep.id))
        .iter()
        .map(|e| e.id().to_string())
        .collect();
    for id in hand_over(d, &dep.id, own) {
        set_entity_dependency(d, &id, None);
    }
    d.dependencies.retain(|x| x.id != dep.id);
    prune(d);
    Vec::new()
}

/// Carry the renames made in the project saved as `file` to a project draft depending on it: paths
/// and port names of its placed modules, names of its types, interfaces and constants, and the
/// interfaces of placed ports.
pub fn apply_dependency_renames(d: &mut Project, file: &str, r: &Renames) {
    for di in 0..d.dependencies.len() {
        if !same_file(&d.dependencies[di].file, file) {
            continue;
        }
        let dep = d.dependencies[di].id.clone();
        for m in &mut d.dependencies[di].modules {
            if let Some(path) = r.modules.get(&m.path) {
                m.path = path.clone();
            }
            if let Some(names) = r.ports.get(&m.path) {
                for pt in &mut m.ports {
                    if let Some(to) = names.get(&pt.name) {
                        pt.name = to.clone();
                    }
                }
            }
        }
        for t in &mut d.types {
            if t.dependency.as_deref() != Some(dep.as_str()) {
                continue;
            }
            let Some(module_path) = &t.module_path else {
                continue;
            };
            let Some(to) = r.module_types.get(&format!("{module_path}.{}", t.name)) else {
                continue;
            };
            let Some(at) = to.rfind('.') else {
                continue;
            };
            t.module_path = Some(to[..at].to_string());
            t.name = to[at + 1..].to_string();
        }
        // Entities by name (types of modules aside), kept current as they are renamed.
        let mut taken: HashMap<String, i64> = HashMap::new();
        for x in entities(d) {
            if !x.scoped() {
                *taken.entry(x.name().to_string()).or_insert(0) += 1;
            }
        }
        let mut rename = |name: &mut String, own: bool, renames: &IndexMap<String, String>| {
            let Some(to) = own.then(|| renames.get(name.as_str())).flatten() else {
                return;
            };
            if taken.get(to).is_some_and(|n| *n != 0) {
                return;
            }
            *taken.entry(name.clone()).or_insert(0) -= 1;
            taken.insert(to.clone(), 1);
            *name = to.clone();
        };
        for e in &mut d.types {
            let own = e.dependency.as_deref() == Some(dep.as_str()) && !e.is_module_type();
            rename(&mut e.name, own, &r.types);
        }
        for e in &mut d.interfaces {
            let own = e.dependency.as_deref() == Some(dep.as_str());
            rename(&mut e.name, own, &r.interfaces);
        }
        for e in &mut d.consts {
            let own = e.dependency.as_deref() == Some(dep.as_str());
            rename(&mut e.name, own, &r.consts);
        }
        follow_module_renames(d, &dep, &r.modules);
    }
    follow_port_interfaces(d, &r.interfaces);
}

/// Make the type references to modules of dependency `dep` follow their renames (old path → new one).
fn follow_module_renames(d: &mut Project, dep: &str, renames: &IndexMap<String, String>) {
    if renames.is_empty() {
        return;
    }
    for_each_type_ref_mut(d, &mut |t| {
        for_each_ref_id_mut(t, &mut |id| {
            let to = parse_dependency_module_ref(id)
                .filter(|(x, _)| *x == dep)
                .and_then(|(_, path)| renames.get(path));
            if let Some(to) = to {
                *id = dependency_module_ref(dep, to);
            }
        })
    });
}

/// Make placed ports follow interface renames: they reference interfaces by name.
pub fn follow_port_interfaces(d: &mut Project, renames: &IndexMap<String, String>) {
    if renames.is_empty() {
        return;
    }
    let names: HashSet<String> = d.interfaces.iter().map(|i| i.name.clone()).collect();
    for dep in &mut d.dependencies {
        for m in &mut dep.modules {
            for pt in &mut m.ports {
                let to = pt
                    .interface
                    .as_ref()
                    .filter(|i| !names.contains(*i))
                    .and_then(|i| renames.get(i));
                if let Some(to) = to {
                    pt.interface = Some(to.clone());
                }
            }
        }
    }
}

/// In a project draft whose own interfaces were renamed (compared with `prev`), make its placed ports follow.
pub fn follow_interface_renames(prev: &Project, d: &mut Project) {
    if !d.dependencies.iter().any(|x| !x.modules.is_empty()) {
        return;
    }
    let mut renames: IndexMap<String, String> = IndexMap::new();
    for i in &d.interfaces {
        if let Some(was) = prev.interfaces.iter().find(|x| x.id == i.id) {
            if was.name != i.name {
                renames.insert(was.name.clone(), i.name.clone());
            }
        }
    }
    follow_port_interfaces(d, &renames);
}
