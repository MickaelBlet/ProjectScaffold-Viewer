//! Own layout of drill-down views (module rects, link shapes, port name sides, places of the
//! modules outside them): drawing a view, and folding a layout edit made in it back. Port of
//! `model/viewLayout.ts`. Values are compared by content where the TypeScript compares object
//! identity, and drawn views are not cached.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use scaffold_model::project::*;
use scaffold_model::types::*;

/// A project as a view draws it, and the modules outside the view root it shows.
#[derive(Clone, Debug, PartialEq)]
pub struct Drawn {
    pub project: Project,
    /// Modules (and placed modules of dependencies) a drill-down view shows outside its root.
    pub outside: HashSet<Id>,
}

/// Modules a view draws: its visible modules and the modules outside it linked to them.
pub fn shown_module_ids(drawn: &Drawn, view: &View) -> HashSet<Id> {
    let mut ids = visible_module_ids(&drawn.project, view);
    ids.extend(drawn.outside.iter().cloned());
    ids
}

/// Free space between the root of a drill-down view and the modules outside it.
const OUTSIDE_GAP: f64 = 80.;
/// Space between two modules outside a drill-down view.
const OUTSIDE_SPACING: f64 = 20.;

fn same_rect(a: &Rect, b: &Rect) -> bool {
    a == b
}

/// `ports` with the name sides `label_of` gives.
fn with_labels(ports: &[Port], label_of: impl Fn(&Port) -> Option<Side>) -> Vec<Port> {
    ports
        .iter()
        .map(|pt| Port {
            label: label_of(pt),
            ..pt.clone()
        })
        .collect()
}

/// `l` with `route`.
fn with_route(l: &Link, route: Option<LinkRoute>) -> Link {
    Link { route, ..l.clone() }
}

/// Whether `a` and `b` have the same fields but the route.
fn same_but_route(a: &Link, b: &Link) -> bool {
    Link {
        route: None,
        ..a.clone()
    } == Link {
        route: None,
        ..b.clone()
    }
}

/// `m` with the rect and the port name sides of `before`.
fn with_layout_of(before: &Module, m: &Module) -> Module {
    let ports = with_labels(&m.ports, |pt| {
        before.ports.iter().find(|b| b.id == pt.id).and_then(|b| b.label)
    });
    Module {
        layout: before.layout,
        ports,
        ..m.clone()
    }
}

struct Outside {
    id: Id,
    /// Its ports linked to the view.
    ports: HashSet<Id>,
    /// Only sends to the view: drawn on its in side.
    sender: bool,
    /// Modules of the view it is linked to.
    partners: Vec<Id>,
}

/// Modules outside a view linked to its visible modules.
fn outside_modules(p: &Project, visible: &HashSet<Id>) -> Vec<Outside> {
    let mut out: IndexMap<Id, Outside> = IndexMap::new();
    let mut add = |module_id: &str, port_id: &str, sender: bool, partner: &str| {
        if !p.modules.iter().any(|m| m.id == module_id) && find_imported(p, module_id).is_none() {
            return;
        }
        let o = out.entry(module_id.to_string()).or_insert_with(|| Outside {
            id: module_id.to_string(),
            ports: HashSet::new(),
            sender: true,
            partners: vec![],
        });
        o.ports.insert(port_id.to_string());
        o.sender &= sender;
        o.partners.push(partner.to_string());
    };
    for l in &p.links {
        let from_in = visible.contains(&l.from.module_id);
        let to_in = visible.contains(&l.to.module_id);
        if from_in && !to_in {
            add(&l.to.module_id, &l.to.port_id, false, &l.from.module_id);
        }
        if !from_in && to_in {
            add(&l.from.module_id, &l.from.port_id, true, &l.to.module_id);
        }
    }
    out.into_values().collect()
}

/// Default rects of the modules outside a drill-down view: senders lined up on its in side (left,
/// or above), receivers on its out side, in the order of the modules they link to.
fn outside_places(p: &Project, root: &Rect, outside: &[(&Outside, Size)]) -> HashMap<Id, Rect> {
    let vertical = p.orientation == Orientation::Vertical;
    let center = |id: &str| {
        let r = absolute_rect(p, id);
        if vertical {
            r.x + r.width / 2.
        } else {
            r.y + r.height / 2.
        }
    };
    let mean = |xs: Vec<f64>| xs.iter().sum::<f64>() / if xs.is_empty() { 1. } else { xs.len() as f64 };
    let mut keyed: Vec<(f64, &Outside, Size)> = outside
        .iter()
        .map(|(o, size)| (mean(o.partners.iter().map(|id| center(id)).collect()), *o, *size))
        .collect();
    keyed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = HashMap::new();
    let mut before = if vertical { root.x } else { root.y };
    let mut after = before;
    for (_, o, size) in keyed {
        let (width, height) = (size.width, size.height);
        let along = if o.sender { before } else { after };
        let advance = (if vertical { width } else { height }) + OUTSIDE_SPACING;
        if o.sender {
            before += advance;
        } else {
            after += advance;
        }
        let (x, y) = if vertical {
            (
                along,
                if o.sender {
                    root.y - height - OUTSIDE_GAP
                } else {
                    root.y + root.height + OUTSIDE_GAP
                },
            )
        } else {
            (
                if o.sender {
                    root.x - width - OUTSIDE_GAP
                } else {
                    root.x + root.width + OUTSIDE_GAP
                },
                along,
            )
        };
        out.insert(o.id.clone(), Rect { x, y, width, height });
    }
    out
}

