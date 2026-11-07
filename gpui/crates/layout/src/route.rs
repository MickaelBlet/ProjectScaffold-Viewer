//! Links shaped by hand: ends attached anywhere on their module's border, and bend points the link
//! goes through. Port of `canvas/linkRoute.ts` (bezier style).

use scaffold_model::types::{LinkAnchor, Rect, Side};

use crate::scene::Pt;

/// Outward direction of each side.
pub fn dir(side: Side) -> Pt {
    match side {
        Side::Left => Pt { x: -1., y: 0. },
        Side::Right => Pt { x: 1., y: 0. },
        Side::Top => Pt { x: 0., y: -1. },
        Side::Bottom => Pt { x: 0., y: 1. },
    }
}

const CORNER: f64 = 8.;

fn dist(a: Pt, b: Pt) -> f64 {
    (b.x - a.x).hypot(b.y - a.y)
}

/// Point of the border of `r` an anchor stands for.
pub fn anchor_point(r: &Rect, a: &LinkAnchor) -> Pt {
    let at = a.at.clamp(0., 1.);
    match a.side {
        Side::Left => Pt {
            x: r.x,
            y: r.y + at * r.height,
        },
        Side::Right => Pt {
            x: r.x + r.width,
            y: r.y + at * r.height,
        },
        Side::Top => Pt {
            x: r.x + at * r.width,
            y: r.y,
        },
        Side::Bottom => Pt {
            x: r.x + at * r.width,
            y: r.y + r.height,
        },
    }
}

/// Anchor on the border of `r` nearest to `p`.
pub fn nearest_anchor(r: &Rect, p: Pt) -> LinkAnchor {
    let fx = |x: f64| {
        if r.width > 0. {
            x.clamp(r.x + CORNER, r.x + r.width - CORNER)
        } else {
            r.x
        }
    };
    let fy = |y: f64| {
        if r.height > 0. {
            y.clamp(r.y + CORNER, r.y + r.height - CORNER)
        } else {
            r.y
        }
    };
    let candidates = [
        (Side::Left, Pt { x: r.x, y: fy(p.y) }),
        (
            Side::Right,
            Pt {
                x: r.x + r.width,
                y: fy(p.y),
            },
        ),
        (Side::Top, Pt { x: fx(p.x), y: r.y }),
        (
            Side::Bottom,
            Pt {
                x: fx(p.x),
                y: r.y + r.height,
            },
        ),
    ];
    let (side, q) =
        candidates.into_iter().fold(
            candidates[0],
            |a, b| if dist(b.1, p) < dist(a.1, p) { b } else { a },
        );
    let at = match side {
        Side::Left | Side::Right => (q.y - r.y) / if r.height > 0. { r.height } else { 1. },
        _ => (q.x - r.x) / if r.width > 0. { r.width } else { 1. },
    };
    LinkAnchor {
        side,
        at: (at * 1000.).round() / 1000.,
    }
}

/// A shaped link: cubic segments and a sampled polyline.
#[derive(Clone, Debug, PartialEq)]
pub struct Curve {
    pub segments: Vec<[Pt; 3]>,
    pub line: Vec<Pt>,
    /// Index in `line` of the source, of each bend point, and of the target.
    pub marks: Vec<usize>,
}

/// Smooth curve through the points, leaving and reaching the modules square to their sides.
pub fn curve(s: Pt, s_side: Side, t: Pt, t_side: Side, points: &[Pt]) -> Curve {
    let mut pts = vec![s];
    pts.extend_from_slice(points);
    pts.push(t);
    let n = pts.len() - 1;
    let tangent = |i: usize| -> Pt {
        if i == 0 {
            let d = dist(pts[0], pts[1]);
            let v = dir(s_side);
            return Pt {
                x: v.x * d,
                y: v.y * d,
            };
        }
        if i == n {
            let d = dist(pts[n - 1], pts[n]);
            let v = dir(t_side);
            return Pt {
                x: -v.x * d,
                y: -v.y * d,
            };
        }
        Pt {
            x: (pts[i + 1].x - pts[i - 1].x) / 2.,
            y: (pts[i + 1].y - pts[i - 1].y) / 2.,
        }
    };
    let mut segments = Vec::new();
    let mut line = vec![s];
    let mut marks = vec![0];
    for i in 0..n {
        let (a, b) = (pts[i], pts[i + 1]);
        let (ta, tb) = (tangent(i), tangent(i + 1));
        let c1 = Pt {
            x: a.x + ta.x / 3.,
            y: a.y + ta.y / 3.,
        };
        let c2 = Pt {
            x: b.x - tb.x / 3.,
            y: b.y - tb.y / 3.,
        };
        segments.push([c1, c2, b]);
        for k in 1..=16 {
            let u = k as f64 / 16.;
            let v = 1. - u;
            line.push(Pt {
                x: v * v * v * a.x + 3. * v * v * u * c1.x + 3. * v * u * u * c2.x + u * u * u * b.x,
                y: v * v * v * a.y + 3. * v * v * u * c1.y + 3. * v * u * u * c2.y + u * u * u * b.y,
            });
        }
        marks.push(line.len() - 1);
    }
    Curve {
        segments,
        line,
        marks,
    }
}

fn length(pts: &[Pt]) -> f64 {
    pts.windows(2).map(|w| dist(w[0], w[1])).sum()
}

/// Point at `at` (0 to 1) of the length of a polyline.
pub fn point_along(pts: &[Pt], at: f64) -> Pt {
    let mut rest = at.clamp(0., 1.) * length(pts);
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let l = dist(a, b);
        if l >= rest && l > 0. {
            return Pt {
                x: a.x + (b.x - a.x) * rest / l,
                y: a.y + (b.y - a.y) * rest / l,
            };
        }
        rest -= l;
    }
    pts.last().copied().unwrap_or(Pt { x: 0., y: 0. })
}

/// Middle of the longest leg between two bend points, clear of the bends.
pub fn label_at(line: &[Pt], marks: &[usize]) -> Pt {
    let legs: Vec<&[Pt]> = marks.windows(2).map(|m| &line[m[0]..=m[1]]).collect();
    let best = legs
        .iter()
        .fold(legs[0], |a, b| if length(b) > length(a) { b } else { a });
    point_along(best, 0.5)
}

pub fn opposite(s: Side) -> Side {
    match s {
        Side::Left => Side::Right,
        Side::Right => Side::Left,
        Side::Top => Side::Bottom,
        Side::Bottom => Side::Top,
    }
}
