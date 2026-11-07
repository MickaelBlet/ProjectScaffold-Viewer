//! IDL definitions into project entities: a clip to paste, or a whole project.

use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::{IndexMap, IndexSet};

use super::parser::IdlFile;
use super::{
    IdlComponent, IdlError, IdlPort, base_name, dir_of, last_segment, normalize_files, normalize_path,
    parse_idl,
};
use crate::clipboard::{CLIP_FORMAT, Clip, PasteOptions, PasteParent, paste_clip};
use crate::dependencies::dependency_name;
use crate::edit::blank_module;
use crate::project::{
    Compartments, LAYOUT_PAD, child_modules, content_top, default_size, empty_project, find_module,
    find_module_mut, grow_ancestors, module_roles, new_id, unique_name,
};
use crate::schema::{FileConstant, FileInterface, FileMessage, FileTypeBody, FileTypeDef, FileTypeRef};
use crate::typeexpr::{is_reserved_type_name, map_ref, walk_type_ref};
use crate::types::{
    Attribute, BitmaskFlag, ConstDef, Dependency, EnumValue, Field, Id, IdRef, Interface, Message, Method,
    MethodParam, Module, Param, ParamDirection, Point, Port, Project, Qualifier, Qualifiers, Rect, TypeBody,
    TypeDef, TypeRef, UnionCase, ValueField,
};

fn ref_names(t: &FileTypeRef, into: &mut Vec<String>) {
    walk_type_ref(t, &mut |n| {
        if let crate::types::TypeRefOf::Ref { target, .. } = n {
            into.push(target.name.clone());
        }
    });
}

fn message_names(messages: &[FileMessage], into: &mut Vec<String>) {
    for m in messages {
        for p in &m.params {
            ref_names(&p.ty, into);
        }
        if let Some(r) = &m.returns {
            ref_names(r, into);
        }
    }
}

