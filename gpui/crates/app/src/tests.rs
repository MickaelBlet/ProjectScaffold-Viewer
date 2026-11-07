//! Canvas interactions in a headless window: selecting, dragging, undoing, deleting.

use gpui_kit::test::TestWindowExt;
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, Modifiers, ModifiersChangedEvent, Pixels, PlatformInput,
    Point, TestAppContext, WindowBounds, WindowOptions, point, px, size,
};
use scaffold_layout::scene::Pt;
use scaffold_model::types::{Id, Rect};

use crate::Workspace;
use crate::canvas::Canvas;
use crate::document::Document;

fn example(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples")
        .join(name)
}

struct Open {
    window: AnyWindowHandle,
    ws: Entity<Workspace>,
}

fn open(cx: &mut TestAppContext, file: &str) -> Open {
    cx.update(|cx| {
        gpui_kit::init(cx);
        let bindings = crate::commands::key_bindings(cx);
        cx.bind_keys(bindings);
    });
    let path = example(file);
    let (window, ws) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: Point::default(),
                    size: size(px(1280.), px(800.)),
                })),
                ..Default::default()
            },
            cx,
            |window, cx| {
                let ws = cx.new(|cx| {
                    let mut w = Workspace::new(window, cx);
                    w.open_path(path, cx);
                    w
                });
                let focus = ws.read(cx).canvas().unwrap().read(cx).focus_handle();
                window.focus(&focus, cx);
                ws
            },
        )
        .expect("open test window")
    });
    // Two frames: the first lays the canvas out, the second fits the view to it.
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        w.render_frame(cx);
    })
    .unwrap();
    Open { window, ws }
}

impl Open {
    fn doc(&self, cx: &mut TestAppContext) -> Entity<Document> {
        cx.read(|cx| self.ws.read(cx).doc().unwrap())
    }

    fn canvas(&self, cx: &mut TestAppContext) -> Entity<Canvas> {
        cx.read(|cx| self.ws.read(cx).canvas().unwrap())
    }

    fn id(&self, cx: &mut TestAppContext, name: &str) -> Id {
        let doc = self.doc(cx);
        cx.read(|cx| {
            doc.read(cx)
                .project
                .modules
                .iter()
                .find(|m| m.name == name)
                .unwrap()
                .id
                .clone()
        })
    }

    fn rect(&self, cx: &mut TestAppContext, id: &str) -> Rect {
        let c = self.canvas(cx);
        cx.read(|cx| c.read(cx).rect_of(id).unwrap())
    }

    /// Window point at an offset from the top-left corner of an item, in canvas units.
    fn at(&self, cx: &mut TestAppContext, id: &str, dx: f64, dy: f64) -> Point<Pixels> {
        let r = self.rect(cx, id);
        let c = self.canvas(cx);
        cx.read(|cx| {
            c.read(cx).window_point(Pt {
                x: r.x + dx,
                y: r.y + dy,
            })
        })
    }

    fn zoom_px(&self, cx: &mut TestAppContext, units: f64) -> Pixels {
        let a = self.at_origin(cx, 0.);
        let b = self.at_origin(cx, units);
        b.x - a.x
    }

    fn at_origin(&self, cx: &mut TestAppContext, x: f64) -> Point<Pixels> {
        let c = self.canvas(cx);
        cx.read(|cx| c.read(cx).window_point(Pt { x, y: 0. }))
    }

    fn drag(&self, cx: &mut TestAppContext, from: Point<Pixels>, to: Point<Pixels>) {
        cx.update_window(self.window, |_, w, cx| w.drag(from, to, cx))
            .unwrap();
    }

    fn press(&self, cx: &mut TestAppContext, key: &str) {
        cx.update_window(self.window, |_, w, cx| w.press(key, cx))
            .unwrap();
    }

    fn dirty(&self, cx: &mut TestAppContext) -> bool {
        let doc = self.doc(cx);
        cx.read(|cx| doc.read(cx).dirty())
    }

    fn selected(&self, cx: &mut TestAppContext) -> Vec<Id> {
        let doc = self.doc(cx);
        cx.read(|cx| doc.read(cx).selected.clone())
    }
}