/// A stored place of a module outside a view, its size at least `min`.
fn place_of(own: &StandIn, min: Size) -> Rect {
    Rect {
        x: own.x,
        y: own.y,
        width: min.width.max(own.width.unwrap_or(min.width)),
        height: min.height.max(own.height.unwrap_or(min.height)),
    }
}

#[allow(clippy::large_enum_variant)]
enum Compact {
    Module(Module),
    Imported(ImportedModule),
}

/// The project as a view draws it. A drill-down view draws its root at the top level (drawn
/// coordinates are those of the canvas), its modules at its own rects (else at their layout),
/// and only its own link shapes and port name sides. The modules outside it linked to its
/// content are drawn too, at the top level and compact (their linked ports, no compartments), at
/// their place in the view or lined up along the root (see `Drawn::outside`).
pub fn in_view(p: &Project, view: &View) -> Drawn {
    let Some(root_id) = view.root_module_id.as_deref() else {
        return Drawn {
            project: p.clone(),
            outside: HashSet::new(),
        };
    };
    let inside = subtree_ids(p, root_id);
    let no_rects = IndexMap::new();
    let no_labels = IndexMap::new();
    let no_routes = IndexMap::new();
    let rects = view.layouts.as_ref().unwrap_or(&no_rects);
    let labels: &IndexMap<Id, Side> = view.port_labels.as_ref().unwrap_or(&no_labels);
    let routes: &IndexMap<Id, LinkRoute> = view.routes.as_ref().unwrap_or(&no_routes);
    let modules: Vec<Module> = p
        .modules
        .iter()
        .map(|m| {
            let mut m = m.clone();
            if inside.contains(&m.id) {
                if let Some(r) = rects.get(&m.id) {
                    m.layout = *r;
                }
            }
            m.ports = with_labels(&m.ports, |pt| labels.get(&pt.id).copied());
            if m.id == root_id {
                m.parent_id = None;
            }
            m
        })
        .collect();
    let links = p
        .links
        .iter()
        .map(|l| with_route(l, routes.get(&l.id).cloned()))
        .collect();
    let mut drawn = Project {
        modules,
        links,
        ..p.clone()
    };
    // Modules outside, linked to the content.
    let visible = visible_module_ids(&drawn, view);
    let outside: Vec<Outside> = outside_modules(&drawn, &visible)
        .into_iter()
        .filter(|o| !view.hidden.contains(&o.id))
        .collect();
    let mut compact: HashMap<Id, Compact> = HashMap::new();
    for o in &outside {
        if let Some(m) = drawn.modules.iter().find(|x| x.id == o.id) {
            compact.insert(
                o.id.clone(),
                Compact::Module(Module {
                    parent_id: None,
                    attributes: vec![],
                    methods: vec![],
                    ports: m
                        .ports
                        .iter()
                        .filter(|pt| o.ports.contains(&pt.id))
                        .cloned()
                        .collect(),
                    ..m.clone()
                }),
            );
        }
        if let Some((_, im)) = find_imported(&drawn, &o.id) {
            let ports = im
                .ports
                .iter()
                .filter(|pt| o.ports.contains(&pt.id))
                .map(|pt| ImportedPort {
                    label: labels.get(&pt.id).copied(),
                    ..pt.clone()
                })
                .collect();
            compact.insert(
                o.id.clone(),
                Compact::Imported(ImportedModule { ports, ..im.clone() }),
            );
        }
    }
    let o = p.orientation;
    let sized = |c: &Compact| match c {
        Compact::Module(m) => default_size(&module_roles(m), Compartments::of_module(m), o),
        Compact::Imported(m) => default_size(&imported_roles(m), Compartments::of_imported(m), o),
    };
    let min_of = |c: &Compact| match c {
        Compact::Module(m) => min_size(&module_roles(m), Compartments::of_module(m), o),
        Compact::Imported(m) => min_size(&imported_roles(m), Compartments::of_imported(m), o),
    };
    let sizes: Vec<(&Outside, Size)> = outside
        .iter()
        .filter_map(|o| compact.get(&o.id).map(|c| (o, sized(c))))
        .collect();
    // A placed module of a dependency is drawn at the top level, where it is in the project.
    let stand_ins = view.stand_ins.as_ref();
    let root_rect = match find_imported(&drawn, root_id) {
        Some((_, placed)) => {
            let at = absolute_position(&drawn, root_id);
            let size = imported_size(placed, o);
            Rect {
                x: at.x,
                y: at.y,
                width: size.width,
                height: size.height,
            }
        }
        None => find_module(&drawn, root_id).map(|m| m.layout).unwrap_or_default(),
    };
    let free: Vec<(&Outside, Size)> = sizes
        .iter()
        .filter(|(o, _)| !stand_ins.is_some_and(|s| s.contains_key(&o.id)))
        .copied()
        .collect();
    let places = outside_places(&drawn, &root_rect, &free);
    for (o, _) in &sizes {
        let Some(c) = compact.get_mut(&o.id) else { continue };
        let r = match stand_ins.and_then(|s| s.get(&o.id)) {
            Some(own) => place_of(own, min_of(c)),
            None => places[&o.id],
        };
        match c {
            Compact::Module(m) => m.layout = r,
            Compact::Imported(m) => {
                m.position = Point { x: r.x, y: r.y };
                m.size = Some(Size {
                    width: r.width,
                    height: r.height,
                });
            }
        }
    }
    for m in &mut drawn.modules {
        if let Some(Compact::Module(c)) = compact.get(&m.id) {
            *m = c.clone();
        }
    }
    if outside.iter().any(|o| find_imported(&drawn, &o.id).is_some()) {
        for dep in &mut drawn.dependencies {
            for im in &mut dep.modules {
                if let Some(Compact::Imported(c)) = compact.get(&im.id) {
                    *im = c.clone();
                }
            }
        }
    }
    Drawn {
        project: drawn,
        outside: outside.iter().map(|o| o.id.clone()).collect(),
    }
}

