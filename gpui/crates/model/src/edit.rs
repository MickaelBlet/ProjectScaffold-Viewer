//! Edits of the project the canvas makes: moving and resizing items, deleting them. Port of the
//! layout and deletion functions of `store/project.ts` and `removePlaced` of `dependencies.ts`.

use std::collections::{HashMap, HashSet};

use crate::binaries::{binary_snapshot, settle_binaries};
use crate::project::{
    Compartments, LAYOUT_PAD, LinkEnd, absolute_position, absolute_rect, below_content, bounds_of,
    child_modules, content_bottom, content_top, default_constraints, default_size, find_imported,
    find_module, find_port, grow_ancestors, grow_imported_ancestors, imported_index, imported_parent,
    is_imported_id, link_origin, link_roles, min_size, module_roles, new_id, next_module_color,
    order_link_ends, prune_views, subtree_ids, unique_name,
};
use indexmap::IndexMap;

use crate::types::{Endpoint, Id, Link, Module, Note, NoteKind, Point, Port, PortRole, Project, Rect, Size};

/// Part of a rect to set: unset fields keep their value.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RectPatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

impl RectPatch {
    pub fn at(x: f64, y: f64) -> Self {
        RectPatch {
            x: Some(x),
            y: Some(y),
            ..Default::default()
        }
    }
}

fn apply(r: &mut crate::types::Rect, p: &RectPatch) {
    if let Some(v) = p.x {
        r.x = v;
    }
    if let Some(v) = p.y {
        r.y = v;
    }
    if let Some(v) = p.width {
        r.width = v;
    }
    if let Some(v) = p.height {
        r.height = v;
    }
}

/// Set several module, note and placed module rects (parent-relative for modules) in one edit.
pub fn set_layouts(d: &mut Project, layouts: &[(Id, RectPatch)]) {
    shift_bends(d, layouts);
    for (id, r) in layouts {
        if let Some(m) = d.modules.iter_mut().find(|m| &m.id == id) {
            apply(&mut m.layout, r);
        }
        if let Some(n) = d.notes.iter_mut().find(|n| &n.id == id) {
            apply(&mut n.layout, r);
        }
        if let Some((di, mi)) = imported_index(d, id) {
            let im = &mut d.dependencies[di].modules[mi];
            im.position = Point {
                x: r.x.unwrap_or(im.position.x),
                y: r.y.unwrap_or(im.position.y),
            };
            if r.width.is_some() || r.height.is_some() {
                let old = im.size.unwrap_or_default();
                im.size = Some(Size {
                    width: r.width.unwrap_or(old.width),
                    height: r.height.unwrap_or(old.height),
                });
            }
        }
    }
    for (id, _) in layouts {
        grow_ancestors(d, id);
        grow_imported_ancestors(d, id);
    }
}

