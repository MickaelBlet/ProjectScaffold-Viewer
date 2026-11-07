//! Export of the view drawn as an SVG image (and a PNG rendered from it), from the same geometry
//! as the canvas. Port of `exportImage.ts` (which captured the page instead).

use std::fmt::Write as _;

use scaffold_layout::scene::{NodeKind, Pt, Scene, perf_color};
use scaffold_model::project::{MODULE_HEADER, find_imported, find_module};
use scaffold_model::types::{NoteKind, PortRole, Project, Side};

use crate::node::{self, Run, RunStyle};

const PAD: f64 = 24.;
const TEXT: &str = "#1d2330";
const MUTED: &str = "#6b7384";
const ACCENT: &str = "#3b6fe0";
const OK: &str = "#2e9e5b";
const BORDER: &str = "#d9dde3";
const SANS: &str = "Inter, 'Segoe UI', 'DejaVu Sans', sans-serif";
const MONO: &str = "'DejaVu Sans Mono', Consolas, monospace";

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Text runs as `tspan`s, styled as on the canvas.
fn tspans(runs: &[Run]) -> String {
    let mut out = String::new();
    for r in runs {
        let style = match r.style {
            RunStyle::Normal => String::new(),
            RunStyle::Muted => format!(r#" fill="{MUTED}" font-weight="normal""#),
            RunStyle::Type => format!(r#" fill="{MUTED}""#),
            RunStyle::Qualifier => format!(r#" fill="{ACCENT}" font-style="italic""#),
            RunStyle::Default => format!(r#" fill="{ACCENT}""#),
            RunStyle::Italic => r#" font-style="italic""#.to_string(),
        };
        let _ = write!(out, "<tspan{style}>{}</tspan>", esc(&r.text));
    }
    out
}

fn path_d(start: Pt, segments: &[[Pt; 3]]) -> String {
    let mut d = format!("M{:.1} {:.1}", start.x, start.y);
    for [a, b, c] in segments {
        let _ = write!(
            d,
            " C{:.1} {:.1} {:.1} {:.1} {:.1} {:.1}",
            a.x, a.y, b.x, b.y, c.x, c.y
        );
    }
    d
}

/// The scene as an SVG document, cropped to what is drawn with a margin.
pub fn scene_svg(p: &Project, scene: &Scene) -> String {
    let b = scene.bounds();
    let (x0, y0) = (b.x - PAD, b.y - PAD);
    let (w, h) = (b.width + 2. * PAD, b.height + 2. * PAD);
    let mut s = String::new();
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0}" height="{h:.0}" viewBox="{x0:.1} {y0:.1} {w:.1} {h:.1}" font-family="{SANS}">"#
    );
    let _ = write!(
        s,
        r#"<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>"#
    );
    let _ = write!(
        s,
        r##"<rect x="{x0:.1}" y="{y0:.1}" width="{w:.1}" height="{h:.1}" fill="#ffffff"/>"##
    );
    // Frames behind everything.
    for n in scene.notes.iter().filter(|n| n.kind == NoteKind::Frame) {
        let c = n.color.as_deref().unwrap_or("#f5d76e");
        let r = n.layout;
        let _ = write!(
            s,
            r#"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" rx="6" fill="{c}" fill-opacity="0.06" stroke="{c}" stroke-width="1.5" stroke-dasharray="6 4"/><text x="{:.1}" y="{:.1}" font-size="12" fill="{TEXT}">{}</text>"#,
            r.x,
            r.y,
            r.width,
            r.height,
            r.x + 8.,
            r.y + 18.,
            esc(&n.text)
        );
    }
    // Containers, then links, then modules: as the canvas stacks them.
    let holds = |id: &str| p.modules.iter().any(|m| m.parent_id.as_deref() == Some(id));
    let (containers, leaves): (Vec<_>, Vec<_>) = scene.nodes.iter().partition(|n| holds(&n.id));
    for n in &containers {
        node_svg(&mut s, p, n);
    }
    for l in &scene.links {
        let dash = if l.remote {
            r#" stroke-dasharray="6 4""#
        } else {
            ""
        };
        let start = if l.bidirectional {
            r#" marker-start="url(#arrow)""#
        } else {
            ""
        };
        let _ = write!(
            s,
            r#"<path d="{}" fill="none" stroke="{}" stroke-width="2"{dash}{start} marker-end="url(#arrow)"/>"#,
            path_d(l.start, &l.segments),
            esc(&l.color)
        );
        let mut badges: Vec<(String, &str)> = Vec::new();
        if let Some(a) = &l.ack {
            badges.push((a.clone(), TEXT));
        }
        if let Some(c) = l.perf {
            badges.push((c.to_string(), perf_color(c)));
        }
        if let Some(t) = &l.transport {
            badges.push((t.clone(), TEXT));
        }
        let mut x = l.label.x - 20.;
        for (text, bg) in badges {
            let bw = text.chars().count() as f64 * 6. + 10.;
            let _ = write!(
                s,
                r##"<rect x="{x:.1}" y="{:.1}" width="{bw:.1}" height="14" rx="7" fill="{bg}"/><text x="{:.1}" y="{:.1}" font-size="10" fill="#ffffff">{}</text>"##,
                l.label.y - 7.,
                x + 5.,
                l.label.y + 3.5,
                esc(&text)
            );
            x += bw + 3.;
        }
    }
    for i in &scene.inherits {
        let dash = if i.realization {
            r#" stroke-dasharray="5 4""#
        } else {
            ""
        };
        let _ = write!(
            s,
            r#"<path d="{}" fill="none" stroke="{MUTED}" stroke-width="1.5"{dash}/>"#,
            path_d(i.start, &i.segments)
        );
        // Hollow triangle on the base.
        let (d, n) = (
            i.dir,
            Pt {
                x: -i.dir.y,
                y: i.dir.x,
            },
        );
        let back = Pt {
            x: i.tip.x - d.x * 12.,
            y: i.tip.y - d.y * 12.,
        };
        let _ = write!(
            s,
            r##"<path d="M{:.1} {:.1}L{:.1} {:.1}L{:.1} {:.1}z" fill="#ffffff" stroke="{MUTED}" stroke-width="1.5"/>"##,
            i.tip.x,
            i.tip.y,
            back.x + n.x * 7.,
            back.y + n.y * 7.,
            back.x - n.x * 7.,
            back.y - n.y * 7.
        );
    }
    for n in &leaves {
        node_svg(&mut s, p, n);
    }
    // Ports: handle on the border, name inside.
    for n in &scene.nodes {
        for port in &n.ports {
            let fill = if port.role == PortRole::In { OK } else { ACCENT };
            let _ = write!(
                s,
                r##"<circle cx="{:.1}" cy="{:.1}" r="5" fill="{fill}" stroke="#ffffff" stroke-width="2"/>"##,
                port.at.x, port.at.y
            );
            let label = match &port.interface {
                Some(i) => format!(
                    r#"{} <tspan font-size="10" fill="{MUTED}">{}</tspan>"#,
                    esc(&port.name),
                    esc(i)
                ),
                None => esc(&port.name),
            };
            let (x, y, anchor) = match port.side {
                Side::Left => (port.at.x + 10., port.at.y + 4., "start"),
                Side::Right => (port.at.x - 10., port.at.y + 4., "end"),
                Side::Top => (port.at.x + 6., port.at.y + 16., "start"),
                Side::Bottom => (port.at.x + 6., port.at.y - 8., "start"),
            };
            let _ = write!(
                s,
                r#"<text x="{x:.1}" y="{y:.1}" font-size="12" fill="{TEXT}" text-anchor="{anchor}">{label}</text>"#
            );
        }
    }
    // Notes in front.
    for n in scene.notes.iter().filter(|n| n.kind == NoteKind::Note) {
        let c = n.color.as_deref().unwrap_or("#f5d76e");
        let r = n.layout;
        let _ = write!(
            s,
            r#"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" rx="6" fill="{c}" fill-opacity="0.35" stroke="{c}" stroke-opacity="0.8"/>"#,
            r.x, r.y, r.width, r.height
        );
        for (i, line) in n.text.lines().enumerate() {
            let _ = write!(
                s,
                r#"<text x="{:.1}" y="{:.1}" font-size="12" fill="{TEXT}">{}</text>"#,
                r.x + 8.,
                r.y + 20. + 16. * i as f64,
                esc(line)
            );
        }
    }
    s.push_str("</svg>\n");
    s
}

fn node_svg(s: &mut String, p: &Project, n: &scaffold_layout::scene::NodeBox) {
    let r = n.rect;
    let module = (n.kind != NodeKind::Imported)
        .then(|| find_module(p, &n.id))
        .flatten();
    let accent = module.and_then(|m| m.color.clone());
    let stroke = accent.clone().unwrap_or(BORDER.into());
    let container = n.kind == NodeKind::Container;
    let (fill, opacity) = match (container, &accent) {
        (true, Some(a)) => (a.clone(), 0.06),
        (true, None) => (ACCENT.to_string(), 0.05),
        _ => ("#ffffff".to_string(), 1.),
    };
    let dash = if n.kind != NodeKind::Module {
        r#" stroke-dasharray="6 4""#
    } else {
        ""
    };
    let _ = write!(
        s,
        r#"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" rx="8" fill="{}" fill-opacity="{opacity}" stroke="{}" stroke-width="1.5"{dash}/>"#,
        r.x,
        r.y,
        r.width,
        r.height,
        esc(&fill),
        esc(&stroke)
    );
    let mut y = r.y;
    if !container && n.ports.iter().any(|pt| pt.side == Side::Top) {
        y += 24.;
    }
    let (title, binary) = match module {
        Some(m) => node::header(p, m),
        None => match find_imported(p, &n.id) {
            Some((dep, im)) => (
                vec![Run {
                    text: format!("{}/{}", dep.name, im.path.rsplit('.').next().unwrap_or("")),
                    style: RunStyle::Normal,
                }],
                None,
            ),
            None => (Vec::new(), None),
        },
    };
    if let Some(a) = &accent {
        let _ = write!(
            s,
            r#"<rect x="{:.1}" y="{y:.1}" width="{:.1}" height="{MODULE_HEADER:.1}" fill="{}" fill-opacity="0.22"/>"#,
            r.x + 0.75,
            r.width - 1.5,
            esc(a)
        );
    }
    let _ = write!(
        s,
        r#"<text x="{:.1}" y="{:.1}" font-size="13" font-weight="600" fill="{TEXT}">{}</text>"#,
        r.x + 10.,
        y + MODULE_HEADER / 2. + 4.5,
        tspans(&title)
    );
    if let Some((name, color)) = binary {
        let c = color.unwrap_or(MUTED.into());
        let _ = write!(
            s,
            r#"<text x="{:.1}" y="{:.1}" font-size="10" fill="{}" text-anchor="end">{}</text>"#,
            r.x + r.width - 8.,
            y + MODULE_HEADER / 2. + 3.5,
            esc(&c),
            esc(&name)
        );
    }
    y += MODULE_HEADER;
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
        None => match find_imported(p, &n.id) {
            Some((_, im)) => {
                let name = im.path.rsplit('.').next().unwrap_or("").to_string();
                (
                    node::attributes(p, &n.id, im.attributes.as_deref().unwrap_or(&[])),
                    node::methods(p, &n.id, &name, im.methods.as_deref().unwrap_or(&[]), &[], None),
                )
            }
            None => (Vec::new(), Vec::new()),
        },
    };
    for lines in [attrs, methods] {
        if lines.is_empty() {
            continue;
        }
        let _ = write!(
            s,
            r#"<line x1="{:.1}" y1="{y:.1}" x2="{:.1}" y2="{y:.1}" stroke="{}"/>"#,
            r.x,
            r.x + r.width,
            esc(&stroke)
        );
        y += 4.;
        for line in lines {
            let _ = write!(
                s,
                r#"<text x="{:.1}" y="{:.1}" font-size="11" font-family="{MONO}" fill="{TEXT}">{}</text>"#,
                r.x + 7.,
                y + 13.,
                tspans(&line)
            );
            y += 18.;
        }
        y += 3.;
    }
}

/// A PNG of an SVG document, at a scale.
pub fn svg_png(svg: &str, scale: f32) -> Result<Vec<u8>, String> {
    let mut opt = resvg::usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| e.to_string())?;
    let size = tree.size().to_int_size().scale_by(scale).ok_or("empty image")?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height()).ok_or("image too large")?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn every_example_exports() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");
        for name in ["robot.scaffold.yaml", "shop.scaffold.yaml"] {
            let text = std::fs::read_to_string(dir.join(name)).unwrap();
            let p =
                scaffold_model::serialize::load_text(&text, scaffold_model::serialize::Format::Yaml).unwrap();
            let svg = scene_svg(&p, &scaffold_layout::scene::project_scene(&p));
            assert!(svg.starts_with("<svg") && svg.contains("</svg>"), "{name}");
            let png = svg_png(&svg, 1.).unwrap();
            assert_eq!(&png[1..4], b"PNG", "{name}");
            if let Ok(out) = std::env::var("SCAFFOLD_EXPORT_DIR") {
                std::fs::write(std::path::Path::new(&out).join(format!("{name}.png")), &png).unwrap();
            }
        }
    }
}
