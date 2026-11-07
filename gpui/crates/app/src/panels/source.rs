//! The project as file text, edited in place: valid edits replace the project (one undo step
//! each), and changes made elsewhere (canvas, inspector, undo, file changed on disk) rewrite the
//! text. Port of `SourcePanel.tsx`.

use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::highlighter::{Diagnostic, DiagnosticSeverity};
use gpui_kit::component::input::{
    CompletionProvider, Editor, EditorState, HoverProvider, InputEvent, Position, Rope, RopeExt,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::completion::{
    ProjectNames, complete, describe_key, file_schema, filter_items, structure_at,
};
use scaffold_model::locate::{locate_validation, target_path};
use scaffold_model::project::{note_path, project_module_paths, type_names};
use scaffold_model::serialize::{Format, reload_text, same_content, save_text};
use scaffold_model::serialize::{line_of_path, parse_text};
use scaffold_model::source_target::{SourceTarget, target_at};
use scaffold_model::types::Project;
use scaffold_model::validate::ProblemTarget;
use scaffold_model::validate::{Severity, validate};

use crate::document::{Document, Selection};
use crate::settings;
use crate::theme;
use crate::workspace::Workspace;

/// Delay after the last keystroke before the text is applied.
const APPLY: Duration = Duration::from_millis(400);
/// Delay after the last caret move before the element under it is shown.
const FOLLOW: Duration = Duration::from_millis(250);

/// A problem of the text, on its line (1-based) when known.
#[derive(Clone, Debug, PartialEq)]
pub struct TextProblem {
    pub line: Option<usize>,
    pub message: String,
    pub error: bool,
}

/// Editor options from the settings, applied when they change.
#[derive(Clone, Copy, PartialEq)]
struct Options {
    wrap: bool,
    numbers: bool,
    folding: bool,
}

pub struct SourcePanel {
    ws: WeakEntity<Workspace>,
    pub editor: Entity<EditorState>,
    /// The document the text is of.
    doc: Option<Entity<Document>>,
    format: Format,
    /// Project the text stands for.
    shown: Project,
    /// The text does not load: its problems are its load errors.
    invalid: bool,
    /// Typed text waiting to be applied.
    pending: Option<Task<()>>,
    /// The project changed elsewhere while the text holds edits it cannot take.
    stale: bool,
    problems: Vec<TextProblem>,
    list_open: bool,
    options: Option<Options>,
    /// Caret offset last seen, and the element last shown for it.
    caret: usize,
    followed: String,
    follow: Option<Task<()>>,
    /// Selection of the document last seen, to move the caret to it.
    selection: Option<Selection>,
    _subs: Vec<Subscription>,
}

impl SourcePanel {
    pub fn new(ws: WeakEntity<Workspace>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language("yaml")
                .line_number(true)
                .folding(true)
                .soft_wrap(false)
        });
        let names = Rc::new(Names { ws: ws.clone() });
        editor.update(cx, |e, _| {
            e.lsp_mut().completion_provider = Some(names.clone());
            e.lsp_mut().hover_provider = Some(names);
        });
        let subs = vec![
            cx.subscribe_in(&editor, window, |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => this.input(window, cx),
                // Back from elsewhere, the element under the caret is shown again.
                InputEvent::Focus => this.followed.clear(),
                InputEvent::Blur => this.flush(window, cx),
                _ => {}
            }),
            cx.observe_in(&editor, window, |this, _, window, cx| {
                this.caret_moved(window, cx)
            }),
        ];
        SourcePanel {
            ws,
            editor,
            doc: None,
            format: Format::Yaml,
            shown: Project::default(),
            invalid: false,
            pending: None,
            stale: false,
            problems: Vec::new(),
            list_open: true,
            options: None,
            caret: 0,
            followed: String::new(),
            follow: None,
            selection: None,
            _subs: subs,
        }
    }

    fn input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pending = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(APPLY).await;
            this.update_in(cx, |s, window, cx| s.apply(window, cx)).ok();
        }));
    }

    /// Apply the text now if it has changes waiting.
    pub fn flush(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            self.apply(window, cx);
        }
    }

    /// Replace the text with the project.
    fn show(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pending = None;
        let Some(doc) = self.doc.clone() else { return };
        let (project, format) = {
            let d = doc.read(cx);
            (d.project.clone(), d.format)
        };
        self.format = format;
        let text = save_text(&project, format, true);
        self.editor
            .update(cx, |e, cx| e.set_value(text.clone(), window, cx));
        let problems = validation_problems(&text, format, &project);
        self.shown = project;
        self.invalid = false;
        self.stale = false;
        self.report(problems, cx);
    }

    fn apply(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.pending = None;
        let Some(doc) = self.doc.clone() else { return };
        let current = doc.read(cx).project.clone();
        let text = self.editor.read(cx).value().to_string();
        match reload_text(&text, self.format, &current) {
            Ok(next) => {
                self.invalid = false;
                self.stale = false;
                // Layout-only or formatting edits that change nothing are no undo step.
                let changed = !same_content(&next, &current);
                self.shown = if changed { next.clone() } else { current };
                let problems = validation_problems(&text, self.format, &self.shown);
                self.report(problems, cx);
                if changed {
                    doc.update(cx, |d, cx| {
                        d.set_from_text(next);
                        cx.notify();
                    });
                }
            }
            Err(e) => {
                self.invalid = true;
                self.list_open = true;
                let problems = e
                    .issues
                    .into_iter()
                    .map(|i| TextProblem {
                        line: i.line,
                        message: i.message,
                        error: true,
                    })
                    .collect();
                self.report(problems, cx);
            }
        }
    }

    /// Show the problems in the list and as diagnostics on their lines.
    fn report(&mut self, problems: Vec<TextProblem>, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let text = e.text().clone();
            let source = text.to_string();
            let lines: Vec<&str> = source.split('\n').collect();
            if let Some(set) = e.diagnostics_mut() {
                set.reset(&text);
                for p in &problems {
                    let Some(n) = p.line.filter(|n| *n >= 1 && *n <= lines.len()) else {
                        continue;
                    };
                    let line = lines[n - 1].trim_end_matches('\r');
                    let from = line.chars().take_while(|c| c.is_whitespace()).count() as u32;
                    let to = (line.encode_utf16().count() as u32).max(from);
                    let row = (n - 1) as u32;
                    set.push(
                        Diagnostic::new(
                            Position::new(row, from)..Position::new(row, to),
                            p.message.clone(),
                        )
                        .with_severity(if p.error {
                            DiagnosticSeverity::Error
                        } else {
                            DiagnosticSeverity::Warning
                        }),
                    );
                }
            }
            cx.notify();
        });
        self.problems = problems;
        cx.notify();
    }

    /// Put the caret on a line (1-based) and focus the text.
    pub fn go_to_line(&mut self, line: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            e.set_cursor_position(Position::new(line.saturating_sub(1) as u32, 0), window, cx);
            e.focus(window, cx);
        });
    }

    /// The element under the caret is selected and zoomed to, once per element.
    fn caret_moved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (caret, focused) = {
            let e = self.editor.read(cx);
            (e.cursor(), e.focus_handle(cx).is_focused(window))
        };
        if caret == self.caret {
            return;
        }
        self.caret = caret;
        if !focused || self.format != Format::Yaml || !settings::get().source_follow {
            return;
        }
        self.follow = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(FOLLOW).await;
            this.update_in(cx, |s, window, cx| s.follow_caret(window, cx))
                .ok();
        }));
    }

    fn follow_caret(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.follow = None;
        let Some(doc) = self.doc.clone() else { return };
        let text = self.editor.read(cx).value().to_string();
        let caret = self.caret.min(text.len());
        let (path, names) = structure_at(&text, caret);
        let p = doc.read(cx).project.clone();
        let Some(target) = target_at(&p, &path, &names) else {
            return;
        };
        let key = format!("{target:?}");
        if key == self.followed {
            return;
        }
        self.followed = key;
        let sel = match target {
            SourceTarget::Note(id) => Some(Selection::Note(id)),
            SourceTarget::Entity(t) => crate::panels::lists::selection_of(&t),
        };
        // Revealing it here does not move the caret back.
        self.selection = sel.clone();
        if let Some(ws) = self.ws.upgrade() {
            ws.update(cx, |w, cx| w.reveal(sel, window, cx));
        }
        // Typing goes on here.
        self.editor.update(cx, |e, cx| e.focus(window, cx));
    }

    /// The caret goes to the entity selected elsewhere (canvas, lists...).
    fn reveal(&mut self, sel: &Selection, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        let p = &doc.read(cx).project;
        let text = self.editor.read(cx).value().to_string();
        let Ok(data) = parse_text(&text, self.format) else {
            return;
        };
        let path = match sel {
            Selection::Note(id) => match note_path(p, id) {
                Some(path) => path,
                None => return,
            },
            other => {
                let target = match other {
                    Selection::Project => ProblemTarget::Project,
                    Selection::Module { id, .. } | Selection::Imported(id) => {
                        ProblemTarget::Module(id.clone())
                    }
                    Selection::Link(id) => ProblemTarget::Link(id.clone()),
                    Selection::Type(id) => ProblemTarget::Type(id.clone()),
                    Selection::Interface(id) => ProblemTarget::Interface(id.clone()),
                    Selection::Dependency(id) => ProblemTarget::Dependency(id.clone()),
                    Selection::Note(_) => unreachable!(),
                };
                target_path(&data, p, &target)
            }
        };
        if let Some(line) = line_of_path(&text, &path) {
            self.editor.update(cx, |e, cx| {
                e.set_cursor_position(Position::new(line.saturating_sub(1) as u32, 0), window, cx);
            });
            self.caret = self.editor.read(cx).cursor();
        }
    }

    /// Follow the active document and its changes made elsewhere.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let doc = self.ws.upgrade().and_then(|w| w.read(cx).doc());
        let same = match (&doc, &self.doc) {
            (Some(a), Some(b)) => a.entity_id() == b.entity_id(),
            (None, None) => true,
            _ => false,
        };
        if !same {
            // Typed text goes to its own document before showing another one.
            self.flush(window, cx);
            self.doc = doc;
            self.show(window, cx);
            return;
        }
        let Some(doc) = self.doc.clone() else { return };
        let (changed, selection) = {
            let d = doc.read(cx);
            (
                d.project != self.shown || d.format != self.format,
                d.selection.clone(),
            )
        };
        if changed {
            if self.invalid || self.pending.is_some() {
                self.stale = true;
            } else {
                self.show(window, cx);
            }
        }
        if selection != self.selection {
            self.selection = selection.clone();
            let focused = self.editor.read(cx).focus_handle(cx).is_focused(window);
            if let Some(sel) =
                selection.filter(|_| !focused && self.format == Format::Yaml && settings::get().source_follow)
            {
                self.reveal(&sel, window, cx);
            }
        }
        let s = settings::get();
        let options = Options {
            wrap: s.editor_word_wrap,
            numbers: s.editor_line_numbers,
            folding: s.editor_folding,
        };
        if self.options != Some(options) {
            self.options = Some(options);
            self.editor.update(cx, |e, cx| {
                e.set_soft_wrap(options.wrap, window, cx);
                e.set_line_number(options.numbers, window, cx);
                e.set_folding(options.folding, window, cx);
            });
        }
    }
}

