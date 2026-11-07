//! Canvas of a project view: modules, ports, notes and links, panned and zoomed.

use std::cell::Cell;
use std::collections::HashSet;
use std::rc::Rc;

use gpui_kit::*;
use scaffold_layout::scene::{
    InheritPath, LinkPath, NodeBox, NodeKind, Pt, Scene, perf_color, project_scene,
};
use scaffold_model::edit::{RectPatch, reparent_module, set_layouts};
use scaffold_model::grid::snap_changes;
use scaffold_model::project::{
    MODULE_HEADER, absolute_position, find_imported, find_module, imported_index, subtree_ids,
};
use scaffold_model::types::{Id, NoteKind, PortRole, Project, Rect, Side};

use crate::document::{Document, GRID};
use crate::node::{self, Run, RunStyle};
use crate::theme::{Theme, alpha, hex, light};

/// What a pointer drag does.
enum Gesture {
    None,
    /// Panning the view, from the last pointer position.
    Pan(Point<Pixels>),
    /// Moving items: canvas point where it started and the offset so far.
    Move {
        start: Pt,
        ids: Vec<Id>,
        offset: Pt,
        /// Item under the pointer, selected alone on a click without moving.
        clicked: Id,
        additive: bool,
    },
    /// Selecting the items inside a box, between canvas points.
    Marquee {
        start: Pt,
        end: Pt,
    },
    /// Pressed on the empty canvas: a click clears the selection, a drag pans.
    Pane(Point<Pixels>),
}

/// Distance (screen pixels) a press must travel to become a drag.
const DRAG_SLOP: f64 = 3.;

pub struct Canvas {
    doc: Entity<Document>,
    /// Version of the document the scene was built from.
    version: u64,
    /// Project drawn: the document's, or a preview while dragging.
    project: Project,
    scene: Scene,
    selected: HashSet<Id>,
    /// Canvas point at the view's top-left corner, and pixels per canvas unit.
    origin: Pt,
    zoom: f64,
    gesture: Gesture,
    /// Bounds of the canvas as last laid out.
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// Size the view was fitted to; None once the user moved the view.
    fitted: Option<Option<Size<Pixels>>>,
}

impl Canvas {
    pub fn new(doc: Entity<Document>, cx: &mut Context<Self>) -> Self {
        cx.observe(&doc, |this, _, cx| {
            this.sync(cx);
            cx.notify();
        })
        .detach();
        let d = doc.read(cx);
        let project = d.project.clone();
        let selected = d.selected.iter().cloned().collect();
        let version = d.version;
        Canvas {
            scene: project_scene(&project),
            project,
            selected,
            version,
            doc,
            origin: Pt { x: 0., y: 0. },
            zoom: 1.,
            gesture: Gesture::None,
            bounds: Rc::new(Cell::new(None)),
            fitted: Some(None),
        }
    }

    /// Window position of a canvas point (tests).
    #[cfg(test)]
    pub fn window_point(&self, p: Pt) -> Point<Pixels> {
        let o = self.bounds.get().map_or(point(px(0.), px(0.)), |b| b.origin);
        let (x, y) = self.screen(p);
        point(o.x + px(x), o.y + px(y))
    }

