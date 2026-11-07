//! Copy / paste of several entities at once: modules (with content, ports and the links between
//! them), notes, types, interfaces and constants. Clips are JSON, as in the web build, so that they
//! go through the system clipboard between documents (and between both builds). Port of
//! `model/clipboard.ts`.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::binaries::{binary_snapshot, settle_binaries};
use crate::project::{
    absolute_position, all_imported, bounds_of, child_modules, dependency_module_refs, for_each_ref_id_mut,
    global_type_names, grow_ancestors, is_module_ref, link_origin, member_names, module_paths, module_types,
    new_id, parse_dependency_module_ref, ref_resolver, subtree_ids, type_names, unique_name,
};
use crate::types::*;

pub const CLIP_FORMAT: &str = "project-scaffold/clip";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub format: String,
    /// Copied modules, parents first. Copied roots have absolute layouts.
    pub modules: Vec<Module>,
    /// Parent of each copied root in the source project.
    pub root_parents: IndexMap<Id, Option<Id>>,
    /// Links between copied modules; their bend points are absolute.
    pub links: Vec<Link>,
    pub notes: Vec<Note>,
    pub types: Vec<TypeDef>,
    pub interfaces: Vec<Interface>,
    #[serde(default)]
    pub consts: Vec<ConstDef>,
    /// Names of the source project's types (qualified), interfaces and modules used as types.
    pub names: IndexMap<Id, String>,
    /// Types selected themselves, not only copied with their module (absent: all).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_types: Option<Vec<Id>>,
}

fn origin_of(p: &Project, id: Option<&str>) -> Point {
    id.map_or(Point { x: 0., y: 0. }, |id| absolute_position(p, id))
}

/// Copy the entities with these ids; None when none can be copied.
pub fn copy_items(p: &Project, ids: &[Id]) -> Option<Clip> {
    let selected: HashSet<&Id> = ids.iter().collect();
    let roots: Vec<&Module> = p
        .modules
        .iter()
        .filter(|m| {
            if !selected.contains(&m.id) {
                return false;
            }
            // A module whose ancestor is copied comes with it.
            let mut up = m.parent_id.as_ref();
            while let Some(u) = up {
                if selected.contains(u) {
                    return false;
                }
                up = p
                    .modules
                    .iter()
                    .find(|x| &x.id == u)
                    .and_then(|x| x.parent_id.as_ref());
            }
            true
        })
        .collect();
    let mut module_ids: HashSet<Id> = HashSet::new();
    for r in &roots {
        module_ids.extend(subtree_ids(p, &r.id));
    }
    let root_ids: HashSet<&Id> = roots.iter().map(|r| &r.id).collect();
    let modules = p
        .modules
        .iter()
        .filter(|m| module_ids.contains(&m.id))
        .map(|m| {
            let mut c = m.clone();
            if root_ids.contains(&m.id) {
                let a = absolute_position(p, &m.id);
                c.parent_id = None;
                c.layout.x = a.x;
                c.layout.y = a.y;
            }
            c
        })
        .collect();
    let links = p
        .links
        .iter()
        .filter(|l| module_ids.contains(&l.from.module_id) && module_ids.contains(&l.to.module_id))
        .map(|l| {
            let mut l = l.clone();
            if let Some(r) = l.route.as_mut().filter(|r| !r.points.is_empty()) {
                let o = origin_of(p, link_origin(p, &l.from.module_id, &l.to.module_id).as_deref());
                for pt in &mut r.points {
                    pt.x += o.x;
                    pt.y += o.y;
                }
            }
            l
        })
        .collect();
    let mut names: IndexMap<Id, String> = IndexMap::new();
    names.extend(type_names(p));
    names.extend(p.interfaces.iter().map(|i| (i.id.clone(), i.name.clone())));
    names.extend(module_paths(&p.modules, &[]));
    names.extend(dependency_module_refs(p));
    let clip = Clip {
        format: CLIP_FORMAT.into(),
        modules,
        root_parents: roots
            .iter()
            .map(|r| (r.id.clone(), r.parent_id.clone()))
            .collect(),
        links,
        notes: p
            .notes
            .iter()
            .filter(|n| selected.contains(&n.id))
            .cloned()
            .collect(),
        types: p
            .types
            .iter()
            .filter(|t| selected.contains(&t.id) || t.module.as_ref().is_some_and(|m| module_ids.contains(m)))
            .cloned()
            .collect(),
        selected_types: Some(
            p.types
                .iter()
                .filter(|t| selected.contains(&t.id))
                .map(|t| t.id.clone())
                .collect(),
        ),
        interfaces: p
            .interfaces
            .iter()
            .filter(|i| selected.contains(&i.id))
            .cloned()
            .collect(),
        consts: p
            .consts
            .iter()
            .filter(|c| selected.contains(&c.id))
            .cloned()
            .collect(),
        names,
    };
    let empty = clip.modules.is_empty()
        && clip.notes.is_empty()
        && clip.types.is_empty()
        && clip.interfaces.is_empty()
        && clip.consts.is_empty();
    (!empty).then_some(clip)
}