#[derive(Clone, Copy)]
enum Named<'a> {
    Type(&'a FileTypeDef),
    Interface(&'a FileInterface),
}

fn used_names(e: Named, needs: &[String]) -> Vec<String> {
    let mut names = needs.to_vec();
    match e {
        Named::Interface(i) => message_names(&i.messages, &mut names),
        Named::Type(t) => match &t.body {
            FileTypeBody::Struct { fields, .. } | FileTypeBody::Exception { fields } => {
                for f in fields {
                    ref_names(&f.ty, &mut names);
                }
            }
            FileTypeBody::Union { discriminator, cases } => {
                for t in std::iter::once(discriminator).chain(cases.iter().map(|c| &c.ty)) {
                    ref_names(t, &mut names);
                }
            }
            FileTypeBody::Alias { ty } => ref_names(ty, &mut names),
            _ => {}
        },
    }
    names
}

/// What [`idl_import`] makes of an IDL file.
#[derive(Clone, Debug)]
pub struct IdlImport {
    /// Types, interfaces and modules to paste; None when the project has them all.
    pub clip: Option<Clip>,
    /// Names of the entities already in the project (by name), left as they are.
    pub existing: Vec<String>,
    /// Names used but defined nowhere, added as custom primitives (empty interfaces for ports).
    pub unresolved: Vec<String>,
}

const MODULE_GAP: f64 = 60.;
const MODULES_PER_ROW: usize = 4;

/// The entities of an IDL file to add to `target`: the interfaces and components named in `only`
/// (all when absent) with the types and interfaces they use, or every type when the file has no
/// interfaces nor components; every definition with `whole`. Components become modules. Types and
/// interfaces `target` has by name are used in place of the file's; names defined nowhere become
/// custom primitives.
pub fn idl_import(idl: &IdlFile, target: &Project, only: Option<&[String]>, whole: bool) -> IdlImport {
    let mut by_name: IndexMap<&str, Named> = IndexMap::new();
    for t in &idl.types {
        by_name.insert(&t.name, Named::Type(t));
    }
    for i in &idl.interfaces {
        by_name.insert(&i.name, Named::Interface(i));
    }
    let components: IndexMap<&str, &IdlComponent> =
        idl.components.iter().map(|c| (c.name.as_str(), c)).collect();
    let mut have: HashMap<&str, &Id> = HashMap::new();
    for e in target
        .types
        .iter()
        .map(|t| (&t.name, &t.id))
        .chain(target.interfaces.iter().map(|i| (&i.name, &i.id)))
    {
        have.insert(e.0, e.1);
    }
    let with_behavior = idl.interfaces.len() + idl.components.len() > 0;
    let mut queue: VecDeque<String> = match only {
        Some(only) => only
            .iter()
            .filter(|n| !components.contains_key(n.as_str()) || by_name.contains_key(n.as_str()))
            .cloned()
            .collect(),
        None if whole => by_name.keys().map(|k| k.to_string()).collect(),
        None if with_behavior => idl.interfaces.iter().map(|i| i.name.clone()).collect(),
        None => idl.types.iter().map(|t| t.name.clone()).collect(),
    };
    let mut component_queue: VecDeque<String> = match only {
        Some(only) => only
            .iter()
            .filter(|n| components.contains_key(n.as_str()))
            .cloned()
            .collect(),
        None if with_behavior => components.keys().map(|k| k.to_string()).collect(),
        None => VecDeque::new(),
    };

    // Components reached from the roots, through their bases.
    let mut picked_components: IndexSet<String> = IndexSet::new();
    while let Some(name) = component_queue.pop_front() {
        if !picked_components.insert(name.clone()) {
            continue;
        }
        let Some(c) = components.get(name.as_str()) else {
            continue;
        };
        component_queue.extend(
            c.bases
                .iter()
                .filter(|b| components.contains_key(b.as_str()))
                .cloned(),
        );
        let mut refs = Vec::new();
        for a in &c.attributes {
            ref_names(&a.ty, &mut refs);
        }
        message_names(&c.methods, &mut refs);
        refs.extend(c.needs.iter().cloned());
        queue.extend(refs);
    }
    // The whole file: its constants too, with their types.
    let target_names: HashSet<&str> = target
        .types
        .iter()
        .map(|e| e.name.as_str())
        .chain(target.interfaces.iter().map(|e| e.name.as_str()))
        .chain(target.consts.iter().map(|e| e.name.as_str()))
        .collect();
    let constants: Vec<&FileConstant> = if only.is_some() {
        Vec::new()
    } else {
        idl.constants
            .iter()
            .filter(|c| !target_names.contains(c.name.as_str()))
            .collect()
    };
    for c in &constants {
        let mut refs = Vec::new();
        ref_names(&c.ty, &mut refs);
        queue.extend(refs);
    }
    let mut port_interfaces: HashSet<String> = HashSet::new();
    for name in &picked_components {
        if let Some(c) = components.get(name.as_str()) {
            for p in &c.ports {
                if let Some(i) = &p.interface {
                    port_interfaces.insert(i.clone());
                    queue.push_back(i.clone());
                }
            }
        }
    }

    // Entities reached from the roots; the project's own ones stop the walk.
    let mut picked: IndexSet<String> = IndexSet::new();
    let mut existing: IndexSet<String> = IndexSet::new();
    let mut unresolved: IndexSet<String> = IndexSet::new();
    while let Some(name) = queue.pop_front() {
        if picked.contains(&name) || existing.contains(&name) || unresolved.contains(&name) {
            continue;
        }
        if have.contains_key(name.as_str()) {
            existing.insert(name);
        } else if let Some(e) = by_name.get(name.as_str()) {
            let needs = idl.needs.get(&name).map(Vec::as_slice).unwrap_or(&[]);
            queue.extend(used_names(*e, needs));
            picked.insert(name);
        } else {
            unresolved.insert(name);
        }
    }
    // Undefined names used as types become custom primitives; those only ports use, empty interfaces.
    let mut used_as_type: HashSet<String> = HashSet::new();
    for name in &picked {
        used_as_type.extend(used_names(by_name[name.as_str()], &[]));
    }
    let mut type_names: Vec<String> = Vec::new();
    for name in &picked_components {
        if let Some(c) = components.get(name.as_str()) {
            for a in &c.attributes {
                ref_names(&a.ty, &mut type_names);
            }
            message_names(&c.methods, &mut type_names);
        }
    }
    used_as_type.extend(type_names);
    let empty_interfaces: HashSet<&String> = unresolved
        .iter()
        .filter(|n| port_interfaces.contains(*n) && !used_as_type.contains(*n))
        .collect();

    let ids: HashMap<&String, Id> = picked
        .iter()
        .chain(unresolved.iter())
        .map(|n| (n, new_id()))
        .collect();
    let resolve = |n: &str| -> Id {
        ids.get(&n.to_string())
            .cloned()
            .or_else(|| have.get(n).map(|i| (*i).clone()))
            .unwrap_or_default()
    };
    let to_ref = |t: &FileTypeRef| -> TypeRef { map_ref(t, |r| IdRef { id: resolve(&r.name) }) };
    let field = |name: &str, ty: &FileTypeRef, description: Option<&String>| Field {
        id: new_id(),
        name: name.to_string(),
        ty: to_ref(ty),
        description: description.cloned().unwrap_or_default(),
    };
    let message = |m: &FileMessage| Message {
        id: new_id(),
        name: m.name.clone(),
        description: m.description.clone().unwrap_or_default(),
        params: m
            .params
            .iter()
            .map(|p| {
                let f = field(&p.name, &p.ty, p.description.as_ref());
                Param {
                    id: f.id,
                    name: f.name,
                    ty: f.ty,
                    description: f.description,
                    direction: p.direction.unwrap_or(ParamDirection::In),
                }
            })
            .collect(),
        returns: m.returns.as_ref().map(to_ref),
        raises: m
            .raises
            .as_ref()
            .filter(|r| !r.is_empty())
            .map(|r| r.iter().map(|n| resolve(n)).collect()),
    };

    let mut types: Vec<TypeDef> = Vec::new();
    let mut interfaces: Vec<Interface> = Vec::new();
    for (name, e) in idl
        .types
        .iter()
        .map(|t| (&t.name, Named::Type(t)))
        .chain(idl.interfaces.iter().map(|i| (&i.name, Named::Interface(i))))
    {
        if !picked.contains(name) {
            continue;
        }
        let id = ids[name].clone();
        match e {
            Named::Interface(i) => interfaces.push(Interface {
                id,
                name: i.name.clone(),
                description: i.description.clone().unwrap_or_default(),
                dependency: None,
                messages: i.messages.iter().map(&message).collect(),
            }),
            Named::Type(t) => {
                let body = match &t.body {
                    FileTypeBody::Struct { fields, .. } | FileTypeBody::Exception { fields } => {
                        let fields: Vec<ValueField> = fields
                            .iter()
                            .map(|f| {
                                let b = field(&f.name, &f.ty, f.description.as_ref());
                                ValueField {
                                    id: b.id,
                                    name: b.name,
                                    ty: b.ty,
                                    description: b.description,
                                    default: f.default.clone(),
                                    constraints: None,
                                    ownership: None,
                                }
                            })
                            .collect();
                        if matches!(t.body, FileTypeBody::Exception { .. }) {
                            TypeBody::Exception { fields }
                        } else {
                            TypeBody::Struct {
                                fields,
                                derives: None,
                            }
                        }
                    }
                    FileTypeBody::Enum { underlying, values } => TypeBody::Enum {
                        underlying: *underlying,
                        values: values
                            .iter()
                            .map(|v| EnumValue {
                                id: new_id(),
                                name: v.name.clone(),
                                value: v.value,
                            })
                            .collect(),
                    },
                    FileTypeBody::Union { discriminator, cases } => TypeBody::Union {
                        discriminator: to_ref(discriminator),
                        cases: cases
                            .iter()
                            .map(|c| {
                                let f = field(&c.name, &c.ty, c.description.as_ref());
                                UnionCase {
                                    id: f.id,
                                    name: f.name,
                                    ty: f.ty,
                                    description: f.description,
                                    labels: c.labels.clone().unwrap_or_default(),
                                    is_default: c.default.unwrap_or(false),
                                }
                            })
                            .collect(),
                    },
                    FileTypeBody::Bitmask { underlying, flags } => TypeBody::Bitmask {
                        underlying: *underlying,
                        flags: flags
                            .iter()
                            .map(|v| BitmaskFlag {
                                id: new_id(),
                                name: v.name.clone(),
                                bit: v.bit,
                            })
                            .collect(),
                    },
                    FileTypeBody::Alias { ty } => TypeBody::Alias { ty: to_ref(ty) },
                    FileTypeBody::Primitive {} => TypeBody::Primitive { type_param: None },
                };
                types.push(type_def(
                    id,
                    t.name.clone(),
                    t.description.clone().unwrap_or_default(),
                    body,
                ));
            }
        }
    }
    // Names only raised: exceptions without fields.
    let mut raised: HashSet<&str> = HashSet::new();
    for n in &picked {
        if let Named::Interface(i) = by_name[n.as_str()] {
            for m in &i.messages {
                raised.extend(m.raises.iter().flatten().map(String::as_str));
            }
        }
    }
    for c in &picked_components {
        if let Some(c) = components.get(c.as_str()) {
            for m in &c.methods {
                raised.extend(m.raises.iter().flatten().map(String::as_str));
            }
        }
    }
    for name in &unresolved {
        let id = ids[name].clone();
        let description = "Not defined in the IDL files".to_string();
        if empty_interfaces.contains(name) {
            interfaces.push(Interface {
                id,
                name: name.clone(),
                description,
                dependency: None,
                messages: Vec::new(),
            });
        } else if raised.contains(name.as_str()) && !used_as_type.contains(name) {
            types.push(type_def(
                id,
                name.clone(),
                description,
                TypeBody::Exception { fields: Vec::new() },
            ));
        } else {
            types.push(type_def(
                id,
                name.clone(),
                description,
                TypeBody::Primitive { type_param: None },
            ));
        }
    }

    // Components side by side, in rows.
    let module_ids: HashMap<&String, Id> = picked_components.iter().map(|n| (n, new_id())).collect();
    let mut modules: Vec<Module> = Vec::new();
    let (mut x, mut y, mut row_height) = (0f64, 0f64, 0f64);
    for c in &idl.components {
        if !picked_components.contains(&c.name) {
            continue;
        }
        let mut m = blank_module(module_ids[&c.name].clone(), c.name.clone(), None, Rect::default());
        m.description = c.description.clone();
        m.attributes = c
            .attributes
            .iter()
            .map(|a| {
                let f = field(&a.name, &a.ty, Some(&a.description));
                Attribute {
                    field: ValueField {
                        id: f.id,
                        name: f.name,
                        ty: f.ty,
                        description: f.description,
                        default: None,
                        constraints: None,
                        ownership: None,
                    },
                    qualifiers: if a.readonly {
                        Qualifiers::default().with(Qualifier::Const)
                    } else {
                        Qualifiers::default()
                    },
                    access: None,
                    accessors: None,
                    guarded_by: None,
                }
            })
            .collect();
        m.methods = c
            .methods
            .iter()
            .map(|fm| {
                let msg = message(fm);
                Method {
                    id: msg.id,
                    name: msg.name,
                    description: msg.description,
                    params: msg
                        .params
                        .into_iter()
                        .map(|param| MethodParam {
                            param,
                            qualifiers: Qualifiers::default(),
                            default: None,
                        })
                        .collect(),
                    returns: msg.returns,
                    raises: msg.raises,
                    qualifiers: Qualifiers::default(),
                    pre: None,
                    post: None,
                    access: None,
                }
            })
            .collect();
        m.ports = c
            .ports
            .iter()
            .map(|p: &IdlPort| Port {
                id: new_id(),
                name: p.name.clone(),
                role: p.role,
                interface_id: p.interface.as_ref().map(|i| resolve(i)).filter(|i| !i.is_empty()),
                description: p.description.clone(),
                label: None,
            })
            .collect();
        let bases: Vec<Id> = c
            .bases
            .iter()
            .filter_map(|b| module_ids.get(b).cloned())
            .collect();
        if !bases.is_empty() {
            m.bases = Some(bases);
        }
        if !modules.is_empty() && modules.len().is_multiple_of(MODULES_PER_ROW) {
            x = 0.;
            y += row_height + MODULE_GAP;
            row_height = 0.;
        }
        let size = default_size(&module_roles(&m), Compartments::of_module(&m), target.orientation);
        m.layout = Rect {
            x,
            y,
            width: size.width,
            height: size.height,
        };
        x += m.layout.width + MODULE_GAP;
        row_height = row_height.max(m.layout.height);
        modules.push(m);
    }

    let consts: Vec<ConstDef> = constants
        .iter()
        .map(|c| ConstDef {
            id: new_id(),
            name: c.name.clone(),
            description: c.description.clone().unwrap_or_default(),
            dependency: None,
            ty: to_ref(&c.ty),
            value: c.value.clone().unwrap_or_default(),
        })
        .collect();

    let empty = types.is_empty() && interfaces.is_empty() && modules.is_empty() && consts.is_empty();
    IdlImport {
        clip: (!empty).then(|| Clip {
            format: CLIP_FORMAT.into(),
            root_parents: modules.iter().map(|m| (m.id.clone(), None)).collect(),
            modules,
            links: Vec::new(),
            notes: Vec::new(),
            types,
            interfaces,
            consts,
            names: IndexMap::new(),
            selected_types: None,
        }),
        existing: existing.into_iter().collect(),
        unresolved: unresolved.into_iter().collect(),
    }
}

fn type_def(id: Id, name: String, description: String, body: TypeBody) -> TypeDef {
    TypeDef {
        id,
        name,
        description,
        dependency: None,
        module: None,
        module_path: None,
        access: None,
        body,
    }
}

fn stem(path: &str) -> String {
    let b = base_name(path);
    match b.rfind('.') {
        Some(k) => b[..k].to_string(),
        None => b.to_string(),
    }
}

/// `path` relative to the folder of `from` (both normalized, of the same root).
fn relative_path(from: &str, path: &str) -> String {
    let mut dir: Vec<&str> = dir_of(from).split('/').collect();
    dir.pop();
    let parts: Vec<&str> = path.split('/').collect();
    let mut common = 0;
    while common < dir.len() && common + 1 < parts.len() && dir[common] == parts[common] {
        common += 1;
    }
    dir[common..]
        .iter()
        .map(|_| "..")
        .chain(parts[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}

/// The project an IDL file stands for.
#[derive(Clone, Debug)]
pub struct IdlProject {
    pub project: Project,
    /// What was left out or approximated, included files found nowhere.
    pub warnings: Vec<String>,
    /// Included files found nowhere.
    pub missing: Vec<String>,
}

/// Module standing for an IDL module of the file (see `interface_servers`).
struct IdlServer {
    /// Qualified IDL module, "" for the file scope.
    scope: String,
    /// Its component, named after the qualified scope until nested (see `nest_servers`).
    component: IdlComponent,
}

/// Whether the file `file` defines components: then its modules serve no interfaces.
fn has_components(idl: &IdlFile, file: &str, main: &str) -> bool {
    idl.components
        .iter()
        .any(|c| idl.origins.get(&c.name).map_or(main, String::as_str) == file)
}

/// IDL module enclosing the component `c` ("" at file scope).
fn component_scope(c: &IdlComponent) -> String {
    let q = c.qualified.as_deref().unwrap_or("");
    match q.rfind("::") {
        Some(k) => q[..k].to_string(),
        None => String::new(),
    }
}

fn origin<'a>(idl: &'a IdlFile, name: &str, main: &'a str) -> &'a str {
    idl.origins.get(name).map_or(main, String::as_str)
}

/// Modules standing for the IDL modules of the file `main`: one per IDL module holding definitions
/// or components (see `nest_servers`), and per IDL module enclosing those; types of IDL modules
/// are theirs (see `idl_project`). In files without components (plain CORBA IDL, DDS
/// types), each provides the interfaces of its IDL module on `in` ports, the file's own module
/// those at file scope.
fn interface_servers(idl: &IdlFile, main: &str) -> Vec<IdlServer> {
    fn add(by_scope: &mut IndexMap<String, Vec<FileInterface>>, scope: &str) {
        if let Some(parent) = scope.rfind("::").filter(|k| *k > 0) {
            add(by_scope, &scope[..parent]);
        }
        by_scope.entry(scope.to_string()).or_default();
    }
    let mut by_scope: IndexMap<String, Vec<FileInterface>> = IndexMap::new();
    let serves = !has_components(idl, main, main);
    let entries = idl
        .types
        .iter()
        .map(|t| (&t.name, None))
        .chain(idl.interfaces.iter().map(|i| (&i.name, Some(i))));
    for (name, interface) in entries {
        let Some(scope) = idl.scopes.get(name.as_str()) else {
            continue;
        };
        if origin(idl, name, main) != main {
            continue;
        }
        match interface {
            Some(i) if serves => {
                add(&mut by_scope, scope);
                by_scope.get_mut(scope).expect("scope").push(i.clone());
            }
            _ if !scope.is_empty() => add(&mut by_scope, scope),
            _ => {}
        }
    }
    for c in &idl.components {
        let scope = component_scope(c);
        if !scope.is_empty() && origin(idl, &c.name, main) == main {
            add(&mut by_scope, &scope);
        }
    }
    let mut taken: Vec<String> = idl.components.iter().map(|c| c.name.clone()).collect();
    let mut servers = Vec::new();
    for (scope, interfaces) in by_scope {
        let base = if scope.is_empty() {
            dependency_name(&stem(main))
        } else {
            scope.split("::").collect::<Vec<_>>().join("_")
        };
        let name = unique_name(&base, taken.iter().map(String::as_str));
        taken.push(name.clone());
        let mut ports: Vec<String> = Vec::new();
        let mut list = Vec::new();
        for i in &interfaces {
            let mut chars = i.name.chars();
            let lower: String = chars
                .next()
                .map(|c| c.to_lowercase().collect::<String>() + chars.as_str())
                .unwrap_or_default();
            let port = unique_name(&lower, ports.iter().map(String::as_str));
            ports.push(port.clone());
            list.push(IdlPort {
                name: port,
                role: crate::types::PortRole::In,
                interface: Some(i.name.clone()),
                description: String::new(),
            });
        }
        let description = if scope.is_empty() {
            "Serves the interfaces of the file.".to_string()
        } else if !interfaces.is_empty() {
            format!("Serves the interfaces of IDL module {scope}.")
        } else {
            format!("IDL module {scope}.")
        };
        servers.push(IdlServer {
            scope,
            component: IdlComponent {
                name,
                description,
                bases: Vec::new(),
                attributes: Vec::new(),
                methods: Vec::new(),
                ports: list,
                needs: Vec::new(),
                qualified: None,
            },
        });
    }
    servers
}

/// Result of [`nest_servers`].
struct Nested {
    /// Module of each IDL module (by id).
    modules: IndexMap<String, Id>,
    /// Qualified IDL names of the components named simply.
    simply: HashSet<String>,
}

/// Nest the modules of `servers` in `p` like their IDL modules, with the modules of the
/// `components` they enclose, named simply there: the innermost first, each laid out in a row in
/// its parent, which grows to fit; the outermost in a row. Returns the module of each IDL module,
/// and the qualified IDL names of the components named simply.
fn nest_servers(p: &mut Project, servers: &[IdlServer], components: &[&IdlComponent]) -> Nested {
    let root = |p: &Project, name: &str| -> Option<Id> {
        p.modules
            .iter()
            .find(|x| x.name == name && x.parent_id.is_none())
            .map(|m| m.id.clone())
    };
    let modules: IndexMap<String, Id> = servers
        .iter()
        .filter_map(|s| root(p, &s.component.name).map(|m| (s.scope.clone(), m)))
        .collect();
    // Components of IDL modules, with their qualified name.
    struct Held {
        m: Id,
        scope: String,
        q: String,
    }
    let held: Vec<Held> = components
        .iter()
        .filter_map(|c| {
            let scope = component_scope(c);
            if scope.is_empty() || !modules.contains_key(&scope) {
                return None;
            }
            root(p, &c.name).map(|m| Held {
                m,
                scope,
                q: c.qualified.clone().unwrap_or_default(),
            })
        })
        .collect();
    let parent_of = |scope: &str| -> Option<String> { scope.rfind("::").map(|k| scope[..k].to_string()) };
    let depth = |scope: &str| -> usize {
        if scope.is_empty() {
            0
        } else {
            scope.split("::").count()
        }
    };
    let row = |p: &mut Project, children: &[Id], y: f64| {
        let mut x = 0.;
        for c in children {
            if let Some(m) = find_module_mut(p, c) {
                m.layout.x = x;
                m.layout.y = y;
                x += m.layout.width + MODULE_GAP;
            }
        }
    };
    let mut scopes: Vec<&String> = modules.keys().collect();
    scopes.sort_by_key(|s| std::cmp::Reverse(depth(s)));
    for scope in scopes {
        let parent = modules[scope].clone();
        let children: Vec<Id> = modules
            .iter()
            .filter(|(s, _)| parent_of(s).as_deref() == Some(scope.as_str()))
            .map(|(_, m)| m.clone())
            .chain(held.iter().filter(|h| &h.scope == scope).map(|h| h.m.clone()))
            .collect();
        let top = find_module(p, &parent)
            .map(|m| content_top(p.orientation, Compartments::of_module(m)))
            .unwrap_or_default();
        row(p, &children, top);
        for c in &children {
            if let Some(m) = find_module_mut(p, c) {
                m.layout.x += LAYOUT_PAD / 2.;
                m.parent_id = Some(parent.clone());
            }
            grow_ancestors(p, c);
        }
    }
    let roots: Vec<Id> = p
        .modules
        .iter()
        .filter(|m| m.parent_id.is_none())
        .map(|m| m.id.clone())
        .collect();
    let mut simply: HashSet<String> = HashSet::new();
    let rename = |p: &mut Project, id: &Id, q: &str| -> bool {
        let simple = last_segment(&format!("::{q}")).to_string();
        let parent = find_module(p, id).and_then(|m| m.parent_id.clone());
        let name = unique_name(
            &simple,
            child_modules(p, parent.as_deref())
                .filter(|x| &x.id != id)
                .map(|x| x.name.as_str()),
        );
        if let Some(m) = find_module_mut(p, id) {
            m.name = name.clone();
        }
        name == simple
    };
    for (scope, m) in &modules {
        if !scope.is_empty() {
            rename(p, m, scope);
        }
    }
    for h in &held {
        if rename(p, &h.m, &h.q) {
            simply.insert(h.q.clone());
        }
    }
    let mine: Vec<Id> = roots
        .into_iter()
        .filter(|m| modules.values().any(|x| x == m))
        .collect();
    row(p, &mine, 0.);
    Nested { modules, simply }
}

/// Make the types of the IDL modules of `p` those of their modules (`modules`, of the file
/// `main`), or of the modules of the included file defining them (by path), named simply there.
/// Returns the qualified IDL names of those named simply.
fn scope_definitions(
    p: &mut Project,
    idl: &IdlFile,
    main: &str,
    modules: &IndexMap<String, Id>,
) -> HashSet<String> {
    let mut simply: HashSet<String> = HashSet::new();
    let mut taken: HashMap<String, Vec<String>> = HashMap::new();
    for e in &mut p.types {
        let scope = idl.scopes.get(&e.name).cloned().unwrap_or_default();
        let q = idl.qualified.get(&e.name).cloned().unwrap_or_default();
        if scope.is_empty() || q.is_empty() {
            continue;
        }
        let file = origin(idl, &e.name, main).to_string();
        let module = if file == main {
            modules.get(&scope).cloned()
        } else {
            None
        };
        if file == main && module.is_none() {
            continue;
        }
        // Unique among the definitions of the module, its submodules and its components.
        let key = format!("{file}|{scope}");
        let names = taken.entry(key).or_insert_with(|| {
            let components: Vec<&IdlComponent> = idl
                .components
                .iter()
                .filter(|c| c.qualified.is_some() && origin(idl, &c.name, main) == file)
                .collect();
            let prefix = format!("{scope}::");
            let mut out: Vec<String> = Vec::new();
            let mut push = |s: String| {
                if !out.contains(&s) {
                    out.push(s);
                }
            };
            for s in idl
                .scopes
                .values()
                .cloned()
                .chain(components.iter().map(|c| component_scope(c)))
            {
                if let Some(rest) = s.strip_prefix(&prefix) {
                    push(rest.split("::").next().unwrap_or("").to_string());
                }
            }
            for c in components.iter().filter(|c| component_scope(c) == scope) {
                push(last_segment(c.qualified.as_deref().unwrap_or("")).to_string());
            }
            out
        });
        let simple = last_segment(&q).to_string();
        if !is_reserved_type_name(&simple) {
            e.name = unique_name(&simple, names.iter().map(String::as_str));
        }
        if e.name == simple {
            simply.insert(q);
        }
        names.push(e.name.clone());
        match module {
            Some(m) => e.module = Some(m),
            None => e.module_path = Some(scope.split("::").collect::<Vec<_>>().join(".")),
        }
    }
    simply
}

/// The project an IDL file stands for, to depend on it like on a project file: its definitions,
/// its components as modules (else its IDL modules serving their interfaces, see
/// `interface_servers`), and the files it includes as its dependencies (`indirect` those it
/// includes through others), their definitions being theirs. `files`: the file (`path`) and those
/// it may include, by path.
pub fn idl_project(path: &str, files: &IndexMap<String, String>) -> Result<IdlProject, IdlError> {
    let all = normalize_files(files);
    let main = normalize_path(path);
    let Some(text) = all.get(&main) else {
        return Err(IdlError(format!("{}: not read", base_name(&main))));
    };
    let options = super::IdlOptions {
        file: main.clone(),
        files: all.clone(),
    };
    let parsed = parse_idl(text, &options)?;
    let mut project = Project {
        name: stem(&main),
        ..empty_project()
    };
    let servers = interface_servers(&parsed, &main);
    let mut idl = parsed.clone();
    idl.components.extend(servers.iter().map(|s| s.component.clone()));
    let import = idl_import(&idl, &project, None, true);
    if let Some(clip) = &import.clip {
        paste_clip(
            &mut project,
            clip,
            &PasteOptions {
                parent: PasteParent::Module(None),
                at: Some(Point { x: 0., y: 0. }),
                ..Default::default()
            },
        );
    }

    // Included files, direct ones first.
    let mut reached: Vec<String> = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::from([main.clone()]);
    while let Some(from) = queue.pop_front() {
        for f in idl.includes.get(&from).into_iter().flatten() {
            if *f != main && !reached.contains(f) {
                reached.push(f.clone());
                queue.push_back(f.clone());
            }
        }
    }
    let direct = idl.includes.get(&main).cloned().unwrap_or_default();
    let mut deps: IndexMap<String, Dependency> = IndexMap::new();
    for f in &reached {
        let name = unique_name(&dependency_name(&stem(f)), deps.values().map(|x| x.name.as_str()));
        deps.insert(
            f.clone(),
            Dependency {
                id: new_id(),
                name,
                file: relative_path(&main, f),
                uses: Vec::new(),
                indirect: !direct.contains(f),
                shared: Vec::new(),
                modules: Vec::new(),
            },
        );
    }
    let uses: Vec<(String, Vec<String>)> = deps
        .keys()
        .map(|f| {
            let used = idl
                .includes
                .get(f)
                .into_iter()
                .flatten()
                .filter_map(|g| deps.get(g).map(|d| d.name.clone()))
                .collect();
            (f.clone(), used)
        })
        .collect();
    for (f, used) in uses {
        deps[&f].uses = used;
    }
    project.dependencies = deps.values().cloned().collect();
    let dep_of = |name: &str| deps.get(origin(&idl, name, &main)).map(|d| d.id.clone());
    for e in &mut project.types {
        if let Some(d) = dep_of(&e.name) {
            e.dependency = Some(d);
        }
    }
    for e in &mut project.interfaces {
        if let Some(d) = dep_of(&e.name) {
            e.dependency = Some(d);
        }
    }
    for e in &mut project.consts {
        if let Some(d) = dep_of(&e.name) {
            e.dependency = Some(d);
        }
    }
    // Components of included files are modules of their own project.
    let ours: HashSet<&str> = servers.iter().map(|s| s.component.name.as_str()).collect();
    let theirs: HashSet<Id> = project
        .modules
        .iter()
        .filter(|m| !ours.contains(m.name.as_str()) && deps.contains_key(origin(&idl, &m.name, &main)))
        .map(|m| m.id.clone())
        .collect();
    if !theirs.is_empty() {
        project.modules.retain(|m| !theirs.contains(&m.id));
        for m in &mut project.modules {
            if let Some(b) = &mut m.bases {
                b.retain(|x| !theirs.contains(x));
            }
        }
    }
    let own: Vec<&IdlComponent> = parsed
        .components
        .iter()
        .filter(|c| origin(&parsed, &c.name, &main) == main)
        .collect();
    let nested = nest_servers(&mut project, &servers, &own);
    let mut simply = nested.simply;
    simply.extend(scope_definitions(&mut project, &parsed, &main, &nested.modules));
    let mut warnings: Vec<String> = idl
        .warnings
        .iter()
        // Renames the modules made needless.
        .filter(|w| match w.find(" imported as ") {
            Some(at) => !simply.contains(&w[..at]),
            None => true,
        })
        .cloned()
        .collect();
    warnings.extend(
        import
            .unresolved
            .iter()
            .map(|n| format!("{n} is defined in none of the files: added empty")),
    );
    Ok(IdlProject {
        project,
        warnings,
        missing: idl.missing.clone(),
    })
}
