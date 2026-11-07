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

use std::sync::atomic::{AtomicBool, Ordering};

pub struct Theme {
    pub bg: Hsla,
    /// Surfaces of panels, cards and dialogs.
    pub panel: Hsla,
    pub border: Hsla,
    pub text: Hsla,
    pub muted: Hsla,
    pub accent: Hsla,
    pub ok: Hsla,
    pub node_bg: Hsla,
    pub node_container: Hsla,
    pub dark: bool,
}

/// The system asks for dark colors (followed by the `system` theme).
static SYSTEM_DARK: AtomicBool = AtomicBool::new(false);

pub fn set_system_dark(dark: bool) {
    SYSTEM_DARK.store(dark, Ordering::Relaxed);
}

/// Name of the theme drawn: the setting, with `system` resolved.
pub fn resolved() -> String {
    let t = crate::settings::get().theme;
    match t.as_str() {
        "system" | "" => if SYSTEM_DARK.load(Ordering::Relaxed) {
            "dark"
        } else {
            "light"
        }
        .into(),
        _ => t,
    }
}

/// Colors of the theme chosen in the settings (the web build's `styles.css` tokens).
pub fn current() -> Theme {
    of(&resolved())
}

pub fn of(name: &str) -> Theme {
    let c = |v: u32| -> Hsla { rgb(v).into() };
    if name == "light" {
        return Theme {
            bg: c(0xf6f7f9),
            panel: c(0xffffff),
            border: c(0xd9dde3),
            text: c(0x1d2330),
            muted: c(0x6b7384),
            accent: c(0x3b6fe0),
            ok: c(0x2e9e5b),
            node_bg: alpha(c(0xffffff), 0.8),
            node_container: alpha(c(0x3b6fe0), 0.05),
            dark: false,
        };
    }
    // Dark, and the base of the color themes: (bg, panel, border, text, muted, accent, node).
    let (bg, panel, border, text, muted, accent, node) = match name {
        "black" => (
            0x000000, 0x0b0b0c, 0x2a2a2d, 0xe8e8ea, 0x8c8c92, 0xd4d6dc, 0x121214,
        ),
        "red" => (
            0x190f11, 0x211417, 0x47292f, 0xf2e5e7, 0xaa8f94, 0xe5484d, 0x29181c,
        ),
        "orange" => (
            0x19130d, 0x221911, 0x4a3524, 0xf4e9df, 0xad9682, 0xff8b3d, 0x2a1f15,
        ),
        "yellow" => (
            0x16140b, 0x1e1b10, 0x433c22, 0xf3efdd, 0xa69e80, 0xf5c518, 0x25220f,
        ),
        "green" => (
            0x0e1611, 0x131d17, 0x2c4134, 0xe3efe7, 0x8ba695, 0x4cd27f, 0x18251d,
        ),
        "pink" => (
            0x1a1017, 0x22141e, 0x482a40, 0xf4e5ef, 0xae8fa5, 0xff6fb5, 0x2a1925,
        ),
        "violet" => (
            0x13111c, 0x1a1626, 0x382f52, 0xeae5f6, 0x9b91b4, 0xa77bff, 0x211c30,
        ),
        _ => (
            0x15181e, 0x1c2028, 0x363c49, 0xe3e7ef, 0x8b93a5, 0x6f9bff, 0x222733,
        ),
    };
    Theme {
        bg: c(bg),
        panel: c(panel),
        border: c(border),
        text: c(text),
        muted: c(muted),
        accent: c(accent),
        ok: c(0x4cc27f),
        node_bg: c(node),
        node_container: alpha(c(accent), 0.07),
        dark: true,
    }
}