    /// Rect of a drawn module or note (tests).
    #[cfg(test)]
    pub fn rect_of(&self, id: &str) -> Option<Rect> {
        self.scene
            .nodes
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.rect)
            .or_else(|| self.scene.notes.iter().find(|n| n.id == id).map(|n| n.layout))
    }

    /// Rebuild the scene after a change of the document.
    fn sync(&mut self, cx: &App) {
        let d = self.doc.read(cx);
        if d.version == self.version {
            return;
        }
        self.version = d.version;
        self.selected = d.selected.iter().cloned().collect();
        if self.project != d.project {
            self.project = d.project.clone();
            self.scene = project_scene(&self.project);
        }
    }

    pub fn fit_view(&mut self, cx: &mut Context<Self>) {
        self.fitted = Some(None);
        cx.notify();
    }

    fn fit(&mut self, size: Size<Pixels>) {
        let b = self.scene.bounds();
        let (w, h) = (f64::from(size.width), f64::from(size.height));
        if b.width <= 0. || w <= 0. {
            return;
        }
        let pad = 40.;
        self.zoom = ((w - 2. * pad) / b.width)
            .min((h - 2. * pad) / b.height)
            .clamp(0.1, 1.5);
        self.origin = Pt {
            x: b.x - (w / self.zoom - b.width) / 2.,
            y: b.y - (h / self.zoom - b.height) / 2.,
        };
    }

    fn screen(&self, p: Pt) -> (f32, f32) {
        (
            ((p.x - self.origin.x) * self.zoom) as f32,
            ((p.y - self.origin.y) * self.zoom) as f32,
        )
    }

    /// Canvas point under a window position.
    fn to_canvas(&self, at: Point<Pixels>) -> Pt {
        let o = self.bounds.get().map_or(point(px(0.), px(0.)), |b| b.origin);
        Pt {
            x: self.origin.x + f64::from(at.x - o.x) / self.zoom,
            y: self.origin.y + f64::from(at.y - o.y) / self.zoom,
        }
    }

    fn on_scroll(&mut self, ev: &ScrollEvent, cx: &mut Context<Self>) {
        self.fitted = None;
        let d = ev.delta.pixel_delta(px(20.));
        if ev.modifiers.control || ev.modifiers.platform {
            // Zoom around the pointer.
            let factor = (-f64::from(d.y) / 400.).exp();
            let at = self.to_canvas(ev.position);
            let o = self.bounds.get().map_or(point(px(0.), px(0.)), |b| b.origin);
            let (lx, ly) = (f64::from(ev.position.x - o.x), f64::from(ev.position.y - o.y));
            self.zoom = (self.zoom * factor).clamp(0.05, 4.);
            self.origin = Pt {
                x: at.x - lx / self.zoom,
                y: at.y - ly / self.zoom,
            };
        } else {
            self.origin.x -= f64::from(d.x) / self.zoom;
            self.origin.y -= f64::from(d.y) / self.zoom;
        }
        cx.notify();
    }

    /// Whether a node is drawn behind the links, as a container.
    fn holds(&self, n: &NodeBox) -> bool {
        n.kind == NodeKind::Container
            || (n.kind == NodeKind::Imported
                && self
                    .scene
                    .nodes
                    .iter()
                    .any(|o| o.id != n.id && o.depth > n.depth && contains(&n.rect, &o.rect)))
    }

    /// Item under a canvas point, front to back: notes, modules, links, containers, frames.
    fn hit(&self, p: Pt) -> Option<Id> {
        let inside = |r: &Rect| p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
        let notes = |kind: NoteKind| {
            self.scene
                .notes
                .iter()
                .rev()
                .find(|n| n.kind == kind && inside(&n.layout))
                .map(|n| n.id.clone())
        };
        if let Some(id) = notes(NoteKind::Note) {
            return Some(id);
        }
        if let Some(n) = self
            .scene
            .nodes
            .iter()
            .rev()
            .find(|n| !self.holds(n) && inside(&n.rect))
        {
            return Some(n.id.clone());
        }
        let reach = 6. / self.zoom;
        if let Some(l) = self
            .scene
            .links
            .iter()
            .rev()
            .find(|l| near_path(l.start, &l.segments, p, reach))
        {
            return Some(l.id.clone());
        }
        if let Some(n) = self
            .scene
            .nodes
            .iter()
            .filter(|n| self.holds(n) && inside(&n.rect))
            .max_by_key(|n| n.depth)
        {
            return Some(n.id.clone());
        }
        notes(NoteKind::Frame)
    }

    fn is_link(&self, id: &str) -> bool {
        self.project.links.iter().any(|l| l.id == id)
    }

    fn on_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let _ = window;
        let at = self.to_canvas(ev.position);
        let additive = ev.modifiers.shift || ev.modifiers.control || ev.modifiers.platform;
        let Some(id) = self.hit(at) else {
            self.gesture = if ev.modifiers.shift {
                Gesture::Marquee { start: at, end: at }
            } else {
                Gesture::Pane(ev.position)
            };
            return;
        };
        let mut sel: Vec<Id> = self.doc.read(cx).selected.clone();
        if additive {
            if let Some(i) = sel.iter().position(|x| *x == id) {
                sel.remove(i);
            } else {
                sel.push(id.clone());
            }
        } else if !sel.contains(&id) {
            sel = vec![id.clone()];
        }
        self.doc.update(cx, |d, cx| {
            d.select(sel.clone());
            cx.notify();
        });
        let ids = if sel.contains(&id) && !self.is_link(&id) {
            movable(&self.project, &sel)
        } else {
            Vec::new()
        };
        self.gesture = Gesture::Move {
            start: at,
            ids,
            offset: Pt { x: 0., y: 0. },
            clicked: id,
            additive,
        };
    }

    fn on_move(&mut self, ev: &MouseMoveEvent, cx: &mut Context<Self>) {
        if ev.pressed_button.is_none() {
            if !matches!(self.gesture, Gesture::None) {
                self.finish(cx);
            }
            return;
        }
        let at = self.to_canvas(ev.position);
        match &mut self.gesture {
            Gesture::None => {}
            Gesture::Pane(from) => {
                let d = ev.position - *from;
                if f64::from(d.x).hypot(f64::from(d.y)) > DRAG_SLOP {
                    self.gesture = Gesture::Pan(*from);
                    self.on_move(ev, cx);
                }
            }
            Gesture::Pan(last) => {
                self.fitted = None;
                let d = ev.position - *last;
                self.origin.x -= f64::from(d.x) / self.zoom;
                self.origin.y -= f64::from(d.y) / self.zoom;
                *last = ev.position;
                cx.notify();
            }
            Gesture::Marquee { end, .. } => {
                *end = at;
                cx.notify();
            }
            Gesture::Move {
                start, ids, offset, ..
            } => {
                let o = Pt {
                    x: at.x - start.x,
                    y: at.y - start.y,
                };
                if offset.x == 0. && offset.y == 0. && o.x.hypot(o.y) * self.zoom <= DRAG_SLOP {
                    return;
                }
                *offset = o;
                if ids.is_empty() {
                    return;
                }
                let doc = self.doc.read(cx);
                let mut preview = doc.project.clone();
                moved(&mut preview, ids, o);
                if GRID.snap {
                    snap_changes(&doc.project, &mut preview, GRID.size);
                }
                self.scene = project_scene(&preview);
                self.project = preview;
                cx.notify();
            }
        }
    }

    fn on_up(&mut self, _: &MouseUpEvent, cx: &mut Context<Self>) {
        self.finish(cx);
    }

    /// End of a press: commit a move, select a box, or select on a click.
    fn finish(&mut self, cx: &mut Context<Self>) {
        match std::mem::replace(&mut self.gesture, Gesture::None) {
            Gesture::None | Gesture::Pan(_) => {}
            Gesture::Pane(_) => self.doc.update(cx, |d, cx| {
                d.select(Vec::new());
                cx.notify();
            }),
            Gesture::Marquee { start, end } => {
                let r = Rect {
                    x: start.x.min(end.x),
                    y: start.y.min(end.y),
                    width: (end.x - start.x).abs(),
                    height: (end.y - start.y).abs(),
                };
                let ids: Vec<Id> = self
                    .scene
                    .nodes
                    .iter()
                    .filter(|n| contains(&r, &n.rect))
                    .map(|n| n.id.clone())
                    .chain(
                        self.scene
                            .notes
                            .iter()
                            .filter(|n| contains(&r, &n.layout))
                            .map(|n| n.id.clone()),
                    )
                    .collect();
                self.doc.update(cx, |d, cx| {
                    let mut sel = d.selected.clone();
                    sel.extend(ids.into_iter().filter(|i| !d.selected.contains(i)));
                    d.select(sel);
                    cx.notify();
                });
                cx.notify();
            }
            Gesture::Move {
                ids,
                offset,
                clicked,
                additive,
                ..
            } => {
                if offset.x == 0. && offset.y == 0. {
                    if !additive {
                        self.doc.update(cx, |d, cx| {
                            d.select(vec![clicked]);
                            cx.notify();
                        });
                    }
                    return;
                }
                if ids.is_empty() {
                    return;
                }
                let target = (ids.len() == 1).then(|| self.drop_target(&ids[0])).flatten();
                let preview = self.project.clone();
                self.doc.update(cx, |d, cx| {
                    d.seal();
                    d.edit(GRID, |p| match target {
                        Some((parent, x, y)) => reparent_module(p, &ids[0], parent.as_deref(), x, y),
                        None => moved(p, &ids, offset),
                    });
                    d.seal();
                    cx.notify();
                });
                // The document may not have changed (a move back): drop the preview.
                if self.doc.read(cx).project != preview {
                    self.version = u64::MAX;
                    self.sync(cx);
                } else {
                    self.version = self.doc.read(cx).version;
                }
                cx.notify();
            }
        }
    }

    /// New parent of a module dropped on the canvas (with its place in it), when it changes: the
    /// deepest module under its center, outside its own subtree.
    #[allow(clippy::type_complexity)]
    fn drop_target(&self, id: &str) -> Option<(Option<Id>, f64, f64)> {
        let p = &self.project;
        let m = find_module(p, id)?;
        let abs = absolute_position(p, id);
        let center = Pt {
            x: abs.x + m.layout.width / 2.,
            y: abs.y + m.layout.height / 2.,
        };
        let own = subtree_ids(p, id);
        let target = self
            .scene
            .nodes
            .iter()
            .filter(|n| n.kind != NodeKind::Imported && !own.contains(&n.id))
            .filter(|n| {
                let r = &n.rect;
                center.x >= r.x && center.y >= r.y && center.x <= r.x + r.width && center.y <= r.y + r.height
            })
            .max_by_key(|n| n.depth)
            .map(|n| n.id.clone());
        if target == m.parent_id {
            return None;
        }
        let base = target
            .as_deref()
            .map_or(scaffold_model::types::Point { x: 0., y: 0. }, |t| {
                absolute_position(p, t)
            });
        Some((target, (abs.x - base.x).round(), (abs.y - base.y).round()))
    }

    fn node(&self, n: &NodeBox, t: &Theme) -> Div {
        let z = self.zoom as f32;
        let p = &self.project;
        let (x, y) = self.screen(Pt {
            x: n.rect.x,
            y: n.rect.y,
        });
        let (w, h) = (
            (n.rect.width * self.zoom) as f32,
            (n.rect.height * self.zoom) as f32,
        );
        let module = (n.kind != NodeKind::Imported)
            .then(|| find_module(p, &n.id))
            .flatten();
        let accent = module.and_then(|m| m.color.as_deref()).map(hex);
        let container = n.kind == NodeKind::Container;
        let bg = match (container, accent) {
            (true, Some(a)) => alpha(a, 0.06),
            (true, None) => t.node_container,
            _ => t.node_bg,
        };
        let mut el = div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(w))
            .h(px(h))
            .flex()
            .flex_col()
            .rounded(px(8. * z))
            .border(px(1.5))
            .border_color(accent.unwrap_or(t.border))
            .bg(bg)
            .overflow_hidden()
            .text_color(t.text);
        if n.kind != NodeKind::Module {
            el = el.border_dashed();
        }
        if self.selected.contains(&n.id) {
            el = el.border(px(2.5)).border_color(t.accent);
        }
        // A top band of ports pushes the header down.
        if !container && n.ports.iter().any(|pt| pt.side == Side::Top) {
            el = el.child(
                div()
                    .h(px(24. * z))
                    .flex_none()
                    .border_b(px(1.))
                    .border_dashed()
                    .border_color(t.border),
            );
        }
        let (title, binary) = match module {
            Some(m) => node::header(p, m),
            None => {
                let (dep, im) = find_imported(p, &n.id).expect("placed module");
                (
                    vec![node_run(format!(
                        "{}/{}",
                        dep.name,
                        im.path.rsplit('.').next().unwrap_or("")
                    ))],
                    None,
                )
            }
        };
        let mut head = div()
            .h(px(MODULE_HEADER as f32 * z))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4. * z))
            .pl(px(10. * z))
            .pr(px(6. * z))
            .border_b(px(1.))
            .border_color(accent.unwrap_or(t.border))
            .bg(accent.map_or(transparent_black(), |a| alpha(a, 0.22)))
            .text_size(px(13. * z))
            .font_weight(FontWeight::SEMIBOLD)
            .whitespace_nowrap()
            .child(div().flex_1().flex().overflow_hidden().children(runs(title, t)));
        if let Some((name, color)) = binary {
            let c = color.as_deref().map(hex).unwrap_or(t.muted);
            head = head.child(
                div()
                    .text_size(px(10. * z))
                    .px(px(4. * z))
                    .rounded(px(4. * z))
                    .border(px(1.))
                    .border_color(c)
                    .text_color(c)
                    .child(name),
            );
        }
        el = el.child(head);
        let (attrs, methods) = match module {
            Some(m) => (
                node::attributes(p, &m.id, &m.attributes),
                node::methods(
                    p,
                    &m.id,
                    &m.name,
                    &m.methods,
                    m.constructors.as_deref().unwrap_or(&[]),
                    m.destructor.as_ref(),
                ),
            ),
            None => {
                let (dep, im) = find_imported(p, &n.id).expect("placed module");
                let _ = dep;
                let name = im.path.rsplit('.').next().unwrap_or("").to_string();
                (
                    node::attributes(p, &n.id, im.attributes.as_deref().unwrap_or(&[])),
                    node::methods(p, &n.id, &name, im.methods.as_deref().unwrap_or(&[]), &[], None),
                )
            }
        };
        for lines in [attrs, methods] {
            if lines.is_empty() {
                continue;
            }
            el = el.child(
                div()
                    .flex_none()
                    .pt(px(4. * z))
                    .pb(px(3. * z))
                    .px(px(4. * z))
                    .text_size(px(11. * z))
                    .font_family("DejaVu Sans Mono")
                    .border_b(px(1.))
                    .border_color(t.border)
                    .bg(accent.map_or(alpha(t.text, 0.04), |a| alpha(a, 0.08)))
                    .children(lines.into_iter().map(|line| {
                        div()
                            .h(px(18. * z))
                            .px(px(3. * z))
                            .flex()
                            .items_center()
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .children(runs(line, t))
                    })),
            );
        }
        el
    }
}