/// Fold an edit of the view of a placed module of a dependency (see `fold_layouts`), which keeps
/// no layout of its own: the placed modules take their new places, the stand-ins of the modules
/// outside and the link shapes stay as they are in the project.
fn fold_placed(prev: &Project, base: &Drawn, next: Project) -> Project {
    let was: HashMap<&str, &Module> = prev.modules.iter().map(|m| (m.id.as_str(), m)).collect();
    let drawn: HashMap<&str, &Module> = base.project.modules.iter().map(|m| (m.id.as_str(), m)).collect();
    let modules = next
        .modules
        .iter()
        .map(|m| match was.get(m.id.as_str()) {
            Some(before) if drawn.get(m.id.as_str()) == Some(&m) || base.outside.contains(&m.id) => {
                (*before).clone()
            }
            _ => m.clone(),
        })
        .collect();
    let prev_links: HashMap<&str, &Link> = prev.links.iter().map(|l| (l.id.as_str(), l)).collect();
    let links = next
        .links
        .iter()
        .map(|l| match prev_links.get(l.id.as_str()) {
            None => l.clone(),
            Some(before) if same_but_route(before, l) => (*before).clone(),
            Some(before) => with_route(l, before.route.clone()),
        })
        .collect();
    Project {
        modules,
        links,
        ..next
    }
}

/// Whether a view has a layout of its own to reset: module rects, link shapes, port name sides or
/// stand-in places.
pub fn has_own_layout(view: &View) -> bool {
    view.layouts.is_some() || view.routes.is_some() || view.port_labels.is_some() || view.stand_ins.is_some()
}

/// Store a temporary view of the module `root_id` under `view_id`, unless stored already.
pub fn store_view<'a>(d: &'a mut Project, view_id: &str, root_id: &str) -> Option<&'a mut View> {
    if let Some(i) = d.views.iter().position(|v| v.id == view_id) {
        return Some(&mut d.views[i]);
    }
    let root = d.modules.iter().find(|m| m.id == root_id)?;
    let name = unique_name(&root.name, d.views.iter().map(|v| v.name.as_str()));
    d.views.push(View {
        id: view_id.to_string(),
        name,
        root_module_id: Some(root_id.to_string()),
        hidden: vec![],
        layouts: None,
        routes: None,
        port_labels: None,
        stand_ins: None,
        temporary: false,
    });
    d.views.last_mut()
}

fn or_none<V>(o: IndexMap<Id, V>) -> Option<IndexMap<Id, V>> {
    (!o.is_empty()).then_some(o)
}

/// Port name sides set in the view are its own: `ports` (id, side) against the ones drawn.
fn keep_labels(
    own: &mut IndexMap<Id, Side>,
    ports: Vec<(Id, Option<Side>)>,
    shown: Option<Vec<(Id, Option<Side>)>>,
) {
    for (id, label) in ports {
        if let Some(shown) = &shown {
            if label == shown.iter().find(|(s, _)| *s == id).and_then(|(_, l)| *l) {
                continue;
            }
        }
        match label {
            Some(l) => {
                own.insert(id, l);
            }
            None => {
                own.shift_remove(&id);
            }
        }
    }
}

fn port_labels(ports: &[Port]) -> Vec<(Id, Option<Side>)> {
    ports.iter().map(|pt| (pt.id.clone(), pt.label)).collect()
}

fn imported_labels(ports: &[ImportedPort]) -> Vec<(Id, Option<Side>)> {
    ports.iter().map(|pt| (pt.id.clone(), pt.label)).collect()
}

fn placed_rect(im: &ImportedModule, o: Orientation) -> Rect {
    let size = imported_size(im, o);
    Rect {
        x: im.position.x,
        y: im.position.y,
        width: size.width,
        height: size.height,
    }
}

fn stand_in(r: &Rect) -> StandIn {
    StandIn {
        x: r.x,
        y: r.y,
        width: Some(r.width),
        height: Some(r.height),
    }
}

