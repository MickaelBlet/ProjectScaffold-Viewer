//! Adding, moving and deleting types, interfaces, constants, binaries and views. Port of the
//! entity functions of `store/project.ts`.

use crate::binaries::remove_binary;
use crate::project::{
    find_module, global_type_names, member_names, module_types, new_id, orphan_refs, prune_views, type_names,
    type_usages, unique_name,
};
use crate::types::*;

/// Names a new type of the project (None) or of a module may not take.
pub fn type_scope_names(d: &Project, module_id: Option<&str>, except_id: Option<&str>) -> Vec<String> {
    match module_id.and_then(|m| find_module(d, m)) {
        None => global_type_names(d, except_id)
            .into_iter()
            .map(String::from)
            .collect(),
        Some(m) => module_types(d, &m.id)
            .into_iter()
            .filter(|t| Some(t.id.as_str()) != except_id)
            .map(|t| t.name.clone())
            .chain(member_names(d, m))
            .collect(),
    }
}

pub const TYPE_KINDS: &[&str] = &[
    "struct",
    "enum",
    "bitmask",
    "union",
    "exception",
    "alias",
    "primitive",
];

/// Add a type of a kind to the project, or to a module (public); returns its id.
pub fn add_type(d: &mut Project, kind: &str, module_id: Option<&str>) -> Id {
    let id = new_id();
    let base = format!("{}{}", kind[..1].to_uppercase(), &kind[1..]);
    let name = unique_name(
        &base,
        type_scope_names(d, module_id, None).iter().map(String::as_str),
    );
    let body = match kind {
        "struct" => TypeBody::Struct {
            fields: vec![],
            derives: None,
        },
        "exception" => TypeBody::Exception { fields: vec![] },
        "enum" => TypeBody::Enum {
            underlying: IntPrimitive::Uint8,
            values: vec![],
        },
        "bitmask" => TypeBody::Bitmask {
            underlying: UnsignedPrimitive::Uint32,
            flags: vec![],
        },
        "union" => TypeBody::Union {
            discriminator: TypeRef::primitive(Primitive::Int32),
            cases: vec![],
        },
        "alias" => TypeBody::Alias {
            ty: TypeRef::primitive(Primitive::Uint32),
        },
        _ => TypeBody::Primitive { type_param: None },
    };
    d.types.push(TypeDef {
        id: id.clone(),
        name,
        description: String::new(),
        dependency: None,
        module: module_id.map(str::to_string),
        module_path: None,
        access: None,
        body,
    });
    id
}

/// Move a type to a module (public) or to the project (None), renamed if its name is taken there.
pub fn set_type_module(d: &mut Project, id: &str, module_id: Option<&str>) {
    let Some(i) = d.types.iter().position(|t| t.id == id) else {
        return;
    };
    if d.types[i].dependency.is_some() || d.types[i].module.as_deref() == module_id {
        return;
    }
    let taken = type_scope_names(d, module_id, Some(id));
    let t = &mut d.types[i];
    t.name = unique_name(&t.name, taken.iter().map(String::as_str));
    t.module = module_id.map(str::to_string);
    if module_id.is_none() {
        t.access = None;
    }
}

/// Dependency an entity comes from.
pub fn dependency_of<'a>(p: &'a Project, id: &str) -> Option<&'a Dependency> {
    let dep = p
        .types
        .iter()
        .find(|t| t.id == id)
        .and_then(|t| t.dependency.as_ref())
        .or_else(|| {
            p.interfaces
                .iter()
                .find(|i| i.id == id)
                .and_then(|i| i.dependency.as_ref())
        })
        .or_else(|| {
            p.consts
                .iter()
                .find(|c| c.id == id)
                .and_then(|c| c.dependency.as_ref())
        })?;
    p.dependencies.iter().find(|x| &x.id == dep)
}

/// Delete a type; returns the usages that prevent it (nothing deleted). `force` deletes a type in
/// use: its usages keep its name as a missing reference, reported until fixed.
pub fn delete_type(d: &mut Project, id: &str, force: bool) -> Vec<String> {
    if let Some(dep) = dependency_of(d, id) {
        return vec![format!("dependency {}, which defines it", dep.name)];
    }
    let usages = type_usages(d, id);
    if !usages.is_empty() && !force {
        return usages;
    }
    let name = type_names(d).get(id).cloned();
    d.types.retain(|t| t.id != id);
    if !usages.is_empty() {
        let id = id.to_string();
        orphan_refs(d, |x| (x == id).then(|| name.clone()).flatten());
    }
    vec![]
}