#[gpui_kit::test]
fn drag_moves_a_module_on_the_grid_and_undo_restores_it(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let op = o.id(cx, "Operator");
    let before = o.rect(cx, &op);
    let from = o.at(cx, &op, 40., 15.);
    let down = o.zoom_px(cx, 205.);
    o.drag(cx, from, point(from.x, from.y + down));
    let after = o.rect(cx, &op);
    assert_eq!(o.selected(cx), vec![op.clone()]);
    assert_eq!(after.x, before.x);
    assert_eq!(after.y % 20., 0.);
    assert!(
        (after.y - before.y - 205.).abs() <= 10.,
        "{before:?} -> {after:?}"
    );
    assert!(o.dirty(cx));
    o.press(cx, "ctrl-z");
    assert_eq!(o.rect(cx, &op), before);
    assert!(!o.dirty(cx));
    o.press(cx, "ctrl-shift-z");
    assert_eq!(o.rect(cx, &op), after);
}

#[gpui_kit::test]
fn dropping_a_module_into_another_reparents_it(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let op = o.id(cx, "Operator");
    let core = o.id(cx, "Core");
    let r = o.rect(cx, &op);
    let from = o.at(cx, &op, r.width / 2., 15.);
    // Its center (grabbed at mid-width, 15 below the top) over the empty bottom-left corner of Core.
    let c = o.rect(cx, &core);
    let canvas = o.canvas(cx);
    let to = cx.read(|cx| {
        canvas.read(cx).window_point(Pt {
            x: c.x + 50.,
            y: c.y + c.height - 30. - r.height / 2. + 15.,
        })
    });
    o.drag(cx, from, to);
    let doc = o.doc(cx);
    let parent = cx.read(|cx| {
        doc.read(cx)
            .project
            .modules
            .iter()
            .find(|m| m.id == op)
            .unwrap()
            .parent_id
            .clone()
    });
    assert_eq!(parent, Some(core));
}

#[gpui_kit::test]
fn click_selects_escape_clears_and_delete_removes(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let logger = o.id(cx, "Logger");
    let at = o.at(cx, &logger, 40., 15.);
    o.drag(cx, at, at);
    assert_eq!(o.selected(cx), vec![logger.clone()]);
    o.press(cx, "escape");
    assert!(o.selected(cx).is_empty());
    o.drag(cx, at, at);
    o.press(cx, "delete");
    let doc = o.doc(cx);
    let (gone, links) = cx.read(|cx| {
        let p = &doc.read(cx).project;
        (
            p.modules.iter().all(|m| m.id != logger),
            p.links
                .iter()
                .all(|l| l.from.module_id != logger && l.to.module_id != logger),
        )
    });
    assert!(gone && links);
    assert!(o.selected(cx).is_empty());
    o.press(cx, "ctrl-z");
    assert!(cx.read(|cx| doc.read(cx).project.modules.iter().any(|m| m.id == logger)));
}

#[gpui_kit::test]
fn arrows_nudge_by_a_grid_cell(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let logger = o.id(cx, "Logger");
    let at = o.at(cx, &logger, 40., 15.);
    o.drag(cx, at, at);
    let before = o.rect(cx, &logger);
    o.press(cx, "right");
    o.press(cx, "shift-down");
    let after = o.rect(cx, &logger);
    assert_eq!(after.x, before.x + 20.);
    assert_eq!(after.y, before.y + 100.);
}

#[gpui_kit::test]
fn dragging_the_pane_pans_and_shift_drag_selects_a_box(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let op = o.id(cx, "Operator");
    let start = o.at(cx, &op, 0., 0.);
    // Empty canvas above Operator.
    let pane = point(start.x, start.y - px(30.));
    o.drag(cx, pane, point(pane.x + px(50.), pane.y));
    let moved = o.at(cx, &op, 0., 0.);
    assert!((moved.x - start.x - px(50.)).abs() < px(1.));
    assert!(o.selected(cx).is_empty());
    let r = o.rect(cx, &op);
    let a = o.at(cx, &op, -10., -10.);
    let b = o.at(cx, &op, r.width + 10., r.height + 10.);
    cx.update_window(o.window, |_, w, cx| {
        w.dispatch_event(
            PlatformInput::ModifiersChanged(ModifiersChangedEvent {
                modifiers: Modifiers::shift(),
                capslock: Default::default(),
            }),
            cx,
        );
        w.drag(a, b, cx);
    })
    .unwrap();
    assert_eq!(o.selected(cx), vec![op]);
}

