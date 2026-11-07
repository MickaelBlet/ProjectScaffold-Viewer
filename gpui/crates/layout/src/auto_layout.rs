//! Automatic arrangement of modules (layered, hierarchical, port aware). Port of
//! `model/autoLayout.ts`, with the own layered layout (`layered`) in place of ELK: each module
//! holding others is laid out on its own, innermost first, then sized to fit; a link between
//! modules of different containers joins the two ancestors that are siblings.

use std::collections::HashMap;

use scaffold_model::project::*;
use scaffold_model::types::*;

use crate::layered::{Edge, Params, js_round, layered};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArrangeOptions {
    /// `Horizontal`: layers left to right, ports on the sides. `Vertical`: top to bottom, ports on
    /// top / bottom.
    pub orientation: Orientation,
    /// Space between modules.
    pub spacing: f64,
}

impl Default for ArrangeOptions {
    fn default() -> Self {
        ArrangeOptions {
            orientation: Orientation::Horizontal,
            spacing: 70.,
        }
    }
}

pub fn arrange_options(orientation: Orientation) -> ArrangeOptions {
    ArrangeOptions {
        orientation,
        ..Default::default()
    }
}

/// Vertical center of the `i`-th of `rows` port rows of a leaf, centered below its header.
fn port_y(i: usize, rows: usize, height: f64) -> f64 {
    MODULE_HEADER
        + (height - MODULE_HEADER - rows as f64 * PORT_ROW) / 2.
        + i as f64 * PORT_ROW
        + PORT_ROW / 2.
}

/// Estimated width of a side port's label (name and interface) with its margins.
fn label_width(p: &Project, pt: &Port) -> f64 {
    let iface = match &pt.interface_id {
        Some(id) => p
            .interfaces
            .iter()
            .find(|i| i.id == *id)
            .map_or(1, |i| i.name.chars().count()),
        None => 1,
    };
    34. + pt.name.chars().count() as f64 * 7. + iface as f64 * 6.
}

#[derive(Clone, Copy, Debug)]
struct Padding {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

/// Frame of a container: padding around its content and smallest size.
#[derive(Clone, Copy, Debug)]
struct Frame {
    padding: Padding,
    min: Size,
}

/// A module (or placed module of a dependency) to arrange.
struct Item {
    id: Id,
    width: f64,
    height: f64,
    children: Vec<Item>,
    frame: Option<Frame>,
    /// Position of each port along the cross axis (leaves only).
    port_offsets: HashMap<Id, f64>,
}

/// A link joining two items of a level.
struct Lifted {
    from: Id,
    to: Id,
    from_off: Option<f64>,
    to_off: Option<f64>,
}

struct Level<'a> {
    vertical: bool,
    spacing: f64,
    edges: &'a HashMap<Option<Id>, Vec<Lifted>>,
    /// Rects relative to the parent.
    rects: HashMap<Id, Rect>,
}

/// Offsets of the ports of a leaf along the cross axis.
fn leaf_offsets(ports: &[(Id, PortRole)], width: f64, height: f64, vertical: bool) -> HashMap<Id, f64> {
    let ins: Vec<&Id> = ports
        .iter()
        .filter(|(_, r)| *r == PortRole::In)
        .map(|(i, _)| i)
        .collect();
    let outs: Vec<&Id> = ports
        .iter()
        .filter(|(_, r)| *r == PortRole::Out)
        .map(|(i, _)| i)
        .collect();
    let rows = ins.len().max(outs.len());
    let mut out = HashMap::new();
    for list in [&ins, &outs] {
        for (i, id) in list.iter().enumerate() {
            let at = if vertical {
                // Ports share their band evenly.
                (i as f64 + 0.5) * width / list.len() as f64
            } else {
                port_y(i, rows, height)
            };
            out.insert((*id).clone(), at);
        }
    }
    out
}

