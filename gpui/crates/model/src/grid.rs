//! Snap to grid: positions and sizes of modules, notes and imported modules on multiples of the
//! grid. Port of `model/grid.ts`.

use std::collections::HashMap;

use crate::project::{
    Compartments, LAYOUT_PAD, absolute_position, content_bottom, content_top, min_size, module_roles,
};
use crate::types::{Id, Point, Project, Rect, Size};

pub const NOTE_MIN: Size = Size {
    width: 80.,
    height: 40.,
};

/// `Math.round(v / grid) * grid` (halves round up, as in JavaScript).
pub fn snap_value(v: f64, grid: f64) -> f64 {
    (v / grid + 0.5).floor() * grid
}

pub fn ceil_to_grid(v: f64, grid: f64) -> f64 {
    (v / grid - 1e-9).ceil() * grid
}

/// Absolute rect with its edges on the grid, not smaller than `min`; `keep_right` (`keep_bottom`)
/// holds the right (bottom) edge when the minimum wins, as when resizing from the left (top).
pub fn snap_rect(r: Rect, grid: f64, min: Size, keep_right: bool, keep_bottom: bool) -> Rect {
    let axis = |pos: f64, size: f64, least: f64, keep_end: bool| -> (f64, f64) {
        let start = snap_value(pos, grid);
        let end = snap_value(pos + size, grid);
        let s = (end - start).max(ceil_to_grid(least, grid)).max(grid);
        if keep_end && end - start < s {
            (end - s, s)
        } else {
            (start, s)
        }
    };
    let (x, width) = axis(r.x, r.width, min.width, keep_right);
    let (y, height) = axis(r.y, r.height, min.height, keep_bottom);
    Rect { x, y, width, height }
}

fn touched(a: Option<&Rect>, b: &Rect) -> bool {
    a != Some(b)
}

/// Snap what an edit moved or resized (`next` against `prev`). Untouched items keep their place,
/// so that turning the grid on does not move a whole diagram.
pub fn snap_changes(prev: &Project, next: &mut Project, grid: f64) {
    let modules: HashMap<&Id, (&Rect, &Option<Id>)> = prev
        .modules
        .iter()
        .map(|m| (&m.id, (&m.layout, &m.parent_id)))
        .collect();
    let notes: HashMap<&Id, &Rect> = prev.notes.iter().map(|n| (&n.id, &n.layout)).collect();
    let imported: HashMap<&Id, Point> = prev
        .dependencies
        .iter()
        .flat_map(|x| x.modules.iter())
        .map(|m| (&m.id, m.position))
        .collect();
    let place = |r: Rect, before: Option<&Rect>, min: Size| -> Rect {
        match before {
            Some(b) if b.width == r.width && b.height == r.height => Rect {
                x: snap_value(r.x, grid),
                y: snap_value(r.y, grid),
                width: ceil_to_grid(r.width, grid),
                height: ceil_to_grid(r.height, grid),
            },
            _ => snap_rect(r, grid, min, false, false),
        }
    };
    let o = next.orientation;
    let mut changed: Vec<Id> = Vec::new();
    // Parents come first: children snap against their parent's final place.
    for i in 0..next.modules.len() {
        let m = &next.modules[i];
        let before = modules.get(&m.id);
        if m.locked || (!touched(before.map(|b| b.0), &m.layout) && before.map(|b| b.1) == Some(&m.parent_id))
        {
            continue;
        }
        changed.push(m.id.clone());
        let parent = m
            .parent_id
            .as_ref()
            .and_then(|pid| next.modules.iter().find(|x| &x.id == pid));
        let origin = parent.map_or(Point { x: 0., y: 0. }, |p| absolute_position(next, &p.id));
        let top = parent.map(|p| content_top(o, Compartments::of_module(p)));
        let min = min_size(&module_roles(m), Compartments::of_module(m), o);
        let mut r = place(
            Rect {
                x: origin.x + m.layout.x,
                y: origin.y + m.layout.y,
                ..m.layout
            },
            before.map(|b| b.0),
            min,
        );
        // Children stay below their parent's header and ports.
        if let Some(top) = top {
            r.x = r.x.max(ceil_to_grid(origin.x + LAYOUT_PAD / 2., grid));
            r.y = r.y.max(ceil_to_grid(origin.y + top, grid));
        }
        next.modules[i].layout = Rect {
            x: r.x - origin.x,
            y: r.y - origin.y,
            ..r
        };
    }
    // Parents grown to hold the snapped children, on the grid too.
    for id in &changed {
        let mut child = next.modules.iter().position(|m| &m.id == id);
        while let Some(ci) = child {
            let Some(pid) = next.modules[ci].parent_id.clone() else {
                break;
            };
            let Some(pi) = next.modules.iter().position(|m| m.id == pid) else {
                break;
            };
            let c = next.modules[ci].layout;
            let width = c.x + c.width + LAYOUT_PAD;
            let height = c.y + c.height + content_bottom(o);
            let parent = &mut next.modules[pi].layout;
            if width > parent.width {
                parent.width = ceil_to_grid(width, grid);
            }
            if height > parent.height {
                parent.height = ceil_to_grid(height, grid);
            }
            child = Some(pi);
        }
    }
    for n in &mut next.notes {
        let before = notes.get(&n.id).copied();
        if !n.locked && touched(before, &n.layout) {
            n.layout = place(n.layout, before, NOTE_MIN);
        }
    }
    for m in next.dependencies.iter_mut().flat_map(|x| x.modules.iter_mut()) {
        let before = imported.get(&m.id);
        if m.locked || before == Some(&m.position) {
            continue;
        }
        m.position = Point {
            x: snap_value(m.position.x, grid),
            y: snap_value(m.position.y, grid),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snaps_like_javascript() {
        assert_eq!(snap_value(10., 20.), 20.);
        assert_eq!(snap_value(-10., 20.), 0.);
        assert_eq!(snap_value(29., 20.), 20.);
        assert_eq!(ceil_to_grid(41., 20.), 60.);
        assert_eq!(ceil_to_grid(40., 20.), 40.);
        let r = snap_rect(
            Rect {
                x: 13.,
                y: 7.,
                width: 30.,
                height: 10.,
            },
            20.,
            Size {
                width: 50.,
                height: 0.,
            },
            true,
            false,
        );
        assert_eq!(
            r,
            Rect {
                x: -20.,
                y: 0.,
                width: 60.,
                height: 20.
            }
        );
    }
}