/// Items of a selection a drag moves: not locked, and not inside another moved module.
fn movable(p: &Project, sel: &[Id]) -> Vec<Id> {
    let chosen: HashSet<&Id> = sel.iter().collect();
    sel.iter()
        .filter(|id| {
            if let Some(m) = find_module(p, id) {
                if m.locked {
                    return false;
                }
                let mut up = m.parent_id.as_ref();
                while let Some(u) = up {
                    if chosen.contains(u) {
                        return false;
                    }
                    up = find_module(p, u).and_then(|x| x.parent_id.as_ref());
                }
                return true;
            }
            if let Some(n) = p.notes.iter().find(|n| &n.id == *id) {
                return !n.locked;
            }
            imported_index(p, id).is_some_and(|(d, m)| !p.dependencies[d].modules[m].locked)
        })
        .cloned()
        .collect()
}

/// Move items by an offset.
fn moved(p: &mut Project, ids: &[Id], o: Pt) {
    let layouts: Vec<(Id, RectPatch)> = ids
        .iter()
        .filter_map(|id| {
            let at = find_module(p, id)
                .map(|m| (m.layout.x, m.layout.y))
                .or_else(|| {
                    p.notes
                        .iter()
                        .find(|n| &n.id == id)
                        .map(|n| (n.layout.x, n.layout.y))
                })
                .or_else(|| find_imported(p, id).map(|(_, m)| (m.position.x, m.position.y)))?;
            Some((id.clone(), RectPatch::at(at.0 + o.x, at.1 + o.y)))
        })
        .collect();
    set_layouts(p, &layouts);
}