/// Fold an edit of `base` (`in_view(prev, view)`), giving `next`, back into the project: the
/// rects, link shapes and port name sides the edit gives become the view's own, the project keeps
/// its own. New modules, and modules moved to another parent, take their rect in the view as
/// their layout. A temporary view gets stored (also when it has notes).
pub fn fold_layouts(prev: &Project, base: &Drawn, next: Project, view_id: &str) -> Project {
    let stored = next.views.iter().find(|v| v.id == view_id);
    let root_id: Option<String> = match stored {
        Some(v) => v.root_module_id.clone(),
        None => isolated_module_id(view_id).map(str::to_string),
    };
    let Some(root_id) = root_id else { return next };
    if is_imported_id(&root_id) {
        return fold_placed(prev, base, next);
    }
    if !next.modules.iter().any(|m| m.id == root_id) {
        return next;
    }
    let was: HashMap<&str, &Module> = prev.modules.iter().map(|m| (m.id.as_str(), m)).collect();
    let drawn: HashMap<&str, &Module> = base.project.modules.iter().map(|m| (m.id.as_str(), m)).collect();
    let inside = subtree_ids(&next, &root_id);
    let mut own: IndexMap<Id, Rect> = stored.and_then(|v| v.layouts.clone()).unwrap_or_default();
    let mut own_labels: IndexMap<Id, Side> = stored.and_then(|v| v.port_labels.clone()).unwrap_or_default();
    let mut own_routes: IndexMap<Id, LinkRoute> = stored.and_then(|v| v.routes.clone()).unwrap_or_default();
    let mut own_places: IndexMap<Id, StandIn> = stored.and_then(|v| v.stand_ins.clone()).unwrap_or_default();
    let outside = &base.outside;
    let mut placed: Vec<Id> = vec![];
    let modules: Vec<Module> = next
        .modules
        .iter()
        .map(|edited| {
            let before = was.get(edited.id.as_str()).copied();
            let shown = drawn.get(edited.id.as_str()).copied();
            if let Some(before) = before {
                if shown == Some(edited) {
                    return before.clone();
                }
            }
            keep_labels(
                &mut own_labels,
                port_labels(&edited.ports),
                shown.map(|s| port_labels(&s.ports)),
            );
            // Modules outside: their rect is their place in the view, the module stays as it is.
            if let Some(before) = before {
                if outside.contains(&edited.id) {
                    if shown.is_none_or(|s| !same_rect(&edited.layout, &s.layout)) {
                        own_places.insert(edited.id.clone(), stand_in(&edited.layout));
                    }
                    return before.clone();
                }
            }
            // The root, drawn at the top level, keeps its parent.
            let m = match (before, shown) {
                (Some(b), Some(s)) if s.parent_id != b.parent_id && edited.parent_id == s.parent_id => {
                    Module {
                        parent_id: b.parent_id.clone(),
                        ..edited.clone()
                    }
                }
                _ => edited.clone(),
            };
            let Some(before) = before.filter(|b| b.parent_id == m.parent_id) else {
                own.shift_remove(&m.id);
                placed.push(m.id.clone());
                let ports = match before {
                    Some(b) => with_layout_of(b, &m).ports,
                    None => with_labels(&m.ports, |_| None),
                };
                return Module { ports, ..m };
            };
            if inside.contains(&m.id) {
                if same_rect(&m.layout, &before.layout) {
                    own.shift_remove(&m.id);
                } else {
                    own.insert(m.id.clone(), m.layout);
                }
            }
            with_layout_of(before, &m)
        })
        .collect();
    // Link shapes set in the view are its own; the project keeps its own.
    let prev_links: HashMap<&str, &Link> = prev.links.iter().map(|l| (l.id.as_str(), l)).collect();
    let drawn_links: HashMap<&str, &Link> = base.project.links.iter().map(|l| (l.id.as_str(), l)).collect();
    let links: Vec<Link> = next
        .links
        .iter()
        .map(|l| {
            let shown = drawn_links.get(l.id.as_str()).copied();
            if shown == Some(l) {
                return prev_links
                    .get(l.id.as_str())
                    .map_or_else(|| l.clone(), |b| (*b).clone());
            }
            if shown.is_none_or(|s| l.route != s.route) {
                match &l.route {
                    Some(r) => {
                        own_routes.insert(l.id.clone(), r.clone());
                    }
                    None => {
                        own_routes.shift_remove(&l.id);
                    }
                }
            }
            match prev_links.get(l.id.as_str()) {
                Some(before) if same_but_route(before, l) => (*before).clone(),
                before => with_route(l, before.and_then(|b| b.route.clone())),
            }
        })
        .collect();
    // Placed modules of dependencies outside: the same, on their position and size.
    let dependencies = if next.dependencies == base.project.dependencies {
        prev.dependencies.clone()
    } else {
        next.dependencies
            .iter()
            .map(|dep| {
                let Some(prev_dep) = prev.dependencies.iter().find(|x| x.id == dep.id) else {
                    return dep.clone();
                };
                let moved: Vec<ImportedModule> = dep
                    .modules
                    .iter()
                    .map(|im| {
                        let before = prev_dep.modules.iter().find(|x| x.id == im.id);
                        let Some(before) = before.filter(|_| outside.contains(&im.id)) else {
                            return im.clone();
                        };
                        let shown = find_imported(&base.project, &im.id).map(|(_, m)| m);
                        if shown == Some(im) {
                            return before.clone();
                        }
                        keep_labels(
                            &mut own_labels,
                            imported_labels(&im.ports),
                            shown.map(|s| imported_labels(&s.ports)),
                        );
                        let r = placed_rect(im, next.orientation);
                        let was = shown.map(|s| placed_rect(s, next.orientation));
                        if was.is_none_or(|w| !same_rect(&r, &w)) {
                            own_places.insert(im.id.clone(), stand_in(&r));
                        }
                        before.clone()
                    })
                    .collect();
                if moved == prev_dep.modules {
                    prev_dep.clone()
                } else {
                    Dependency {
                        modules: moved,
                        ..dep.clone()
                    }
                }
            })
            .collect()
    };
    let layouts = or_none(own);
    let port_labels = or_none(own_labels);
    let routes = or_none(own_routes);
    let stand_ins = or_none(own_places);
    let notes = next.notes.iter().any(|n| n.view_id.as_deref() == Some(view_id));
    let mut folded = Project {
        modules,
        links,
        dependencies,
        ..next
    };
    let keep = layouts.is_some() || port_labels.is_some() || routes.is_some() || stand_ins.is_some() || notes;
    let view = if keep {
        store_view(&mut folded, view_id, &root_id)
    } else {
        folded.views.iter_mut().find(|v| v.id == view_id)
    };
    if let Some(view) = view {
        view.layouts = layouts;
        view.port_labels = port_labels;
        view.routes = routes;
        view.stand_ins = stand_ins;
    }
    // Their parents grow to hold the modules placed from the view.
    for id in &placed {
        grow_ancestors(&mut folded, id);
    }
    folded
}

