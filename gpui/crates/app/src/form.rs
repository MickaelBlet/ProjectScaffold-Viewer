//! Form widgets of the panels (the web build's `components/fields.tsx`): text fields committed on
//! Enter or when left, text areas, number fields, selects, checkboxes, color swatches, sections
//! and rows. Text fields keep their input state between renders by key, and follow the model when
//! not being edited.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::{Sizable, tooltip::Tooltip};
use gpui_kit::*;
use scaffold_model::types::Project;

use crate::document::Document;
use crate::theme;

/// Runs when a field is committed; an error message keeps the field marked invalid.
pub type Commit = Rc<dyn Fn(String, &mut Window, &mut App) -> Option<String>>;

/// Input states of a panel's text fields, by key.
#[derive(Default)]
pub struct Fields {
    inputs: HashMap<String, Entity<InputState>>,
    areas: HashMap<String, Entity<TextareaState>>,
    commits: Rc<RefCell<HashMap<String, Commit>>>,
    errors: Rc<RefCell<HashMap<String, String>>>,
    subs: HashMap<String, Subscription>,
    used: HashSet<String>,
}

impl Fields {
    /// Start a render: fields not used by its end are dropped.
    pub fn begin(&mut self) {
        self.used.clear();
    }

    pub fn end(&mut self) {
        let used = &self.used;
        self.inputs.retain(|k, _| used.contains(k));
        self.areas.retain(|k, _| used.contains(k));
        self.subs.retain(|k, _| used.contains(k));
        self.commits.borrow_mut().retain(|k, _| used.contains(k));
        self.errors.borrow_mut().retain(|k, _| used.contains(k));
    }