/// Bend points of the links and inheritance lines whose both ends move by the same offset, outside
/// a moving module, move with them.
fn shift_bends(d: &mut Project, layouts: &[(Id, RectPatch)]) {
    let mut offset: HashMap<Id, Point> = HashMap::new();
    for (id, r) in layouts {
        let at = d
            .modules
            .iter()
            .find(|m| &m.id == id)
            .map(|m| Point {
                x: m.layout.x,
                y: m.layout.y,
            })
            .or_else(|| find_imported(d, id).map(|(_, m)| m.position));
        if let Some(at) = at {
            offset.insert(
                id.clone(),
                Point {
                    x: r.x.unwrap_or(at.x) - at.x,
                    y: r.y.unwrap_or(at.y) - at.y,
                },
            );
        }
    }
    // Offset of a module moved with itself or an ancestor.
    let moved = |d: &Project, id: Option<&str>| -> Option<Point> {
        let mut cur = id.map(str::to_string);
        while let Some(c) = cur {
            if let Some(o) = offset.get(&c) {
                return Some(*o);
            }
            cur = d
                .modules
                .iter()
                .find(|m| m.id == c)
                .and_then(|m| m.parent_id.clone());
        }
        None
    };
    let same = |a: Option<Point>, b: Option<Point>| match (a, b) {
        (Some(a), Some(b)) if a == b => Some(a),
        _ => None,
    };
    let mut link_shifts = Vec::new();
    for (i, l) in d.links.iter().enumerate() {
        if l.route.as_ref().is_none_or(|r| r.points.is_empty())
            || moved(d, link_origin(d, &l.from.module_id, &l.to.module_id).as_deref()).is_some()
        {
            continue;
        }
        if let Some(o) = same(moved(d, Some(&l.from.module_id)), moved(d, Some(&l.to.module_id))) {
            link_shifts.push((i, o));
        }
    }
    let mut base_shifts = Vec::new();
    for (i, m) in d.modules.iter().enumerate() {
        for b in m.base_routes.iter().flat_map(|r| r.keys()) {
            if moved(d, link_origin(d, &m.id, b).as_deref()).is_some() {
                continue;
            }
            if let Some(o) = same(moved(d, Some(&m.id)), moved(d, Some(b))) {
                base_shifts.push((i, b.clone(), o));
            }
        }
    }
    let shift = |pts: &mut Vec<Point>, o: Point| {
        for pt in pts {
            pt.x += o.x;
            pt.y += o.y;
        }
    };
    for (i, o) in link_shifts {
        if let Some(r) = &mut d.links[i].route {
            shift(&mut r.points, o);
        }
    }
    for (i, b, o) in base_shifts {
        if let Some(r) = d.modules[i].base_routes.as_mut().and_then(|x| x.get_mut(&b)) {
            shift(&mut r.points, o);
        }
    }
}

/// Remove placed modules of dependencies: top-level ones with their content (content alone stays).
pub fn remove_placed(d: &mut Project, ids: &HashSet<Id>) {
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
        for m in &x.modules {
            if under(&m.path) {
                gone.insert(m.id.clone());
            }
        }
        x.modules.retain(|m| !gone.contains(&m.id));
    }
    if !gone.is_empty() {
        drop_refs(d, &gone);
    }
}

/// Drop the links to removed modules, and the bases they were.
fn drop_refs(d: &mut Project, gone: &HashSet<Id>) {
    d.links
        .retain(|l| !gone.contains(&l.from.module_id) && !gone.contains(&l.to.module_id));
    for m in &mut d.modules {
        if let Some(bases) = &mut m.bases {
            if bases.iter().any(|b| gone.contains(b)) {
                bases.retain(|b| !gone.contains(b));
                if bases.is_empty() {
                    m.bases = None;
                }
            }
        }
    }
}

/// Delete modules (with their content), placed modules and notes in one edit.
pub fn delete_items(d: &mut Project, ids: &[Id]) {
    let set: HashSet<Id> = ids.iter().cloned().collect();
    remove_placed(d, &set);
    let mut gone: HashSet<Id> = HashSet::new();
    for id in ids {
        if d.modules.iter().any(|m| &m.id == id) {
            gone.extend(subtree_ids(d, id));
        }
    }
    d.modules.retain(|m| !gone.contains(&m.id));
    // Types of removed modules go with them.
    d.types
        .retain(|t| t.module.as_ref().is_none_or(|m| !gone.contains(m)));
    drop_refs(d, &gone);
    d.notes.retain(|n| !set.contains(&n.id));
    prune_views(d);
}