/// Center each layer (row when `vertical`, column otherwise) of a level on the axis of its
/// content: the layered placement aligns modules to straighten links, which leaves narrow layers
/// on one side.
fn center_layers(rects: &mut [Rect], vertical: bool) {
    if rects.len() < 2 {
        return;
    }
    let flow = |r: &Rect| {
        if vertical {
            (r.y, r.y + r.height)
        } else {
            (r.x, r.x + r.width)
        }
    };
    let cross = |r: &Rect| {
        if vertical {
            (r.x, r.x + r.width)
        } else {
            (r.y, r.y + r.height)
        }
    };
    let mid = |list: &[usize], rects: &[Rect]| {
        let lo = list
            .iter()
            .map(|&i| cross(&rects[i]).0)
            .fold(f64::INFINITY, f64::min);
        let hi = list
            .iter()
            .map(|&i| cross(&rects[i]).1)
            .fold(f64::NEG_INFINITY, f64::max);
        (lo + hi) / 2.
    };
    // Layers: modules overlapping along the flow.
    let mut order: Vec<usize> = (0..rects.len()).collect();
    order.sort_by(|&a, &b| {
        flow(&rects[a])
            .0
            .partial_cmp(&flow(&rects[b]).0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut layers: Vec<Vec<usize>> = vec![];
    let mut end = f64::NEG_INFINITY;
    for i in order {
        if flow(&rects[i]).0 >= end {
            layers.push(vec![]);
        }
        layers.last_mut().expect("a layer").push(i);
        end = end.max(flow(&rects[i]).1);
    }
    let all: Vec<usize> = (0..rects.len()).collect();
    let axis = mid(&all, rects);
    for layer in layers {
        let shift = axis - mid(&layer, rects);
        for i in layer {
            if vertical {
                rects[i].x += shift;
            } else {
                rects[i].y += shift;
            }
        }
    }
}

impl Level<'_> {
    /// Arranges `items` (children of `parent`) and records their rects; returns the size of the
    /// parent: its content with the padding of `frame` (never below its minimum size).
    fn arrange(&mut self, items: &mut [Item], parent: Option<&Id>, frame: Option<Frame>) -> (f64, f64) {
        // Containers first: they get the size of their content.
        for item in items.iter_mut() {
            if item.children.is_empty() {
                continue;
            }
            let (w, h) = self.arrange(&mut item.children, Some(&item.id.clone()), item.frame);
            item.width = w;
            item.height = h;
        }
        let index: HashMap<&str, usize> = items
            .iter()
            .enumerate()
            .map(|(i, it)| (it.id.as_str(), i))
            .collect();
        let sizes: Vec<(f64, f64)> = items.iter().map(|it| (it.width, it.height)).collect();
        let cross_of = |i: usize, off: Option<f64>| {
            off.unwrap_or(if self.vertical { sizes[i].0 } else { sizes[i].1 } / 2.)
        };
        let edges: Vec<Edge> = self
            .edges
            .get(&parent.cloned())
            .map(|list| {
                list.iter()
                    .filter_map(|l| {
                        let (a, b) = (*index.get(l.from.as_str())?, *index.get(l.to.as_str())?);
                        Some(Edge::new(a, b, cross_of(a, l.from_off), cross_of(b, l.to_off)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let placed = layered(
            &sizes,
            &edges,
            &Params {
                vertical: self.vertical,
                node_gap: self.spacing,
                layer_gap: self.spacing * 1.6,
                edge_gap: self.spacing / 3.,
            },
        );
        let mut rects: Vec<Rect> = items
            .iter()
            .zip(&placed.pos)
            .map(|(it, at)| Rect {
                x: at.x,
                y: at.y,
                width: it.width,
                height: it.height,
            })
            .collect();
        center_layers(&mut rects, self.vertical);
        let bounds = bounds_of(&rects);
        let (dx, dy, size) = match frame {
            Some(f) if !items.is_empty() => {
                let width = f.min.width.max(f.padding.left + bounds.width + f.padding.right);
                let height = f.min.height.max(f.padding.top + bounds.height + f.padding.bottom);
                (
                    f.padding.left - bounds.x,
                    f.padding.top - bounds.y,
                    (width, height),
                )
            }
            Some(f) => (
                0.,
                0.,
                (
                    f.min.width.max(f.padding.left + f.padding.right),
                    f.min.height.max(f.padding.top + f.padding.bottom),
                ),
            ),
            None => (0., 0., (bounds.width, bounds.height)),
        };
        for (it, r) in items.iter().zip(&rects) {
            self.rects.insert(
                it.id.clone(),
                Rect {
                    x: r.x + dx,
                    y: r.y + dy,
                    ..*r
                },
            );
        }
        size
    }
}

/// New rects (parent-relative) for the modules inside `scope_id` (or all modules).
pub fn compute_arrangement(
    p: &Project,
    scope_id: Option<&str>,
    options: &ArrangeOptions,
) -> HashMap<Id, Rect> {
    let scope = scope_id.and_then(|id| find_module(p, id));
    let o = options.orientation;
    let vertical = o == Orientation::Vertical;
    // Leaves get their default size when the ports move to other edges.
    let reset = o != p.orientation;
    // Horizontal: a container's side port labels sit inside its frame (see ModuleNode), clear of
    // its content.
    let labels = |ports: &[Port], role: PortRole| {
        if vertical {
            0.
        } else {
            ports
                .iter()
                .filter(|pt| pt.role == role)
                .map(|pt| label_width(p, pt))
                .fold(0., f64::max)
        }
    };
    let frame_of = |m: &Module| {
        let c = Compartments::of_module(m);
        Frame {
            padding: Padding {
                top: content_top(o, c) + LAYOUT_PAD / 2.,
                left: LAYOUT_PAD.max(labels(&m.ports, PortRole::In)),
                bottom: content_bottom(o),
                right: LAYOUT_PAD.max(labels(&m.ports, PortRole::Out)),
            },
            min: min_size(&module_roles(m), c, o),
        }
    };

    let mut owner: HashMap<Id, Id> = HashMap::new();
    fn build(
        p: &Project,
        m: &Module,
        o: Orientation,
        reset: bool,
        frame_of: &dyn Fn(&Module) -> Frame,
        owner: &mut HashMap<Id, Id>,
    ) -> Item {
        let mut children: Vec<Item> = child_modules(p, Some(&m.id))
            .map(|c| build(p, c, o, reset, frame_of, owner))
            .collect();
        for pt in &m.ports {
            owner.insert(pt.id.clone(), m.id.clone());
        }
        let min = min_size(&module_roles(m), Compartments::of_module(m), o);
        let leaf = children.is_empty();
        let size = if reset {
            default_size(&module_roles(m), Compartments::of_module(m), o)
        } else {
            Size {
                width: m.layout.width,
                height: m.layout.height,
            }
        };
        let (width, height) = if leaf {
            (size.width.max(min.width), size.height.max(min.height))
        } else {
            (min.width, min.height)
        };
        let ports: Vec<(Id, PortRole)> = m.ports.iter().map(|pt| (pt.id.clone(), pt.role)).collect();
        Item {
            id: m.id.clone(),
            width,
            height,
            frame: (!leaf).then(|| frame_of(m)),
            port_offsets: if leaf {
                leaf_offsets(&ports, width, height, o == Orientation::Vertical)
            } else {
                HashMap::new()
            },
            children: std::mem::take(&mut children),
        }
    }
    let mut items: Vec<Item> = child_modules(p, scope_id)
        .map(|m| build(p, m, o, reset, &frame_of, &mut owner))
        .collect();
    // Imported modules sit at the top level, fixed size, with their content.
    let imported: Vec<&ImportedModule> = if scope_id.is_some() {
        vec![]
    } else {
        imported_roots(p)
    };
    for m in &imported {
        let Size { width, height } = imported_size(m, o);
        let ports: Vec<(Id, PortRole)> = m.ports.iter().map(|pt| (pt.id.clone(), pt.role)).collect();
        for pt in &m.ports {
            owner.insert(pt.id.clone(), m.id.clone());
        }
        items.push(Item {
            id: m.id.clone(),
            width,
            height,
            children: vec![],
            frame: None,
            port_offsets: leaf_offsets(&ports, width, height, vertical),
        });
    }

    // Links, lifted to the items that are siblings.
    let mut offsets: HashMap<Id, f64> = HashMap::new();
    let mut parents: HashMap<Id, Option<Id>> = HashMap::new();
    fn collect(
        items: &[Item],
        parent: Option<&Id>,
        offsets: &mut HashMap<Id, f64>,
        parents: &mut HashMap<Id, Option<Id>>,
    ) {
        for it in items {
            parents.insert(it.id.clone(), parent.cloned());
            offsets.extend(it.port_offsets.iter().map(|(k, v)| (k.clone(), *v)));
            collect(&it.children, Some(&it.id), offsets, parents);
        }
    }
    collect(&items, None, &mut offsets, &mut parents);
    let chain = |id: &Id| {
        let mut c = vec![id.clone()];
        while let Some(Some(up)) = parents.get(c.last().expect("a chain")) {
            c.push(up.clone());
        }
        c.reverse();
        c
    };
    let mut edges: HashMap<Option<Id>, Vec<Lifted>> = HashMap::new();
    for l in &p.links {
        let (Some(a), Some(b)) = (owner.get(&l.from.port_id), owner.get(&l.to.port_id)) else {
            continue;
        };
        let (ca, cb) = (chain(a), chain(b));
        let Some(i) = (0..ca.len().min(cb.len())).find(|&i| ca[i] != cb[i]) else {
            continue;
        };
        let at =
            |c: &Vec<Id>, own: &Id, port: &Id| (c[i] == *own).then(|| offsets.get(port).copied()).flatten();
        edges
            .entry((i > 0).then(|| ca[i - 1].clone()))
            .or_default()
            .push(Lifted {
                from: ca[i].clone(),
                to: cb[i].clone(),
                from_off: at(&ca, a, &l.from.port_id),
                to_off: at(&cb, b, &l.to.port_id),
            });
    }

    let mut level = Level {
        vertical,
        spacing: options.spacing,
        edges: &edges,
        rects: HashMap::new(),
    };
    let root_frame = scope.map(frame_of);
    let (width, height) = level.arrange(&mut items, scope_id.map(str::to_string).as_ref(), root_frame);
    let mut rects: HashMap<Id, Rect> = level
        .rects
        .into_iter()
        .map(|(id, r)| {
            let r = Rect {
                x: js_round(r.x),
                y: js_round(r.y),
                ..r
            };
            (id, r)
        })
        .collect();
    // The arranged container fits its new content.
    if let Some(s) = scope {
        rects.insert(
            s.id.clone(),
            Rect {
                width,
                height,
                ..s.layout
            },
        );
    }

    // Top level: keep the arrangement where the modules were.
    if scope_id.is_none() {
        let tops: Vec<(Id, Rect)> = child_modules(p, None)
            .map(|m| (m.id.clone(), m.layout))
            .chain(imported.iter().map(|m| {
                let s = imported_size(m, p.orientation);
                (
                    m.id.clone(),
                    Rect {
                        x: m.position.x,
                        y: m.position.y,
                        width: s.width,
                        height: s.height,
                    },
                )
            }))
            .collect();
        let before = bounds_of(&tops.iter().map(|t| t.1).collect::<Vec<_>>());
        let after = bounds_of(
            &tops
                .iter()
                .filter_map(|t| rects.get(&t.0).copied())
                .collect::<Vec<_>>(),
        );
        for (id, _) in &tops {
            if let Some(r) = rects.get_mut(id) {
                r.x = r.x - after.x + before.x;
                r.y = r.y - after.y + before.y;
            }
        }
    }
    rects
}

/// The project with the modules inside `scope_id` (or all modules) arranged.
pub fn arrange(p: &Project, scope_id: Option<&str>, options: &ArrangeOptions) -> Project {
    let rects = compute_arrangement(p, scope_id, options);
    apply_arrangement(p, &rects, scope_id, options.orientation)
}

/// `p` with the `rects` (parent-relative; absolute positions for placed modules of dependencies)
/// applied, rounded, in `orientation`.
pub fn apply_arrangement(
    p: &Project,
    rects: &HashMap<Id, Rect>,
    scope_id: Option<&str>,
    orientation: Orientation,
) -> Project {
    let mut d = p.clone();
    d.orientation = orientation;
    for m in &mut d.modules {
        if let Some(r) = rects.get(&m.id) {
            m.layout = Rect {
                x: js_round(r.x),
                y: js_round(r.y),
                width: js_round(r.width),
                height: js_round(r.height),
            };
        }
    }
    for m in d.dependencies.iter_mut().flat_map(|x| x.modules.iter_mut()) {
        if let Some(r) = rects.get(&m.id) {
            m.position = Point {
                x: js_round(r.x),
                y: js_round(r.y),
            };
        }
    }
    let ids: Vec<Id> = d
        .modules
        .iter()
        .filter(|m| rects.contains_key(&m.id))
        .map(|m| m.id.clone())
        .collect();
    for id in &ids {
        grow_ancestors(&mut d, id);
    }
    if let Some(scope) = scope_id {
        let first = child_modules(&d, Some(scope))
            .next()
            .map_or_else(|| scope.to_string(), |m| m.id.clone());
        grow_ancestors(&mut d, &first);
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use scaffold_model::serialize::{Format, load_text};

    fn example(name: &str) -> Project {
        let path = format!("{}/../../../examples/{name}", env!("CARGO_MANIFEST_DIR"));
        load_text(&std::fs::read_to_string(path).unwrap(), Format::Yaml).unwrap()
    }

    fn overlap(a: &Rect, b: &Rect) -> bool {
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    }

    fn check_no_overlap(p: &Project) {
        let parents: Vec<Option<&str>> = std::iter::once(None)
            .chain(p.modules.iter().map(|m| Some(m.id.as_str())))
            .collect();
        for parent in parents {
            let siblings: Vec<&Module> = child_modules(p, parent).collect();
            for (i, a) in siblings.iter().enumerate() {
                for b in &siblings[i + 1..] {
                    assert!(!overlap(&a.layout, &b.layout), "{} / {}", a.name, b.name);
                }
            }
        }
    }

    fn check_children_inside(p: &Project) {
        for m in &p.modules {
            let Some(parent) = m.parent_id.as_deref().and_then(|id| find_module(p, id)) else {
                continue;
            };
            assert!(m.layout.x >= 0. && m.layout.y >= 0., "{}", m.name);
            assert!(m.layout.x + m.layout.width <= parent.layout.width, "{}", m.name);
            assert!(m.layout.y + m.layout.height <= parent.layout.height, "{}", m.name);
        }
    }

    fn by_name<'a>(p: &'a Project, n: &str) -> &'a Rect {
        &p.modules.iter().find(|m| m.name == n).unwrap().layout
    }

    fn arrange_all(p: &Project, o: Orientation) -> Project {
        arrange(
            p,
            None,
            &ArrangeOptions {
                orientation: o,
                spacing: 70.,
            },
        )
    }

    #[test]
    fn arranges_the_whole_project_without_overlaps() {
        let ex = example("robot.scaffold.yaml");
        let p = arrange(&ex, None, &ArrangeOptions::default());
        check_no_overlap(&p);
        check_children_inside(&p);
        let names = |p: &Project| p.modules.iter().map(|m| m.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&p), names(&ex));
    }

    #[test]
    fn arranges_the_content_of_one_module_only() {
        let ex = example("robot.scaffold.yaml");
        let core = ex.modules.iter().find(|m| m.name == "Core").unwrap();
        let p = arrange(&ex, Some(&core.id), &ArrangeOptions::default());
        check_no_overlap(&p);
        check_children_inside(&p);
        for m in p
            .modules
            .iter()
            .filter(|m| m.parent_id.is_none() && m.id != core.id)
        {
            assert_eq!(m.layout, ex.modules.iter().find(|x| x.id == m.id).unwrap().layout);
        }
    }

    #[test]
    fn fits_each_container_to_its_content() {
        let drone = example("fleet/drone.scaffold.yaml");
        for o in [Orientation::Horizontal, Orientation::Vertical] {
            let p = arrange_all(&drone, o);
            for m in &p.modules {
                let content: Vec<Rect> = child_modules(&p, Some(&m.id)).map(|c| c.layout).collect();
                if content.is_empty() {
                    continue;
                }
                let b = bounds_of(&content);
                assert_eq!(
                    b.y,
                    content_top(o, Compartments::of_module(m)) + LAYOUT_PAD / 2.,
                    "{}",
                    m.name
                );
                assert_eq!(m.layout.height - b.y - b.height, content_bottom(o), "{}", m.name);
                if o == Orientation::Vertical {
                    assert_eq!(m.layout.width - b.width, 2. * LAYOUT_PAD, "{}", m.name);
                }
            }
        }
    }

    #[test]
    fn fits_the_arranged_container_to_its_new_content() {
        let mut big = example("robot.scaffold.yaml");
        let core = big.modules.iter().position(|m| m.name == "Core").unwrap();
        big.modules[core].layout.width = 3000.;
        big.modules[core].layout.height = 3000.;
        let id = big.modules[core].id.clone();
        let p = arrange(&big, Some(&id), &ArrangeOptions::default());
        let layout = find_module(&p, &id).unwrap().layout;
        assert!(layout.width < 3000. && layout.height < 3000.);
        check_children_inside(&p);
    }

    #[test]
    fn handles_an_empty_project() {
        let mut ex = example("robot.scaffold.yaml");
        ex.modules.clear();
        ex.links.clear();
        let p = arrange(&ex, None, &ArrangeOptions::default());
        assert!(p.modules.is_empty());
    }

    #[test]
    fn vertical_moves_ports_to_top_bottom_and_layers_downwards() {
        let ex = example("robot.scaffold.yaml");
        let p = arrange_all(&ex, Orientation::Vertical);
        assert_eq!(p.orientation, Orientation::Vertical);
        check_no_overlap(&p);
        check_children_inside(&p);
        // Sensor sends to Controller and Logger: they are below it.
        let sensor = by_name(&p, "Sensor");
        for n in ["Controller", "Logger"] {
            assert!(by_name(&p, n).y > sensor.y + sensor.height, "{n}");
        }
    }

    #[test]
    fn vertical_centers_each_layer_on_its_container_axis() {
        let ex = example("robot.scaffold.yaml");
        let p = arrange_all(&ex, Orientation::Vertical);
        let (sensor, logger, controller) = (
            by_name(&p, "Sensor"),
            by_name(&p, "Logger"),
            by_name(&p, "Controller"),
        );
        let row = logger.x.min(controller.x) + (logger.x + logger.width).max(controller.x + controller.width);
        assert!((sensor.x + sensor.width / 2. - row / 2.).abs() <= 0.5);
    }

    #[test]
    fn arranges_horizontally_again() {
        let ex = example("robot.scaffold.yaml");
        let v = arrange_all(&ex, Orientation::Vertical);
        let h = arrange_all(&v, Orientation::Horizontal);
        assert_eq!(h.orientation, Orientation::Horizontal);
        check_no_overlap(&h);
        check_children_inside(&h);
    }

    #[test]
    fn layers_follow_the_links_horizontally() {
        let ex = example("robot.scaffold.yaml");
        let p = arrange_all(&ex, Orientation::Horizontal);
        let sensor = by_name(&p, "Sensor");
        for n in ["Controller", "Logger"] {
            assert!(by_name(&p, n).x > sensor.x + sensor.width, "{n}");
        }
    }

    #[test]
    fn arranges_every_example_without_overlaps() {
        for name in [
            "robot",
            "rover",
            "game",
            "shop",
            "fleet/drone",
            "fleet/ground",
            "vehicle",
        ] {
            let ex = example(&format!("{name}.scaffold.yaml"));
            for o in [Orientation::Horizontal, Orientation::Vertical] {
                let p = arrange_all(&ex, o);
                check_no_overlap(&p);
                check_children_inside(&p);
            }
        }
    }
}
