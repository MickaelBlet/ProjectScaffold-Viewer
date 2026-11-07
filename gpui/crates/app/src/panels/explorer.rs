//! One tree of every entity of the project: views, dependencies, binaries, types, interfaces,
//! constants, modules (with their types) and links. Port of `ExplorerPanel.tsx`.

use std::collections::HashSet;

use gpui_kit::component::Sizable;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{ContextMenuExt, PopupMenuItem};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::edit::delete_items;
use scaffold_model::entities::{
    TYPE_KINDS, add_binary, add_const, add_interface, add_type, delete_binary, delete_const,
    delete_interface, delete_type,
};
use scaffold_model::fuzzy;
use scaffold_model::project::{child_modules, project_module_paths};
use scaffold_model::types::{Id, Project};

use crate::document::{Document, Selection};
use crate::form::apply;
use crate::theme;
use crate::workspace::Workspace;

pub struct ExplorerPanel {
    pub ws: WeakEntity<Workspace>,
    filter: Entity<InputState>,
    collapsed: HashSet<&'static str>,
    /// Modules whose content is folded.
    folded: HashSet<Id>,
    _sub: Subscription,
}

const SECTIONS: &[&str] = &[
    "Views",
    "Dependencies",
    "Binaries",
    "Types",
    "Interfaces",
    "Constants",
    "Modules",
    "Links",
];

fn kind_color(kind: &str) -> Hsla {
    theme::hex(match kind {
        "struct" => "#3b6fe0",
        "enum" => "#2e9e5b",
        "bitmask" => "#2e9e8f",
        "union" => "#8a4fd1",
        "exception" => "#e0513b",
        "alias" => "#d98b00",
        "interface" => "#d14f9e",
        "module" => "#3b8fd1",
        _ => "#7a8496",
    })
}

impl ExplorerPanel {
    pub fn new(ws: WeakEntity<Workspace>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter"));
        let _sub = cx.subscribe_in(&filter, window, |_, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        });
        ExplorerPanel {
            ws,
            filter,
            collapsed: HashSet::new(),
            folded: HashSet::new(),
            _sub,
        }
    }

    fn section(
        &self,
        title: &'static str,
        count: usize,
        add: Option<AnyElement>,
        rows: Vec<AnyElement>,
        cx: &mut Context<Self>,
    ) -> Div {
        let t = theme::light();
        let open = !self.collapsed.contains(title);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id(SharedString::from(format!("sec-{title}")))
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_1()
                    .h(px(24.))
                    .bg(theme::alpha(t.text, 0.04))
                    .border_b_1()
                    .border_color(t.border)
                    .cursor_pointer()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(t.muted)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.collapsed.remove(title) {
                            this.collapsed.insert(title);
                        }
                        cx.notify();
                    }))
                    .child(if open { "▾" } else { "▸" })
                    .child(
                        div()
                            .flex_1()
                            .child(format!("{} ({count})", title.to_uppercase())),
                    )
                    .children(add),
            )
            .when(open, |d| d.children(rows))
    }

    #[allow(clippy::too_many_arguments)]
    fn item(
        &self,
        key: String,
        depth: usize,
        badge: Option<&str>,
        label: String,
        sub: Option<String>,
        selected: bool,
        dim: bool,
        on_click: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Stateful<Div> {
        let t = theme::light();
        div()
            .id(SharedString::from(key))
            .flex()
            .items_center()
            .gap_1()
            .h(px(22.))
            .pl(px(8. + 14. * depth as f32))
            .pr_1()
            .text_sm()
            .whitespace_nowrap()
            .overflow_hidden()
            .cursor_pointer()
            .when(selected, |d| d.bg(theme::alpha(t.accent, 0.15)))
            .when(dim, |d| d.opacity(0.55))
            .hover(|d| d.bg(theme::alpha(t.accent, 0.08)))
            .on_click(move |_, window, cx| on_click(window, cx))
            .children(badge.map(|b| {
                div()
                    .flex_none()
                    .px_1()
                    .rounded_sm()
                    .text_xs()
                    .text_color(kind_color(b))
                    .border_1()
                    .border_color(theme::alpha(kind_color(b), 0.5))
                    .child(b.chars().next().unwrap_or('?').to_string())
            }))
            .child(div().flex_none().child(label))
            .children(sub.map(|s| div().text_xs().text_color(t.muted).overflow_hidden().child(s)))
    }
}

/// Select an entity of a document.
fn pick(doc: &Entity<Document>, sel: Selection) -> impl Fn(&mut Window, &mut App) + 'static {
    let doc = doc.clone();
    move |_, cx| {
        doc.update(cx, |d, cx| {
            d.select_entity(Some(sel.clone()));
            cx.notify();
        })
    }
}

