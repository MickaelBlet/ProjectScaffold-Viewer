//! ProjectScaffold native editor built on GPUI.

mod canvas;
mod document;
mod node;
mod prefs;
mod theme;

use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::edit::{delete_items, nudge};
use scaffold_model::project::{all_imported, prune_views};
use scaffold_model::types::Id;

use crate::canvas::Canvas;
use crate::document::{DiskChange, Document, GRID};

actions!(
    scaffold,
    [
        Open,
        Save,
        SaveAs,
        Undo,
        Redo,
        Delete,
        SelectAll,
        Deselect,
        FitView,
        NudgeLeft,
        NudgeRight,
        NudgeUp,
        NudgeDown,
        NudgeLeftFar,
        NudgeRightFar,
        NudgeUpFar,
        NudgeDownFar,
        Quit,
    ]
);

fn key_bindings() -> Vec<KeyBinding> {
    let c = Some("Workspace");
    vec![
        KeyBinding::new("ctrl-o", Open, c),
        KeyBinding::new("ctrl-s", Save, c),
        KeyBinding::new("ctrl-shift-s", SaveAs, c),
        KeyBinding::new("ctrl-z", Undo, c),
        KeyBinding::new("ctrl-shift-z", Redo, c),
        KeyBinding::new("ctrl-y", Redo, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("backspace", Delete, c),
        KeyBinding::new("ctrl-a", SelectAll, c),
        KeyBinding::new("escape", Deselect, c),
        KeyBinding::new("shift-1", FitView, c),
        KeyBinding::new("left", NudgeLeft, c),
        KeyBinding::new("right", NudgeRight, c),
        KeyBinding::new("up", NudgeUp, c),
        KeyBinding::new("down", NudgeDown, c),
        KeyBinding::new("shift-left", NudgeLeftFar, c),
        KeyBinding::new("shift-right", NudgeRightFar, c),
        KeyBinding::new("shift-up", NudgeUpFar, c),
        KeyBinding::new("shift-down", NudgeDownFar, c),
        KeyBinding::new("ctrl-q", Quit, c),
    ]
}

/// Arrow keys move by a grid cell (five when far) on the grid, else by 2px (20px).
fn nudge_step(far: bool) -> f64 {
    match (GRID.snap, far) {
        (true, true) => GRID.size * 5.,
        (true, false) => GRID.size,
        (false, true) => 20.,
        (false, false) => 2.,
    }
}

struct Workspace {
    doc: Option<Entity<Document>>,
    canvas: Option<Entity<Canvas>>,
    error: Option<String>,
    focus: FocusHandle,
    /// Set once the user agreed to lose unsaved changes, to let the window close.
    closing: bool,
}

impl Workspace {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let this = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            this.update(cx, |w, cx| w.may_close(window, cx, false))
                .unwrap_or(true)
        });
        Workspace {
            doc: None,
            canvas: None,
            error: None,
            focus: cx.focus_handle(),
            closing: false,
        }
    }

    fn set_doc(&mut self, doc: Document, cx: &mut Context<Self>) {
        let doc = cx.new(|_| doc);
        cx.observe(&doc, |_, _, cx| cx.notify()).detach();
        // Follow changes of the file made by other programs.
        let watched = doc.downgrade();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let Some(doc) = watched.upgrade() else { break };
                let change = doc.update(cx, |d, cx| {
                    let c = d.check_disk();
                    if c != DiskChange::None {
                        cx.notify();
                    }
                    c
                });
                if let DiskChange::Invalid(e) = change
                    && this
                        .update(cx, |w, cx| {
                            w.error = Some(format!("The file changed on disk but does not load:\n{e}"));
                            cx.notify();
                        })
                        .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        self.canvas = Some(cx.new(|cx| Canvas::new(doc.clone(), cx)));
        self.doc = Some(doc);
        self.error = None;
        cx.notify();
    }

    fn open_path(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        match Document::open(&path) {
            Ok(d) => {
                prefs::add_recent(&path);
                self.set_doc(d, cx)
            }
            Err(e) => {
                if !path.exists() {
                    prefs::remove_recent(&path);
                }
                self.error = Some(e);
                cx.notify();
            }
        }
    }

    fn dirty(&self, cx: &App) -> bool {
        self.doc.as_ref().is_some_and(|d| d.read(cx).dirty())
    }

    /// Whether the window may close (or the app quit) now; else ask about unsaved changes first.
    fn may_close(&mut self, window: &mut Window, cx: &mut Context<Self>, quit: bool) -> bool {
        if self.closing || !self.dirty(cx) {
            return true;
        }
        let title = self.doc.as_ref().map(|d| d.read(cx).title()).unwrap_or_default();
        let answer = window.prompt(
            PromptLevel::Warning,
            &format!("Save changes to {title}?"),
            Some("Your changes will be lost if you don't save them."),
            &["Save", "Don't Save", "Cancel"],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            let choice = answer.await.ok();
            this.update_in(cx, |w, window, cx| {
                match choice {
                    Some(0) => {
                        if !w.save(window, cx) {
                            return;
                        }
                    }
                    Some(1) => {}
                    _ => return,
                }
                w.closing = true;
                if quit {
                    cx.quit();
                } else {
                    window.remove_window();
                }
            })
            .ok();
        })
        .detach();
        false
    }

    /// Save to the document's file, or ask where. False when not saved yet.
    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(doc) = self.doc.clone() else {
            return false;
        };
        let Some(path) = doc.read(cx).path.clone() else {
            self.save_as(window, cx);
            return false;
        };
        self.write(&doc, &path, cx)
    }

    fn write(&mut self, doc: &Entity<Document>, path: &std::path::Path, cx: &mut Context<Self>) -> bool {
        match doc.update(cx, |d, cx| {
            let r = d.save_to(path);
            cx.notify();
            r
        }) {
            Ok(()) => true,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                false
            }
        }
    }

    fn save_as(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.doc.clone() else {
            return;
        };
        let current = doc.read(cx).path.clone();
        let dir = current
            .as_deref()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default();
        let name = current
            .as_deref()
            .and_then(|p| p.file_name())
            .map_or("project.scaffold.yaml".to_string(), |n| {
                n.to_string_lossy().into_owned()
            });
        let rx = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(path))) = rx.await {
                this.update(cx, |w, cx| w.write(&doc, &path, cx)).ok();
            }
        })
        .detach();
    }

    fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dirty(cx) {
            // One document at a time for now: keep unsaved changes.
            self.error = Some("Save or undo the changes before opening another file.".into());
            cx.notify();
            return;
        }
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await
                && let Some(path) = paths.into_iter().next()
            {
                this.update(cx, |w, cx| w.open_path(path, cx)).ok();
            }
        })
        .detach();
    }

    /// Run an edit of the document's project with the current selection.
    fn edit(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut scaffold_model::types::Project, &[Id])) {
        if let Some(doc) = &self.doc {
            doc.update(cx, |d, cx| {
                let sel = d.selected.clone();
                d.edit(GRID, |p| f(p, &sel));
                cx.notify();
            });
        }
    }

    fn with_doc(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Document)) {
        if let Some(doc) = &self.doc {
            doc.update(cx, |d, cx| {
                f(d);
                cx.notify();
            });
        }
    }

    fn nudge(&mut self, dx: f64, dy: f64, far: bool, cx: &mut Context<Self>) {
        let step = nudge_step(far);
        self.edit(cx, |p, sel| nudge(p, sel, dx * step, dy * step));
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = match &self.doc {
            Some(d) => {
                let d = d.read(cx);
                format!(
                    "{}{} — ProjectScaffold",
                    if d.dirty() { "● " } else { "" },
                    d.title()
                )
            }
            None => "ProjectScaffold".into(),
        };
        window.set_window_title(&title);
        let body = match &self.canvas {
            Some(c) => div().size_full().child(c.clone()),
            None => {
                let t = theme::light();
                let recent = prefs::recent();
                div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .bg(t.bg)
                    .text_color(t.text)
                    .child(div().text_xl().child("ProjectScaffold"))
                    .child(div().text_color(t.muted).child("Open a project: Ctrl+O"))
                    .when(!recent.is_empty(), |d| {
                        d.child(div().mt_4().text_sm().text_color(t.muted).child("Recent"))
                    })
                    .children(recent.into_iter().enumerate().map(|(i, path)| {
                        let label = path.display().to_string();
                        div()
                            .id(("recent", i))
                            .px_2()
                            .rounded_md()
                            .text_color(t.accent)
                            .cursor_pointer()
                            .hover(|d| d.bg(theme::alpha(t.accent, 0.08)))
                            .on_click(cx.listener(move |w, _, _, cx| w.open_path(path.clone(), cx)))
                            .child(label)
                    }))
            }
        };
        // The file changed on disk while there are unsaved changes.
        let conflict = self
            .doc
            .as_ref()
            .filter(|d| d.read(cx).conflict.is_some())
            .map(|_| {
                let button = |id: &'static str, label: &'static str| {
                    div()
                        .id(id)
                        .px_2()
                        .rounded_md()
                        .border_1()
                        .border_color(theme::hex("#b7791f"))
                        .cursor_pointer()
                        .child(label)
                };
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .p_2()
                    .flex()
                    .gap_2()
                    .items_center()
                    .bg(theme::hex("#fef3c7"))
                    .text_color(theme::hex("#744210"))
                    .text_sm()
                    .child(
                        div()
                            .flex_1()
                            .child("The file changed on disk. Your unsaved changes differ from it."),
                    )
                    .child(
                        button("reload", "Reload from disk").on_click(cx.listener(|w, _, _, cx| {
                            w.with_doc(cx, |d| {
                                if let Some(text) = d.conflict.clone() {
                                    let _ = d.reload(&text);
                                }
                            })
                        })),
                    )
                    .child(
                        button("keep", "Keep mine")
                            .on_click(cx.listener(|w, _, _, cx| w.with_doc(cx, Document::keep_mine))),
                    )
            });
        let error = self.error.clone().map(|e| {
            div()
                .absolute()
                .bottom_0()
                .left_0()
                .right_0()
                .p_2()
                .bg(theme::hex("#fde8e8"))
                .text_color(theme::hex("#9b1c1c"))
                .text_sm()
                .id("error")
                .on_click(cx.listener(|w, _, _, cx| {
                    w.error = None;
                    cx.notify();
                }))
                .child(e)
        });
        div()
            .size_full()
            .relative()
            .key_context("Workspace")
            .track_focus(&self.focus)
            .on_action(cx.listener(|w, _: &Open, window, cx| w.open(window, cx)))
            .on_action(cx.listener(|w, _: &Save, window, cx| {
                w.save(window, cx);
            }))
            .on_action(cx.listener(|w, _: &SaveAs, window, cx| w.save_as(window, cx)))
            .on_action(cx.listener(|w, _: &Undo, _, cx| w.with_doc(cx, Document::undo)))
            .on_action(cx.listener(|w, _: &Redo, _, cx| w.with_doc(cx, Document::redo)))
            .on_action(cx.listener(|w, _: &Delete, _, cx| {
                w.edit(cx, |p, sel| {
                    p.links.retain(|l| !sel.contains(&l.id));
                    delete_items(p, sel);
                    prune_views(p);
                })
            }))
            .on_action(cx.listener(|w, _: &SelectAll, _, cx| {
                w.with_doc(cx, |d| {
                    let p = &d.project;
                    let ids = p
                        .modules
                        .iter()
                        .map(|m| m.id.clone())
                        .chain(all_imported(p).map(|m| m.id.clone()))
                        .chain(
                            p.notes
                                .iter()
                                .filter(|n| n.view_id.is_none())
                                .map(|n| n.id.clone()),
                        )
                        .collect();
                    d.select(ids);
                })
            }))
            .on_action(cx.listener(|w, _: &Deselect, _, cx| w.with_doc(cx, |d| d.select(Vec::new()))))
            .on_action(cx.listener(|w, _: &FitView, _, cx| {
                if let Some(c) = &w.canvas {
                    c.update(cx, |c, cx| c.fit_view(cx));
                }
            }))
            .on_action(cx.listener(|w, _: &NudgeLeft, _, cx| w.nudge(-1., 0., false, cx)))
            .on_action(cx.listener(|w, _: &NudgeRight, _, cx| w.nudge(1., 0., false, cx)))
            .on_action(cx.listener(|w, _: &NudgeUp, _, cx| w.nudge(0., -1., false, cx)))
            .on_action(cx.listener(|w, _: &NudgeDown, _, cx| w.nudge(0., 1., false, cx)))
            .on_action(cx.listener(|w, _: &NudgeLeftFar, _, cx| w.nudge(-1., 0., true, cx)))
            .on_action(cx.listener(|w, _: &NudgeRightFar, _, cx| w.nudge(1., 0., true, cx)))
            .on_action(cx.listener(|w, _: &NudgeUpFar, _, cx| w.nudge(0., -1., true, cx)))
            .on_action(cx.listener(|w, _: &NudgeDownFar, _, cx| w.nudge(0., 1., true, cx)))
            .on_action(cx.listener(|w, _: &Quit, window, cx| {
                if w.may_close(window, cx, true) {
                    cx.quit();
                }
            }))
            .child(body)
            .children(conflict)
            .children(error)
    }
}

fn main() {
    env_logger::init();
    // Under WSLg the D3D12 OpenGL driver presents nothing: draw with the software renderer.
    if std::env::var_os("WSL_DISTRO_NAME").is_some() && std::env::var_os("LIBGL_ALWAYS_SOFTWARE").is_none() {
        // SAFETY: set before any other thread starts.
        unsafe { std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1") };
    }
    let file = std::env::args().nth(1).map(PathBuf::from);
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            cx.bind_keys(key_bindings());
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::centered(size(px(1280.), px(800.)), cx)),
                titlebar: Some(TitlebarOptions {
                    title: Some("ProjectScaffold".into()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, move |window, cx| {
                let ws = cx.new(|cx| {
                    let mut w = Workspace::new(window, cx);
                    if let Some(f) = file {
                        w.open_path(f, cx);
                    }
                    w
                });
                window.focus(&ws.read(cx).focus.clone(), cx);
                ws
            })
            .expect("failed to open window");
            cx.activate(true);
        });
}

#[cfg(test)]
mod tests;
