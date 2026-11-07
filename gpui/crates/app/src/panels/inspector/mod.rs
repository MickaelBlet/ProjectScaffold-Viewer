//! The Inspector: edits what is selected (project, module, link, type, interface, note, placed
//! module, dependency, several items). Port of `panels/Inspector.tsx` and its inspectors.

mod link;
mod module;
mod project;
mod types;

use std::rc::Rc;

use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::defaults::{format_value, parse_value};
use scaffold_model::edit::{set_layouts, set_locked};
use scaffold_model::project::{frame_contents, type_scope};
use scaffold_model::typeexpr::{parse_type_ref, print_type_ref};
use scaffold_model::types::{Id, NoteKind, Project, TypeRef, Value};

use crate::document::{Document, Selection};
use crate::form::{self, Fields, apply, button, checkbox, colors, heading, muted, row, section};
use crate::theme;
use crate::workspace::Workspace;

pub struct InspectorPanel {
    pub ws: WeakEntity<Workspace>,
    pub fields: Fields,
}

impl InspectorPanel {
    pub fn new(ws: WeakEntity<Workspace>) -> Self {
        InspectorPanel {
            ws,
            fields: Fields::default(),
        }
    }
}

/// Commit closure of a text field that applies `f` to the project with the text.
pub fn on_text(
    doc: &Entity<Document>,
    f: impl Fn(&mut Project, String) + 'static,
) -> impl Fn(String, &mut Window, &mut App) -> Option<String> + 'static {
    let doc = doc.clone();
    move |v, _, cx| {
        apply(&doc, cx, |p| f(p, v));
        None
    }
}

/// Commit closure of a text field checked by `check` (an error keeps the field invalid).
pub fn on_checked_text(
    doc: &Entity<Document>,
    check: impl Fn(&Project, &str) -> Option<String> + 'static,
    f: impl Fn(&mut Project, String) + 'static,
) -> impl Fn(String, &mut Window, &mut App) -> Option<String> + 'static {
    let doc = doc.clone();
    move |v, _, cx| {
        let v = v.trim().to_string();
        if let Some(e) = check(&doc.read(cx).project, &v) {
            return Some(e);
        }
        apply(&doc, cx, |p| f(p, v));
        None
    }
}

impl InspectorPanel {
    /// A type expression field (`vector<Sample>`), names resolved in `context` (a module).
    #[allow(clippy::too_many_arguments)]
    pub fn type_field(
        &mut self,
        key: String,
        p: &Project,
        context: Option<&str>,
        ty: &TypeRef,
        doc: &Entity<Document>,
        window: &mut Window,
        cx: &mut Context<Self>,
        set: impl Fn(&mut Project, TypeRef) + 'static,
    ) -> AnyElement {
        let scope = type_scope(p, context);
        let shown = print_type_ref(ty, |id| scope.name_of(id));
        let ctx = context.map(str::to_string);
        let doc = doc.clone();
        self.fields
            .text(key, &shown, "type", window, cx, move |v, _, cx| {
                let p = doc.read(cx).project.clone();
                let scope = type_scope(&p, ctx.as_deref());
                match parse_type_ref(v.trim(), |n| scope.id_of(n)) {
                    Ok(t) => {
                        apply(&doc, cx, |p| set(p, t.clone()));
                        None
                    }
                    Err(e) => Some(e.to_string()),
                }
            })
    }

    /// A value field (`42`, `"text"`, `[1, 2]`, `Idle`); empty: None.
    #[allow(clippy::too_many_arguments)]
    pub fn value_field(
        &mut self,
        key: String,
        value: Option<&Value>,
        placeholder: &str,
        doc: &Entity<Document>,
        window: &mut Window,
        cx: &mut Context<Self>,
        set: impl Fn(&mut Project, Option<Value>) + 'static,
    ) -> AnyElement {
        let shown = value.map(format_value).unwrap_or_default();
        let doc = doc.clone();
        self.fields
            .text(key, &shown, placeholder, window, cx, move |v, _, cx| {
                let v = v.trim();
                if v.is_empty() {
                    apply(&doc, cx, |p| set(p, None));
                    return None;
                }
                match parse_value(v) {
                    Ok(x) => {
                        apply(&doc, cx, |p| set(p, Some(x.clone())));
                        None
                    }
                    Err(e) => Some(e),
                }
            })
    }