/// Move a module under a new parent at a parent-relative place, renaming it if its name is taken.
pub fn reparent_module(d: &mut Project, id: &str, parent_id: Option<&str>, x: f64, y: f64) {
    let Some(i) = d.modules.iter().position(|m| m.id == id) else {
        return;
    };
    if d.modules[i].parent_id.as_deref() == parent_id {
        return;
    }
    if parent_id.is_some_and(|p| subtree_ids(d, id).contains(p)) {
        return;
    }
    let name = {
        let taken = child_modules(d, parent_id)
            .filter(|s| s.id != id)
            .map(|s| s.name.as_str());
        unique_name(&d.modules[i].name, taken)
    };
    let before = binary_snapshot(d);
    let m = &mut d.modules[i];
    m.name = name;
    m.parent_id = parent_id.map(str::to_string);
    m.layout.x = x;
    m.layout.y = y;
    grow_ancestors(d, id);
    // Parents must precede children for the canvas.
    let moved = subtree_ids(d, id);
    let (inside, outside): (Vec<_>, Vec<_>) = std::mem::take(&mut d.modules)
        .into_iter()
        .partition(|m| moved.contains(&m.id));
    d.modules = outside;
    d.modules.extend(inside);
    settle_binaries(d, &before);
}

/// Move items by an offset (arrow keys), locked ones excepted.
pub fn nudge(d: &mut Project, ids: &[Id], dx: f64, dy: f64) {
    let mut layouts = Vec::new();
    for id in ids {
        let at = d
            .modules
            .iter()
            .find(|m| &m.id == id)
            .map(|m| (m.layout.x, m.layout.y, m.locked))
            .or_else(|| {
                d.notes
                    .iter()
                    .find(|n| &n.id == id)
                    .map(|n| (n.layout.x, n.layout.y, n.locked))
            })
            .or_else(|| find_imported(d, id).map(|(_, m)| (m.position.x, m.position.y, m.locked)));
        if let Some((x, y, false)) = at {
            layouts.push((id.clone(), RectPatch::at(x + dx, y + dy)));
        }
    }
    if !layouts.is_empty() {
        set_layouts(d, &layouts);
    }
}

/// An end of a link being drawn: a port, or a module getting a new port (`port_id` None).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectEnd {
    pub module_id: Id,
    pub port_id: Option<Id>,
}

/// Ends of a connection drawn between two ends, in link order, or None when they cannot be linked
/// (roles, interfaces, module to module). Port of `linkEnds` (`canvas/flowGraph.ts`).
pub fn link_ends(p: &Project, a: &ConnectEnd, b: &ConnectEnd) -> Option<(ConnectEnd, ConnectEnd)> {
    if a.module_id == b.module_id {
        return None;
    }
    if a.port_id.is_none() && b.port_id.is_none() {
        return None;
    }
    // A link to a placed module of a dependency needs one end here, and its own port.
    if is_imported_id(&a.module_id) && is_imported_id(&b.module_id) {
        return None;
    }
    let end = |e: &ConnectEnd| -> Option<LinkEnd<ConnectEnd>> {
        let role = match &e.port_id {
            Some(pid) => Some(find_port(p, &e.module_id, pid)?.role),
            None if is_imported_id(&e.module_id) => return None,
            None => None,
        };
        Some(LinkEnd {
            module_id: e.module_id.clone(),
            role,
            data: e.clone(),
        })
    };
    let (x, y) = order_link_ends(p, &end(a)?, &end(b)?)?;
    let iface = |e: &ConnectEnd| {
        e.port_id
            .as_ref()
            .and_then(|pid| find_port(p, &e.module_id, pid))
            .and_then(|pt| pt.interface_id)
    };
    match (iface(&x.data), iface(&y.data)) {
        (Some(i), Some(j)) if i != j => None,
        _ => Some((x.data, y.data)),
    }
}

/// Add a port to a module, growing it to show it; returns its id.
fn push_port(d: &mut Project, module_id: &str, role: PortRole, interface_id: Option<Id>) -> Option<Id> {
    let o = d.orientation;
    let m = d.modules.iter_mut().find(|m| m.id == module_id)?;
    let id = new_id();
    let name = unique_name(role.as_str(), m.ports.iter().map(|p| p.name.as_str()));
    m.ports.push(Port {
        id: id.clone(),
        name,
        role,
        interface_id,
        description: String::new(),
        label: None,
    });
    let min = min_size(&module_roles(m), Compartments::of_module(m), o);
    m.layout.width = m.layout.width.max(min.width);
    m.layout.height = m.layout.height.max(min.height);
    grow_ancestors(d, module_id);
    Some(id)
}

