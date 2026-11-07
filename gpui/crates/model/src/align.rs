//! Alignment and distribution of rects (absolute coordinates). Port of `align.ts`.

use indexmap::IndexMap;

use crate::types::{Id, Rect};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlignMode {
    Left,
    HCenter,
    Right,
    Top,
    VCenter,
    Bottom,
}

/// New absolute positions aligning the rects on the selection's bounds.
pub fn align(rects: &IndexMap<Id, Rect>, mode: AlignMode) -> IndexMap<Id, Rect> {
    let all: Vec<&Rect> = rects.values().collect();
    let left = all.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
    let right = all
        .iter()
        .map(|r| r.x + r.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let top = all.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
    let bottom = all
        .iter()
        .map(|r| r.y + r.height)
        .fold(f64::NEG_INFINITY, f64::max);
    rects
        .iter()
        .map(|(id, r)| {
            let mut n = *r;
            match mode {
                AlignMode::Left => n.x = left,
                AlignMode::Right => n.x = right - r.width,
                AlignMode::HCenter => n.x = (left + right) / 2. - r.width / 2.,
                AlignMode::Top => n.y = top,
                AlignMode::Bottom => n.y = bottom - r.height,
                AlignMode::VCenter => n.y = (top + bottom) / 2. - r.height / 2.,
            }
            (id.clone(), n)
        })
        .collect()
}

/// Equal gaps between the rects along an axis (`horizontal`), keeping the outermost ones in place.
pub fn distribute(rects: &IndexMap<Id, Rect>, horizontal: bool) -> IndexMap<Id, Rect> {
    let pos = |r: &Rect| if horizontal { r.x } else { r.y };
    let size = |r: &Rect| if horizontal { r.width } else { r.height };
    let mut sorted: Vec<(Id, Rect)> = rects.iter().map(|(k, v)| (k.clone(), *v)).collect();
    sorted.sort_by(|a, b| {
        pos(&a.1)
            .partial_cmp(&pos(&b.1))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if sorted.len() < 3 {
        return sorted.into_iter().collect();
    }
    let first = sorted[0].1;
    let last = sorted[sorted.len() - 1].1;
    let total: f64 = sorted.iter().map(|(_, r)| size(r)).sum();
    let gap = (pos(&last) + size(&last) - pos(&first) - total) / (sorted.len() - 1) as f64;
    let mut cursor = pos(&first);
    for (_, r) in &mut sorted {
        let s = size(r);
        if horizontal {
            r.x = cursor
        } else {
            r.y = cursor
        }
        cursor += s + gap;
    }
    sorted.into_iter().collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizeDim {
    Width,
    Height,
    Both,
}

/// Give every rect the size of the largest one.
pub fn same_size(rects: &IndexMap<Id, Rect>, dim: SizeDim) -> IndexMap<Id, Rect> {
    let w = rects.values().map(|r| r.width).fold(f64::NEG_INFINITY, f64::max);
    let h = rects.values().map(|r| r.height).fold(f64::NEG_INFINITY, f64::max);
    rects
        .iter()
        .map(|(id, r)| {
            let mut n = *r;
            if dim != SizeDim::Height {
                n.width = w
            }
            if dim != SizeDim::Width {
                n.height = h
            }
            (id.clone(), n)
        })
        .collect()
}