    /// Commit a field when Enter is pressed in it or when it is left.
    fn handler(&self, key: &str) -> impl Fn(String, &mut Window, &mut App) + 'static {
        let (k, commits, errors) = (key.to_string(), self.commits.clone(), self.errors.clone());
        move |value, window, cx| {
            let commit = commits.borrow().get(&k).cloned();
            let Some(commit) = commit else { return };
            match commit(value, window, cx) {
                Some(e) => errors.borrow_mut().insert(k.clone(), e),
                None => errors.borrow_mut().remove(&k),
            };
        }
    }

    fn watch_input<V: 'static>(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<V>,
        input: &Entity<InputState>,
    ) {
        let run = self.handler(key);
        let sub = cx.subscribe_in(input, window, move |_, input, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                let value = input.read(cx).value().to_string();
                run(value, window, cx);
                cx.notify();
            }
        });
        self.subs.insert(key.to_string(), sub);
    }

    fn watch_area<V: 'static>(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<V>,
        area: &Entity<TextareaState>,
    ) {
        let run = self.handler(key);
        let sub = cx.subscribe_in(area, window, move |_, area, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::Blur) {
                let value = area.read(cx).value().to_string();
                run(value, window, cx);
                cx.notify();
            }
        });
        self.subs.insert(key.to_string(), sub);
    }

    /// A one-line text field showing `value`, committed with `commit`.
    pub fn text<V: 'static>(
        &mut self,
        key: impl Into<String>,
        value: &str,
        placeholder: &str,
        window: &mut Window,
        cx: &mut Context<V>,
        commit: impl Fn(String, &mut Window, &mut App) -> Option<String> + 'static,
    ) -> AnyElement {
        let key = key.into();
        self.used.insert(key.clone());
        let input = match self.inputs.get(&key) {
            Some(i) => i.clone(),
            None => {
                let placeholder = placeholder.to_string();
                let v = value.to_string();
                let i = cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(placeholder)
                        .default_value(v)
                });
                self.watch_input(&key, window, cx, &i);
                self.inputs.insert(key.clone(), i.clone());
                i
            }
        };
        // Follow the model unless being edited.
        let focused = input.read(cx).focus_handle(cx).is_focused(window);
        if !focused && input.read(cx).value() != value {
            let v = value.to_string();
            input.update(cx, |i, cx| i.set_value(v, window, cx));
            self.errors.borrow_mut().remove(&key);
        }
        let commit: Commit = Rc::new(commit);
        self.commits.borrow_mut().insert(key.clone(), commit);
        let error = self.errors.borrow().get(&key).cloned();
        let el = div()
            .id(SharedString::from(format!("field-{key}")))
            .w_full()
            .child(Input::new(&input).small());
        match error {
            Some(e) => el
                .border_1()
                .border_color(theme::hex("#d23f3f"))
                .rounded_md()
                .tooltip(move |window, cx| Tooltip::new(e.clone()).build(window, cx))
                .into_any_element(),
            None => el.into_any_element(),
        }
    }

    /// A text area showing `value`, committed when left.
    pub fn area<V: 'static>(
        &mut self,
        key: impl Into<String>,
        value: &str,
        placeholder: &str,
        window: &mut Window,
        cx: &mut Context<V>,
        commit: impl Fn(String, &mut Window, &mut App) -> Option<String> + 'static,
    ) -> AnyElement {
        let key = key.into();
        self.used.insert(key.clone());
        let area = match self.areas.get(&key) {
            Some(a) => a.clone(),
            None => {
                let placeholder = placeholder.to_string();
                let v = value.to_string();
                let a = cx.new(|cx| {
                    TextareaState::new(window, cx)
                        .auto_grow(2, 12)
                        .placeholder(placeholder)
                        .default_value(v)
                });
                self.watch_area(&key, window, cx, &a);
                self.areas.insert(key.clone(), a.clone());
                a
            }
        };
        let focused = area.read(cx).focus_handle(cx).is_focused(window);
        if !focused && area.read(cx).value() != value {
            let v = value.to_string();
            area.update(cx, |i, cx| i.set_value(v, window, cx));
        }
        self.commits.borrow_mut().insert(key.clone(), Rc::new(commit));
        div()
            .w_full()
            .child(Textarea::new(&area).small())
            .into_any_element()
    }

    /// A number field (empty: None); `integer` rejects fractions.
    #[allow(clippy::too_many_arguments)]
    pub fn number<V: 'static>(
        &mut self,
        key: impl Into<String>,
        value: Option<f64>,
        placeholder: &str,
        integer: bool,
        window: &mut Window,
        cx: &mut Context<V>,
        commit: impl Fn(Option<f64>, &mut Window, &mut App) + 'static,
    ) -> AnyElement {
        let shown = value.map(fmt_number).unwrap_or_default();
        self.text(key, &shown, placeholder, window, cx, move |v, window, cx| {
            let v = v.trim();
            if v.is_empty() {
                commit(None, window, cx);
                return None;
            }
            match v.parse::<f64>() {
                Ok(n) if n.is_finite() && (!integer || n.fract() == 0.) => {
                    commit(Some(n), window, cx);
                    None
                }
                _ => Some(if integer {
                    "An integer is expected".into()
                } else {
                    "A number is expected".into()
                }),
            }
        })
    }
}

pub fn fmt_number(n: f64) -> String {
    scaffold_model::emit::js_number(&serde_json::Number::from_f64(n).unwrap_or(0.into()))
}

/// Edit a document's project as one undo step.
pub fn apply(doc: &Entity<Document>, cx: &mut App, f: impl FnOnce(&mut Project)) {
    doc.update(cx, |d, cx| {
        d.seal();
        d.edit(crate::settings::grid(), f);
        d.seal();
        cx.notify();
    });
}

/// Panel heading.
pub fn heading(title: impl Into<SharedString>, sub: Option<String>) -> Div {
    let t = theme::light();
    div()
        .flex()
        .items_baseline()
        .gap_2()
        .pb_1()
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .child(title.into()),
        )
        .children(sub.map(|s| div().text_xs().text_color(t.muted).child(s)))
}

/// A titled group of fields, with optional actions at the right of its title.
pub fn section(title: impl Into<SharedString>, actions: Option<AnyElement>) -> Div {
    let t = theme::light();
    div().flex().flex_col().gap_1().pt_2().child(
        div()
            .flex()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(t.border)
            .pb(px(2.))
            .child(
                div()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(t.muted)
                    .child(title.into().to_uppercase()),
            )
            .children(actions),
    )
}