    fn note(
        &mut self,
        id: &Id,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(n) = p.notes.iter().find(|n| &n.id == id).cloned() else {
            return muted("Note deleted.");
        };
        let nid = n.id.clone();
        let with = move |f: Rc<dyn Fn(&mut scaffold_model::types::Note)>| {
            let nid = nid.clone();
            move |p: &mut Project| {
                if let Some(n) = p.notes.iter_mut().find(|x| x.id == nid) {
                    f(n)
                }
            }
        };
        let contents = if n.kind == NoteKind::Frame {
            frame_contents(p, &n.id)
        } else {
            vec![]
        };
        let d = doc.clone();
        let w = with.clone();
        let kind = form::select(
            "note-kind",
            n.kind.as_str(),
            vec![("note".into(), "note".into()), ("frame".into(), "frame".into())],
            move |k, _, cx| {
                let k = NoteKind::parse(&k).unwrap_or(NoteKind::Note);
                apply(&d, cx, w(Rc::new(move |n| n.kind = k)));
            },
        );
        let w = with.clone();
        let text = self.fields.area(
            format!("note-text-{}", n.id),
            &n.text,
            "Text",
            window,
            cx,
            on_text(doc, move |p, v| w(Rc::new(move |n| n.text = v.clone()))(p)),
        );
        let (d, w) = (doc.clone(), with.clone());
        let color = colors("note-color", n.color.as_deref(), move |c, _, cx| {
            apply(&d, cx, w(Rc::new(move |n| n.color = c.clone())))
        });
        let (d, id2) = (doc.clone(), n.id.clone());
        let locked = checkbox(
            "note-locked",
            "Locked (position and size)",
            n.locked,
            move |v, _, cx| apply(&d, cx, |p| set_locked(p, std::slice::from_ref(&id2), v)),
        );
        let ws = self.ws.clone();
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading(n.kind.as_str().to_string(), None))
            .child(row("Kind", kind))
            .child(text)
            .child(section("Color", None).child(color))
            .child(section("Layout", None).child(locked))
            .when(n.kind == NoteKind::Frame, |d| {
                let mut s = section(format!("Contents ({})", contents.len()), None);
                for (cid, _, name) in &contents {
                    let (ws, cid) = (ws.clone(), cid.clone());
                    s = s.child(form::link(
                        SharedString::from(format!("fc-{cid}")),
                        name.clone(),
                        move |window, cx| {
                            let sel = Selection::of(&Project::default(), &cid);
                            let _ = sel;
                            ws.update(cx, |w, cx| w.reveal_id(cid.clone(), window, cx)).ok();
                        },
                    ));
                }
                if contents.is_empty() {
                    s = s.child(muted("Nothing lies fully inside this frame."));
                }
                d.child(s)
            })
            .child(muted(
                "Notes and frames are editor annotations: they are saved but never exported.",
            ))
    }

    fn multi(&mut self, ids: &[Id], doc: &Entity<Document>, p: &Project) -> Div {
        let modules: Vec<&scaffold_model::types::Module> =
            p.modules.iter().filter(|m| ids.contains(&m.id)).collect();
        let notes: Vec<&scaffold_model::types::Note> =
            p.notes.iter().filter(|n| ids.contains(&n.id)).collect();
        let mut parts = Vec::new();
        for (n, what) in [(modules.len(), "module"), (notes.len(), "note")] {
            if n > 0 {
                parts.push(format!("{n} {what}{}", if n > 1 { "s" } else { "" }));
            }
        }
        let on_canvas = modules.len() + notes.len();
        let ws = self.ws.clone();
        let cmd = |id: &'static str, label: &'static str| {
            let ws = ws.clone();
            button(
                SharedString::from(format!("multi-{id}")),
                label,
                move |window, cx| {
                    ws.update(cx, |w, cx| w.run(id, window, cx)).ok();
                },
            )
        };
        let mut out = div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading("Selection", Some(parts.join(", "))));
        if on_canvas > 1 {
            out = out.child(
                section("Align", None).child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_1()
                        .child(cmd("arrange.left", "Left"))
                        .child(cmd("arrange.hcenter", "Center"))
                        .child(cmd("arrange.right", "Right"))
                        .child(cmd("arrange.top", "Top"))
                        .child(cmd("arrange.vcenter", "Middle"))
                        .child(cmd("arrange.bottom", "Bottom"))
                        .child(cmd("arrange.distH", "Distribute ↔"))
                        .child(cmd("arrange.distV", "Distribute ↕"))
                        .child(cmd("arrange.sameSize", "Same size")),
                ),
            );
        }
        if !modules.is_empty() {
            let same = modules.iter().all(|m| m.color == modules[0].color);
            let current = if same { modules[0].color.clone() } else { None };
            let (d, mids): (Entity<Document>, Vec<Id>) =
                (doc.clone(), modules.iter().map(|m| m.id.clone()).collect());
            out = out.child(section("Color", None).child(colors(
                "multi-color",
                current.as_deref(),
                move |c, _, cx| {
                    let mids = mids.clone();
                    apply(&d, cx, move |p| {
                        for m in p.modules.iter_mut().filter(|m| mids.contains(&m.id)) {
                            m.color = c.clone();
                        }
                    })
                },
            )));
        }
        if on_canvas > 0 {
            let all = modules.iter().all(|m| m.locked) && notes.iter().all(|n| n.locked);
            let (d, all_ids): (Entity<Document>, Vec<Id>) = (doc.clone(), ids.to_vec());
            out = out.child(section("Layout", None).child(checkbox(
                "multi-locked",
                "Locked (position and size)",
                all,
                move |v, _, cx| apply(&d, cx, |p| set_locked(p, &all_ids, v)),
            )));
        }
        let mut items = section("Items", None);
        for m in &modules {
            items = items.child(div().text_sm().child(m.name.clone()));
        }
        for n in &notes {
            items = items.child(
                div()
                    .text_sm()
                    .child(n.text.lines().next().unwrap_or("").to_string()),
            );
        }
        out.child(items).child(
            div()
                .flex()
                .gap_1()
                .pt_2()
                .when(!modules.is_empty(), |d| d.child(cmd("arrange.group", "Group")))
                .child(cmd("edit.copy", "Copy"))
                .child(cmd("edit.duplicate", "Duplicate"))
                .child(cmd("edit.delete", "Delete")),
        )
    }

    fn imported(&mut self, id: &Id, doc: &Entity<Document>, p: &Project) -> Div {
        let Some((dep, m)) = scaffold_model::project::find_imported(p, id) else {
            return muted("Module no longer placed.");
        };
        let (d, mid) = (doc.clone(), m.id.clone());
        let mut ports = section(format!("Ports ({})", m.ports.len()), None);
        for pt in &m.ports {
            ports = ports.child(div().text_sm().child(format!(
                    "{} {}{}",
                    pt.role,
                    pt.name,
                    pt.interface
                        .as_ref()
                        .map(|i| format!(": {i}"))
                        .unwrap_or_default()
                )));
        }
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading(m.path.clone(), Some(format!("from {}", dep.name))))
            .child(muted(format!(
                "A module of {} ({}), placed on this canvas: edited in its own project.",
                dep.name, dep.file
            )))
            .child(ports)
            .child(section("Layout", None).child(checkbox(
                "imp-locked",
                "Locked (position and size)",
                m.locked,
                move |v, _, cx| apply(&d, cx, |p| set_locked(p, std::slice::from_ref(&mid), v)),
            )))
            .child({
                let (d, mid) = (doc.clone(), m.id.clone());
                div()
                    .pt_2()
                    .child(button("imp-remove", "Remove from this canvas", move |_, cx| {
                        apply(&d, cx, |p| {
                            scaffold_model::edit::delete_items(p, std::slice::from_ref(&mid))
                        })
                    }))
            })
    }

    fn dependency(&mut self, id: &Id, p: &Project) -> Div {
        let Some(dep) = p.dependencies.iter().find(|d| &d.id == id) else {
            return muted("Dependency removed.");
        };
        let types = p
            .types
            .iter()
            .filter(|t| t.dependency.as_ref() == Some(id))
            .count();
        let ifaces = p
            .interfaces
            .iter()
            .filter(|i| i.dependency.as_ref() == Some(id))
            .count();
        let mut s = div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading(dep.name.clone(), Some("dependency".into())))
            .child(row("File", div().text_sm().child(dep.file.clone())))
            .child(row(
                "Uses",
                div().text_sm().child(if dep.uses.is_empty() {
                    "—".into()
                } else {
                    dep.uses.join(", ")
                }),
            ))
            .child(row(
                "Shared",
                div().text_sm().child(if dep.shared.is_empty() {
                    "—".into()
                } else {
                    dep.shared.join(", ")
                }),
            ))
            .child(muted(format!(
                "{types} types, {ifaces} interfaces, {} placed modules{}",
                dep.modules.len(),
                if dep.indirect {
                    " (used by another dependency)"
                } else {
                    ""
                }
            )));
        let mut placed = section(format!("Placed modules ({})", dep.modules.len()), None);
        for m in &dep.modules {
            placed = placed.child(div().text_sm().child(m.path.clone()));
        }
        s = s.child(placed);
        s
    }
}

