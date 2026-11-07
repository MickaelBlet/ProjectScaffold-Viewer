//! Colors of the web build's light theme (`styles.css` `:root`).

use gpui_kit::{Hsla, rgb};

pub fn hex(s: &str) -> Hsla {
    let h = s.trim_start_matches('#');
    let v = u32::from_str_radix(h, 16).unwrap_or(0x888888);
    let v = if h.len() == 3 {
        let (r, g, b) = ((v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf);
        (r * 17) << 16 | (g * 17) << 8 | (b * 17)
    } else {
        v
    };
    rgb(v).into()
}

pub fn alpha(c: Hsla, a: f32) -> Hsla {
    Hsla { a, ..c }
}

pub struct Theme {
    pub bg: Hsla,
    pub border: Hsla,
    pub text: Hsla,
    #[allow(dead_code)]
    pub muted: Hsla,
    pub accent: Hsla,
    pub ok: Hsla,
    pub node_bg: Hsla,
    pub node_container: Hsla,
}

pub fn light() -> Theme {
    let c = |v: u32| -> Hsla { rgb(v).into() };
    Theme {
        bg: c(0xf6f7f9),
        border: c(0xd9dde3),
        text: c(0x1d2330),
        muted: c(0x6b7384),
        accent: c(0x3b6fe0),
        ok: c(0x2e9e5b),
        node_bg: alpha(c(0xffffff), 0.8),
        node_container: alpha(c(0x3b6fe0), 0.05),
    }
}
