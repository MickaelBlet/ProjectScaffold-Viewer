//! Floating ports: each port of a module sits on the edge facing the modules it is linked to, so
//! that links leave from where the port is drawn. A container's port linked to its content keeps
//! its edge. Port of `canvas/portSides.ts`.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use scaffold_model::project::*;
use scaffold_model::types::*;

use crate::route::anchor_point;
use crate::scene::Pt;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub side: Side,
    /// Position along the edge (the linked ports' center); None keeps the port order.
    pub order: Option<f64>,
}

/// Ports by module, for the modules whose ports float.
pub type PortSides = HashMap<Id, IndexMap<Id, Placement>>;

pub fn default_side(role: PortRole, o: Orientation) -> Side {
    match (o, role) {
        (Orientation::Vertical, PortRole::In) => Side::Top,
        (Orientation::Vertical, PortRole::Out) => Side::Bottom,
        (_, PortRole::In) => Side::Left,
        (_, PortRole::Out) => Side::Right,
    }
}

fn center_x(r: &Rect) -> f64 {
    r.x + r.width / 2.
}
fn center_y(r: &Rect) -> f64 {
    r.y + r.height / 2.
}

/// Edge of `a` facing `b`.
pub fn facing_side(a: &Rect, b: &Rect, o: Orientation) -> Side {
    let below = b.y >= a.y + a.height;
    let v_gap = if below {
        b.y - (a.y + a.height)
    } else {
        a.y - (b.y + b.height)
    };
    let right = b.x >= a.x + a.width;
    let h_gap = if right {
        b.x - (a.x + a.width)
    } else {
        a.x - (b.x + b.width)
    };
    if o == Orientation::Horizontal {
        if v_gap > 0. && v_gap >= h_gap {
            return if below { Side::Bottom } else { Side::Top };
        }
        return if center_x(b) < center_x(a) {
            Side::Left
        } else {
            Side::Right
        };
    }
    if h_gap > 0. && h_gap >= v_gap {
        return if right { Side::Right } else { Side::Left };
    }
    if center_y(b) < center_y(a) {
        Side::Top
    } else {
        Side::Bottom
    }
}

/// Modules drawn with content: holding others.
pub fn container_ids(p: &Project) -> HashSet<Id> {
    p.modules.iter().filter_map(|m| m.parent_id.clone()).collect()
}

const SWEEPS: usize = 4;

fn port_point(r: &Rect, side: Side, i: usize, n: usize, rows_top: f64) -> Pt {
    let y = r.y + rows_top + PORT_ROW * (i as f64 + 0.5);
    let x = r.x + r.width * (i as f64 + 0.5) / n as f64;
    match side {
        Side::Left => Pt { x: r.x, y },
        Side::Right => Pt { x: r.x + r.width, y },
        Side::Top => Pt { x, y: r.y },
        Side::Bottom => Pt { x, y: r.y + r.height },
    }
}

const SIDES: [Side; 4] = [Side::Left, Side::Right, Side::Top, Side::Bottom];