/// The whole content of `source` to paste into `target`: its modules with their links, its notes
/// when asked, and the types, interfaces and constants `target` lacks (others match by name).
pub fn copy_project(source: &Project, target: &Project, with_notes: bool) -> Option<Clip> {
    let have: HashSet<&str> = global_type_names(target, None).into_iter().collect();
    let mut ids: Vec<Id> = child_modules(source, None).map(|m| m.id.clone()).collect();
    if with_notes {
        ids.extend(
            source
                .notes
                .iter()
                .filter(|n| n.view_id.is_none())
                .map(|n| n.id.clone()),
        );
    }
    let entities = source
        .types
        .iter()
        .filter(|t| !t.is_module_type())
        .map(|t| (&t.id, &t.name))
        .chain(source.interfaces.iter().map(|i| (&i.id, &i.name)))
        .chain(source.consts.iter().map(|c| (&c.id, &c.name)));
    ids.extend(
        entities
            .filter(|(_, n)| !have.contains(n.as_str()))
            .map(|(id, _)| id.clone()),
    );
    copy_items(source, &ids)
}

pub fn to_text(clip: &Clip) -> String {
    serde_json::to_string(clip).unwrap_or_default()
}

pub fn parse_clip(text: &str) -> Option<Clip> {
    let clip: Clip = serde_json::from_str(text).ok()?;
    (clip.format == CLIP_FORMAT).then_some(clip)
}

/// Parent of the pasted top modules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PasteParent {
    /// The source parent when it exists here (duplicate, paste in the same document).
    Original,
    /// A module, or the top level.
    Module(Option<Id>),
}

#[derive(Clone, Debug)]
pub struct PasteOptions {
    pub parent: PasteParent,
    /// Absolute position of the pasted content's top-left corner; else shifted by `offset`.
    pub at: Option<Point>,
    pub offset: Option<f64>,
    /// Drill-down view the pasted notes go to; else the views of the whole project.
    pub view_id: Option<Id>,
}

impl Default for PasteOptions {
    fn default() -> Self {
        PasteOptions {
            parent: PasteParent::Original,
            at: None,
            offset: None,
            view_id: None,
        }
    }
}