pub fn add_interface(d: &mut Project) -> Id {
    let id = new_id();
    let name = unique_name("Interface", global_type_names(d, None));
    d.interfaces.push(Interface {
        id: id.clone(),
        name,
        description: String::new(),
        dependency: None,
        messages: vec![],
    });
    id
}

/// Delete an interface (ports using it become untyped); returns why it cannot be deleted.
pub fn delete_interface(d: &mut Project, id: &str) -> Vec<String> {
    if let Some(dep) = dependency_of(d, id) {
        return vec![format!("dependency {}, which defines it", dep.name)];
    }
    d.interfaces.retain(|i| i.id != id);
    for m in &mut d.modules {
        for p in &mut m.ports {
            if p.interface_id.as_deref() == Some(id) {
                p.interface_id = None;
            }
        }
    }
    vec![]
}

pub fn add_const(d: &mut Project) -> Id {
    let id = new_id();
    let name = unique_name("Constant", global_type_names(d, None));
    d.consts.push(ConstDef {
        id: id.clone(),
        name,
        description: String::new(),
        dependency: None,
        ty: TypeRef::primitive(Primitive::Uint32),
        value: serde_json::json!(0),
    });
    id
}

pub fn delete_const(d: &mut Project, id: &str) {
    d.consts.retain(|c| c.id != id);
}

pub fn add_binary(d: &mut Project) -> Id {
    let id = new_id();
    let name = unique_name("Binary", d.binaries.iter().map(|b| b.name.as_str()));
    d.binaries.push(Binary {
        id: id.clone(),
        name,
        description: String::new(),
        color: None,
    });
    id
}

pub fn delete_binary(d: &mut Project, id: &str) {
    remove_binary(d, id);
}

/// Rename a custom transport, and the links using it.
pub fn rename_transport(d: &mut Project, i: usize, name: &str) {
    let Some(was) = d.transports.get(i).cloned() else {
        return;
    };
    d.transports[i] = name.to_string();
    for l in &mut d.links {
        if l.constraints.remote.transport.as_deref() == Some(was.as_str()) {
            l.constraints.remote.transport = Some(name.to_string());
        }
    }
}

/// Delete a link and what views keep of it.
pub fn delete_link(d: &mut Project, id: &str) {
    d.links.retain(|l| l.id != id);
    prune_views(d);
}

/// Delete a port and the links through it.
pub fn delete_port(d: &mut Project, module_id: &str, port_id: &str) {
    if let Some(m) = d.modules.iter_mut().find(|m| m.id == module_id) {
        m.ports.retain(|p| p.id != port_id);
    }
    d.links
        .retain(|l| l.from.port_id != port_id && l.to.port_id != port_id);
    prune_views(d);
}

/// Reverse a link's direction (its shape mirrored).
pub fn reverse_link(d: &mut Project, id: &str) {
    let mirror = |r: &LinkRoute| LinkRoute {
        from: r.to,
        to: r.from,
        label: r.label.map(|l| ((1. - l) * 1000.).round() / 1000.),
        points: r.points.iter().rev().copied().collect(),
    };
    if let Some(l) = d.links.iter_mut().find(|l| l.id == id) {
        std::mem::swap(&mut l.from, &mut l.to);
        if let Some(r) = &l.route {
            l.route = Some(mirror(r));
        }
    }
    for v in &mut d.views {
        if let Some(r) = v.routes.as_mut().and_then(|r| r.get_mut(id)) {
            *r = mirror(r);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_and_deletes_entities() {
        let mut p = Project::default();
        let s = add_type(&mut p, "struct", None);
        let s2 = add_type(&mut p, "struct", None);
        assert_eq!(p.types[0].name, "Struct");
        assert_ne!(p.types[1].name, "Struct");
        let i = add_interface(&mut p);
        let c = add_const(&mut p);
        assert!(p.consts.iter().any(|x| x.id == c));
        assert!(delete_type(&mut p, &s, false).is_empty());
        assert!(p.types.iter().all(|t| t.id != s));
        assert!(delete_interface(&mut p, &i).is_empty());
        let _ = s2;
        let b = add_binary(&mut p);
        delete_binary(&mut p, &b);
        assert!(p.binaries.is_empty());
    }
}
