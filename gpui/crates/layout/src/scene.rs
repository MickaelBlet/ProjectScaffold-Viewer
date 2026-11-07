//! Geometry of a view as the canvas draws it: modules, ports, notes and links in absolute canvas
//! coordinates. Mirrors what React Flow lays out from the DOM in the web build (`flowGraph.ts`,
//! `ModuleNode.tsx`, the CSS of `.module`), first for the project view.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use scaffold_model::project::*;
use scaffold_model::types::*;

use crate::port_sides::{
    Placement, container_ids, floating_port_sides, free_ports, needed_height, port_anchors, ports_on,
};
use crate::route::{anchor_point, curve, dir, label_at, nearest_anchor, opposite, point_along};

/// Height of a row of side ports (`.port-row`).
pub const PORT_ROW_H: f64 = 24.;
/// Size of a port handle (`.handle`).
pub const HANDLE: f64 = 10.;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PortBox {
    pub id: Id,
    pub name: String,
    pub role: PortRole,
    pub interface: Option<String>,
    /// Edge of the module the port sits on.
    pub side: Side,
    /// Center of its handle.
    pub at: Pt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeKind {
    Module,
    /// A module holding others: drawn dashed, behind its content.
    Container,
    /// A placed module of a dependency.
    Imported,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NodeBox {
    pub id: Id,
    pub kind: NodeKind,
    pub rect: Rect,
    pub depth: usize,
    pub ports: Vec<PortBox>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LinkPath {
    pub id: Id,
    pub color: String,
    pub bidirectional: bool,
    pub remote: bool,
    /// Cubic segments: start, then (control a, control b, end) triples.
    pub start: Pt,
    pub segments: Vec<[Pt; 3]>,
    pub start_side: Side,
    pub end_side: Side,
    /// Middle of the path, for its badges.
    pub label: Pt,
    /// Badges: acknowledgement (with timeout), performance class when not normal, transport.
    pub ack: Option<String>,
    pub perf: Option<PerformanceClass>,
    pub transport: Option<String>,
}

/// UML generalization from a module to its base: a line ending in a hollow triangle on the base.
#[derive(Clone, Debug, PartialEq)]
pub struct InheritPath {
    pub start: Pt,
    pub segments: Vec<[Pt; 3]>,
    /// Tip of the triangle, on the base, and the unit vector the line reaches it along.
    pub tip: Pt,
    pub dir: Pt,
    /// The base is an interface: dashed, as a UML realization.
    pub realization: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scene {
    /// Back to front: notes and frames are separate.
    pub nodes: Vec<NodeBox>,
    pub notes: Vec<Note>,
    pub links: Vec<LinkPath>,
    pub inherits: Vec<InheritPath>,
}

impl Scene {
    /// Bounding box of everything drawn.
    pub fn bounds(&self) -> Rect {
        let rects: Vec<Rect> = self
            .nodes
            .iter()
            .map(|n| n.rect)
            .chain(self.notes.iter().map(|n| n.layout))
            .collect();
        bounds_of(&rects)
    }

    pub fn port(&self, module: &str, port: &str) -> Option<&PortBox> {
        self.nodes
            .iter()
            .find(|n| n.id == module)?
            .ports
            .iter()
            .find(|p| p.id == port)
    }
}

pub fn perf_color(c: PerformanceClass) -> &'static str {
    match c {
        PerformanceClass::Realtime => "#e0513b",
        PerformanceClass::Low => "#d98b00",
        PerformanceClass::Normal => "#7a8496",
        PerformanceClass::Bulk => "#3b8fd1",
    }
}

/// Distance of a bezier control point from its end (React Flow's `calculateControlOffset`).
fn control_offset(distance: f64, curvature: f64) -> f64 {
    if distance >= 0. {
        0.5 * distance
    } else {
        curvature * 25. * (-distance).sqrt()
    }
}

fn control(side: Side, from: Pt, to: Pt) -> Pt {
    const C: f64 = 0.25;
    match side {
        Side::Left => Pt {
            x: from.x - control_offset(from.x - to.x, C),
            y: from.y,
        },
        Side::Right => Pt {
            x: from.x + control_offset(to.x - from.x, C),
            y: from.y,
        },
        Side::Top => Pt {
            x: from.x,
            y: from.y - control_offset(from.y - to.y, C),
        },
        Side::Bottom => Pt {
            x: from.x,
            y: from.y + control_offset(to.y - from.y, C),
        },
    }
}

/// Bezier link between two handles (React Flow's `getBezierPath`).
pub fn bezier(s: Pt, s_side: Side, t: Pt, t_side: Side) -> ([Pt; 3], Pt) {
    let c1 = control(s_side, s, t);
    let c2 = control(t_side, t, s);
    // Point at u = 0.5 of the cubic.
    let mid = Pt {
        x: s.x * 0.125 + c1.x * 0.375 + c2.x * 0.375 + t.x * 0.125,
        y: s.y * 0.125 + c1.y * 0.375 + c2.y * 0.375 + t.y * 0.125,
    };
    ([c1, c2, t], mid)
}

/// A port to place: id, name, role, interface name.
type PortInfo = (Id, String, PortRole, Option<String>);

/// Ports of a module where the canvas draws them (`ModuleNode`): `top` / `bottom` bands, side
/// rows centered below the header and compartments (on a container's frame), hand-set anchors.
fn place(
    rect: Rect,
    ports: &[PortInfo],
    placements: &IndexMap<Id, Placement>,
    anchors: &HashMap<Id, LinkAnchor>,
    compartments: f64,
    container: bool,
    o: Orientation,
) -> Vec<PortBox> {
    let ids: Vec<Id> = ports.iter().map(|x| x.0.clone()).collect();
    let free = free_ports(&ids, anchors);
    let on = |side| {
        ports_on(&free, placements, side)
            .into_iter()
            .cloned()
            .collect::<Vec<Id>>()
    };
    let (left, right, top, bottom) = (on(Side::Left), on(Side::Right), on(Side::Top), on(Side::Bottom));
    let vertical = o == Orientation::Vertical;
    let top_band = !top.is_empty() || (vertical && container);
    let bottom_band = !bottom.is_empty() || (vertical && container);
    // Container bands are outside the frame in horizontal orientation.
    let inside_bands = !container || vertical;
    let rows = left.len().max(right.len()) as f64;
    let rows_top = if container {
        (rect.height - rows * PORT_ROW_H) / 2.
    } else {
        let body = MODULE_HEADER + compartments + if top_band && inside_bands { PORT_BAND } else { 0. };
        let free_h = rect.height
            - body
            - if bottom_band && inside_bands {
                PORT_BAND
            } else {
                0.
            };
        body + (free_h - rows * PORT_ROW_H) / 2.
    };
    let info = |id: &Id| ports.iter().find(|x| &x.0 == id).expect("port");
    let mut out = Vec::new();
    let mut push = |id: &Id, side: Side, at: Pt| {
        let (_, name, role, iface) = info(id);
        out.push(PortBox {
            id: id.clone(),
            name: name.clone(),
            role: *role,
            interface: iface.clone(),
            side,
            at,
        });
    };
    for (list, side, x) in [
        (&left, Side::Left, rect.x),
        (&right, Side::Right, rect.x + rect.width),
    ] {
        for (i, id) in list.iter().enumerate() {
            push(
                id,
                side,
                Pt {
                    x,
                    y: rect.y + rows_top + (i as f64 + 0.5) * PORT_ROW_H,
                },
            );
        }
    }
    for (list, side, y) in [
        (&top, Side::Top, rect.y),
        (&bottom, Side::Bottom, rect.y + rect.height),
    ] {
        let n = list.len() as f64;
        for (i, id) in list.iter().enumerate() {
            push(
                id,
                side,
                Pt {
                    x: rect.x + rect.width * (i as f64 + 0.5) / n,
                    y,
                },
            );
        }
    }
    for id in &ids {
        if let Some(a) = anchors.get(id) {
            push(id, a.side, anchor_point(&rect, a));
        }
    }
    out
}

/// Scene of the project view (every module, placed modules of dependencies, the project's notes).
pub fn project_scene(p: &Project) -> Scene {
    let o = p.orientation;
    let parents = container_ids(p);
    let visible: HashSet<Id> = p
        .modules
        .iter()
        .map(|m| m.id.clone())
        .chain(all_imported(p).map(|m| m.id.clone()))
        .collect();
    let sides = floating_port_sides(p, &visible);
    let anchors = port_anchors(p, Some(&sides));
    let paths = project_module_paths(p);
    let iface_name = |id: &Option<Id>| -> Option<String> {
        id.as_ref().map(|i| {
            p.interfaces
                .iter()
                .find(|x| &x.id == i)
                .map_or("?".into(), |x| x.name.clone())
        })
    };
    let mut nodes = Vec::new();
    let mut add = |id: &Id,
                   kind: NodeKind,
                   rect: Rect,
                   depth: usize,
                   ports: Vec<PortInfo>,
                   comp: f64,
                   container: bool| {
        let placements = &sides[id];
        let ids: Vec<Id> = ports.iter().map(|x| x.0.clone()).collect();
        // Leaves grow to fit the ports placed on their edges.
        let mut rect = rect;
        if !container {
            rect.height = rect
                .height
                .max(needed_height(&free_ports(&ids, &anchors), placements, comp));
        }
        let ports = place(rect, &ports, placements, &anchors, comp, container, o);
        nodes.push(NodeBox {
            id: id.clone(),
            kind,
            rect,
            depth,
            ports,
        });
    };
    for m in &p.modules {
        let pos = absolute_position(p, &m.id);
        let rect = Rect {
            x: pos.x,
            y: pos.y,
            width: m.layout.width,
            height: m.layout.height,
        };
        let container = parents.contains(&m.id);
        let ports = m
            .ports
            .iter()
            .map(|pt| {
                (
                    pt.id.clone(),
                    pt.name.clone(),
                    pt.role,
                    iface_name(&pt.interface_id),
                )
            })
            .collect();
        let kind = if container {
            NodeKind::Container
        } else {
            NodeKind::Module
        };
        let comp = compartments_height(Compartments::of_module(m));
        add(
            &m.id,
            kind,
            rect,
            paths[&m.id].split('.').count(),
            ports,
            comp,
            container,
        );
    }
    for dep in &p.dependencies {
        for m in &dep.modules {
            let pos = absolute_position(p, &m.id);
            let size = imported_size(m, o);
            let rect = Rect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            };
            let holds = dep
                .modules
                .iter()
                .any(|x| parent_path(&x.path) == Some(m.path.as_str()));
            let ports = m
                .ports
                .iter()
                .map(|pt| (pt.id.clone(), pt.name.clone(), pt.role, pt.interface.clone()))
                .collect();
            let comp = compartments_height(Compartments::of_imported(m));
            add(
                &m.id,
                NodeKind::Imported,
                rect,
                m.path.split('.').count(),
                ports,
                comp,
                holds,
            );
        }
    }
    // Parents behind their content.
    nodes.sort_by_key(|n| (n.kind != NodeKind::Container, n.depth));
    let by_id: HashMap<&str, &NodeBox> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut links = Vec::new();
    for l in &p.links {
        let node = |e: &Endpoint| by_id.get(e.module_id.as_str()).copied();
        let port = |e: &Endpoint| node(e).and_then(|n| n.ports.iter().find(|x| x.id == e.port_id));
        let (Some(a), Some(b), Some(na), Some(nb)) = (port(&l.from), port(&l.to), node(&l.from), node(&l.to))
        else {
            continue;
        };
        let route = l.route.as_ref();
        // The end of a link: at its port's handle (outside the border), or at a hand-set attachment.
        let end = |pb: &PortBox, n: &NodeBox, anchor: Option<LinkAnchor>| -> (Pt, Side) {
            if let Some(a) = anchor {
                let at = anchor_point(&n.rect, &a);
                if (at.x - pb.at.x).hypot(at.y - pb.at.y) >= 12. {
                    return (at, a.side);
                }
            }
            let d = dir(pb.side);
            (
                Pt {
                    x: pb.at.x + d.x * HANDLE / 2.,
                    y: pb.at.y + d.y * HANDLE / 2.,
                },
                pb.side,
            )
        };
        let (mut s, mut s_side) = end(a, na, route.and_then(|r| r.from));
        let (mut t, mut t_side) = end(b, nb, route.and_then(|r| r.to));
        // A container's end of a link to its content leaves inwards, from the edge it sits on.
        let inwards = |n: &NodeBox, at: Pt| -> (Pt, Side) {
            let side = opposite(nearest_anchor(&n.rect, at).side);
            let d = dir(side);
            (
                Pt {
                    x: at.x + d.x * HANDLE,
                    y: at.y + d.y * HANDLE,
                },
                side,
            )
        };
        let subtree = |id: &str, of: &str| subtree_ids(p, id).contains(of) && id != of;
        if subtree(&l.from.module_id, &l.to.module_id) {
            (s, s_side) = inwards(na, s);
        }
        if subtree(&l.to.module_id, &l.from.module_id) {
            (t, t_side) = inwards(nb, t);
        }
        // Bend points are relative to the innermost module holding both ends.
        let offset = link_origin(p, &l.from.module_id, &l.to.module_id)
            .map(|o| absolute_position(p, &o))
            .unwrap_or(Point { x: 0., y: 0. });
        let points: Vec<Pt> = route.map_or(vec![], |r| {
            r.points
                .iter()
                .map(|q| Pt {
                    x: q.x + offset.x,
                    y: q.y + offset.y,
                })
                .collect()
        });
        let shaped = curve(s, s_side, t, t_side, &points);
        let label = match route.and_then(|r| r.label) {
            Some(at) => point_along(&shaped.line, at),
            None if points.is_empty() => bezier(s, s_side, t, t_side).1,
            None => label_at(&shaped.line, &shaped.marks),
        };
        let segments = if points.is_empty() {
            vec![bezier(s, s_side, t, t_side).0]
        } else {
            shaped.segments
        };
        links.push(LinkPath {
            id: l.id.clone(),
            color: l
                .color
                .clone()
                .unwrap_or_else(|| perf_color(l.constraints.performance.class).into()),
            bidirectional: l.constraints.direction == Direction::Bidirectional,
            remote: l.constraints.remote.enabled,
            start: s,
            segments,
            start_side: s_side,
            end_side: t_side,
            label,
            ack: l
                .constraints
                .ack
                .required
                .then(|| match l.constraints.ack.timeout_ms {
                    Some(t) => format!(
                        "ACK {}ms",
                        scaffold_model::emit::js_number(&serde_json::Number::from_f64(t).unwrap_or(0.into()))
                    ),
                    None => "ACK".into(),
                }),
            perf: (l.constraints.performance.class != PerformanceClass::Normal)
                .then_some(l.constraints.performance.class),
            transport: l.constraints.remote.enabled.then(|| {
                l.constraints
                    .remote
                    .transport
                    .clone()
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| "remote".into())
            }),
        });
    }
    let inherits = inherit_paths(p, &by_id);
    let notes = p.notes.iter().filter(|n| n.view_id.is_none()).cloned().collect();
    Scene {
        nodes,
        notes,
        links,
        inherits,
    }
}

const ARROW: f64 = 14.;

fn contains(outer: &Rect, inner: &Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height
}

/// Where the line meets the modules (bezier style), leaving and reaching them square to their sides.
fn inherit_ends(s: &Rect, t: &Rect, inset: f64) -> ((Pt, Side), (Pt, Side)) {
    let cx = |b: &Rect| b.x + b.width / 2.;
    let cy = |b: &Rect| b.y + b.height / 2.;
    if contains(t, s) {
        let x = cx(s);
        return (
            (Pt { x, y: s.y }, Side::Top),
            (Pt { x, y: t.y + inset }, Side::Bottom),
        );
    }
    if contains(s, t) {
        let x = cx(t);
        return (
            (Pt { x, y: s.y + inset }, Side::Bottom),
            (Pt { x, y: t.y }, Side::Top),
        );
    }
    let v_gap = (t.y - (s.y + s.height)).max(s.y - (t.y + t.height));
    let h_gap = (t.x - (s.x + s.width)).max(s.x - (t.x + t.width));
    let middle = |lo: f64, hi: f64, a: f64, b: f64| {
        if lo <= hi {
            ((lo + hi) / 2., (lo + hi) / 2.)
        } else {
            (a, b)
        }
    };
    if v_gap > 0. && v_gap >= h_gap {
        let below = t.y > s.y;
        let (sx, tx) = middle(s.x.max(t.x), (s.x + s.width).min(t.x + t.width), cx(s), cx(t));
        return (
            (
                Pt {
                    x: sx,
                    y: if below { s.y + s.height } else { s.y },
                },
                if below { Side::Bottom } else { Side::Top },
            ),
            (
                Pt {
                    x: tx,
                    y: if below { t.y } else { t.y + t.height },
                },
                if below { Side::Top } else { Side::Bottom },
            ),
        );
    }
    let right = cx(t) > cx(s);
    let (sy, ty) = middle(s.y.max(t.y), (s.y + s.height).min(t.y + t.height), cy(s), cy(t));
    (
        (
            Pt {
                x: if right { s.x + s.width } else { s.x },
                y: sy,
            },
            if right { Side::Right } else { Side::Left },
        ),
        (
            Pt {
                x: if right { t.x } else { t.x + t.width },
                y: ty,
            },
            if right { Side::Left } else { Side::Right },
        ),
    )
}

/// Inheritance lines between the drawn modules (`inheritEdges.ts`, `InheritEdge.tsx`).
fn inherit_paths(p: &Project, by_id: &HashMap<&str, &NodeBox>) -> Vec<InheritPath> {
    let mut out = Vec::new();
    for m in &p.modules {
        for b in m.bases.iter().flatten() {
            let (Some(sn), Some(tn)) = (by_id.get(m.id.as_str()), by_id.get(b.as_str())) else {
                continue;
            };
            if b == &m.id {
                continue;
            }
            let base = find_module(p, b);
            let outer = base.and_then(|base| {
                if subtree_ids(p, &base.id).contains(&m.id) {
                    Some(base)
                } else if subtree_ids(p, &m.id).contains(&base.id) {
                    Some(m)
                } else {
                    None
                }
            });
            let inset = outer.map_or(0., |o| content_top(p.orientation, Compartments::of_module(o)));
            let ((from, fs), (to, ts)) = inherit_ends(&sn.rect, &tn.rect, inset);
            let length = (to.x - from.x).hypot(to.y - from.y);
            if length < ARROW {
                continue;
            }
            let straight = from.x == to.x || from.y == to.y;
            let d = dir(ts);
            let u = if straight {
                Pt {
                    x: (to.x - from.x) / length,
                    y: (to.y - from.y) / length,
                }
            } else {
                Pt { x: -d.x, y: -d.y }
            };
            let end = Pt {
                x: to.x - u.x * ARROW,
                y: to.y - u.y * ARROW,
            };
            let (seg, _) = bezier(from, fs, end, ts);
            out.push(InheritPath {
                start: from,
                segments: vec![seg],
                tip: to,
                dir: u,
                realization: base.is_some_and(|b| b.kind == Some(ModuleKind::Interface)),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bezier_like_react_flow() {
        let (seg, mid) = bezier(
            Pt { x: 0., y: 0. },
            Side::Right,
            Pt { x: 100., y: 50. },
            Side::Left,
        );
        assert_eq!(seg[0], Pt { x: 50., y: 0. });
        assert_eq!(seg[1], Pt { x: 50., y: 50. });
        assert_eq!(mid, Pt { x: 50., y: 25. });
    }
}