/// Link two ends (in link order), adding the missing ports and giving an untyped end the other's
/// interface; returns the link id. Port of `connect` (`store/project.ts`).
pub fn connect(d: &mut Project, from: &ConnectEnd, to: &ConnectEnd) -> Option<Id> {
    let iface = |d: &Project, e: &ConnectEnd| {
        e.port_id
            .as_ref()
            .and_then(|pid| find_port(d, &e.module_id, pid))
            .and_then(|pt| pt.interface_id)
    };
    let shared = iface(d, from).or_else(|| iface(d, to));
    let (from_role, to_role) = link_roles(d, &from.module_id, &to.module_id);
    let from_port = match &from.port_id {
        Some(p) => p.clone(),
        None => push_port(d, &from.module_id, from_role, shared.clone())?,
    };
    let to_port = match &to.port_id {
        Some(p) => p.clone(),
        None => push_port(d, &to.module_id, to_role, shared)?,
    };
    let a = find_port(d, &from.module_id, &from_port);
    let b = find_port(d, &to.module_id, &to_port);
    if let (Some(a), Some(b)) = (&a, &b) {
        for (m, port, other) in [(&from.module_id, &from_port, b), (&to.module_id, &to_port, a)] {
            if let Some(pt) = d
                .modules
                .iter_mut()
                .find(|x| &x.id == m)
                .and_then(|x| x.ports.iter_mut().find(|pt| &pt.id == port))
            {
                if pt.interface_id.is_none() {
                    pt.interface_id = other.interface_id.clone();
                }
            }
        }
    }
    let id = new_id();
    let module_name = |e: &str| {
        find_module(d, e)
            .map(|m| m.name.clone())
            .or_else(|| find_imported(d, e).map(|(_, m)| m.path.rsplit('.').next().unwrap_or("").to_string()))
    };
    let base = format!(
        "{}_to_{}",
        module_name(&from.module_id).unwrap_or_else(|| "a".into()),
        module_name(&to.module_id).unwrap_or_else(|| "b".into())
    );
    let name = unique_name(&base, d.links.iter().map(|l| l.name.as_str()));
    let interface_id = find_port(d, &from.module_id, &from_port)
        .and_then(|pt| pt.interface_id)
        .or_else(|| find_port(d, &to.module_id, &to_port).and_then(|pt| pt.interface_id));
    let constraints = default_constraints(d.interfaces.iter().find(|i| Some(&i.id) == interface_id.as_ref()));
    d.links.push(Link {
        id: id.clone(),
        name,
        description: String::new(),
        from: Endpoint {
            module_id: from.module_id.clone(),
            port_id: from_port,
        },
        to: Endpoint {
            module_id: to.module_id.clone(),
            port_id: to_port,
        },
        constraints,
        color: None,
        route: None,
    });
    Some(id)
}

/// A module with nothing in it.
pub fn blank_module(id: Id, name: String, parent_id: Option<Id>, layout: Rect) -> Module {
    Module {
        id,
        name,
        description: String::new(),
        parent_id,
        kind: None,
        bases: None,
        base_args: None,
        implements: None,
        r#final: false,
        derives: None,
        constructors: None,
        copy: None,
        r#move: None,
        destructor: None,
        instantiation: None,
        locks: None,
        active: None,
        invariants: None,
        state_machine: None,
        metadata: Default::default(),
        attributes: Vec::new(),
        methods: Vec::new(),
        ports: Vec::new(),
        layout,
        color: None,
        binary_id: None,
        locked: false,
        base_routes: None,
    }
}

