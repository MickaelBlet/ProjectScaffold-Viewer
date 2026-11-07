//! An IDL file edited as text beside the canvas, checked as typed. Port of `FilePanel.tsx` /
//! `store/textFiles.ts` (one file at a time).

use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::component::input::{Editor, EditorState, InputEvent};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::settings;
use crate::theme;

/// Delay after the last keystroke before the text is checked.
const CHECK: Duration = Duration::from_millis(400);

/// The panel asks to be closed.
pub struct CloseText;

impl EventEmitter<CloseText> for TextFilePanel {}

pub struct TextFilePanel {
    pub path: PathBuf,
    pub editor: Entity<EditorState>,
    /// Text as last read or saved.
    saved: String,
    dirty: bool,
    /// What reading the text as IDL found.
    problems: Vec<String>,
    check: Option<Task<()>>,
    error: Option<String>,
    _sub: Subscription,
}

impl TextFilePanel {
    pub fn new(path: PathBuf, text: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .line_number(true)
                .folding(true)
                .soft_wrap(false)
                .default_value(text.clone())
        });
        let _sub = cx.subscribe_in(&editor, window, |this, _, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::Change) {
                this.changed(window, cx);
            }
        });
        let mut panel = TextFilePanel {
            path,
            editor,
            saved: text,
            dirty: false,
            problems: Vec::new(),
            check: None,
            error: None,
            _sub,
        };
        panel.problems = panel.read(cx);
        panel
    }

    pub fn dirty(&self) -> bool {
        self.dirty
    }

    fn changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dirty = self.editor.read(cx).value().as_ref() != self.saved;
        self.check = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(CHECK).await;
            this.update(cx, |s, cx| {
                s.problems = s.read(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Problems of the text read as IDL, with the files it includes read from disk.
    fn read(&self, cx: &App) -> Vec<String> {
        let key = self.path.to_string_lossy().replace('\\', "/");
        let files = indexmap::IndexMap::from([(key, self.editor.read(cx).value().to_string())]);
        let files = scaffold_model::idl::read_idl_includes(&files, |p| std::fs::read_to_string(p).ok());
        match scaffold_model::idl::parse_idl_files(&files) {
            Ok(f) => f
                .warnings
                .iter()
                .cloned()
                .chain(f.missing.iter().map(|m| format!("Included file not found: {m}")))
                .collect(),
            Err(e) => vec![e.to_string()],
        }
    }

    pub fn save(&mut self, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        match std::fs::write(&self.path, &text) {
            Ok(()) => {
                self.saved = text;
                self.dirty = false;
                self.error = None;
            }
            Err(e) => self.error = Some(format!("{}: {e}", self.path.display())),
        }
        cx.notify();
    }
}

impl Render for TextFilePanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current();
        let s = settings::get();
        let name = self
            .path
            .file_name()
            .map_or(String::new(), |n| n.to_string_lossy().into_owned());
        let font = if s.editor_font_family.trim().is_empty() {
            "DejaVu Sans Mono".to_string()
        } else {
            s.editor_font_family.clone()
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .border_b_1()
                    .border_color(t.border)
                    .text_sm()
                    .child(format!("{}{name}", if self.dirty { "● " } else { "" }))
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("text-save")
                            .px_2()
                            .rounded_md()
                            .border_1()
                            .border_color(t.border)
                            .text_xs()
                            .when(self.dirty, |d| d.cursor_pointer().text_color(t.accent))
                            .when(!self.dirty, |d| d.text_color(t.muted))
                            .child("Save")
                            .on_click(cx.listener(|s, _, _, cx| s.save(cx))),
                    )
                    .child(
                        div()
                            .id("text-close")
                            .px_1()
                            .cursor_pointer()
                            .text_color(t.muted)
                            .child("×")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(CloseText))),
                    ),
            )
            .children(
                self.error
                    .clone()
                    .map(|e| div().px_2().text_xs().text_color(theme::hex("#d23f3f")).child(e)),
            )
            .child(
                div().flex_1().min_h_0().child(
                    Editor::new(&self.editor)
                        .h_full()
                        .bordered(false)
                        .font_family(font)
                        .text_size(px(s.editor_font_size as f32)),
                ),
            )
            .when(!self.problems.is_empty(), |d| {
                d.child(
                    div()
                        .id("text-problems")
                        .max_h(px(120.))
                        .overflow_y_scroll()
                        .border_t_1()
                        .border_color(t.border)
                        .px_2()
                        .text_xs()
                        .children(
                            self.problems
                                .iter()
                                .map(|p| div().text_color(theme::hex("#b7791f")).child(p.clone())),
                        ),
                )
            })
    }
}