/// Completions and key descriptions from the file schema and the names of the project.
struct Names {
    ws: WeakEntity<Workspace>,
}

impl Names {
    fn project_names(&self, cx: &App) -> ProjectNames {
        let Some(doc) = self.ws.upgrade().and_then(|w| w.read(cx).doc()) else {
            return ProjectNames::default();
        };
        let p = &doc.read(cx).project;
        let paths = project_module_paths(p);
        let qualified = type_names(p);
        ProjectNames {
            interfaces: p.interfaces.iter().map(|i| i.name.clone()).collect(),
            modules: p
                .modules
                .iter()
                .filter_map(|m| paths.get(&m.id).cloned())
                .collect(),
            placed: p
                .dependencies
                .iter()
                .map(|d| (d.name.clone(), d.modules.iter().map(|m| m.path.clone()).collect()))
                .collect(),
            // The types of the modules of dependencies this project can use: their public ones.
            types: p
                .types
                .iter()
                .filter(|t| !(t.dependency.is_some() && t.module_path.is_some() && t.access.is_some()))
                .filter_map(|t| qualified.get(&t.id).cloned())
                .collect(),
        }
    }
}

impl CompletionProvider for Names {
    fn completions(
        &self,
        text: &Rope,
        offset: usize,
        trigger: lsp_types::CompletionContext,
        _: &mut Window,
        cx: &mut App,
    ) -> Task<anyhow::Result<lsp_types::CompletionResponse>> {
        let source = text.to_string();
        let explicit = trigger.trigger_kind == lsp_types::CompletionTriggerKind::INVOKED;
        let result = complete(
            &source,
            offset.min(source.len()),
            file_schema(),
            &self.project_names(cx),
        );
        let items = match &result {
            Some(r) if explicit || r.value || !r.prefix.is_empty() => {
                let range =
                    lsp_types::Range::new(text.offset_to_position(r.from), text.offset_to_position(r.to));
                filter_items(r)
                    .into_iter()
                    .map(|c| lsp_types::CompletionItem {
                        label: c.label,
                        detail: c.detail,
                        text_edit: Some(lsp_types::CompletionTextEdit::Edit(lsp_types::TextEdit::new(
                            range, c.insert,
                        ))),
                        ..Default::default()
                    })
                    .collect()
            }
            _ => Vec::new(),
        };
        Task::ready(Ok(lsp_types::CompletionResponse::Array(items)))
    }