/// Whether a path of cubic segments passes within `reach` of a point.
fn near_path(start: Pt, segments: &[[Pt; 3]], p: Pt, reach: f64) -> bool {
    let mut a = start;
    for [c1, c2, b] in segments {
        let mut prev = a;
        for k in 1..=24 {
            let u = k as f64 / 24.;
            let v = 1. - u;
            let q = Pt {
                x: v * v * v * a.x + 3. * v * v * u * c1.x + 3. * v * u * u * c2.x + u * u * u * b.x,
                y: v * v * v * a.y + 3. * v * v * u * c1.y + 3. * v * u * u * c2.y + u * u * u * b.y,
            };
            if dist_to_segment(p, prev, q) <= reach {
                return true;
            }
            prev = q;
        }
        a = *b;
    }
    false
}

fn dist_to_segment(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l = dx * dx + dy * dy;
    let t = if l > 0. {
        (((p.x - a.x) * dx + (p.y - a.y) * dy) / l).clamp(0., 1.)
    } else {
        0.
    };
    (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy)
}

fn contains(outer: &Rect, inner: &Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height
}

fn node_run(text: String) -> Run {
    Run {
        text,
        style: RunStyle::Normal,
    }
}

fn runs(list: Vec<Run>, t: &Theme) -> Vec<Div> {
    list.into_iter()
        .map(|r| {
            let d = div().flex_none().child(r.text);
            match r.style {
                RunStyle::Normal => d,
                RunStyle::Muted => d.text_color(t.muted).font_weight(FontWeight::NORMAL),
                RunStyle::Type => d.text_color(t.muted),
                RunStyle::Qualifier => d.text_color(t.accent).italic(),
                RunStyle::Default => d.text_color(t.accent),
                RunStyle::Italic => d.italic(),
            }
        })
        .collect()
}