/// New module at a parent-relative place; returns its id. Port of `addModule`.
pub fn add_module(d: &mut Project, parent_id: Option<&str>, x: f64, y: f64) -> Id {
    let id = new_id();
    let name = unique_name("Module", child_modules(d, parent_id).map(|m| m.name.as_str()));
    let size = default_size(&[], Compartments::default(), d.orientation);
    let mut m = blank_module(
        id.clone(),
        name,
        parent_id.map(str::to_string),
        Rect {
            x,
            y,
            width: size.width,
            height: size.height,
        },
    );
    m.color = Some(next_module_color(d));
    d.modules.push(m);
    grow_ancestors(d, &id);
    id
}

/// New module inside another, below its ports and existing children. Port of `addSubmodule`.
pub fn add_submodule(d: &mut Project, parent_id: &str) -> Id {
    let y = below_content(d, parent_id, None);
    add_module(d, Some(parent_id), LAYOUT_PAD, y)
}

/// New port on a module, which grows to fit it.
pub fn add_port(d: &mut Project, module_id: &str, role: PortRole) -> Option<Id> {
    push_port(d, module_id, role, None)
}

/// New note or frame at an absolute place; returns its id. Port of `addNote`.
pub fn add_note(d: &mut Project, kind: NoteKind, x: f64, y: f64, view_id: Option<Id>) -> Id {
    let id = new_id();
    let (text, width, height) = match kind {
        NoteKind::Note => ("Note", 180., 100.),
        NoteKind::Frame => ("Group", 420., 280.),
    };
    d.notes.push(Note {
        id: id.clone(),
        kind,
        text: text.into(),
        layout: Rect { x, y, width, height },
        color: None,
        locked: false,
        view_id,
    });
    id
}

/// Whether an item (module, note, placed module) is locked; None when there is no such item.
pub fn locked_of(p: &Project, id: &str) -> Option<bool> {
    find_module(p, id)
        .map(|m| m.locked)
        .or_else(|| p.notes.iter().find(|n| n.id == id).map(|n| n.locked))
        .or_else(|| find_imported(p, id).map(|(_, m)| m.locked))
}

/// Lock or unlock the position and size of modules, notes and placed modules.
pub fn set_locked(d: &mut Project, ids: &[Id], locked: bool) {
    for m in &mut d.modules {
        if ids.contains(&m.id) {
            m.locked = locked;
        }
    }
    for n in &mut d.notes {
        if ids.contains(&n.id) {
            n.locked = locked;
        }
    }
    for m in d.dependencies.iter_mut().flat_map(|x| x.modules.iter_mut()) {
        if ids.contains(&m.id) {
            m.locked = locked;
        }
    }
}

/// Absolute rects of the selected modules and notes.
pub fn selected_rects(p: &Project, ids: &[Id]) -> IndexMap<Id, Rect> {
    let mut out = IndexMap::new();
    for id in ids {
        if find_module(p, id).is_some() {
            out.insert(id.clone(), absolute_rect(p, id));
        } else if let Some(n) = p.notes.iter().find(|n| &n.id == id) {
            out.insert(id.clone(), n.layout);
        }
    }
    out
}

/// Apply absolute rects to modules (parent-relative) and notes; locked items stay put.
pub fn apply_absolute(d: &mut Project, rects: &IndexMap<Id, Rect>) {
    let mut layouts = Vec::new();
    for (id, r) in rects {
        if locked_of(d, id) == Some(true) {
            continue;
        }
        let origin = find_module(d, id)
            .and_then(|m| m.parent_id.as_deref())
            .map_or(Point { x: 0., y: 0. }, |pid| absolute_position(d, pid));
        layouts.push((
            id.clone(),
            RectPatch {
                x: Some((r.x - origin.x).round()),
                y: Some((r.y - origin.y).round()),
                width: Some(r.width),
                height: Some(r.height),
            },
        ));
    }
    set_layouts(d, &layouts);
}