/// Paste a clip into a project; returns the ids of the pasted top-level entities.
pub fn paste_clip(d: &mut Project, clip: &Clip, options: &PasteOptions) -> Vec<Id> {
    let before = binary_snapshot(d);
    let mut pasted: Vec<Id> = Vec::new();
    // Types and interfaces first: pasted modules and fields may reference them.
    let type_ids: HashMap<Id, Id> = clip
        .types
        .iter()
        .map(|t| &t.id)
        .chain(clip.interfaces.iter().map(|i| &i.id))
        .map(|id| (id.clone(), new_id()))
        .collect();
    let module_ids: HashMap<Id, Id> = clip.modules.iter().map(|m| (m.id.clone(), new_id())).collect();
    let iface_names: HashMap<String, Id> = d
        .interfaces
        .iter()
        .map(|i| (i.name.clone(), i.id.clone()))
        .collect();
    let resolve = ref_resolver(d);
    let known: HashSet<Id> = d
        .types
        .iter()
        .map(|t| t.id.clone())
        .chain(d.interfaces.iter().map(|i| i.id.clone()))
        .collect();
    let dep_ids: HashSet<Id> = d.dependencies.iter().map(|x| x.id.clone()).collect();
    let rebind = |d: &Project, id: &Id| -> Id {
        if let Some(c) = type_ids.get(id).or_else(|| module_ids.get(id)) {
            return c.clone();
        }
        if known.contains(id) {
            return id.clone();
        }
        // Modules used as types: here, else by path.
        let here = match parse_dependency_module_ref(id) {
            Some((dep, _)) => dep_ids.contains(dep),
            None => is_module_ref(d, id),
        };
        if here {
            return id.clone();
        }
        let name = clip.names.get(id).map(String::as_str).unwrap_or("");
        iface_names
            .get(name)
            .cloned()
            .or_else(|| resolve(name))
            .unwrap_or_else(|| id.clone())
    };
    let rebind_ref = |d: &Project, t: &TypeRef| -> TypeRef {
        let mut t = t.clone();
        for_each_ref_id_mut(&mut t, &mut |id| *id = rebind(d, id));
        t
    };
    let value_field = |d: &Project, f: &ValueField| ValueField {
        id: new_id(),
        ty: rebind_ref(d, &f.ty),
        ..f.clone()
    };
    let param = |d: &Project, p: &Param| Param {
        id: new_id(),
        ty: rebind_ref(d, &p.ty),
        ..p.clone()
    };
    let method_param = |d: &Project, p: &MethodParam| MethodParam {
        param: param(d, &p.param),
        ..p.clone()
    };
    let raises =
        |d: &Project, r: &Option<Vec<Id>>| r.as_ref().map(|r| r.iter().map(|x| rebind(d, x)).collect());

    let selected_types: HashSet<&Id> = match &clip.selected_types {
        Some(s) => s.iter().collect(),
        None => clip.types.iter().map(|t| &t.id).collect(),
    };
    for t in &clip.types {
        // A type of a module: of its copy, else of the module when here, else of the project.
        let module = t.module.as_ref().and_then(|m| {
            module_ids
                .get(m)
                .cloned()
                .or_else(|| d.modules.iter().find(|x| &x.id == m).map(|x| x.id.clone()))
        });
        let taken: Vec<String> = match &module {
            None => global_type_names(d, None).into_iter().map(String::from).collect(),
            Some(mid) => {
                let mut v: Vec<String> = module_types(d, mid).iter().map(|x| x.name.clone()).collect();
                if let Some(owner) = d.modules.iter().find(|m| &m.id == mid) {
                    v.extend(member_names(d, owner));
                }
                v
            }
        };
        let body = match &t.body {
            TypeBody::Struct { fields, derives } => TypeBody::Struct {
                fields: fields.iter().map(|f| value_field(d, f)).collect(),
                derives: derives.clone(),
            },
            TypeBody::Exception { fields } => TypeBody::Exception {
                fields: fields.iter().map(|f| value_field(d, f)).collect(),
            },
            TypeBody::Enum { underlying, values } => TypeBody::Enum {
                underlying: *underlying,
                values: values
                    .iter()
                    .map(|v| EnumValue {
                        id: new_id(),
                        ..v.clone()
                    })
                    .collect(),
            },
            TypeBody::Bitmask { underlying, flags } => TypeBody::Bitmask {
                underlying: *underlying,
                flags: flags
                    .iter()
                    .map(|v| BitmaskFlag {
                        id: new_id(),
                        ..v.clone()
                    })
                    .collect(),
            },
            TypeBody::Union { discriminator, cases } => TypeBody::Union {
                discriminator: rebind_ref(d, discriminator),
                cases: cases
                    .iter()
                    .map(|c| UnionCase {
                        id: new_id(),
                        ty: rebind_ref(d, &c.ty),
                        ..c.clone()
                    })
                    .collect(),
            },
            TypeBody::Alias { ty } => TypeBody::Alias {
                ty: rebind_ref(d, ty),
            },
            TypeBody::Primitive { type_param } => TypeBody::Primitive {
                type_param: type_param.as_ref().map(|tp| TypeParam {
                    constraint: tp.constraint,
                    derives_from: tp
                        .derives_from
                        .as_ref()
                        .map(|f| module_ids.get(f).cloned().unwrap_or_else(|| f.clone())),
                    default: tp.default.as_ref().map(|x| rebind_ref(d, x)),
                }),
            },
        };
        let id = type_ids[&t.id].clone();
        let def = TypeDef {
            id: id.clone(),
            name: unique_name(&t.name, taken.iter().map(String::as_str)),
            description: t.description.clone(),
            dependency: None,
            access: if module.is_some() { t.access } else { None },
            module,
            module_path: None,
            body,
        };
        d.types.push(def);
        if selected_types.contains(&t.id) {
            pasted.push(id);
        }
    }
    for c in &clip.consts {
        let id = new_id();
        let name = unique_name(&c.name, global_type_names(d, None));
        let ty = rebind_ref(d, &c.ty);
        d.consts.push(ConstDef {
            id: id.clone(),
            name,
            description: c.description.clone(),
            dependency: None,
            ty,
            value: c.value.clone(),
        });
        pasted.push(id);
    }
    for i in &clip.interfaces {
        let id = type_ids[&i.id].clone();
        let name = unique_name(&i.name, global_type_names(d, None));
        let messages = i
            .messages
            .iter()
            .map(|m| Message {
                id: new_id(),
                params: m.params.iter().map(|p| param(d, p)).collect(),
                returns: m.returns.as_ref().map(|r| rebind_ref(d, r)),
                raises: raises(d, &m.raises),
                ..m.clone()
            })
            .collect();
        d.interfaces.push(Interface {
            id: id.clone(),
            name,
            description: i.description.clone(),
            dependency: None,
            messages,
        });
        pasted.push(id);
    }

    // Placement: roots keep their relative arrangement.
    let rects: Vec<Rect> = clip
        .modules
        .iter()
        .filter(|m| clip.root_parents.contains_key(&m.id))
        .map(|m| m.layout)
        .chain(clip.notes.iter().map(|n| n.layout))
        .collect();
    let bounds = bounds_of(&rects);
    let offset = options.offset.unwrap_or(30.);
    let shift = match options.at {
        Some(at) => Point {
            x: at.x - bounds.x,
            y: at.y - bounds.y,
        },
        None => Point { x: offset, y: offset },
    };

    let mut port_ids: HashMap<Id, Id> = HashMap::new();
    for m in &clip.modules {
        let is_root = clip.root_parents.contains_key(&m.id);
        let exists = |d: &Project, id: &Id| d.modules.iter().any(|x| &x.id == id);
        let parent_id: Option<Id> = if !is_root {
            m.parent_id.as_ref().and_then(|p| module_ids.get(p).cloned())
        } else {
            match &options.parent {
                PasteParent::Original => clip
                    .root_parents
                    .get(&m.id)
                    .cloned()
                    .flatten()
                    .filter(|o| exists(d, o)),
                PasteParent::Module(p) => p.clone().filter(|o| exists(d, o)),
            }
        };
        let mut layout = m.layout;
        if is_root {
            let o = origin_of(d, parent_id.as_deref());
            layout.x = (m.layout.x + shift.x - o.x).round();
            layout.y = (m.layout.y + shift.y - o.y).round();
        }
        let id = module_ids[&m.id].clone();
        // Methods and state machine, their ids renamed together.
        let methods: Vec<Method> = m
            .methods
            .iter()
            .map(|x| Method {
                id: new_id(),
                params: x.params.iter().map(|p| method_param(d, p)).collect(),
                returns: x.returns.as_ref().map(|r| rebind_ref(d, r)),
                raises: raises(d, &x.raises),
                ..x.clone()
            })
            .collect();
        let method_ids: HashMap<&Id, &Id> = m
            .methods
            .iter()
            .zip(&methods)
            .map(|(a, b)| (&a.id, &b.id))
            .collect();
        let state_machine = m.state_machine.as_ref().map(|sm| {
            let state_ids: HashMap<&Id, Id> = sm.states.iter().map(|s| (&s.id, new_id())).collect();
            let state = |id: &Id| state_ids.get(id).cloned().unwrap_or_else(|| id.clone());
            let method = |id: &Id| {
                method_ids
                    .get(id)
                    .map(|x| (*x).clone())
                    .unwrap_or_else(|| id.clone())
            };
            StateMachine {
                initial: sm.initial.as_ref().map(state),
                states: sm
                    .states
                    .iter()
                    .map(|s| State {
                        id: state(&s.id),
                        entry: s.entry.as_ref().map(method),
                        exit: s.exit.as_ref().map(method),
                        ..s.clone()
                    })
                    .collect(),
                transitions: sm
                    .transitions
                    .iter()
                    .map(|t| Transition {
                        id: new_id(),
                        from: state(&t.from),
                        to: state(&t.to),
                        trigger: t.trigger.as_ref().map(method),
                        action: t.action.as_ref().map(method),
                        ..t.clone()
                    })
                    .collect(),
            }
        });
        let name = unique_name(
            &m.name,
            child_modules(d, parent_id.as_deref()).map(|s| s.name.as_str()),
        );
        let attributes = m
            .attributes
            .iter()
            .map(|a| Attribute {
                field: value_field(d, &a.field),
                ..a.clone()
            })
            .collect();
        let constructors = m.constructors.as_ref().map(|cs| {
            cs.iter()
                .map(|c| Constructor {
                    id: new_id(),
                    params: c.params.iter().map(|p| method_param(d, p)).collect(),
                    ..c.clone()
                })
                .collect()
        });
        let ports = m
            .ports
            .iter()
            .map(|pt| {
                let pid = new_id();
                port_ids.insert(pt.id.clone(), pid.clone());
                Port {
                    id: pid,
                    interface_id: pt.interface_id.as_ref().map(|i| rebind(d, i)),
                    ..pt.clone()
                }
            })
            .collect();
        d.modules.push(Module {
            id: id.clone(),
            parent_id,
            // Copies are placed by the user: they start unlocked.
            locked: false,
            name,
            layout,
            attributes,
            constructors,
            methods,
            state_machine,
            ports,
            ..m.clone()
        });
        if is_root {
            grow_ancestors(d, &id);
            pasted.push(id);
        }
    }
    // Ports whose interface does not exist here become untyped; implemented interfaces and bases
    // follow the copies, else stay when they exist here.
    let iface_ids: HashSet<Id> = d.interfaces.iter().map(|i| i.id.clone()).collect();
    let new_modules: HashSet<&Id> = module_ids.values().collect();
    let existing: HashSet<Id> = d
        .modules
        .iter()
        .map(|m| m.id.clone())
        .chain(all_imported(d).map(|m| m.id.clone()))
        .collect();
    let implements: Vec<(usize, Option<Vec<Id>>)> = d
        .modules
        .iter()
        .enumerate()
        .filter(|(_, m)| new_modules.contains(&m.id))
        .map(|(i, m)| {
            (
                i,
                m.implements
                    .as_ref()
                    .map(|x| x.iter().map(|id| rebind(d, id)).collect()),
            )
        })
        .collect();
    for (i, imp) in implements {
        let base_args: Option<IndexMap<Id, Vec<TypeRef>>> = d.modules[i].base_args.clone();
        let rebound_args: HashMap<Id, Vec<TypeRef>> = base_args
            .iter()
            .flatten()
            .map(|(b, args)| (b.clone(), args.iter().map(|a| rebind_ref(d, a)).collect()))
            .collect();
        let m = &mut d.modules[i];
        for pt in &mut m.ports {
            if pt.interface_id.as_ref().is_some_and(|x| !iface_ids.contains(x)) {
                pt.interface_id = None;
            }
        }
        m.implements = imp;
        // Shapes of inheritance lines are relative to modules that may not have come along.
        m.base_routes = None;
        m.base_args = None;
        if let Some(bases) = m.bases.take() {
            let mut kept = Vec::new();
            let mut args: IndexMap<Id, Vec<TypeRef>> = IndexMap::new();
            for b in bases {
                let id = module_ids.get(&b).cloned().unwrap_or_else(|| b.clone());
                if !existing.contains(&id) {
                    continue;
                }
                if let Some(a) = rebound_args.get(&b) {
                    args.insert(id.clone(), a.clone());
                }
                kept.push(id);
            }
            if !kept.is_empty() {
                m.bases = Some(kept);
            }
            if !args.is_empty() {
                m.base_args = Some(args);
            }
        }
    }

    for l in &clip.links {
        let (Some(fm), Some(tm), Some(fp), Some(tp)) = (
            module_ids.get(&l.from.module_id),
            module_ids.get(&l.to.module_id),
            port_ids.get(&l.from.port_id),
            port_ids.get(&l.to.port_id),
        ) else {
            continue;
        };
        let mut link = Link {
            id: new_id(),
            name: unique_name(&l.name, d.links.iter().map(|x| x.name.as_str())),
            from: Endpoint {
                module_id: fm.clone(),
                port_id: fp.clone(),
            },
            to: Endpoint {
                module_id: tm.clone(),
                port_id: tp.clone(),
            },
            ..l.clone()
        };
        // Bend points move with the pasted modules.
        let o = origin_of(d, link_origin(d, fm, tm).as_deref());
        if let Some(r) = link.route.as_mut().filter(|r| !r.points.is_empty()) {
            for pt in &mut r.points {
                pt.x = (pt.x + shift.x - o.x).round();
                pt.y = (pt.y + shift.y - o.y).round();
            }
        }
        d.links.push(link);
    }

    for n in &clip.notes {
        let id = new_id();
        d.notes.push(Note {
            id: id.clone(),
            view_id: options.view_id.clone(),
            locked: false,
            layout: Rect {
                x: (n.layout.x + shift.x).round(),
                y: (n.layout.y + shift.y).round(),
                ..n.layout
            },
            ..n.clone()
        });
        pasted.push(id);
    }
    settle_binaries(d, &before);
    pasted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serialize::{Format, load_text};
    use crate::validate::{Severity, validate};

    fn example(name: &str) -> Project {
        let path = format!("{}/../../../examples/{name}", env!("CARGO_MANIFEST_DIR"));
        load_text(&std::fs::read_to_string(path).unwrap(), Format::Yaml).unwrap()
    }

    #[test]
    fn duplicates_modules_with_their_content_and_links() {
        let mut p = example("robot.scaffold.yaml");
        let core = p.modules.iter().find(|m| m.name == "Core").unwrap().id.clone();
        let (modules, links, types) = (p.modules.len(), p.links.len(), p.types.len());
        let inside = subtree_ids(&p, &core).len();
        let inner_links = p
            .links
            .iter()
            .filter(|l| {
                let s = subtree_ids(&p, &core);
                s.contains(&l.from.module_id) && s.contains(&l.to.module_id)
            })
            .count();
        let sub = subtree_ids(&p, &core);
        let module_types = p
            .types
            .iter()
            .filter(|t| t.module.as_ref().is_some_and(|m| sub.contains(m)))
            .count();
        let errors = |p: &Project| {
            validate(p)
                .iter()
                .filter(|x| x.severity == Severity::Error)
                .count()
        };
        let errors_before = errors(&p);
        let clip = parse_clip(&to_text(&copy_items(&p, std::slice::from_ref(&core)).unwrap())).unwrap();
        let pasted = paste_clip(&mut p, &clip, &PasteOptions::default());
        assert_eq!(pasted.len(), 1);
        assert_eq!(p.modules.len(), modules + inside);
        assert_eq!(p.links.len(), links + inner_links);
        assert_eq!(p.types.len(), types + module_types);
        let copy = p.modules.iter().find(|m| m.id == pasted[0]).unwrap();
        assert!(
            copy.name != "Core" && copy.name.starts_with("Core"),
            "{}",
            copy.name
        );
        // Pasting keeps the project as valid as it was.
        assert_eq!(errors(&p), errors_before, "{:?}", validate(&p));
    }

    #[test]
    fn copies_nothing_from_an_empty_selection() {
        let p = example("robot.scaffold.yaml");
        assert!(copy_items(&p, &[]).is_none());
    }
}