/// A labelled field.
pub fn row(label: impl Into<SharedString>, field: impl IntoElement) -> Div {
    let t = theme::light();
    div()
        .flex()
        .items_center()
        .gap_2()
        .min_h(px(26.))
        .child(
            div()
                .w(px(96.))
                .flex_none()
                .text_xs()
                .text_color(t.muted)
                .child(label.into()),
        )
        .child(div().flex_1().min_w_0().child(field))
}

pub fn muted(text: impl Into<SharedString>) -> Div {
    div()
        .text_xs()
        .text_color(theme::light().muted)
        .child(text.into())
}

/// A small button.
pub fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> Button {
    Button::new(id)
        .label(label)
        .small()
        .outline()
        .on_click(move |_, window, cx| on_click(window, cx))
}

/// A small icon-like button (a glyph), red when `danger`.
pub fn icon_button(
    id: impl Into<ElementId>,
    glyph: &'static str,
    tip: &'static str,
    danger: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> Button {
    let b = Button::new(id).label(glyph).xsmall().ghost().tooltip(tip);
    let b = if danger { b.danger() } else { b };
    b.on_click(move |_, window, cx| on_click(window, cx))
}

pub fn checkbox(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    checked: bool,
    on_change: impl Fn(bool, &mut Window, &mut App) + 'static,
) -> Checkbox {
    Checkbox::new(id)
        .label(label.into())
        .checked(checked)
        .on_click(move |v, window, cx| on_change(*v, window, cx))
}

/// A select over string options: a button showing the current one, opening a menu.
pub fn select(
    id: impl Into<ElementId>,
    current: &str,
    options: Vec<(String, String)>,
    on_change: impl Fn(String, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let label = options
        .iter()
        .find(|(v, _)| v == current)
        .map_or_else(|| current.to_string(), |(_, l)| l.clone());
    let on_change = Rc::new(on_change);
    let current = current.to_string();
    Button::new(id)
        .label(format!("{label} ▾"))
        .small()
        .outline()
        .dropdown_menu(move |mut menu, _, _| {
            for (v, l) in &options {
                let (v, on_change) = (v.clone(), on_change.clone());
                menu = menu.item(
                    PopupMenuItem::new(l.clone())
                        .checked(v == current)
                        .on_click(move |_, window, cx| on_change(v.clone(), window, cx)),
                );
            }
            menu.max_h(px(360.)).scrollable(true)
        })
        .into_any_element()
}

/// Color swatches of the palette, and none.
pub fn colors(
    id: &str,
    current: Option<&str>,
    on_change: impl Fn(Option<String>, &mut Window, &mut App) + 'static,
) -> Div {
    let on_change = Rc::new(on_change);
    let t = theme::light();
    let mut row = div().flex().flex_wrap().gap_1();
    let none = on_change.clone();
    row = row.child(
        div()
            .id(SharedString::from(format!("{id}-none")))
            .size(px(18.))
            .rounded_sm()
            .border_1()
            .border_color(if current.is_none() { t.text } else { t.border })
            .text_xs()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .child("∅")
            .on_click(move |_, window, cx| none(None, window, cx)),
    );
    for c in scaffold_model::project::PALETTE {
        let on_change = on_change.clone();
        let selected = current == Some(*c);
        row = row.child(
            div()
                .id(SharedString::from(format!("{id}-{c}")))
                .size(px(18.))
                .rounded_sm()
                .bg(theme::hex(c))
                .border_2()
                .border_color(if selected {
                    t.text
                } else {
                    theme::alpha(t.text, 0.)
                })
                .cursor_pointer()
                .on_click(move |_, window, cx| on_change(Some(c.to_string()), window, cx)),
        );
    }
    row
}

/// A clickable entry of a list (an entity to go to).
pub fn link(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let t = theme::light();
    div()
        .id(id)
        .text_sm()
        .text_color(t.accent)
        .cursor_pointer()
        .hover(|d| d.underline())
        .child(label.into())
        .on_click(move |_, window, cx| on_click(window, cx))
}