fn arrow(path: &mut PathBuilder, tip: Point<Pixels>, dir: (f32, f32), size: f32) {
    let (dx, dy) = dir;
    let base = point(tip.x - px(dx * size), tip.y - px(dy * size));
    let (nx, ny) = (-dy * size * 0.5, dx * size * 0.5);
    path.move_to(tip);
    path.line_to(point(base.x + px(nx), base.y + px(ny)));
    path.line_to(point(base.x - px(nx), base.y - px(ny)));
    path.close();
}

/// Direction pointing into a module through its side.
fn inward(side: Side) -> (f32, f32) {
    match side {
        Side::Left => (1., 0.),
        Side::Right => (-1., 0.),
        Side::Top => (0., 1.),
        Side::Bottom => (0., -1.),
    }
}

struct Paint {
    links: Vec<LinkPath>,
    selected: HashSet<Id>,
    inherits: Vec<InheritPath>,
    origin: Pt,
    zoom: f64,
    muted: Hsla,
    node_bg: Hsla,
}

fn paint(s: &Paint, bounds: Bounds<Pixels>, window: &mut Window) {
    let zoom = s.zoom;
    let at = |p: Pt| {
        point(
            bounds.origin.x + px(((p.x - s.origin.x) * zoom) as f32),
            bounds.origin.y + px(((p.y - s.origin.y) * zoom) as f32),
        )
    };
    let width = px((2. * zoom).max(0.8) as f32);
    let head = (8. * zoom).max(4.) as f32;
    for l in &s.inherits {
        let mut b = PathBuilder::stroke(px((1.5 * zoom).max(0.8) as f32));
        if l.realization {
            b = b.dash_array(&[px(6. * zoom as f32), px(4. * zoom as f32)]);
        }
        b.move_to(at(l.start));
        for [c1, c2, end] in &l.segments {
            b.cubic_bezier_to(at(*end), at(*c1), at(*c2));
        }
        if let Ok(path) = b.build() {
            window.paint_path(path, s.muted);
        }
        // Hollow triangle on the base.
        let size = (14. * zoom) as f32;
        let mut tri = PathBuilder::fill();
        arrow(&mut tri, at(l.tip), (l.dir.x as f32, l.dir.y as f32), size);
        if let Ok(path) = tri.build() {
            window.paint_path(path, s.node_bg);
        }
        let mut edge = PathBuilder::stroke(px((1.5 * zoom).max(0.8) as f32));
        arrow(&mut edge, at(l.tip), (l.dir.x as f32, l.dir.y as f32), size);
        if let Ok(path) = edge.build() {
            window.paint_path(path, s.muted);
        }
    }
    for l in &s.links {
        let color = hex(&l.color);
        let width = if s.selected.contains(&l.id) {
            width * 2.2
        } else {
            width
        };
        let mut b = PathBuilder::stroke(width);
        if l.remote {
            b = b.dash_array(&[px(6. * zoom as f32), px(4. * zoom as f32)]);
        }
        b.move_to(at(l.start));
        for [c1, c2, end] in &l.segments {
            b.cubic_bezier_to(at(*end), at(*c1), at(*c2));
        }
        if let Ok(path) = b.build() {
            window.paint_path(path, color);
        }
        let end = l.segments.last().map_or(l.start, |s| s[2]);
        let mut heads = PathBuilder::fill();
        arrow(&mut heads, at(end), inward(l.end_side), head);
        if l.bidirectional {
            arrow(&mut heads, at(l.start), inward(l.start_side), head);
        }
        if let Ok(path) = heads.build() {
            window.paint_path(path, color);
        }
    }
}

