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
        cx.bind_keys(crate::key_bindings());
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
                window.focus(&ws.read(cx).focus.clone(), cx);
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
        cx.read(|cx| self.ws.read(cx).doc.clone().unwrap())
    }

    fn canvas(&self, cx: &mut TestAppContext) -> Entity<Canvas> {
        cx.read(|cx| self.ws.read(cx).canvas.clone().unwrap())
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
