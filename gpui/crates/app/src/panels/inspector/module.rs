//! Module inspector: identity, inheritance, attributes, methods, lifecycle, ports, submodules,
//! links, layout and metadata. Port of `ModuleInspector.tsx` and its sections.

use std::rc::Rc;

use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::binaries::assign_binary;
use scaffold_model::edit::{add_port, add_submodule, reparent_module, set_locked};
use scaffold_model::entities::{add_type, delete_port};
use scaffold_model::project::{
    NameTarget, can_derive, child_modules, name_error, new_id, project_module_paths, remove_base, set_access,
    set_attribute_qualifier, set_method_qualifier, subtree_ids, unique_name,
};
use scaffold_model::types::Primitive;
use scaffold_model::types::*;

use super::{InspectorPanel, on_checked_text, on_text};
use crate::document::{Document, Selection};
use crate::form::{self, apply, checkbox, colors, heading, icon_button, muted, row, section};

/// Edit of one module of the project.
fn on_module(id: Id, f: impl Fn(&mut Module) + 'static) -> impl Fn(&mut Project) + 'static {
    move |p| {
        if let Some(m) = p.modules.iter_mut().find(|m| m.id == id) {
            f(m)
        }
    }
}

fn access_options() -> Vec<(String, String)> {
    ["public", "protected", "private"]
        .iter()
        .map(|a| {
            (
                a.to_string(),
                format!("{} {a}", Access::parse(a).map_or("", |x| x.marker())),
            )
        })
        .collect()
}

fn param_direction_options() -> Vec<(String, String)> {
    ["in", "out", "inout"]
        .iter()
        .map(|d| (d.to_string(), d.to_string()))
        .collect()
}

impl InspectorPanel {
    pub(super) fn module(
        &mut self,
        id: &Id,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(m) = p.modules.iter().find(|m| &m.id == id).cloned() else {
            return muted("Module deleted.");
        };
        let mid = m.id.clone();
        let paths = project_module_paths(p);
        let k = |s: &str| format!("mod-{s}-{mid}");

        // Identity.
        let name = self.fields.text(
            k("name"),
            &m.name,
            "Name",
            window,
            cx,
            on_checked_text(
                doc,
                {
                    let (mid, parent) = (mid.clone(), m.parent_id.clone());
                    move |p, v| {
                        name_error(
                            p,
                            &NameTarget::Module {
                                id: Some(mid.clone()),
                                parent_id: parent.clone(),
                            },
                            v,
                        )
                    }
                },
                {
                    let mid = mid.clone();
                    move |p, v| on_module(mid.clone(), move |m| m.name = v.clone())(p)
                },
            ),
        );
        let own = subtree_ids(p, &mid);
        let mut parents: Vec<(String, String)> = vec![(String::new(), "(top level)".into())];
        parents.extend(
            p.modules
                .iter()
                .filter(|x| !own.contains(&x.id))
                .map(|x| (x.id.clone(), paths.get(&x.id).cloned().unwrap_or_default())),
        );
        let (d, mid2) = (doc.clone(), mid.clone());
        let parent = form::select(
            k("parent"),
            m.parent_id.as_deref().unwrap_or(""),
            parents,
            move |v, _, cx| {
                let to = (!v.is_empty()).then_some(v);
                let mid2 = mid2.clone();
                apply(&d, cx, move |p| {
                    let y = to
                        .as_deref()
                        .map_or(40., |t| scaffold_model::project::below_content(p, t, None));
                    reparent_module(p, &mid2, to.as_deref(), 20., y)
                })
            },
        );
        let (d, mid2) = (doc.clone(), mid.clone());
        let kind = form::select(
            k("kind"),
            m.kind.map_or("class", |x| x.as_str()),
            ModuleKind::ALL
                .iter()
                .map(|x| (x.as_str().to_string(), x.as_str().to_string()))
                .collect(),
            move |v, _, cx| {
                let kind = ModuleKind::parse(&v).filter(|x| *x != ModuleKind::Class);
                apply(&d, cx, on_module(mid2.clone(), move |m| m.kind = kind))
            },
        );
        let (d, mid2) = (doc.clone(), mid.clone());
        let fin = checkbox(
            k("final"),
            "final (no module may derive from it)",
            m.r#final,
            move |v, _, cx| apply(&d, cx, on_module(mid2.clone(), move |m| m.r#final = v)),
        );
        let mut derives = div().flex().flex_wrap().gap_2();
        for dv in Derive::ALL {
            let has = m.derives.as_ref().is_some_and(|x| x.contains(dv));
            let (d, mid2, dv) = (doc.clone(), mid.clone(), *dv);
            derives = derives.child(checkbox(
                k(&format!("derive-{dv}")),
                dv.label(),
                has,
                move |v, _, cx| {
                    apply(
                        &d,
                        cx,
                        on_module(mid2.clone(), move |m| {
                            let mut list = m.derives.take().unwrap_or_default();
                            list.retain(|x| *x != dv);
                            if v {
                                list.push(dv);
                                list.sort_by_key(|x| Derive::ALL.iter().position(|y| y == x));
                            }
                            m.derives = (!list.is_empty()).then_some(list);
                        }),
                    )
                },
            ));
        }
        let (d, mid2) = (doc.clone(), mid.clone());
        let instantiation = form::select(
            k("inst"),
            m.instantiation.map_or("", |x| x.as_str()),
            std::iter::once((String::new(), "(none)".to_string()))
                .chain(
                    Instantiation::ALL
                        .iter()
                        .map(|x| (x.as_str().to_string(), x.as_str().to_string())),
                )
                .collect(),
            move |v, _, cx| {
                let i = Instantiation::parse(&v);
                apply(&d, cx, on_module(mid2.clone(), move |m| m.instantiation = i))
            },
        );
        // Active modules.
        let (d, mid2) = (doc.clone(), mid.clone());
        let active = checkbox(
            k("active"),
            "Active: its own thread runs the calls reaching its in ports",
            m.active.is_some(),
            move |v, _, cx| {
                apply(
                    &d,
                    cx,
                    on_module(mid2.clone(), move |m| m.active = v.then(Active::default)),
                )
            },
        );
        let active_rows = m.active.clone().map(|a| {
            let (d, mid2) = (doc.clone(), mid.clone());
            let queue = self.fields.number(
                k("queue"),
                a.queue.map(|x| x as f64),
                &DEFAULT_ACTIVE_QUEUE.to_string(),
                true,
                window,
                cx,
                move |v, _, cx| {
                    apply(
                        &d,
                        cx,
                        on_module(mid2.clone(), move |m| {
                            if let Some(a) = &mut m.active {
                                a.queue = v.map(|x| x.max(1.) as u64)
                            }
                        }),
                    )
                },
            );
            let (d, mid2) = (doc.clone(), mid.clone());
            let timeout = self.fields.number(
                k("timeout"),
                a.timeout_ms.map(|x| x as f64),
                &DEFAULT_ACTIVE_TIMEOUT_MS.to_string(),
                true,
                window,
                cx,
                move |v, _, cx| {
                    apply(
                        &d,
                        cx,
                        on_module(mid2.clone(), move |m| {
                            if let Some(a) = &mut m.active {
                                a.timeout_ms = v.map(|x| x.max(0.) as u64)
                            }
                        }),
                    )
                },
            );
            let (d, mid2) = (doc.clone(), mid.clone());
            let overflow = form::select(
                k("overflow"),
                a.overflow.map_or("block", |x| x.as_str()),
                ActiveOverflow::ALL
                    .iter()
                    .map(|x| (x.as_str().to_string(), x.as_str().to_string()))
                    .collect(),
                move |v, _, cx| {
                    let o = ActiveOverflow::parse(&v).filter(|x| *x != ActiveOverflow::Block);
                    apply(
                        &d,
                        cx,
                        on_module(mid2.clone(), move |m| {
                            if let Some(a) = &mut m.active {
                                a.overflow = o
                            }
                        }),
                    )
                },
            );
            div()
                .flex()
                .flex_col()
                .child(row("Queue", queue))
                .child(row("Timeout (ms)", timeout))
                .child(row("Queue full", overflow))
        });
        // Binary: top-level modules name theirs.
        let binary = (m.parent_id.is_none()).then(|| {
            let (d, mid2) = (doc.clone(), mid.clone());
            form::select(
                k("binary"),
                m.binary_id.as_deref().unwrap_or(""),
                std::iter::once((String::new(), "(none)".to_string()))
                    .chain(p.binaries.iter().map(|b| (b.id.clone(), b.name.clone())))
                    .collect(),
                move |v, _, cx| {
                    let b = (!v.is_empty()).then_some(v);
                    let mid2 = mid2.clone();
                    apply(&d, cx, move |p| {
                        assign_binary(p, std::iter::once(&mid2), b.as_ref())
                    })
                },
            )
        });
        let description = self.fields.area(
            k("desc"),
            &m.description,
            "Description",
            window,
            cx,
            on_text(doc, {
                let mid = mid.clone();
                move |p, v| on_module(mid.clone(), move |m| m.description = v.clone())(p)
            }),
        );

        // Implemented interfaces.
        let implemented = m.implements.clone().unwrap_or_default();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut implements = section(
            format!("Implements ({})", implemented.len()),
            Some(
                form::select(
                    k("impl-add"),
                    "",
                    p.interfaces
                        .iter()
                        .filter(|i| !implemented.contains(&i.id))
                        .map(|i| (i.id.clone(), i.name.clone()))
                        .collect(),
                    move |v, _, cx| {
                        apply(
                            &d,
                            cx,
                            on_module(mid2.clone(), move |m| {
                                m.implements.get_or_insert_with(Vec::new).push(v.clone())
                            }),
                        )
                    },
                )
                .into_any_element(),
            ),
        );
        for i in &implemented {
            let name = p
                .interfaces
                .iter()
                .find(|x| &x.id == i)
                .map_or("?".into(), |x| x.name.clone());
            let (d, mid2, i2) = (doc.clone(), mid.clone(), i.clone());
            implements = implements.child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(div().flex_1().child(name))
                    .child(icon_button(
                        SharedString::from(format!("impl-x-{mid}-{i}")),
                        "×",
                        "No longer implemented",
                        true,
                        move |_, cx| {
                            let i2 = i2.clone();
                            apply(
                                &d,
                                cx,
                                on_module(mid2.clone(), move |m| {
                                    if let Some(v) = &mut m.implements {
                                        v.retain(|x| *x != i2);
                                        if v.is_empty() {
                                            m.implements = None;
                                        }
                                    }
                                }),
                            )
                        },
                    )),
            );
        }

        // Bases.
        let bases = m.bases.clone().unwrap_or_default();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut base_section = section(
            format!("Bases ({})", bases.len()),
            Some(
                form::select(
                    k("base-add"),
                    "",
                    p.modules
                        .iter()
                        .filter(|x| !bases.contains(&x.id) && !x.r#final && can_derive(p, &mid, &x.id))
                        .map(|x| (x.id.clone(), paths.get(&x.id).cloned().unwrap_or_default()))
                        .collect(),
                    move |v, _, cx| {
                        apply(
                            &d,
                            cx,
                            on_module(mid2.clone(), move |m| {
                                m.bases.get_or_insert_with(Vec::new).push(v.clone())
                            }),
                        )
                    },
                )
                .into_any_element(),
            ),
        );
        for b in &bases {
            let (d, mid2, b2) = (doc.clone(), mid.clone(), b.clone());
            base_section = base_section.child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(
                        div()
                            .flex_1()
                            .child(paths.get(b).cloned().unwrap_or_else(|| "?".into())),
                    )
                    .child(icon_button(
                        SharedString::from(format!("base-x-{mid}-{b}")),
                        "×",
                        "Remove base",
                        true,
                        move |_, cx| {
                            let b2 = b2.clone();
                            apply(&d, cx, on_module(mid2.clone(), move |m| remove_base(m, &b2)))
                        },
                    )),
            );
        }

        // Types of the module.
        let mtypes: Vec<&TypeDef> = p
            .types
            .iter()
            .filter(|t| t.module.as_ref() == Some(&mid))
            .collect();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut types_section = section(
            format!("Types ({})", mtypes.len()),
            Some(
                form::select(
                    k("type-add"),
                    "",
                    scaffold_model::entities::TYPE_KINDS
                        .iter()
                        .map(|x| (x.to_string(), format!("New {x}")))
                        .collect(),
                    move |v, _, cx| {
                        let mid2 = mid2.clone();
                        apply(&d, cx, move |p| {
                            add_type(p, &v, Some(&mid2));
                        })
                    },
                )
                .into_any_element(),
            ),
        );
        for t in &mtypes {
            let (d, tid) = (doc.clone(), t.id.clone());
            types_section = types_section.child(form::link(
                SharedString::from(format!("mt-{}", t.id)),
                format!("{} {}", t.kind(), t.name),
                move |_, cx| {
                    d.update(cx, |d, cx| {
                        d.select_entity(Some(Selection::Type(tid.clone())));
                        cx.notify();
                    })
                },
            ));
        }

        let attributes = self.attributes(&m, doc, p, window, cx);
        let methods = self.methods(&m, doc, p, window, cx);
        let lifecycle = self.lifecycle(&m, doc, p, window, cx);
        let ports = self.ports(&m, doc, p, window, cx);

        // Invariants.
        let inv = m.invariants.clone().unwrap_or_default();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut invariants = section(
            format!("Invariants ({})", inv.len()),
            Some(
                icon_button(
                    SharedString::from(k("inv-add")),
                    "+",
                    "Add invariant",
                    false,
                    move |_, cx| {
                        apply(
                            &d,
                            cx,
                            on_module(mid2.clone(), |m| {
                                m.invariants.get_or_insert_with(Vec::new).push("true".into())
                            }),
                        )
                    },
                )
                .into_any_element(),
            ),
        );
        for (i, c) in inv.iter().enumerate() {
            let field = self.fields.text(
                k(&format!("inv-{i}")),
                c,
                "condition",
                window,
                cx,
                on_text(doc, {
                    let mid = mid.clone();
                    move |p, v| {
                        on_module(mid.clone(), move |m| {
                            if let Some(x) = m.invariants.as_mut().and_then(|l| l.get_mut(i)) {
                                *x = v.clone()
                            }
                        })(p)
                    }
                }),
            );
            let (d, mid2) = (doc.clone(), mid.clone());
            invariants = invariants.child(
                div()
                    .flex()
                    .gap_1()
                    .items_center()
                    .child(div().flex_1().child(field))
                    .child(icon_button(
                        SharedString::from(k(&format!("inv-x-{i}"))),
                        "×",
                        "Remove condition",
                        true,
                        move |_, cx| {
                            apply(
                                &d,
                                cx,
                                on_module(mid2.clone(), move |m| {
                                    if let Some(l) = &mut m.invariants {
                                        if i < l.len() {
                                            l.remove(i);
                                        }
                                        if l.is_empty() {
                                            m.invariants = None;
                                        }
                                    }
                                }),
                            )
                        },
                    )),
            );
        }

        // Submodules and links.
        let children: Vec<&Module> = child_modules(p, Some(&mid)).collect();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut subs = section(
            format!("Submodules ({})", children.len()),
            Some(
                icon_button(
                    SharedString::from(k("sub-add")),
                    "+",
                    "Add submodule",
                    false,
                    move |_, cx| {
                        let mid2 = mid2.clone();
                        apply(&d, cx, move |p| {
                            add_submodule(p, &mid2);
                        })
                    },
                )
                .into_any_element(),
            ),
        );
        for c in &children {
            let (d, cid) = (doc.clone(), c.id.clone());
            subs = subs.child(form::link(
                SharedString::from(format!("sub-{}", c.id)),
                c.name.clone(),
                move |_, cx| {
                    d.update(cx, |d, cx| {
                        d.select(vec![cid.clone()]);
                        cx.notify();
                    })
                },
            ));
        }
        let links: Vec<&Link> = p
            .links
            .iter()
            .filter(|l| l.from.module_id == mid || l.to.module_id == mid)
            .collect();
        let mut links_section = section(format!("Links ({})", links.len()), None);
        for l in &links {
            let (d, lid) = (doc.clone(), l.id.clone());
            let other = if l.from.module_id == mid {
                &l.to.module_id
            } else {
                &l.from.module_id
            };
            let arrow = if l.from.module_id == mid { "→" } else { "←" };
            links_section = links_section.child(form::link(
                SharedString::from(format!("ml-{}", l.id)),
                format!(
                    "{} {arrow} {}",
                    l.name,
                    paths.get(other).cloned().unwrap_or_else(|| "?".into())
                ),
                move |_, cx| {
                    d.update(cx, |d, cx| {
                        d.select(vec![lid.clone()]);
                        cx.notify();
                    })
                },
            ));
        }

        let (d, mid2) = (doc.clone(), mid.clone());
        let color = colors(&k("color"), m.color.as_deref(), move |c, _, cx| {
            apply(&d, cx, on_module(mid2.clone(), move |m| m.color = c.clone()))
        });
        let (d, mid2) = (doc.clone(), mid.clone());
        let locked = checkbox(
            k("locked"),
            "Locked (position and size)",
            m.locked,
            move |v, _, cx| apply(&d, cx, |p| set_locked(p, std::slice::from_ref(&mid2), v)),
        );
        let metadata = self.metadata(&k("meta"), &m.metadata, doc, window, cx, {
            let mid = mid.clone();
            move |p| {
                p.modules
                    .iter_mut()
                    .find(|m| m.id == mid)
                    .map(|m| &mut m.metadata)
            }
        });

        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading(
                m.name.clone(),
                Some(paths.get(&mid).cloned().unwrap_or_default()),
            ))
            .child(row("Name", name))
            .child(row("Parent", parent))
            .child(row("Kind", kind))
            .child(fin)
            .child(row("Derives", derives))
            .child(row("Instances", instantiation))
            .child(active)
            .children(active_rows)
            .children(binary.map(|b| row("Binary", b)))
            .child(description)
            .child(implements)
            .child(base_section)
            .child(types_section)
            .child(attributes)
            .child(invariants)
            .child(methods)
            .child(lifecycle)
            .child(ports)
            .child(subs)
            .child(links_section)
            .child(section("Color", None).child(color))
            .child(section("Layout", None).child(locked))
            .child(metadata)
    }

    fn attributes(
        &mut self,
        m: &Module,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let mid = m.id.clone();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut s = section(
            format!("Attributes ({})", m.attributes.len()),
            Some(
                icon_button(
                    SharedString::from(format!("attr-add-{mid}")),
                    "+",
                    "Add attribute",
                    false,
                    move |_, cx| {
                        apply(
                            &d,
                            cx,
                            on_module(mid2.clone(), |m| {
                                let name =
                                    unique_name("value", m.attributes.iter().map(|a| a.field.name.as_str()));
                                m.attributes.push(Attribute {
                                    field: ValueField {
                                        id: new_id(),
                                        name,
                                        ty: TypeRef::primitive(Primitive::Int32),
                                        description: String::new(),
                                        default: None,
                                        constraints: None,
                                        ownership: None,
                                    },
                                    qualifiers: Qualifiers::default(),
                                    access: None,
                                    accessors: None,
                                    guarded_by: None,
                                })
                            }),
                        )
                    },
                )
                .into_any_element(),
            ),
        );
        for a in &m.attributes {
            let aid = a.field.id.clone();
            let with = {
                let (mid, aid) = (mid.clone(), aid.clone());
                move |f: Rc<dyn Fn(&mut Attribute)>| {
                    let (mid, aid) = (mid.clone(), aid.clone());
                    move |p: &mut Project| {
                        if let Some(a) = p
                            .modules
                            .iter_mut()
                            .find(|m| m.id == mid)
                            .and_then(|m| m.attributes.iter_mut().find(|a| a.field.id == aid))
                        {
                            f(a)
                        }
                    }
                }
            };
            let (d, w) = (doc.clone(), with.clone());
            let access = form::select(
                SharedString::from(format!("attr-acc-{aid}")),
                a.access.map_or(Access::Public, |x| x.access()).as_str(),
                access_options(),
                move |v, _, cx| {
                    let acc = Access::parse(&v).unwrap_or(Access::Public);
                    apply(&d, cx, w(Rc::new(move |a| set_access(&mut a.access, acc))))
                },
            );
            let w = with.clone();
            let name = self.fields.text(
                format!("attr-name-{aid}"),
                &a.field.name,
                "name",
                window,
                cx,
                on_checked_text(
                    doc,
                    |_, v| {
                        (!scaffold_model::project::is_identifier(v))
                            .then(|| "Must be an identifier".to_string())
                    },
                    move |p, v| w(Rc::new(move |a| a.field.name = v.clone()))(p),
                ),
            );
            let w = with.clone();
            let ty = self.type_field(
                format!("attr-type-{aid}"),
                p,
                Some(&mid),
                &a.field.ty,
                doc,
                window,
                cx,
                move |p, t| w(Rc::new(move |a| a.field.ty = t.clone()))(p),
            );
            let w = with.clone();
            let default = self.value_field(
                format!("attr-def-{aid}"),
                a.field.default.as_ref(),
                "default",
                doc,
                window,
                cx,
                move |p, v| w(Rc::new(move |a| a.field.default = v.clone()))(p),
            );
            let mut quals = div().flex().flex_wrap().gap_2();
            for q in ATTRIBUTE_QUALIFIERS {
                let (d, w, q) = (doc.clone(), with.clone(), *q);
                quals = quals.child(checkbox(
                    SharedString::from(format!("attr-q-{aid}-{q}")),
                    q.as_str(),
                    a.qualifiers.has(q),
                    move |v, _, cx| apply(&d, cx, w(Rc::new(move |a| set_attribute_qualifier(a, q, v)))),
                ));
            }
            let (d, mid2, aid2) = (doc.clone(), mid.clone(), aid.clone());
            s = s.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .pb_1()
                    .border_b_1()
                    .border_color(crate::theme::light().border)
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(access)
                            .child(div().w(px(100.)).child(name))
                            .child(div().flex_1().child(ty))
                            .child(icon_button(
                                SharedString::from(format!("attr-x-{aid}")),
                                "×",
                                "Delete attribute",
                                true,
                                move |_, cx| {
                                    let aid2 = aid2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_module(mid2.clone(), move |m| {
                                            m.attributes.retain(|a| a.field.id != aid2)
                                        }),
                                    )
                                },
                            )),
                    )
                    .child(row("Default", default))
                    .child(quals),
            );
        }
        s
    }

    #[allow(clippy::too_many_arguments)]
    fn params(
        &mut self,
        key: &str,
        params: &[MethodParam],
        context: &str,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
        at: impl Fn(&mut Project) -> Option<&mut Vec<MethodParam>> + Clone + 'static,
    ) -> Div {
        let (d, at0) = (doc.clone(), at.clone());
        let mut s = div().flex().flex_col().gap_1().pl_2().child(
            div()
                .flex()
                .items_center()
                .gap_1()
                .child(muted(format!("Parameters ({})", params.len())))
                .child(icon_button(
                    SharedString::from(format!("{key}-p-add")),
                    "+",
                    "Add parameter",
                    false,
                    move |_, cx| {
                        let at0 = at0.clone();
                        apply(&d, cx, move |p| {
                            if let Some(list) = at0(p) {
                                let name = unique_name("arg", list.iter().map(|x| x.param.name.as_str()));
                                list.push(MethodParam {
                                    param: Param {
                                        id: new_id(),
                                        name,
                                        ty: TypeRef::primitive(Primitive::Int32),
                                        description: String::new(),
                                        direction: ParamDirection::In,
                                    },
                                    qualifiers: Qualifiers::default(),
                                    default: None,
                                })
                            }
                        })
                    },
                )),
        );
        for (i, prm) in params.iter().enumerate() {
            let pid = prm.param.id.clone();
            let with = {
                let (at, pid) = (at.clone(), pid.clone());
                move |f: Rc<dyn Fn(&mut MethodParam)>| {
                    let (at, pid) = (at.clone(), pid.clone());
                    move |p: &mut Project| {
                        if let Some(x) = at(p).and_then(|l| l.iter_mut().find(|x| x.param.id == pid)) {
                            f(x)
                        }
                    }
                }
            };
            let (d, w) = (doc.clone(), with.clone());
            let dir = form::select(
                SharedString::from(format!("{key}-pdir-{pid}")),
                prm.param.direction.as_str(),
                param_direction_options(),
                move |v, _, cx| {
                    let dir = ParamDirection::parse(&v).unwrap_or(ParamDirection::In);
                    apply(&d, cx, w(Rc::new(move |x| x.param.direction = dir)))
                },
            );
            let w = with.clone();
            let name = self.fields.text(
                format!("{key}-pname-{pid}"),
                &prm.param.name,
                "name",
                window,
                cx,
                on_text(doc, move |p, v| w(Rc::new(move |x| x.param.name = v.clone()))(p)),
            );
            let w = with.clone();
            let ty = self.type_field(
                format!("{key}-ptype-{pid}"),
                p,
                Some(context),
                &prm.param.ty,
                doc,
                window,
                cx,
                move |p, t| w(Rc::new(move |x| x.param.ty = t.clone()))(p),
            );
            let (d, at2) = (doc.clone(), at.clone());
            s = s.child(
                div()
                    .flex()
                    .gap_1()
                    .items_center()
                    .child(dir)
                    .child(div().w(px(90.)).child(name))
                    .child(div().flex_1().child(ty))
                    .child(icon_button(
                        SharedString::from(format!("{key}-px-{pid}")),
                        "×",
                        "Remove parameter",
                        true,
                        move |_, cx| {
                            let at2 = at2.clone();
                            apply(&d, cx, move |p| {
                                if let Some(l) = at2(p)
                                    && i < l.len()
                                {
                                    l.remove(i);
                                }
                            })
                        },
                    )),
            );
        }
        s
    }

    fn methods(
        &mut self,
        m: &Module,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let mid = m.id.clone();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut s = section(
            format!("Methods ({})", m.methods.len()),
            Some(
                icon_button(
                    SharedString::from(format!("meth-add-{mid}")),
                    "+",
                    "Add method",
                    false,
                    move |_, cx| {
                        apply(
                            &d,
                            cx,
                            on_module(mid2.clone(), |m| {
                                let name = unique_name("method", m.methods.iter().map(|x| x.name.as_str()));
                                m.methods.push(Method {
                                    id: new_id(),
                                    name,
                                    description: String::new(),
                                    params: vec![],
                                    returns: None,
                                    raises: None,
                                    qualifiers: Qualifiers::default(),
                                    pre: None,
                                    post: None,
                                    access: None,
                                })
                            }),
                        )
                    },
                )
                .into_any_element(),
            ),
        );
        for x in &m.methods {
            let xid = x.id.clone();
            let with = {
                let (mid, xid) = (mid.clone(), xid.clone());
                move |f: Rc<dyn Fn(&mut Method)>| {
                    let (mid, xid) = (mid.clone(), xid.clone());
                    move |p: &mut Project| {
                        if let Some(x) = p
                            .modules
                            .iter_mut()
                            .find(|m| m.id == mid)
                            .and_then(|m| m.methods.iter_mut().find(|x| x.id == xid))
                        {
                            f(x)
                        }
                    }
                }
            };
            let (d, w) = (doc.clone(), with.clone());
            let access = form::select(
                SharedString::from(format!("meth-acc-{xid}")),
                x.access.map_or(Access::Public, |a| a.access()).as_str(),
                access_options(),
                move |v, _, cx| {
                    let acc = Access::parse(&v).unwrap_or(Access::Public);
                    apply(&d, cx, w(Rc::new(move |x| set_access(&mut x.access, acc))))
                },
            );
            let w = with.clone();
            let name = self.fields.text(
                format!("meth-name-{xid}"),
                &x.name,
                "name",
                window,
                cx,
                on_checked_text(
                    doc,
                    |_, v| {
                        (!scaffold_model::project::is_identifier(v))
                            .then(|| "Must be an identifier".to_string())
                    },
                    move |p, v| w(Rc::new(move |x| x.name = v.clone()))(p),
                ),
            );
            let returns_shown = x.returns.clone().unwrap_or(TypeRef::primitive(Primitive::Bool));
            let w = with.clone();
            let returns = if x.returns.is_some() {
                self.type_field(
                    format!("meth-ret-{xid}"),
                    p,
                    Some(&mid),
                    &returns_shown,
                    doc,
                    window,
                    cx,
                    move |p, t| w(Rc::new(move |x| x.returns = Some(t.clone())))(p),
                )
            } else {
                muted("void").into_any_element()
            };
            let (d, w) = (doc.clone(), with.clone());
            let has_return = checkbox(
                SharedString::from(format!("meth-hasret-{xid}")),
                "returns",
                x.returns.is_some(),
                move |v, _, cx| {
                    apply(
                        &d,
                        cx,
                        w(Rc::new(move |x| {
                            x.returns = v.then(|| TypeRef::primitive(Primitive::Bool))
                        })),
                    )
                },
            );
            let params = self.params(&format!("meth-{xid}"), &x.params, &mid, doc, p, window, cx, {
                let (mid, xid) = (mid.clone(), xid.clone());
                move |p: &mut Project| {
                    p.modules
                        .iter_mut()
                        .find(|m| m.id == mid)
                        .and_then(|m| m.methods.iter_mut().find(|x| x.id == xid))
                        .map(|x| &mut x.params)
                }
            });
            let mut quals = div().flex().flex_wrap().gap_2();
            for q in METHOD_QUALIFIERS {
                let (d, w, q) = (doc.clone(), with.clone(), *q);
                quals = quals.child(checkbox(
                    SharedString::from(format!("meth-q-{xid}-{q}")),
                    q.as_str(),
                    x.qualifiers.has(q),
                    move |v, _, cx| apply(&d, cx, w(Rc::new(move |x| set_method_qualifier(x, q, v)))),
                ));
            }
            let (d, mid2, xid2) = (doc.clone(), mid.clone(), xid.clone());
            s = s.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .pb_1()
                    .border_b_1()
                    .border_color(crate::theme::light().border)
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(access)
                            .child(div().flex_1().child(name))
                            .child(icon_button(
                                SharedString::from(format!("meth-x-{xid}")),
                                "×",
                                "Delete method",
                                true,
                                move |_, cx| {
                                    let xid2 = xid2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_module(mid2.clone(), move |m| m.methods.retain(|x| x.id != xid2)),
                                    )
                                },
                            )),
                    )
                    .child(params)
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(has_return)
                            .child(div().flex_1().child(returns)),
                    )
                    .child(quals),
            );
        }
        s
    }

    fn lifecycle(
        &mut self,
        m: &Module,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let mid = m.id.clone();
        let special =
            |key: &str, current: Option<SpecialMember>, set: fn(&mut Module, Option<SpecialMember>)| {
                let (d, mid2) = (doc.clone(), mid.clone());
                form::select(
                    SharedString::from(format!("{key}-{mid}")),
                    current.map_or("", |x| x.as_str()),
                    std::iter::once((String::new(), "(implicit)".to_string()))
                        .chain(
                            SpecialMember::ALL
                                .iter()
                                .map(|x| (x.as_str().to_string(), x.as_str().to_string())),
                        )
                        .collect(),
                    move |v, _, cx| {
                        let s = SpecialMember::parse(&v);
                        apply(&d, cx, on_module(mid2.clone(), move |m| set(m, s)))
                    },
                )
            };
        let copy = special("copy", m.copy, |m, s| m.copy = s);
        let mv = special("move", m.r#move, |m, s| m.r#move = s);
        let (d, mid2) = (doc.clone(), mid.clone());
        let destructor = checkbox(
            SharedString::from(format!("dtor-{mid}")),
            "Destructor",
            m.destructor.is_some(),
            move |v, _, cx| {
                apply(
                    &d,
                    cx,
                    on_module(mid2.clone(), move |m| m.destructor = v.then(Destructor::default)),
                )
            },
        );
        let virt = m.destructor.as_ref().map(|dt| {
            let (d, mid2) = (doc.clone(), mid.clone());
            checkbox(
                SharedString::from(format!("dtor-v-{mid}")),
                "virtual",
                dt.r#virtual == Some(true),
                move |v, _, cx| {
                    apply(
                        &d,
                        cx,
                        on_module(mid2.clone(), move |m| {
                            if let Some(dt) = &mut m.destructor {
                                dt.r#virtual = v.then_some(true)
                            }
                        }),
                    )
                },
            )
        });
        let ctors = m.constructors.clone().unwrap_or_default();
        let (d, mid2) = (doc.clone(), mid.clone());
        let mut s = section(
            "Lifecycle",
            Some(
                icon_button(
                    SharedString::from(format!("ctor-add-{mid}")),
                    "+",
                    "Add constructor",
                    false,
                    move |_, cx| {
                        apply(
                            &d,
                            cx,
                            on_module(mid2.clone(), |m| {
                                m.constructors.get_or_insert_with(Vec::new).push(Constructor {
                                    id: new_id(),
                                    description: String::new(),
                                    params: vec![],
                                    access: None,
                                    explicit: false,
                                    defaulted: false,
                                    deleted: false,
                                })
                            }),
                        )
                    },
                )
                .into_any_element(),
            ),
        )
        .child(row("Copy", copy))
        .child(row("Move", mv))
        .child(div().flex().gap_2().child(destructor).children(virt));
        for c in &ctors {
            let cid = c.id.clone();
            let params = self.params(&format!("ctor-{cid}"), &c.params, &mid, doc, p, window, cx, {
                let (mid, cid) = (mid.clone(), cid.clone());
                move |p: &mut Project| {
                    p.modules
                        .iter_mut()
                        .find(|m| m.id == mid)
                        .and_then(|m| m.constructors.as_mut())
                        .and_then(|l| l.iter_mut().find(|x| x.id == cid))
                        .map(|x| &mut x.params)
                }
            });
            let (d, mid2, cid2) = (doc.clone(), mid.clone(), cid.clone());
            let flag = |key: &'static str, label: &'static str, on: bool, set: fn(&mut Constructor, bool)| {
                let (d, mid2, cid2) = (doc.clone(), mid.clone(), cid.clone());
                checkbox(
                    SharedString::from(format!("ctor-{key}-{cid}")),
                    label,
                    on,
                    move |v, _, cx| {
                        let cid2 = cid2.clone();
                        apply(
                            &d,
                            cx,
                            on_module(mid2.clone(), move |m| {
                                if let Some(c) = m
                                    .constructors
                                    .as_mut()
                                    .and_then(|l| l.iter_mut().find(|x| x.id == cid2))
                                {
                                    set(c, v)
                                }
                            }),
                        )
                    },
                )
            };
            s = s.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(div().flex_1().child(format!("{}(…)", m.name)))
                            .child(flag("explicit", "explicit", c.explicit, |c, v| c.explicit = v))
                            .child(flag("default", "= default", c.defaulted, |c, v| c.defaulted = v))
                            .child(flag("delete", "= delete", c.deleted, |c, v| c.deleted = v))
                            .child(icon_button(
                                SharedString::from(format!("ctor-x-{cid}")),
                                "×",
                                "Delete constructor",
                                true,
                                move |_, cx| {
                                    let cid2 = cid2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_module(mid2.clone(), move |m| {
                                            if let Some(l) = &mut m.constructors {
                                                l.retain(|x| x.id != cid2);
                                                if l.is_empty() {
                                                    m.constructors = None;
                                                }
                                            }
                                        }),
                                    )
                                },
                            )),
                    )
                    .child(params),
            );
        }
        s
    }

    fn ports(
        &mut self,
        m: &Module,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let mid = m.id.clone();
        let (d, d2, mid2, mid3) = (doc.clone(), doc.clone(), mid.clone(), mid.clone());
        let mut s = section(
            format!("Ports ({})", m.ports.len()),
            Some(
                div()
                    .flex()
                    .gap_1()
                    .child(form::button(
                        SharedString::from(format!("port-in-{mid}")),
                        "+ in",
                        move |_, cx| {
                            let mid2 = mid2.clone();
                            apply(&d, cx, move |p| {
                                add_port(p, &mid2, PortRole::In);
                            })
                        },
                    ))
                    .child(form::button(
                        SharedString::from(format!("port-out-{mid}")),
                        "+ out",
                        move |_, cx| {
                            let mid3 = mid3.clone();
                            apply(&d2, cx, move |p| {
                                add_port(p, &mid3, PortRole::Out);
                            })
                        },
                    ))
                    .into_any_element(),
            ),
        );
        for pt in &m.ports {
            let pid = pt.id.clone();
            let with = {
                let (mid, pid) = (mid.clone(), pid.clone());
                move |f: Rc<dyn Fn(&mut Port)>| {
                    let (mid, pid) = (mid.clone(), pid.clone());
                    move |p: &mut Project| {
                        if let Some(x) = p
                            .modules
                            .iter_mut()
                            .find(|m| m.id == mid)
                            .and_then(|m| m.ports.iter_mut().find(|x| x.id == pid))
                        {
                            f(x)
                        }
                    }
                }
            };
            let w = with.clone();
            let name = self.fields.text(
                format!("port-name-{pid}"),
                &pt.name,
                "name",
                window,
                cx,
                on_checked_text(
                    doc,
                    {
                        let (pid, mid) = (pid.clone(), mid.clone());
                        move |p, v| {
                            name_error(
                                p,
                                &NameTarget::Port {
                                    id: Some(pid.clone()),
                                    module_id: mid.clone(),
                                },
                                v,
                            )
                        }
                    },
                    move |p, v| w(Rc::new(move |x| x.name = v.clone()))(p),
                ),
            );
            let (d, w) = (doc.clone(), with.clone());
            let role = form::select(
                SharedString::from(format!("port-role-{pid}")),
                pt.role.as_str(),
                vec![("in".into(), "in".into()), ("out".into(), "out".into())],
                move |v, _, cx| {
                    let r = PortRole::parse(&v).unwrap_or(PortRole::In);
                    apply(&d, cx, w(Rc::new(move |x| x.role = r)))
                },
            );
            let (d, w) = (doc.clone(), with.clone());
            let iface = form::select(
                SharedString::from(format!("port-iface-{pid}")),
                pt.interface_id.as_deref().unwrap_or(""),
                std::iter::once((String::new(), "(untyped)".to_string()))
                    .chain(p.interfaces.iter().map(|i| (i.id.clone(), i.name.clone())))
                    .collect(),
                move |v, _, cx| {
                    let i = (!v.is_empty()).then_some(v);
                    apply(&d, cx, w(Rc::new(move |x| x.interface_id = i.clone())))
                },
            );
            let (d, mid2, pid2) = (doc.clone(), mid.clone(), pid.clone());
            s = s.child(
                div()
                    .flex()
                    .gap_1()
                    .items_center()
                    .child(role)
                    .child(div().w(px(100.)).child(name))
                    .child(div().flex_1().child(iface))
                    .child(icon_button(
                        SharedString::from(format!("port-x-{pid}")),
                        "×",
                        "Delete port",
                        true,
                        move |_, cx| {
                            let (mid2, pid2) = (mid2.clone(), pid2.clone());
                            apply(&d, cx, move |p| delete_port(p, &mid2, &pid2))
                        },
                    )),
            );
        }
        s.when(m.ports.is_empty(), |s| s.child(muted("No ports.")))
    }
}