#[cfg(test)]
mod tests {
    use super::*;
    use scaffold_model::serialize::{Format, from_file, load_text, to_file};
    use serde_json::{Value, json};

    fn example(name: &str) -> Project {
        let path = format!("{}/../../../examples/{name}", env!("CARGO_MANIFEST_DIR"));
        load_text(&std::fs::read_to_string(path).unwrap(), Format::Yaml).unwrap()
    }

    fn id_of(p: &Project, path: &str) -> Id {
        p.modules
            .iter()
            .find(|m| module_path(p, &m.id) == path)
            .unwrap()
            .id
            .clone()
    }

    /// Edit `p` as the view draws it, folded back as the store does.
    fn edit(p: &Project, view_id: &str, f: impl FnOnce(&mut Project)) -> Project {
        let base = in_view(p, &find_view(p, view_id));
        let mut next = base.project.clone();
        f(&mut next);
        fold_layouts(p, &base, next, view_id)
    }

    fn mod_mut<'a>(p: &'a mut Project, id: &str) -> &'a mut Module {
        p.modules.iter_mut().find(|m| m.id == id).unwrap()
    }
    fn module<'a>(p: &'a Project, id: &str) -> &'a Module {
        p.modules.iter().find(|m| m.id == id).unwrap()
    }
    fn view<'a>(p: &'a Project, id: &str) -> &'a View {
        p.views.iter().find(|v| v.id == id).unwrap()
    }
    fn view_of<'a>(file: &'a Value, root: &str) -> Option<&'a Value> {
        file["editor"]["views"]
            .as_array()?
            .iter()
            .find(|v| v["root"] == root)
    }
    fn imported<'a>(p: &'a Project, path: &str) -> &'a ImportedModule {
        p.dependencies
            .iter()
            .flat_map(|d| &d.modules)
            .find(|m| m.path == path)
            .unwrap()
    }

    struct Ctx {
        example: Project,
        core: Id,
        sensor: Id,
        view_id: Id,
        link: Id,
        port: Id,
    }

    fn ctx() -> Ctx {
        let example = example("robot.scaffold.yaml");
        let core = id_of(&example, "Core");
        let sensor = id_of(&example, "Core.Sensor");
        let link = example
            .links
            .iter()
            .find(|l| l.name == "sensor_to_controller")
            .unwrap()
            .id
            .clone();
        let port = module(&example, &sensor).ports[0].id.clone();
        Ctx {
            view_id: isolated_view_id(&core),
            example,
            core,
            sensor,
            link,
            port,
        }
    }

    fn link_of<'a>(p: &'a Project, id: &str) -> &'a Link {
        p.links.iter().find(|l| l.id == id).unwrap()
    }
    fn port_of<'a>(p: &'a Project, sensor: &str, port: &str) -> &'a Port {
        module(p, sensor).ports.iter().find(|pt| pt.id == port).unwrap()
    }

    fn shaped(c: &Ctx) -> Project {
        let mut p = c.example.clone();
        p.links.iter_mut().find(|l| l.id == c.link).unwrap().route = Some(LinkRoute {
            points: vec![Point { x: 1., y: 2. }],
            ..Default::default()
        });
        mod_mut(&mut p, &c.sensor)
            .ports
            .iter_mut()
            .find(|pt| pt.id == c.port)
            .unwrap()
            .label = Some(Side::Top);
        p
    }

    #[test]
    fn keeps_rects_of_an_edit_in_a_drill_down_view_storing_a_temporary_view() {
        let c = ctx();
        let (sx, sy) = (
            module(&c.example, &c.sensor).layout.x,
            module(&c.example, &c.sensor).layout.y,
        );
        let core_w = module(&c.example, &c.core).layout.width;
        let next = edit(&c.example, &c.view_id, |d| {
            mod_mut(d, &c.sensor).layout.x += 40.;
            mod_mut(d, &c.core).layout.width += 100.;
        });
        let v = view(&next, &c.view_id);
        assert_eq!(v.root_module_id.as_deref(), Some(c.core.as_str()));
        let layouts = v.layouts.as_ref().unwrap();
        assert_eq!(
            layouts[&c.sensor],
            Rect {
                x: sx + 40.,
                ..module(&c.example, &c.sensor).layout
            }
        );
        assert_eq!(layouts[&c.core].width, core_w + 100.);
        // The project view is unchanged.
        assert_eq!(module(&next, &c.sensor), module(&c.example, &c.sensor));
        assert_eq!(module(&next, &c.core).layout, module(&c.example, &c.core).layout);
        // The view draws its own rects.
        assert_eq!(module(&in_view(&next, v).project, &c.sensor).layout.x, sx + 40.);
        let _ = sy;
    }

    #[test]
    fn drops_a_rect_brought_back_to_the_module_layout() {
        let c = ctx();
        let moved = edit(&c.example, &c.view_id, |d| mod_mut(d, &c.sensor).layout.x += 40.);
        let back = edit(&moved, &c.view_id, |d| mod_mut(d, &c.sensor).layout.x -= 40.);
        assert!(view(&back, &c.view_id).layouts.is_none());
    }

    #[test]
    fn gives_new_modules_their_rect_as_layout_growing_their_parents() {
        let c = ctx();
        let id = new_id();
        let next = edit(&c.example, &c.view_id, |d| {
            let m = Module {
                id: id.clone(),
                name: "Extra".into(),
                layout: Rect {
                    x: 2000.,
                    y: 40.,
                    width: 200.,
                    height: 80.,
                },
                ..module(d, &c.sensor).clone()
            };
            d.modules.push(m);
            grow_ancestors(d, &id);
        });
        assert_eq!(module(&next, &id).layout.x, 2000.);
        assert!(module(&next, &c.core).layout.width >= 2200.);
    }

    #[test]
    fn round_trips_the_rects_of_a_view_through_the_file() {
        let c = ctx();
        let y = module(&c.example, &c.sensor).layout.y;
        let next = edit(&c.example, &c.view_id, |d| mod_mut(d, &c.sensor).layout.y += 20.);
        let file = to_file(&next, true);
        let saved = view_of(&file, "Core").unwrap();
        assert_eq!(saved["layout"]["Core.Sensor"]["y"].as_f64(), Some(y + 20.));
        let back = from_file(&file, None).unwrap();
        let core = id_of(&back, "Core");
        let v = back
            .views
            .iter()
            .find(|v| v.root_module_id.as_deref() == Some(core.as_str()))
            .unwrap();
        assert_eq!(
            v.layouts.as_ref().unwrap()[&id_of(&back, "Core.Sensor")].y,
            y + 20.
        );
    }

    #[test]
    fn draws_only_its_own_link_shapes_and_port_name_sides() {
        let c = ctx();
        let p = shaped(&c);
        let drawn = in_view(&p, &find_view(&p, &c.view_id));
        assert!(link_of(&drawn.project, &c.link).route.is_none());
        assert!(port_of(&drawn.project, &c.sensor, &c.port).label.is_none());
        // Deterministic while nothing changes.
        assert_eq!(in_view(&p, &find_view(&p, &c.view_id)), drawn);
        assert_eq!(in_view(&p, &find_view(&p, GLOBAL_VIEW)).project, p);
    }

    #[test]
    fn keeps_link_shapes_and_port_name_sides_set_in_the_view() {
        let c = ctx();
        let p = shaped(&c);
        let route = LinkRoute {
            points: vec![Point { x: 5., y: 6. }],
            label: Some(0.25),
            ..Default::default()
        };
        let next = edit(&p, &c.view_id, |d| {
            d.links.iter_mut().find(|l| l.id == c.link).unwrap().route = Some(route.clone());
            mod_mut(d, &c.sensor)
                .ports
                .iter_mut()
                .find(|pt| pt.id == c.port)
                .unwrap()
                .label = Some(Side::Bottom);
        });
        let v = view(&next, &c.view_id).clone();
        assert_eq!(v.routes.as_ref().unwrap()[&c.link], route);
        assert_eq!(v.port_labels.as_ref().unwrap()[&c.port], Side::Bottom);
        assert_eq!(link_of(&next, &c.link), link_of(&p, &c.link));
        assert_eq!(module(&next, &c.sensor), module(&p, &c.sensor));
        let drawn = in_view(&next, &v).project;
        assert_eq!(link_of(&drawn, &c.link).route, Some(route));
        assert_eq!(port_of(&drawn, &c.sensor, &c.port).label, Some(Side::Bottom));
        // Cleared in the view: back to the automatic shape.
        let cleared = edit(&next, &c.view_id, |d| {
            d.links.iter_mut().find(|l| l.id == c.link).unwrap().route = None;
            mod_mut(d, &c.sensor)
                .ports
                .iter_mut()
                .find(|pt| pt.id == c.port)
                .unwrap()
                .label = None;
        });
        let after = view(&cleared, &c.view_id);
        assert!(after.routes.is_none());
        assert!(after.port_labels.is_none());
        assert_eq!(link_of(&cleared, &c.link).route, link_of(&p, &c.link).route);
    }

    #[test]
    fn gives_links_new_in_the_view_their_shape_in_the_view_only() {
        let c = ctx();
        let id = new_id();
        let route = LinkRoute {
            points: vec![Point { x: 3., y: 4. }],
            ..Default::default()
        };
        let next = edit(&c.example, &c.view_id, |d| {
            let l = Link {
                id: id.clone(),
                name: "extra".into(),
                route: Some(route.clone()),
                ..link_of(d, &c.link).clone()
            };
            d.links.push(l);
        });
        assert!(link_of(&next, &id).route.is_none());
        assert_eq!(view(&next, &c.view_id).routes.as_ref().unwrap()[&id], route);
    }

    fn note(view_id: &str, kind: NoteKind, text: &str) -> Note {
        Note {
            id: "n".into(),
            kind,
            text: text.into(),
            layout: Rect {
                x: 0.,
                y: 0.,
                width: 1.,
                height: 1.,
            },
            color: None,
            locked: false,
            view_id: Some(view_id.into()),
        }
    }

    #[test]
    fn drops_the_shapes_names_and_notes_of_deleted_links_ports_and_views() {
        let c = ctx();
        let mut next = edit(&c.example, &c.view_id, |d| {
            d.links.iter_mut().find(|l| l.id == c.link).unwrap().route = Some(LinkRoute {
                points: vec![],
                from: Some(LinkAnchor {
                    side: Side::Top,
                    at: 0.5,
                }),
                ..Default::default()
            });
            mod_mut(d, &c.sensor)
                .ports
                .iter_mut()
                .find(|pt| pt.id == c.port)
                .unwrap()
                .label = Some(Side::Left);
            d.notes.push(note(&c.view_id, NoteKind::Note, ""));
        });
        next.links.retain(|l| l.id != c.link);
        mod_mut(&mut next, &c.sensor).ports.retain(|pt| pt.id != c.port);
        prune_views(&mut next);
        let v = view(&next, &c.view_id);
        assert!(v.routes.is_none());
        assert!(v.port_labels.is_none());
        assert!(next.notes.iter().any(|n| n.id == "n"));
        let mut gone = next.clone();
        gone.views.retain(|v| v.id != c.view_id);
        prune_views(&mut gone);
        assert!(!gone.notes.iter().any(|n| n.id == "n"));
    }

    #[test]
    fn round_trips_link_shapes_port_name_sides_and_notes_of_a_view_through_the_file() {
        let c = ctx();
        let p = shaped(&c);
        let next = edit(&p, &c.view_id, |d| {
            d.links.iter_mut().find(|l| l.id == c.link).unwrap().route = Some(LinkRoute {
                points: vec![Point { x: 7., y: 8. }],
                ..Default::default()
            });
            mod_mut(d, &c.sensor)
                .ports
                .iter_mut()
                .find(|pt| pt.id == c.port)
                .unwrap()
                .label = Some(Side::Right);
            d.notes.push(note(&c.view_id, NoteKind::Frame, "In view"));
        });
        let file = to_file(&next, true);
        let saved = view_of(&file, "Core").unwrap();
        assert_eq!(
            saved["links"],
            json!({ "sensor_to_controller": { "points": [{ "x": 7, "y": 8 }] } })
        );
        let port_name = &port_of(&next, &c.sensor, &c.port).name;
        assert_eq!(
            saved["labels"],
            json!({ "Core.Sensor": { port_name.as_str(): "right" } })
        );
        assert_eq!(
            saved["notes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n["text"].clone())
                .collect::<Vec<_>>(),
            vec![json!("In view")]
        );
        let global_notes = file["editor"]["notes"].as_array().cloned().unwrap_or_default();
        assert!(!global_notes.iter().any(|n| n["text"] == "In view"));
        let back = from_file(&file, Some(&next)).unwrap();
        let v = back
            .views
            .iter()
            .find(|v| v.root_module_id.as_deref() == Some(c.core.as_str()))
            .unwrap();
        let want = view(&next, &c.view_id);
        assert_eq!(v.routes, want.routes);
        assert_eq!(v.port_labels, want.port_labels);
        // Ids kept on reload.
        assert_eq!(back.notes, next.notes);
        assert_eq!(link_of(&back, &c.link).route, link_of(&p, &c.link).route);
        assert_eq!(port_of(&back, &c.sensor, &c.port).label, Some(Side::Top));
    }

    #[test]
    fn round_trips_the_places_of_outside_stand_ins_dropped_with_their_module() {
        let c = ctx();
        let operator = id_of(&c.example, "Operator");
        let mut next = c.example.clone();
        next.views.push(View {
            id: c.view_id.clone(),
            name: "Core".into(),
            root_module_id: Some(c.core.clone()),
            hidden: vec![],
            layouts: None,
            routes: None,
            port_labels: None,
            stand_ins: Some(IndexMap::from([(
                operator.clone(),
                StandIn {
                    x: -300.,
                    y: 40.,
                    ..Default::default()
                },
            )])),
            temporary: false,
        });
        let file = to_file(&next, true);
        assert_eq!(
            view_of(&file, "Core").unwrap()["outside"],
            json!({ "Operator": { "x": -300, "y": 40 } })
        );
        let back = from_file(&file, None).unwrap();
        let core = id_of(&back, "Core");
        let v = back
            .views
            .iter()
            .find(|v| v.root_module_id.as_deref() == Some(core.as_str()))
            .unwrap();
        let operator = id_of(&back, "Operator");
        assert_eq!(
            v.stand_ins.as_ref().unwrap()[&operator],
            StandIn {
                x: -300.,
                y: 40.,
                ..Default::default()
            }
        );
        let mut gone = next.clone();
        gone.modules.retain(|m| m.id != operator);
        prune_views(&mut gone);
        assert!(view(&gone, &c.view_id).stand_ins.is_none());
    }

    #[test]
    fn keeps_the_place_of_a_placed_dependency_module_outside_the_view_saved_and_reloaded() {
        let ground = example("fleet/ground.scaffold.yaml");
        let datalink = id_of(&ground, "Datalink");
        let radio = imported(&ground, "Radio").id.clone();
        let id = ground
            .views
            .iter()
            .find(|v| v.root_module_id.as_deref() == Some(datalink.as_str()))
            .unwrap()
            .id
            .clone();
        let base = in_view(&ground, &find_view(&ground, &id));
        assert!(base.outside.contains(&radio));
        let mut moved = base.project.clone();
        moved
            .dependencies
            .iter_mut()
            .flat_map(|d| d.modules.iter_mut())
            .find(|m| m.id == radio)
            .unwrap()
            .position = Point { x: -400., y: 30. };
        let next = fold_layouts(&ground, &base, moved, &id);
        // Kept by the edits that follow.
        let mut pruned = next.clone();
        prune_views(&mut pruned);
        let place = view(&pruned, &id).stand_ins.as_ref().unwrap()[&radio];
        assert_eq!((place.x, place.y), (-400., 30.));
        let saved = to_file(&pruned, true);
        let out = &saved["editor"]["views"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "Datalink")
            .unwrap()["outside"]["Drone/Radio"];
        assert_eq!((out["x"].as_f64(), out["y"].as_f64()), (Some(-400.), Some(30.)));
        let back = from_file(&saved, None).unwrap();
        let place = view(&back, &id).stand_ins.as_ref().unwrap()[&radio];
        assert_eq!((place.x, place.y), (-400., 30.));
    }

    #[test]
    fn draws_a_placed_dependency_module_in_a_view_of_its_own_which_keeps_nothing() {
        let ground = example("fleet/ground.scaffold.yaml");
        let datalink = id_of(&ground, "Datalink");
        let radio = imported(&ground, "Radio").id.clone();
        let id = isolated_view_id(&radio);
        let v = find_view(&ground, &id);
        assert_eq!(
            (v.name.as_str(), v.root_module_id.as_deref(), v.temporary),
            ("Radio", Some(radio.as_str()), true)
        );
        assert!(!can_keep_view(&v));
        assert_eq!(visible_module_ids(&ground, &v), HashSet::from([radio.clone()]));
        let base = in_view(&ground, &v);
        assert!(base.outside.contains(&datalink));
        let mut edited = base.project.clone();
        mod_mut(&mut edited, &datalink).layout.x -= 500.;
        edited
            .dependencies
            .iter_mut()
            .flat_map(|d| d.modules.iter_mut())
            .find(|m| m.id == radio)
            .unwrap()
            .size = Some(Size {
            width: 400.,
            height: 300.,
        });
        let next = fold_layouts(&ground, &base, edited, &id);
        // The stand-in stays where the project has it; the placed module takes its new size.
        assert_eq!(next.modules, ground.modules);
        assert_eq!(next.views, ground.views);
        assert_eq!(
            imported(&next, "Radio").size,
            Some(Size {
                width: 400.,
                height: 300.
            })
        );
    }

    #[test]
    fn draws_modules_outside_a_drill_down_view_compact_at_the_top_level_lined_up_along_it() {
        let c = ctx();
        let operator = id_of(&c.example, "Operator");
        let drawn = in_view(&c.example, &find_view(&c.example, &c.view_id));
        assert_eq!(drawn.outside, HashSet::from([operator.clone()]));
        assert!(module(&drawn.project, &c.core).parent_id.is_none());
        let o = module(&drawn.project, &operator);
        assert!(o.parent_id.is_none());
        assert!(o.attributes.is_empty());
        assert_eq!(
            o.ports.iter().map(|pt| pt.name.as_str()).collect::<Vec<_>>(),
            vec!["cmd"]
        );
        // Only sends to the view: on its in side.
        assert!(o.layout.x + o.layout.width < module(&drawn.project, &c.core).layout.x);
        assert!(
            in_view(&c.example, &find_view(&c.example, GLOBAL_VIEW))
                .outside
                .is_empty()
        );
    }

    #[test]
    fn keeps_the_place_of_a_module_outside_the_view_the_module_as_it_is() {
        let c = ctx();
        let operator = id_of(&c.example, "Operator");
        let core_w = module(&c.example, &c.core).layout.width;
        let next = edit(&c.example, &c.view_id, |d| {
            let l = &mut mod_mut(d, &operator).layout;
            (l.x, l.y, l.width) = (-500., 10., 300.);
            mod_mut(d, &c.core).layout.width += 10.;
        });
        let v = view(&next, &c.view_id).clone();
        let place = v.stand_ins.as_ref().unwrap()[&operator];
        assert_eq!((place.x, place.y, place.width), (-500., 10., Some(300.)));
        assert_eq!(module(&next, &operator), module(&c.example, &operator));
        // The root keeps its parent; its rect is the view's.
        assert_eq!(
            module(&next, &c.core).parent_id,
            module(&c.example, &c.core).parent_id
        );
        assert_eq!(v.layouts.as_ref().unwrap()[&c.core].width, core_w + 10.);
        let l = module(&in_view(&next, &v).project, &operator).layout;
        assert_eq!((l.x, l.y, l.width), (-500., 10., 300.));
    }

    #[test]
    fn shapes_the_links_to_modules_outside_the_view_in_the_view_only() {
        let c = ctx();
        let to_core = c
            .example
            .links
            .iter()
            .find(|l| l.name == "operator_to_core")
            .unwrap()
            .id
            .clone();
        let route = LinkRoute {
            points: vec![Point { x: -100., y: 50. }],
            from: Some(LinkAnchor {
                side: Side::Bottom,
                at: 0.5,
            }),
            ..Default::default()
        };
        let next = edit(&c.example, &c.view_id, |d| {
            d.links.iter_mut().find(|l| l.id == to_core).unwrap().route = Some(route.clone());
        });
        assert_eq!(view(&next, &c.view_id).routes.as_ref().unwrap()[&to_core], route);
        assert_eq!(link_of(&next, &to_core), link_of(&c.example, &to_core));
    }
}