impl Render for Canvas {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let (Some(last), Some(size)) = (self.fitted, self.bounds.get().map(|b| b.size))
            && last != Some(size)
        {
            self.fit(size);
            self.fitted = Some(Some(size));
        }
        let t: Theme = light();
        let z = self.zoom as f32;
        // Stacking as the web build: containers, links, modules, then port handles and names.
        let mut containers = div().absolute().inset_0();
        let mut modules = div().absolute().inset_0();
        let mut layer = div().absolute().inset_0();
        for n in &self.scene.nodes {
            if self.holds(n) {
                containers = containers.child(self.node(n, &t));
            } else {
                modules = modules.child(self.node(n, &t));
            }
            // Ports: handle on the border, name inside.
            for port in &n.ports {
                let (hx, hy) = self.screen(port.at);
                let s = (10. * z).max(5.);
                let fill = if port.role == PortRole::In { t.ok } else { t.accent };
                layer = layer.child(
                    div()
                        .absolute()
                        .left(px(hx - s / 2.))
                        .top(px(hy - s / 2.))
                        .size(px(s))
                        .rounded_full()
                        .border(px(2. * z))
                        .border_color(hex("#ffffff"))
                        .bg(fill),
                );
                let label_w = 160. * z;
                let lh = 16. * z;
                let mut label = div()
                    .absolute()
                    .flex()
                    .gap(px(4. * z))
                    .text_size(px(12. * z))
                    .whitespace_nowrap();
                label = label.child(port.name.clone());
                if let Some(i) = &port.interface {
                    label = label.child(div().text_size(px(10. * z)).text_color(t.muted).child(i.clone()));
                }
                layer = layer.child(match port.side {
                    Side::Left => label.left(px(hx + 10. * z)).top(px(hy - lh / 2.)),
                    Side::Right => label
                        .left(px(hx - 10. * z - label_w))
                        .w(px(label_w))
                        .justify_end()
                        .top(px(hy - lh / 2.)),
                    Side::Top => label.left(px(hx + 6. * z)).top(px(hy + 4. * z)),
                    Side::Bottom => label.left(px(hx + 6. * z)).top(px(hy - 4. * z - lh)),
                });
            }
        }
        // Badges of the links, at their label point.
        let mut badges = div().absolute().inset_0();
        for l in &self.scene.links {
            let (bx, by) = self.screen(l.label);
            let badge = |text: String, bg: Hsla| {
                div()
                    .px(px(5. * z))
                    .rounded(px(8. * z))
                    .text_size(px(10. * z))
                    .bg(bg)
                    .text_color(hex("#ffffff"))
                    .child(text)
            };
            let mut row = div().flex().gap(px(3. * z));
            row = row.child(badge(
                if l.bidirectional {
                    "⇄".into()
                } else {
                    "→".into()
                },
                t.text,
            ));
            if let Some(a) = &l.ack {
                row = row.child(badge(a.clone(), t.text));
            }
            if let Some(c) = l.perf {
                row = row.child(badge(c.to_string(), hex(perf_color(c))));
            }
            if let Some(tr) = &l.transport {
                row = row.child(badge(tr.clone(), t.text));
            }
            // Centered on the label point (width unknown: approximate from the text).
            let h = 14. * z;
            badges = badges.child(
                div()
                    .absolute()
                    .left(px(bx))
                    .top(px(by - h / 2.))
                    .child(div().relative().left(px(-20. * z)).child(row)),
            );
        }
        // Notes and frames: frames behind, notes in front.
        let mut back = div().absolute().inset_0();
        let mut front = div().absolute().inset_0();
        for note in &self.scene.notes {
            let (x, y) = self.screen(Pt {
                x: note.layout.x,
                y: note.layout.y,
            });
            let color = note.color.as_deref().map(hex).unwrap_or(hex("#f5d76e"));
            let selected = self.selected.contains(&note.id);
            let el = div()
                .absolute()
                .left(px(x))
                .top(px(y))
                .w(px((note.layout.width * self.zoom) as f32))
                .h(px((note.layout.height * self.zoom) as f32))
                .rounded(px(6. * z))
                .p(px(8. * z))
                .text_size(px(12. * z))
                .text_color(t.text)
                .overflow_hidden()
                .child(note.text.clone());
            match note.kind {
                NoteKind::Frame => {
                    back = back.child(
                        el.border(px(if selected { 2.5 } else { 1.5 }))
                            .border_dashed()
                            .border_color(if selected { t.accent } else { color })
                            .bg(alpha(color, 0.06)),
                    )
                }
                NoteKind::Note => {
                    front = front.child(
                        el.bg(alpha(color, 0.35))
                            .border(px(if selected { 2.5 } else { 1. }))
                            .border_color(if selected { t.accent } else { alpha(color, 0.8) }),
                    )
                }
            }
        }
        // Box of a marquee selection.
        let marquee = match &self.gesture {
            Gesture::Marquee { start, end } => {
                let (x0, y0) = self.screen(Pt {
                    x: start.x.min(end.x),
                    y: start.y.min(end.y),
                });
                let (x1, y1) = self.screen(Pt {
                    x: start.x.max(end.x),
                    y: start.y.max(end.y),
                });
                Some(
                    div()
                        .absolute()
                        .left(px(x0))
                        .top(px(y0))
                        .w(px(x1 - x0))
                        .h(px(y1 - y0))
                        .border(px(1.))
                        .border_color(t.accent)
                        .bg(alpha(t.accent, 0.08)),
                )
            }
            _ => None,
        };
        let paint_state = Paint {
            selected: self.selected.clone(),
            links: self.scene.links.clone(),
            inherits: self.scene.inherits.clone(),
            origin: self.origin,
            zoom: self.zoom,
            muted: t.muted,
            node_bg: hex("#ffffff"),
        };
        let size = self.bounds.clone();
        let entity = cx.entity();
        div()
            .id("canvas")
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(t.bg)
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| this.on_scroll(ev, cx)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| this.on_down(ev, window, cx)),
            )
            .on_mouse_down(
                MouseButton::Middle,
                cx.listener(|this, ev: &MouseDownEvent, _, _| this.gesture = Gesture::Pan(ev.position)),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseUpEvent, _, cx| this.on_up(ev, cx)),
            )
            .on_mouse_up(
                MouseButton::Middle,
                cx.listener(|this, ev: &MouseUpEvent, _, cx| this.on_up(ev, cx)),
            )
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| this.on_move(ev, cx)))
            .child(back)
            .child(containers)
            .child(
                canvas(
                    move |bounds, _, cx| {
                        // Refit when the canvas gets its first (or a new) size.
                        let resized = size.get().map(|b| b.size) != Some(bounds.size);
                        size.set(Some(bounds));
                        if resized {
                            entity.update(cx, |_, cx| cx.notify());
                        }
                    },
                    move |bounds, _, window, _| paint(&paint_state, bounds, window),
                )
                .absolute()
                .size_full(),
            )
            .child(badges)
            .child(modules)
            .child(layer)
            .child(front)
            .children(marquee)
    }
}