    fn is_completion_trigger(&self, _offset: usize, new_text: &str, _: &mut App) -> bool {
        settings::get().editor_autocomplete
            && new_text
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() || matches!(c, ':' | ' ' | '-' | '_' | '.'))
    }
}

impl HoverProvider for Names {
    fn hover(
        &self,
        text: &Rope,
        offset: usize,
        _: &mut Window,
        _: &mut App,
    ) -> Task<anyhow::Result<Option<lsp_types::Hover>>> {
        let source = text.to_string();
        let hover =
            describe_key(&source, offset.min(source.len()), file_schema()).map(|d| lsp_types::Hover {
                contents: lsp_types::HoverContents::Scalar(lsp_types::MarkedString::String(d.text)),
                range: Some(lsp_types::Range::new(
                    text.offset_to_position(d.from),
                    text.offset_to_position(d.to),
                )),
            });
        Task::ready(Ok(hover))
    }
}

/// Validation problems of the project shown by the text, on their lines.
fn validation_problems(text: &str, format: Format, project: &Project) -> Vec<TextProblem> {
    let problems = validate(project);
    locate_validation(text, format, project, &problems)
        .into_iter()
        .map(|p| TextProblem {
            line: Some(p.line),
            message: p.message,
            error: p.severity == Severity::Error,
        })
        .collect()
}