/// Group sibling modules into a new parent module; returns its id, or an error message.
/// Port of `groupSelection`.
pub fn group_modules(d: &mut Project, ids: &[Id]) -> Result<Option<Id>, &'static str> {
    let mods: Vec<Module> = ids.iter().filter_map(|id| find_module(d, id).cloned()).collect();
    let Some(first) = mods.first() else {
        return Ok(None);
    };
    let parent_id = first.parent_id.clone();
    if mods.iter().any(|m| m.parent_id != parent_id) {
        return Err("Only modules with the same parent can be grouped.");
    }
    let rects: Vec<Rect> = mods.iter().map(|m| m.layout).collect();
    let b = bounds_of(&rects);
    let o = d.orientation;
    let top = content_top(o, Compartments::default()) + LAYOUT_PAD / 2.;
    let before = binary_snapshot(d);
    let group_id = new_id();
    let name = unique_name(
        "Group",
        child_modules(d, parent_id.as_deref()).map(|m| m.name.as_str()),
    );
    d.modules.push(blank_module(
        group_id.clone(),
        name,
        parent_id,
        Rect {
            x: b.x - LAYOUT_PAD,
            y: b.y - top,
            width: b.width + 2. * LAYOUT_PAD,
            height: b.height + top + content_bottom(o),
        },
    ));
    let chosen: HashSet<&Id> = mods.iter().map(|m| &m.id).collect();
    for i in 0..d.modules.len() {
        if !chosen.contains(&d.modules[i].id) {
            continue;
        }
        let taken: Vec<String> = d
            .modules
            .iter()
            .filter(|s| s.parent_id.as_deref() == Some(group_id.as_str()) && s.id != d.modules[i].id)
            .map(|s| s.name.clone())
            .collect();
        let m = &mut d.modules[i];
        m.parent_id = Some(group_id.clone());
        m.name = unique_name(&m.name, taken.iter().map(String::as_str));
        m.layout.x += LAYOUT_PAD - b.x;
        m.layout.y += top - b.y;
    }
    // Parents must precede children for the canvas.
    let moved: HashSet<Id> = mods.iter().flat_map(|m| subtree_ids(d, &m.id)).collect();
    let (inside, outside): (Vec<_>, Vec<_>) = std::mem::take(&mut d.modules)
        .into_iter()
        .partition(|m| moved.contains(&m.id));
    d.modules = outside;
    d.modules.extend(inside);
    grow_ancestors(d, &group_id);
    settle_binaries(d, &before);
    Ok(Some(group_id))
}

/// Make the placed ports of dependencies whose interface was renamed follow (`renames`: old name
/// to new). Port of `followPortInterfaces`.
pub fn follow_port_interfaces(d: &mut Project, renames: &HashMap<String, String>) {
    if renames.is_empty() {
        return;
    }
    let names: HashSet<String> = d.interfaces.iter().map(|i| i.name.clone()).collect();
    for m in d.dependencies.iter_mut().flat_map(|x| x.modules.iter_mut()) {
        for pt in &mut m.ports {
            if let Some(to) = pt
                .interface
                .as_ref()
                .filter(|i| !names.contains(*i))
                .and_then(|i| renames.get(i))
            {
                pt.interface = Some(to.clone());
            }
        }
    }
}

