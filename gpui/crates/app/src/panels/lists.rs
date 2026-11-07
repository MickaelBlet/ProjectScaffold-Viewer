//! Problems, Output and Search panels. Port of `ProblemsPanel.tsx`, `OutputPanel.tsx` and
//! `SearchPanel.tsx`.

use gpui_kit::component::Sizable;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::search::search_project;
use scaffold_model::validate::{ProblemTarget, Severity, validate};

use crate::document::Selection;
use crate::theme;
use crate::workspace::Workspace;

/// Inspector selection of a problem's (or search hit's) target.
pub fn selection_of(t: &ProblemTarget) -> Option<Selection> {
    Some(match t {
        ProblemTarget::Project | ProblemTarget::Const(_) => Selection::Project,
        ProblemTarget::Type(id) => Selection::Type(id.clone()),
        ProblemTarget::Interface(id) => Selection::Interface(id.clone()),
        ProblemTarget::Module(id) => Selection::Module {
            id: id.clone(),
            member: None,
        },
        ProblemTarget::Link(id) => Selection::Link(id.clone()),
        ProblemTarget::Dependency(id) => Selection::Dependency(id.clone()),
    })
}

fn target_label(p: &scaffold_model::types::Project, t: &ProblemTarget) -> String {
    let paths = scaffold_model::project::project_module_paths(p);
    match t {
        ProblemTarget::Project => "project".into(),
        ProblemTarget::Type(id) => scaffold_model::project::type_names(p)
            .get(id)
            .map_or("type".into(), |n| format!("type {n}")),
        ProblemTarget::Interface(id) => p
            .interfaces
            .iter()
            .find(|i| &i.id == id)
            .map_or("interface".into(), |i| format!("interface {}", i.name)),
        ProblemTarget::Const(id) => p
            .consts
            .iter()
            .find(|c| &c.id == id)
            .map_or("constant".into(), |c| format!("constant {}", c.name)),
        ProblemTarget::Module(id) => paths.get(id).map_or("module".into(), |n| format!("module {n}")),
        ProblemTarget::Link(id) => p
            .links
            .iter()
            .find(|l| &l.id == id)
            .map_or("link".into(), |l| format!("link {}", l.name)),
        ProblemTarget::Dependency(id) => p
            .dependencies
            .iter()
            .find(|d| &d.id == id)
            .map_or("dependency".into(), |d| format!("dependency {}", d.name)),
    }
}

/// Problems of the active document: errors first.
pub struct ProblemsPanel {
    pub ws: WeakEntity<Workspace>,
}

impl Render for ProblemsPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current();
        let Some(doc) = self.ws.upgrade().and_then(|w| w.read(cx).doc()) else {
            return div()
                .p_2()
                .text_sm()
                .text_color(t.muted)
                .child("No document.")
                .into_any_element();
        };
        let p = doc.read(cx).project.clone();
        let mut problems = validate(&p);
        problems.sort_by_key(|x| x.severity != Severity::Error);
        if problems.is_empty() {
            return div()
                .p_2()
                .text_sm()
                .text_color(t.muted)
                .child("No problems.")
                .into_any_element();
        }
        let ws = self.ws.clone();
        div()
            .id("problems")
            .size_full()
            .overflow_y_scroll()
            .text_sm()
            .children(problems.into_iter().enumerate().map(|(i, pr)| {
                let error = pr.severity == Severity::Error;
                let label = target_label(&p, &pr.target);
                let (ws, target) = (ws.clone(), pr.target.clone());
                div()
                    .id(("problem", i))
                    .flex()
                    .gap_2()
                    .px_2()
                    .py(px(2.))
                    .cursor_pointer()
                    .hover(|d| d.bg(theme::alpha(t.accent, 0.08)))
                    .on_click(move |_, window, cx| {
                        let sel = selection_of(&target);
                        ws.update(cx, |w, cx| w.reveal(sel, window, cx)).ok();
                    })
                    .child(
                        div()
                            .flex_none()
                            .w(px(56.))
                            .text_xs()
                            .text_color(if error {
                                theme::hex("#d23f3f")
                            } else {
                                theme::hex("#b7791f")
                            })
                            .child(if error { "error" } else { "warning" }),
                    )
                    .child(div().flex_1().child(pr.message))
                    .child(div().flex_none().text_xs().text_color(t.muted).child(label))
            }))
            .into_any_element()
    }
}

/// Messages of the app: saves, imports, failures.
pub struct OutputPanel {
    pub ws: WeakEntity<Workspace>,
}

impl Render for OutputPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current();
        let lines = self
            .ws
            .upgrade()
            .map(|w| w.read(cx).output.clone())
            .unwrap_or_default();
        div()
            .id("output")
            .size_full()
            .overflow_y_scroll()
            .p_1()
            .text_xs()
            .font_family("DejaVu Sans Mono")
            .when(lines.is_empty(), |d| d.text_color(t.muted).child("No output."))
            .children(lines.into_iter().map(|l| div().child(l)))
    }
}

/// Full-text search over the active project.
pub struct SearchPanel {
    pub ws: WeakEntity<Workspace>,
    query: Entity<InputState>,
    _sub: Subscription,
}

impl SearchPanel {
    pub fn new(ws: WeakEntity<Workspace>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search names, descriptions, metadata"));
        let _sub = cx.subscribe_in(&query, window, |_, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        });
        SearchPanel { ws, query, _sub }
    }

    pub fn focus(this: &Entity<Self>, window: &mut Window, cx: &mut App) {
        let query = this.read(cx).query.clone();
        query.update(cx, |q, cx| q.focus(window, cx));
    }
}

impl Render for SearchPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current();
        let q = self.query.read(cx).value().to_string();
        let doc = self.ws.upgrade().and_then(|w| w.read(cx).doc());
        let hits = match (&doc, q.trim().is_empty()) {
            (Some(d), false) => search_project(&d.read(cx).project, q.trim()),
            _ => Vec::new(),
        };
        let ws = self.ws.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_1()
            .p_1()
            .child(Input::new(&self.query).small())
            .child(div().text_xs().text_color(t.muted).child(if q.trim().is_empty() {
                String::new()
            } else {
                format!("{} results", hits.len())
            }))
            .child(
                div()
                    .id("search-hits")
                    .flex_1()
                    .overflow_y_scroll()
                    .text_sm()
                    .children(hits.into_iter().enumerate().map(|(i, h)| {
                        let (ws, target) = (ws.clone(), h.target.clone());
                        div()
                            .id(("hit", i))
                            .px_1()
                            .py(px(2.))
                            .cursor_pointer()
                            .hover(|d| d.bg(theme::alpha(t.accent, 0.08)))
                            .on_click(move |_, window, cx| {
                                let sel = selection_of(&target);
                                ws.update(cx, |w, cx| w.reveal(sel, window, cx)).ok();
                            })
                            .child(div().child(h.label))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(t.muted)
                                    .child(format!("{}: {}", h.field, h.text)),
                            )
                    })),
            )
    }
}