/// An "add" glyph at the right of a section title.
fn add_button(id: &'static str, on_click: impl Fn(&mut Window, &mut App) + 'static) -> AnyElement {
    let t = theme::light();
    div()
        .id(id)
        .px_1()
        .rounded_sm()
        .text_color(t.text)
        .hover(|d| d.bg(theme::alpha(t.text, 0.08)))
        .on_click(move |ev, window, cx| {
            cx.stop_propagation();
            let _ = ev;
            on_click(window, cx)
        })
        .child("+")
        .into_any_element()
}

impl Render for ExplorerPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::light();
        let Some(doc) = self.ws.upgrade().and_then(|w| w.read(cx).doc()) else {
            return div()
                .p_2()
                .text_sm()
                .text_color(t.muted)
                .child("No document.")
                .into_any_element();
        };
        let (p, sel): (Project, Option<Selection>) = {
            let d = doc.read(cx);
            (d.project.clone(), d.selection.clone())
        };
        let is_sel = |s: &Selection| sel.as_ref() == Some(s);
        let q = self.filter.read(cx).value().trim().to_string();
        let keep = |name: &str| q.is_empty() || fuzzy::fuzzy_match(&q, name).is_some();
        let paths = project_module_paths(&p);
        let mut sections: Vec<Div> = Vec::new();

        // Views.
        let views: Vec<AnyElement> = std::iter::once(("global".to_string(), "Project".to_string()))
            .chain(p.views.iter().map(|v| (v.id.clone(), v.name.clone())))
            .filter(|(_, n)| keep(n))
            .map(|(id, name)| {
                self.item(
                    format!("view-{id}"),
                    0,
                    None,
                    name,
                    None,
                    false,
                    id != "global",
                    |_, _| {},
                )
                .into_any_element()
            })
            .collect();
        sections.push(self.section("Views", p.views.len() + 1, None, views, cx));

        // Dependencies, with their placed modules.
        let deps: Vec<AnyElement> = p
            .dependencies
            .iter()
            .filter(|x| keep(&x.name))
            .map(|x| {
                let s = Selection::Dependency(x.id.clone());
                self.item(
                    format!("dep-{}", x.id),
                    0,
                    None,
                    x.name.clone(),
                    Some(x.file.clone()),
                    is_sel(&s),
                    x.indirect,
                    pick(&doc, s),
                )
                .into_any_element()
            })
            .collect();
        sections.push(self.section("Dependencies", p.dependencies.len(), None, deps, cx));

        // Binaries.
        let binaries: Vec<AnyElement> = p
            .binaries
            .iter()
            .filter(|b| keep(&b.name))
            .map(|b| {
                let count = p
                    .modules
                    .iter()
                    .filter(|m| m.binary_id.as_ref() == Some(&b.id))
                    .count();
                let ids: Vec<Id> = p
                    .modules
                    .iter()
                    .filter(|m| m.binary_id.as_ref() == Some(&b.id))
                    .map(|m| m.id.clone())
                    .collect();
                let d2 = doc.clone();
                let bid = b.id.clone();
                let d3 = doc.clone();
                self.item(
                    format!("bin-{}", b.id),
                    0,
                    None,
                    b.name.clone(),
                    Some(format!("{count} modules")),
                    false,
                    false,
                    move |_, cx| {
                        d2.update(cx, |d, cx| {
                            d.select(ids.clone());
                            cx.notify();
                        })
                    },
                )
                .context_menu(move |menu, _, _| {
                    let (d3, bid) = (d3.clone(), bid.clone());
                    menu.item(
                        PopupMenuItem::new("Remove binary")
                            .on_click(move |_, _, cx| apply(&d3, cx, |p| delete_binary(p, &bid))),
                    )
                })
                .into_any_element()
            })
            .collect();
        let d = doc.clone();
        sections.push(self.section(
            "Binaries",
            p.binaries.len(),
            Some(add_button("add-binary", move |_, cx| {
                apply(&d, cx, |p| void(add_binary(p)))
            })),
            binaries,
            cx,
        ));

        // Types of the project (module types are listed under their module).
        let types: Vec<AnyElement> = p
            .types
            .iter()
            .filter(|ty| ty.module.is_none() && ty.module_path.is_none() && keep(&ty.name))
            .map(|ty| {
                let s = Selection::Type(ty.id.clone());
                let (d2, tid) = (doc.clone(), ty.id.clone());
                self.item(
                    format!("type-{}", ty.id),
                    0,
                    Some(ty.kind()),
                    ty.name.clone(),
                    ty.dependency
                        .as_ref()
                        .and_then(|x| p.dependencies.iter().find(|d| &d.id == x))
                        .map(|x| format!("from {}", x.name)),
                    is_sel(&s),
                    ty.dependency.is_some(),
                    pick(&doc, s),
                )
                .context_menu(move |menu, _, _| {
                    let (d2, tid) = (d2.clone(), tid.clone());
                    menu.item(
                        PopupMenuItem::new("Delete type")
                            .on_click(move |_, _, cx| apply(&d2, cx, |p| void(delete_type(p, &tid, true)))),
                    )
                })
                .into_any_element()
            })
            .collect();
        let d = doc.clone();
        let add_types = Button_menu("add-type", move |menu| {
            let mut menu = menu;
            for k in TYPE_KINDS {
                let d = d.clone();
                menu = menu.item(PopupMenuItem::new(format!("New {k}")).on_click(move |_, _, cx| {
                    let mut id = None;
                    apply(&d, cx, |p| id = Some(add_type(p, k, None)));
                    if let Some(id) = id {
                        d.update(cx, |d, cx| {
                            d.select_entity(Some(Selection::Type(id)));
                            cx.notify();
                        });
                    }
                }));
            }
            menu
        });
        let own_types = p
            .types
            .iter()
            .filter(|t| t.module.is_none() && t.module_path.is_none())
            .count();
        sections.push(self.section("Types", own_types, Some(add_types), types, cx));

        // Interfaces.
        let interfaces: Vec<AnyElement> = p
            .interfaces
            .iter()
            .filter(|i| keep(&i.name))
            .map(|i| {
                let s = Selection::Interface(i.id.clone());
                let (d2, iid) = (doc.clone(), i.id.clone());
                self.item(
                    format!("iface-{}", i.id),
                    0,
                    Some("interface"),
                    i.name.clone(),
                    Some(format!("{} messages", i.messages.len())),
                    is_sel(&s),
                    i.dependency.is_some(),
                    pick(&doc, s),
                )
                .context_menu(move |menu, _, _| {
                    let (d2, iid) = (d2.clone(), iid.clone());
                    menu.item(
                        PopupMenuItem::new("Delete interface")
                            .on_click(move |_, _, cx| apply(&d2, cx, |p| void(delete_interface(p, &iid)))),
                    )
                })
                .into_any_element()
            })
            .collect();
        let d = doc.clone();
        sections.push(self.section(
            "Interfaces",
            p.interfaces.len(),
            Some(add_button("add-iface", move |_, cx| {
                let mut id = None;
                apply(&d, cx, |p| id = Some(add_interface(p)));
                if let Some(id) = id {
                    d.update(cx, |d, cx| {
                        d.select_entity(Some(Selection::Interface(id)));
                        cx.notify();
                    });
                }
            })),
            interfaces,
            cx,
        ));

        // Constants: edited in the project inspector.
        let consts: Vec<AnyElement> = p
            .consts
            .iter()
            .filter(|c| keep(&c.name))
            .map(|c| {
                let (d2, cid) = (doc.clone(), c.id.clone());
                self.item(
                    format!("const-{}", c.id),
                    0,
                    None,
                    c.name.clone(),
                    Some(scaffold_model::defaults::format_value(&c.value)),
                    false,
                    c.dependency.is_some(),
                    pick(&doc, Selection::Project),
                )
                .context_menu(move |menu, _, _| {
                    let (d2, cid) = (d2.clone(), cid.clone());
                    menu.item(
                        PopupMenuItem::new("Delete constant")
                            .on_click(move |_, _, cx| apply(&d2, cx, |p| delete_const(p, &cid))),
                    )
                })
                .into_any_element()
            })
            .collect();
        let d = doc.clone();
        sections.push(self.section(
            "Constants",
            p.consts.len(),
            Some(add_button("add-const", move |_, cx| {
                apply(&d, cx, |p| void(add_const(p)))
            })),
            consts,
            cx,
        ));

        // Modules: the module tree, with the types of each module.
        let mut modules: Vec<AnyElement> = Vec::new();
        let mut stack: Vec<(Id, usize)> = child_modules(&p, None)
            .map(|m| (m.id.clone(), 0))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        while let Some((id, depth)) = stack.pop() {
            let Some(m) = p.modules.iter().find(|m| m.id == id) else {
                continue;
            };
            let path = paths.get(&id).cloned().unwrap_or_default();
            let children: Vec<Id> = child_modules(&p, Some(&id)).map(|c| c.id.clone()).collect();
            let shown = q.is_empty() || keep(&path);
            let folded = self.folded.contains(&id) && q.is_empty();
            if shown {
                let s = Selection::Module {
                    id: id.clone(),
                    member: None,
                };
                let (d2, mid) = (doc.clone(), id.clone());
                let selected = is_sel(&s) || doc.read(cx).selected.contains(&id);
                let has_children = !children.is_empty();
                let fold_id = id.clone();
                let toggle = cx.listener(move |this, _: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    if !this.folded.remove(&fold_id) {
                        this.folded.insert(fold_id.clone());
                    }
                    cx.notify();
                });
                let row = self
                    .item(
                        format!("mod-{id}"),
                        depth,
                        Some("module"),
                        if q.is_empty() {
                            m.name.clone()
                        } else {
                            path.clone()
                        },
                        m.binary_id
                            .as_ref()
                            .and_then(|b| p.binaries.iter().find(|x| &x.id == b))
                            .map(|b| b.name.clone()),
                        selected,
                        false,
                        pick(&doc, s),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("fold-{id}")))
                            .ml_auto()
                            .px_1()
                            .text_xs()
                            .text_color(t.muted)
                            .when(has_children, |d| d.child(if folded { "▸" } else { "▾" }))
                            .on_click(toggle),
                    )
                    .context_menu(move |menu, _, _| {
                        let mut menu = menu;
                        for k in ["struct", "enum", "alias", "primitive"] {
                            let (d2, mid) = (d2.clone(), mid.clone());
                            menu = menu.item(PopupMenuItem::new(format!("New {k} of the module")).on_click(
                                move |_, _, cx| {
                                    apply(&d2, cx, |p| void(add_type(p, k, Some(&mid))));
                                },
                            ));
                        }
                        let (d2, mid) = (d2.clone(), mid.clone());
                        menu.separator()
                            .item(PopupMenuItem::new("Delete module").on_click(move |_, _, cx| {
                                apply(&d2, cx, |p| delete_items(p, std::slice::from_ref(&mid)))
                            }))
                    });
                modules.push(row.into_any_element());
                // Types of the module.
                if !folded {
                    for ty in p.types.iter().filter(|ty| ty.module.as_ref() == Some(&id)) {
                        let s = Selection::Type(ty.id.clone());
                        modules.push(
                            self.item(
                                format!("mtype-{}", ty.id),
                                depth + 1,
                                Some(ty.kind()),
                                ty.name.clone(),
                                ty.access.map(|a| a.access().to_string()),
                                is_sel(&s),
                                false,
                                pick(&doc, s),
                            )
                            .into_any_element(),
                        );
                    }
                }
            }
            if !folded {
                for c in children.into_iter().rev() {
                    stack.push((c, depth + 1));
                }
            }
        }
        let count = p.modules.len();
        sections.push(self.section(
            "Modules",
            count,
            Some(add_button("add-module", {
                let ws = self.ws.clone();
                move |window, cx| {
                    ws.update(cx, |w, cx| w.run("insert.module", window, cx)).ok();
                }
            })),
            modules,
            cx,
        ));

        // Links.
        let links: Vec<AnyElement> = p
            .links
            .iter()
            .filter(|l| keep(&l.name))
            .map(|l| {
                let s = Selection::Link(l.id.clone());
                let end = |id: &str| paths.get(id).cloned().unwrap_or_else(|| "?".into());
                self.item(
                    format!("link-{}", l.id),
                    0,
                    None,
                    l.name.clone(),
                    Some(format!("{} → {}", end(&l.from.module_id), end(&l.to.module_id))),
                    is_sel(&s),
                    false,
                    pick(&doc, s),
                )
                .into_any_element()
            })
            .collect();
        sections.push(self.section("Links", p.links.len(), None, links, cx));
        let _ = SECTIONS;

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(div().p_1().child(Input::new(&self.filter).small()))
            .child(
                div()
                    .id("explorer")
                    .flex_1()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .id("explorer-project")
                            .px_2()
                            .py_1()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .cursor_pointer()
                            .when(is_sel(&Selection::Project), |d| {
                                d.bg(theme::alpha(t.accent, 0.15))
                            })
                            .on_click({
                                let f = pick(&doc, Selection::Project);
                                move |_, window, cx| f(window, cx)
                            })
                            .child(p.name.clone()),
                    )
                    .children(sections),
            )
            .into_any_element()
    }
}

fn void<T>(_: T) {}

/// A "+" opening a menu of choices.
#[allow(non_snake_case)]
fn Button_menu(
    id: &'static str,
    build: impl Fn(gpui_kit::component::menu::PopupMenu) -> gpui_kit::component::menu::PopupMenu + 'static,
) -> AnyElement {
    use gpui_kit::component::Sizable;
    use gpui_kit::component::button::{Button, ButtonVariants};
    use gpui_kit::component::menu::DropdownMenu;
    Button::new(id)
        .label("+")
        .xsmall()
        .ghost()
        .dropdown_menu(move |menu, _, _| build(menu))
        .into_any_element()
}