/// Ports of a module on one edge, in drawing order (ids).
pub fn ports_on<'a>(ports: &'a [Id], placements: &IndexMap<Id, Placement>, side: Side) -> Vec<&'a Id> {
    let mut on: Vec<(usize, &Id, Option<f64>)> = ports
        .iter()
        .enumerate()
        .filter(|(_, id)| placements.get(*id).is_some_and(|p| p.side == side))
        .map(|(i, id)| (i, id, placements[id].order))
        .collect();
    // Linked ports follow the ports they link to; unlinked ones stay in their order, last.
    on.sort_by(|a, b| {
        let (x, y) = (a.2.unwrap_or(f64::INFINITY), b.2.unwrap_or(f64::INFINITY));
        x.partial_cmp(&y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    on.into_iter().map(|x| x.1).collect()
}

/// Ports drawn at a hand-set attachment of one of their links.
pub fn port_anchors(p: &Project, sides: Option<&PortSides>) -> HashMap<Id, LinkAnchor> {
    let mut out = HashMap::new();
    for l in &p.links {
        let route = l.route.as_ref();
        for (end, anchor) in [
            (&l.from, route.and_then(|r| r.from)),
            (&l.to, route.and_then(|r| r.to)),
        ] {
            let Some(anchor) = anchor else { continue };
            if out.contains_key(&end.port_id) {
                continue;
            }
            let placed = sides
                .and_then(|s| s.get(&end.module_id))
                .and_then(|m| m.get(&end.port_id));
            if placed.is_some_and(|pl| pl.side != anchor.side) {
                continue;
            }
            out.insert(end.port_id.clone(), anchor);
        }
    }
    out
}

pub fn free_ports(ports: &[Id], anchors: &HashMap<Id, LinkAnchor>) -> Vec<Id> {
    ports
        .iter()
        .filter(|id| !anchors.contains_key(*id))
        .cloned()
        .collect()
}

/// Top of a module's side port rows, relative to it (approximation used to order ports).
fn rows_top(
    free: &[Id],
    placements: &IndexMap<Id, Placement>,
    r: &Rect,
    container: bool,
    o: Orientation,
    floating: bool,
) -> f64 {
    let count = |side: Side| {
        free.iter()
            .filter(|id| placements.get(*id).is_some_and(|p| p.side == side))
            .count()
    };
    let vertical = o == Orientation::Vertical;
    let top_band = count(Side::Top) > 0 || (vertical && (!floating || container));
    let bottom_band = count(Side::Bottom) > 0 || (vertical && (!floating || container));
    let rows = count(Side::Left).max(count(Side::Right)) as f64;
    let body = MODULE_HEADER + if top_band { PORT_BAND } else { 0. };
    if container {
        return (r.height - rows * PORT_ROW) / 2.;
    }
    body + (r.height - body - if bottom_band { PORT_BAND } else { 0. } - rows * PORT_ROW) / 2.
}

fn place_ports(
    ports: &[Id],
    placements: &IndexMap<Id, Placement>,
    anchors: &HashMap<Id, LinkAnchor>,
    r: &Rect,
    rows_top: f64,
    out: &mut HashMap<Id, Pt>,
) {
    let free = free_ports(ports, anchors);
    for side in SIDES {
        let on = ports_on(&free, placements, side);
        let n = on.len();
        for (i, id) in on.into_iter().enumerate() {
            out.insert(id.clone(), port_point(r, side, i, n, rows_top));
        }
    }
    for id in ports {
        if let Some(a) = anchors.get(id) {
            out.insert(id.clone(), anchor_point(r, a));
        }
    }
}

/// A module or placed module: id and ports (id, role).
struct Mod {
    id: Id,
    ports: Vec<(Id, PortRole)>,
}

/// Placement of the ports of the visible modules (placed modules of dependencies included).
pub fn floating_port_sides(p: &Project, visible: &HashSet<Id>) -> PortSides {
    let parents = container_ids(p);
    let mut rects: HashMap<Id, Rect> = HashMap::new();
    let mut rect = |id: &str| {
        *rects
            .entry(id.to_string())
            .or_insert_with(|| absolute_rect(p, id))
    };
    let subtrees: HashMap<Id, HashSet<Id>> = p
        .modules
        .iter()
        .map(|m| (m.id.clone(), subtree_ids(p, &m.id)))
        .collect();
    let inside = |a: &str, b: &str| subtrees.get(a).is_some_and(|s| s.contains(b));
    let nested = |a: &str, b: &str| inside(a, b) || inside(b, a);

    struct End {
        side: Side,
        other: Endpoint,
        index: usize,
        anchored: bool,
    }
    let mut ends: HashMap<Id, Vec<End>> = HashMap::new();
    let mut pinned: HashSet<Id> = HashSet::new();
    for (index, l) in p.links.iter().enumerate() {
        for (end, other, anchor) in [
            (&l.from, &l.to, l.route.as_ref().and_then(|r| r.from)),
            (&l.to, &l.from, l.route.as_ref().and_then(|r| r.to)),
        ] {
            if !visible.contains(&end.module_id) {
                continue;
            }
            if parents.contains(&end.module_id) && inside(&end.module_id, &other.module_id) {
                pinned.insert(end.port_id.clone());
            }
            if anchor.is_none()
                && (!visible.contains(&other.module_id) || nested(&end.module_id, &other.module_id))
            {
                continue;
            }
            let side = match anchor {
                Some(a) => a.side,
                None => facing_side(&rect(&end.module_id), &rect(&other.module_id), p.orientation),
            };
            ends.entry(end.port_id.clone()).or_default().push(End {
                side,
                other: other.clone(),
                index,
                anchored: anchor.is_some(),
            });
        }
    }

    let modules: Vec<Mod> = p
        .modules
        .iter()
        .map(|m| Mod {
            id: m.id.clone(),
            ports: m.ports.iter().map(|x| (x.id.clone(), x.role)).collect(),
        })
        .chain(all_imported(p).map(|m| Mod {
            id: m.id.clone(),
            ports: m.ports.iter().map(|x| (x.id.clone(), x.role)).collect(),
        }))
        .filter(|m| visible.contains(&m.id))
        .collect();
    let mut out: PortSides = HashMap::new();
    for m in &modules {
        let mut placements = IndexMap::new();
        for (pid, role) in &m.ports {
            let fallback = default_side(*role, p.orientation);
            let list: Vec<&End> = ends
                .get(pid)
                .into_iter()
                .flatten()
                .filter(|v| v.anchored || !pinned.contains(pid))
                .collect();
            let mut count: IndexMap<Side, usize> = IndexMap::new();
            for v in &list {
                *count.entry(v.side).or_default() += 1;
            }
            let best = count.values().copied().max().unwrap_or(0);
            // Ties keep the default edge when it is one of them.
            let side = if list.is_empty() || count.get(&fallback) == Some(&best) {
                fallback
            } else {
                *count
                    .iter()
                    .find(|(_, n)| **n == best)
                    .map(|(s, _)| s)
                    .unwrap_or(&fallback)
            };
            placements.insert(pid.clone(), Placement { side, order: None });
        }
        out.insert(m.id.clone(), placements);
    }

    let anchors = port_anchors(p, Some(&out));
    let mut points: HashMap<Id, Pt> = HashMap::new();
    let ids = |m: &Mod| m.ports.iter().map(|x| x.0.clone()).collect::<Vec<_>>();
    let top = |m: &Mod, placements: &IndexMap<Id, Placement>, r: &Rect| {
        rows_top(
            &free_ports(&ids(m), &anchors),
            placements,
            r,
            parents.contains(&m.id),
            p.orientation,
            true,
        )
    };
    for m in &modules {
        let r = rect(&m.id);
        place_ports(
            &ids(m),
            &out[&m.id],
            &anchors,
            &r,
            top(m, &out[&m.id], &r),
            &mut points,
        );
    }
    for _ in 0..SWEEPS {
        for m in &modules {
            let r = rect(&m.id);
            let mut placements = out[&m.id].clone();
            for (pid, _) in &m.ports {
                let side = placements[pid].side;
                if pinned.contains(pid) || anchors.contains_key(pid) {
                    continue;
                }
                let horizontal_axis = matches!(side, Side::Top | Side::Bottom);
                // Links between the same two ports keep their order at both ends.
                let at: Vec<f64> = ends
                    .get(pid)
                    .into_iter()
                    .flatten()
                    .filter(|e| e.side == side)
                    .filter_map(|e| {
                        points
                            .get(&e.other.port_id)
                            .map(|pt| if horizontal_axis { pt.x } else { pt.y } + e.index as f64 * 1e-6)
                    })
                    .collect();
                if at.is_empty() {
                    continue;
                }
                placements[pid] = Placement {
                    side,
                    order: Some(at.iter().sum::<f64>() / at.len() as f64),
                };
            }
            place_ports(
                &ids(m),
                &placements,
                &anchors,
                &r,
                top(m, &placements, &r),
                &mut points,
            );
            out.insert(m.id.clone(), placements);
        }
    }
    out
}

/// Height a module needs to draw its ports where they are placed, below its compartments.
pub fn needed_height(ports: &[Id], placements: &IndexMap<Id, Placement>, compartments: f64) -> f64 {
    let count = |side: Side| ports_on(ports, placements, side).len();
    let rows = count(Side::Left).max(count(Side::Right)) as f64;
    let bands = usize::from(count(Side::Top) > 0) + usize::from(count(Side::Bottom) > 0);
    MODULE_HEADER
        + compartments
        + bands as f64 * PORT_BAND
        + if rows > 0. { rows * PORT_ROW + 12. } else { 12. }
}