impl Render for InspectorPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current();
        let Some(doc) = self.ws.upgrade().and_then(|w| w.read(cx).doc()) else {
            return div()
                .p_2()
                .text_sm()
                .text_color(t.muted)
                .child("No document.")
                .into_any_element();
        };
        let (p, sel, ids) = {
            let d = doc.read(cx);
            (d.project.clone(), d.selection.clone(), d.selected.clone())
        };
        self.fields.begin();
        let body = match (&sel, ids.len()) {
            (_, n) if n > 1 => self.multi(&ids, &doc, &p),
            (None, _) | (Some(Selection::Project), _) => self.project(&doc, &p, window, cx),
            (Some(Selection::Module { id, .. }), _) => self.module(id, &doc, &p, window, cx),
            (Some(Selection::Link(id)), _) => self.link(id, &doc, &p, window, cx),
            (Some(Selection::Type(id)), _) => self.type_def(id, &doc, &p, window, cx),
            (Some(Selection::Interface(id)), _) => self.interface(id, &doc, &p, window, cx),
            (Some(Selection::Note(id)), _) => self.note(id, &doc, &p, window, cx),
            (Some(Selection::Imported(id)), _) => self.imported(id, &doc, &p),
            (Some(Selection::Dependency(id)), _) => self.dependency(id, &p),
        };
        self.fields.end();
        let _ = set_layouts;
        div()
            .id("inspector")
            .size_full()
            .overflow_y_scroll()
            .p_2()
            .text_sm()
            .child(body)
            .into_any_element()
    }
}