#[gpui_kit::test]
fn handles_resize_on_the_grid_keeping_the_opposite_side(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let logger = o.id(cx, "Logger");
    let at = o.at(cx, &logger, 40., 15.);
    o.drag(cx, at, at);
    let before = o.rect(cx, &logger);
    // Bottom-right corner: 60 wider, 40 taller (Logger is near the window's right side).
    let corner = o.at(cx, &logger, before.width, before.height);
    let (dx, dy) = (o.zoom_px(cx, 60.), o.zoom_px(cx, 40.));
    o.drag(cx, corner, point(corner.x + dx, corner.y + dy));
    let grown = o.rect(cx, &logger);
    assert_eq!((grown.x, grown.y), (before.x, before.y));
    assert_eq!(grown.width, before.width + 60., "{before:?} -> {grown:?}");
    assert_eq!(grown.height, before.height + 40., "{before:?} -> {grown:?}");
    assert_eq!((grown.x + grown.width) % 20., 0.);
    // Left side far to the right: the minimum width wins, the right side stays.
    let left = o.at(cx, &logger, 0., grown.height / 2.);
    let far = o.zoom_px(cx, 250.);
    o.drag(cx, left, point(left.x + far, left.y));
    let shrunk = o.rect(cx, &logger);
    assert_eq!(shrunk.x + shrunk.width, grown.x + grown.width);
    assert!(shrunk.width >= 140. && shrunk.width < grown.width);
    o.press(cx, "ctrl-z");
    assert_eq!(o.rect(cx, &logger), grown);
    o.press(cx, "ctrl-z");
    assert_eq!(o.rect(cx, &logger), before);
}

#[gpui_kit::test]
fn a_dragged_frame_carries_what_lies_inside(cx: &mut TestAppContext) {
    // Guides would align the frame with its neighbours instead of moving it by the drag.
    crate::settings::update(|s| s.guides = false);
    let o = open(cx, "shop.scaffold.yaml");
    let doc = o.doc(cx);
    // Unlock the frame (locked in the example).
    let frame = cx.update(|cx| {
        doc.update(cx, |d, cx| {
            let off = crate::document::Grid {
                snap: false,
                size: 20.,
            };
            let id = d
                .project
                .notes
                .iter()
                .find(|n| n.text == "Api binary")
                .unwrap()
                .id
                .clone();
            d.edit(off, |p| {
                p.notes.iter_mut().find(|n| n.id == id).unwrap().locked = false;
            });
            d.seal();
            cx.notify();
            id
        })
    });
    let inside: Vec<(Id, Rect)> = cx
        .read(|cx| {
            let p = &doc.read(cx).project;
            let locked = |id: &str| {
                p.modules.iter().any(|m| m.id == id && m.locked)
                    || p.notes.iter().any(|n| n.id == id && n.locked)
            };
            scaffold_model::project::frame_contents(p, &frame)
                .into_iter()
                .map(|(id, _, _)| id)
                .filter(|id| !locked(id))
                .collect::<Vec<_>>()
        })
        .into_iter()
        .filter_map(|id| {
            // Notes of drill-down views are not drawn in the project view.
            let c = o.canvas(cx);
            let r = cx.read(|cx| c.read(cx).rect_of(&id))?;
            Some((id, r))
        })
        .collect();
    assert!(!inside.is_empty());
    let f = o.rect(cx, &frame);
    let from = o.at(cx, &frame, 4., 4.);
    let by = o.zoom_px(cx, 40.);
    o.drag(cx, from, point(from.x, from.y + by));
    let g = o.rect(cx, &frame);
    assert_eq!(g.y - f.y, 40., "{f:?} -> {g:?}");
    for (id, r) in inside {
        let now = o.rect(cx, &id);
        // Moved items land on the grid, as in the web build.
        assert!(
            (now.x - r.x).abs() <= 10. && (now.y - r.y - 40.).abs() <= 10.,
            "{id}: {r:?} -> {now:?}"
        );
    }
}

#[gpui_kit::test]
fn dragging_from_a_port_to_a_module_links_them_through_a_new_port(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let (op, logger) = (o.id(cx, "Operator"), o.id(cx, "Logger"));
    let doc = o.doc(cx);
    let (port, links) = cx.read(|cx| {
        let p = &doc.read(cx).project;
        let m = p.modules.iter().find(|m| m.id == logger).unwrap();
        (m.ports[0].id.clone(), p.links.len())
    });
    let c = o.canvas(cx);
    let from = cx.read(|cx| {
        let c = c.read(cx);
        c.window_point(c.port_point(&logger, &port).unwrap())
    });
    let to = o.at(cx, &op, 60., 60.);
    o.drag(cx, from, to);
    let (count, last, sel) = cx.read(|cx| {
        let d = doc.read(cx);
        let l = d.project.links.last().unwrap();
        (
            d.project.links.len(),
            (
                l.from.module_id.clone(),
                l.to.module_id.clone(),
                l.to.port_id.clone(),
            ),
            d.selected.clone(),
        )
    });
    assert_eq!(count, links + 1);
    assert_eq!(last, (op, logger, port));
    assert_eq!(sel.len(), 1);
    o.press(cx, "ctrl-z");
    assert_eq!(cx.read(|cx| doc.read(cx).project.links.len()), links);
}