/// In a project whose own interfaces were renamed (compared with `prev`), make its placed ports
/// follow. Port of `followInterfaceRenames`.
pub fn follow_interface_renames(prev: &Project, d: &mut Project) {
    if !d.dependencies.iter().any(|x| !x.modules.is_empty()) {
        return;
    }
    let renames: HashMap<String, String> = d
        .interfaces
        .iter()
        .filter_map(|i| {
            let was = prev.interfaces.iter().find(|x| x.id == i.id)?;
            (was.name != i.name).then(|| (was.name.clone(), i.name.clone()))
        })
        .collect();
    follow_port_interfaces(d, &renames);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serialize::Format;
    use crate::serialize::load_text;

    fn example(name: &str) -> Project {
        let path = format!("{}/../../../examples/{name}", env!("CARGO_MANIFEST_DIR"));
        load_text(&std::fs::read_to_string(path).unwrap(), Format::Yaml).unwrap()
    }

    #[test]
    fn connects_ports_and_modules() {
        let mut p = example("robot.scaffold.yaml");
        let id = |p: &Project, n: &str| p.modules.iter().find(|m| m.name == n).unwrap().id.clone();
        let (op, logger) = (id(&p, "Operator"), id(&p, "Logger"));
        let logger_in = p.modules.iter().find(|m| m.id == logger).unwrap().ports[0].clone();
        let a = ConnectEnd {
            module_id: logger.clone(),
            port_id: Some(logger_in.id.clone()),
        };
        let b = ConnectEnd {
            module_id: op.clone(),
            port_id: None,
        };
        // Dragged from the in port: the link still goes from Operator to Logger.
        let (from, to) = link_ends(&p, &a, &b).unwrap();
        assert_eq!(
            (from.module_id.as_str(), to.module_id.as_str()),
            (op.as_str(), logger.as_str())
        );
        let n = p.links.len();
        connect(&mut p, &from, &to).unwrap();
        assert_eq!(p.links.len(), n + 1);
        let m = p.modules.iter().find(|m| m.id == op).unwrap();
        let new = m.ports.last().unwrap();
        assert_eq!(
            (new.role, &new.interface_id),
            (PortRole::Out, &logger_in.interface_id)
        );
        // Two modules without ports: dropped on the module instead.
        assert!(
            link_ends(
                &p,
                &ConnectEnd {
                    module_id: op.clone(),
                    port_id: None
                },
                &b
            )
            .is_none()
        );
    }

    #[test]
    fn groups_siblings_into_a_new_module() {
        let mut p = example("robot.scaffold.yaml");
        let id = |p: &Project, n: &str| p.modules.iter().find(|m| m.name == n).unwrap().id.clone();
        let (a, b) = (id(&p, "Controller"), id(&p, "Logger"));
        let gap = |p: &Project| {
            let (ra, rb) = (absolute_rect(p, &a), absolute_rect(p, &b));
            (rb.x - ra.x, rb.y - ra.y)
        };
        let before = gap(&p);
        let g = group_modules(&mut p, &[a.clone(), b.clone()]).unwrap().unwrap();
        let ga = p.modules.iter().position(|m| m.id == g).unwrap();
        let ia = p.modules.iter().position(|m| m.id == a).unwrap();
        assert!(ga < ia);
        assert_eq!(p.modules[ia].parent_id.as_deref(), Some(g.as_str()));
        // Grouped modules keep their arrangement.
        assert_eq!(gap(&p), before);
        let op = id(&p, "Operator");
        assert!(group_modules(&mut p, &[op, b]).is_err());
    }

    #[test]
    fn moves_and_deletes() {
        let mut p = example("robot.scaffold.yaml");
        let id = p
            .modules
            .iter()
            .find(|m| m.parent_id.is_none())
            .unwrap()
            .id
            .clone();
        set_layouts(&mut p, &[(id.clone(), RectPatch::at(1000., 2000.))]);
        let m = p.modules.iter().find(|m| m.id == id).unwrap();
        assert_eq!((m.layout.x, m.layout.y), (1000., 2000.));
        let before = p.modules.len();
        let inside = subtree_ids(&p, &id).len();
        delete_items(&mut p, std::slice::from_ref(&id));
        assert_eq!(p.modules.len(), before - inside);
        assert!(
            p.links
                .iter()
                .all(|l| p.modules.iter().any(|m| m.id == l.from.module_id))
        );
    }
}