fn pill(id: &'static str, label: String, on: bool) -> Stateful<Div> {
    let t = theme::current();
    div()
        .id(id)
        .px_2()
        .rounded_full()
        .border_1()
        .text_xs()
        .cursor_pointer()
        .when(on, |d| {
            d.border_color(t.accent)
                .text_color(t.accent)
                .bg(theme::alpha(t.accent, 0.08))
        })
        .when(!on, |d| d.border_color(t.border).text_color(t.muted))
        .child(label)
}

impl Render for SourcePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let t = theme::current();
        if self.doc.is_none() {
            return div()
                .p_2()
                .text_sm()
                .text_color(t.muted)
                .child("No document.")
                .into_any_element();
        }
        let s = settings::get();
        let errors = self.problems.iter().filter(|p| p.error).count();
        let warnings = self.problems.len() - errors;
        let yaml = self.format == Format::Yaml;
        let header = div()
            .flex()
            .items_center()
            .gap_2()
            .px_2()
            .py_1()
            .border_b_1()
            .border_color(t.border)
            .when(yaml, |d| {
                d.child(
                    pill("src-follow", "Sync selection".into(), s.source_follow).on_click(|_, _, cx| {
                        settings::update(|s| s.source_follow = !s.source_follow);
                        cx.refresh_windows();
                    }),
                )
            })
            .child(div().flex_1())
            .when(self.invalid, |d| {
                d.child(
                    div()
                        .text_xs()
                        .text_color(theme::hex("#d23f3f"))
                        .child("Not applied"),
                )
            })
            .when(!self.problems.is_empty(), |d| {
                d.child(
                    pill(
                        "src-counts",
                        format!("{errors} errors, {warnings} warnings"),
                        self.list_open,
                    )
                    .on_click(cx.listener(|s, _, _, cx| {
                        s.list_open = !s.list_open;
                        cx.notify();
                    })),
                )
            })
            .when(self.stale || self.invalid, |d| {
                d.child(
                    pill("src-discard", "Discard edits".into(), false)
                        .on_click(cx.listener(|s, _, window, cx| s.show(window, cx))),
                )
            });
        let font = if s.editor_font_family.trim().is_empty() {
            "DejaVu Sans Mono".to_string()
        } else {
            s.editor_font_family.clone()
        };
        let list = (self.list_open && !self.problems.is_empty()).then(|| {
            div()
                .id("src-problems")
                .max_h(px(140.))
                .overflow_y_scroll()
                .border_t_1()
                .border_color(t.border)
                .text_xs()
                .children(self.problems.iter().enumerate().map(|(i, p)| {
                    let line = p.line;
                    div()
                        .id(("src-problem", i))
                        .flex()
                        .gap_2()
                        .px_2()
                        .py(px(1.))
                        .child(
                            div()
                                .flex_none()
                                .text_color(if p.error {
                                    theme::hex("#d23f3f")
                                } else {
                                    theme::hex("#b7791f")
                                })
                                .child(if p.error { "error" } else { "warning" }),
                        )
                        .when_some(line, |d, n| {
                            d.child(
                                div()
                                    .id(("src-line", i))
                                    .flex_none()
                                    .text_color(t.accent)
                                    .cursor_pointer()
                                    .child(format!("Line {n}"))
                                    .on_click(
                                        cx.listener(move |s, _, window, cx| s.go_to_line(n, window, cx)),
                                    ),
                            )
                        })
                        .child(div().flex_1().child(p.message.clone()))
                }))
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .child(header)
            .when(self.stale, |d| {
                d.child(
                    div()
                        .px_2()
                        .text_xs()
                        .text_color(theme::hex("#b7791f"))
                        .child("The project changed elsewhere since these edits."),
                )
            })
            .child(
                div().flex_1().min_h_0().child(
                    Editor::new(&self.editor)
                        .h_full()
                        .bordered(false)
                        .font_family(font)
                        .text_size(px(s.editor_font_size as f32)),
                ),
            )
            .children(list)
            .into_any_element()
    }
}
