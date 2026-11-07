//! Edits of the project the canvas makes: moving and resizing items, deleting them. Port of the
//! layout and deletion functions of `store/project.ts` and `removePlaced` of `dependencies.ts`.

use std::collections::{HashMap, HashSet};

use crate::binaries::{binary_snapshot, settle_binaries};
use crate::project::{
    child_modules, find_imported, grow_ancestors, grow_imported_ancestors, imported_index, imported_parent,
    link_origin, prune_views, subtree_ids, unique_name,
};
use crate::types::{Id, Point, Project, Size};

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
