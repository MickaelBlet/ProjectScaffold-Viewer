//! ProjectScaffold native editor built on GPUI.

mod canvas;
mod commands;
mod document;
mod form;
mod node;
mod panels;
mod prefs;
mod settings;
mod theme;
mod workspace;

use std::path::PathBuf;

use gpui_kit::component::TitleBar;
use gpui_kit::*;

use crate::workspace::Workspace;

fn main() {
    env_logger::init();
    // Under WSLg the D3D12 OpenGL driver presents nothing: draw with the software renderer.
    if std::env::var_os("WSL_DISTRO_NAME").is_some() && std::env::var_os("LIBGL_ALWAYS_SOFTWARE").is_none() {
        // SAFETY: set before any other thread starts.
        unsafe { std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1") };
    }
    let files: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            let bindings = commands::key_bindings(cx);
            cx.bind_keys(bindings);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::centered(size(px(1280.), px(800.)), cx)),
                ..TitleBar::window_options()
            };
            gpui_kit::open_window(options, cx, move |window, cx| {
                let ws = cx.new(|cx| {
                    let mut w = Workspace::new(window, cx);
                    for f in files {
                        w.open_path(f, cx);
                    }
                    w
                });
                let focus = ws
                    .read(cx)
                    .canvas()
                    .map(|c| c.read(cx).focus_handle())
                    .unwrap_or_else(|| ws.read(cx).focus.clone());
                window.focus(&focus, cx);
                ws
            })
            .expect("failed to open window");
            cx.activate(true);
        });
}

#[cfg(test)]
mod tests;