impl Open {
    fn select(&self, cx: &mut TestAppContext, ids: Vec<Id>) {
        let doc = self.doc(cx);
        cx.update(|cx| {
            doc.update(cx, |d, cx| {
                d.select(ids);
                cx.notify();
            })
        });
    }

    fn modules(&self, cx: &mut TestAppContext) -> usize {
        let doc = self.doc(cx);
        cx.read(|cx| doc.read(cx).project.modules.len())
    }
}

#[gpui_kit::test]
fn duplicate_copy_paste_group_and_lock_from_the_keyboard(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let logger = o.id(cx, "Logger");
    let controller = o.id(cx, "Controller");
    let n = o.modules(cx);
    o.select(cx, vec![logger.clone()]);
    o.press(cx, "ctrl-d");
    assert_eq!(o.modules(cx), n + 1);
    let copy = o.selected(cx);
    assert_eq!(copy.len(), 1);
    assert_ne!(copy[0], logger);
    o.press(cx, "ctrl-z");
    assert_eq!(o.modules(cx), n);
    // Through the system clipboard.
    o.select(cx, vec![logger.clone()]);
    o.press(cx, "ctrl-c");
    o.press(cx, "escape");
    o.press(cx, "ctrl-v");
    assert_eq!(o.modules(cx), n + 1);
    o.press(cx, "ctrl-z");
    // Group two siblings, then lock the group.
    o.select(cx, vec![logger.clone(), controller.clone()]);
    o.press(cx, "ctrl-g");
    assert_eq!(o.modules(cx), n + 1);
    let group = o.selected(cx);
    let doc = o.doc(cx);
    let parent = cx.read(|cx| {
        doc.read(cx)
            .project
            .modules
            .iter()
            .find(|m| m.id == logger)
            .unwrap()
            .parent_id
            .clone()
    });
    assert_eq!(parent, group.first().cloned());
    o.press(cx, "ctrl-l");
    let locked = cx.read(|cx| {
        let p = &doc.read(cx).project;
        p.modules
            .iter()
            .find(|m| Some(&m.id) == group.first())
            .unwrap()
            .locked
    });
    assert!(locked);
}

#[gpui_kit::test]
fn new_documents_open_in_tabs(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let first = o.doc(cx);
    o.press(cx, "alt-n");
    let second = o.doc(cx);
    assert_ne!(first, second);
    o.press(cx, "ctrl-m");
    assert_eq!(cx.read(|cx| second.read(cx).project.modules.len()), 1);
    o.press(cx, "alt-1");
    assert_eq!(o.doc(cx), first);
    o.press(cx, "alt-pagedown");
    assert_eq!(o.doc(cx), second);
}

#[gpui_kit::test]
fn the_source_panel_edits_the_project_as_text(cx: &mut TestAppContext) {
    let o = open(cx, "robot.scaffold.yaml");
    let doc = o.doc(cx);
    o.press(cx, "alt-u");
    cx.update_window(o.window, |_, w, cx| w.render_frame(cx)).unwrap();
    let source = cx.read(|cx| o.ws.read(cx).source.clone());
    let editor = cx.read(|cx| source.read(cx).editor.clone());
    let text = cx.read(|cx| editor.read(cx).value().to_string());
    assert!(text.contains("name: Robot"), "{text}");
    // A valid edit replaces the project.
    let renamed = text.replacen("name: Robot", "name: Rover", 1);
    cx.update_window(o.window, |_, w, cx| {
        editor.update(cx, |e, cx| e.replace_all(renamed.clone(), w, cx));
    })
    .unwrap();
    cx.update_window(o.window, |_, w, cx| source.update(cx, |s, cx| s.flush(w, cx)))
        .unwrap();
    assert_eq!(cx.read(|cx| doc.read(cx).project.name.clone()), "Rover");
    // Undo elsewhere rewrites the text.
    cx.update(|cx| doc.update(cx, |d, _| d.undo()));
    cx.update_window(o.window, |_, w, cx| w.render_frame(cx)).unwrap();
    let text = cx.read(|cx| editor.read(cx).value().to_string());
    assert!(text.contains("name: Robot"), "{text}");
    // Text that does not load is not applied.
    cx.update_window(o.window, |_, w, cx| {
        editor.update(cx, |e, cx| e.replace_all("project: [", w, cx));
    })
    .unwrap();
    cx.update_window(o.window, |_, w, cx| source.update(cx, |s, cx| s.flush(w, cx)))
        .unwrap();
    assert_eq!(cx.read(|cx| doc.read(cx).project.name.clone()), "Robot");
}
