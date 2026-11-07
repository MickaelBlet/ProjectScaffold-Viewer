//! Type and interface inspectors. Port of `TypeInspector.tsx`, `InterfaceInspector.tsx` and
//! `MessageList.tsx`.

use std::rc::Rc;

use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::entities::{delete_interface, delete_type, set_type_module};
use scaffold_model::project::{
    NameTarget, name_error, new_id, project_module_paths, set_access, type_usages, unique_name,
};
use scaffold_model::types::Primitive;
use scaffold_model::types::*;

use super::{InspectorPanel, on_checked_text, on_text};
use crate::document::Document;
use crate::form::{self, apply, button, checkbox, heading, icon_button, muted, row, section};

fn on_type(id: Id, f: impl Fn(&mut TypeDef) + 'static) -> impl Fn(&mut Project) + 'static {
    move |p| {
        if let Some(t) = p.types.iter_mut().find(|t| t.id == id) {
            f(t)
        }
    }
}

fn on_iface(id: Id, f: impl Fn(&mut Interface) + 'static) -> impl Fn(&mut Project) + 'static {
    move |p| {
        if let Some(i) = p.interfaces.iter_mut().find(|i| i.id == id) {
            f(i)
        }
    }
}

fn new_value_field(name: String) -> ValueField {
    ValueField {
        id: new_id(),
        name,
        ty: TypeRef::primitive(Primitive::Int32),
        description: String::new(),
        default: None,
        constraints: None,
        ownership: None,
    }
}

/// Fields of a struct or exception.
fn fields_of(t: &mut TypeDef) -> Option<&mut Vec<ValueField>> {
    match &mut t.body {
        TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => Some(fields),
        _ => None,
    }
}

impl InspectorPanel {
    pub(super) fn type_def(
        &mut self,
        id: &Id,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(t) = p.types.iter().find(|t| &t.id == id).cloned() else {
            return muted("Type deleted.");
        };
        let tid = t.id.clone();
        let k = |s: &str| format!("type-{s}-{tid}");
        let readonly = t.dependency.is_some();
        let context = t.module.clone();
        let name = self.fields.text(
            k("name"),
            &t.name,
            "Name",
            window,
            cx,
            on_checked_text(
                doc,
                {
                    let (tid, module) = (tid.clone(), t.module.clone());
                    move |p, v| {
                        name_error(
                            p,
                            &NameTarget::Type {
                                id: Some(tid.clone()),
                                module: module.clone(),
                            },
                            v,
                        )
                    }
                },
                {
                    let tid = tid.clone();
                    move |p, v| on_type(tid.clone(), move |t| t.name = v.clone())(p)
                },
            ),
        );
        let description = self.fields.area(
            k("desc"),
            &t.description,
            "Description",
            window,
            cx,
            on_text(doc, {
                let tid = tid.clone();
                move |p, v| on_type(tid.clone(), move |t| t.description = v.clone())(p)
            }),
        );
        let paths = project_module_paths(p);
        let (d, t2) = (doc.clone(), tid.clone());
        let owner = form::select(
            k("owner"),
            t.module.as_deref().unwrap_or(""),
            std::iter::once((String::new(), "(project)".to_string()))
                .chain(
                    p.modules
                        .iter()
                        .map(|m| (m.id.clone(), paths.get(&m.id).cloned().unwrap_or_default())),
                )
                .collect(),
            move |v, _, cx| {
                let m = (!v.is_empty()).then_some(v);
                let t2 = t2.clone();
                apply(&d, cx, move |p| set_type_module(p, &t2, m.as_deref()))
            },
        );
        let access = t.module.is_some().then(|| {
            let (d, t2) = (doc.clone(), tid.clone());
            form::select(
                k("access"),
                t.access.map_or(Access::Public, |a| a.access()).as_str(),
                ["public", "protected", "private"]
                    .iter()
                    .map(|a| (a.to_string(), a.to_string()))
                    .collect(),
                move |v, _, cx| {
                    let acc = Access::parse(&v).unwrap_or(Access::Public);
                    apply(
                        &d,
                        cx,
                        on_type(t2.clone(), move |t| set_access(&mut t.access, acc)),
                    )
                },
            )
        });

        let body = match &t.body {
            TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => {
                let (d, t2) = (doc.clone(), tid.clone());
                let mut s = section(
                    format!("Fields ({})", fields.len()),
                    Some(
                        icon_button(
                            SharedString::from(k("f-add")),
                            "+",
                            "Add field",
                            false,
                            move |_, cx| {
                                apply(
                                    &d,
                                    cx,
                                    on_type(t2.clone(), |t| {
                                        if let Some(f) = fields_of(t) {
                                            let n = unique_name("field", f.iter().map(|x| x.name.as_str()));
                                            f.push(new_value_field(n));
                                        }
                                    }),
                                )
                            },
                        )
                        .into_any_element(),
                    ),
                );
                for f in fields {
                    let fid = f.id.clone();
                    let with = {
                        let (tid, fid) = (tid.clone(), fid.clone());
                        move |g: Rc<dyn Fn(&mut ValueField)>| {
                            let (tid, fid) = (tid.clone(), fid.clone());
                            move |p: &mut Project| {
                                if let Some(x) = p
                                    .types
                                    .iter_mut()
                                    .find(|t| t.id == tid)
                                    .and_then(fields_of)
                                    .and_then(|l| l.iter_mut().find(|x| x.id == fid))
                                {
                                    g(x)
                                }
                            }
                        }
                    };
                    let w = with.clone();
                    let name = self.fields.text(
                        format!("tf-name-{fid}"),
                        &f.name,
                        "name",
                        window,
                        cx,
                        on_text(doc, move |p, v| w(Rc::new(move |x| x.name = v.clone()))(p)),
                    );
                    let w = with.clone();
                    let ty = self.type_field(
                        format!("tf-type-{fid}"),
                        p,
                        context.as_deref(),
                        &f.ty,
                        doc,
                        window,
                        cx,
                        move |p, ty| w(Rc::new(move |x| x.ty = ty.clone()))(p),
                    );
                    let w = with.clone();
                    let default = self.value_field(
                        format!("tf-def-{fid}"),
                        f.default.as_ref(),
                        "default",
                        doc,
                        window,
                        cx,
                        move |p, v| w(Rc::new(move |x| x.default = v.clone()))(p),
                    );
                    let (d, t2, f2) = (doc.clone(), tid.clone(), fid.clone());
                    s = s.child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(div().w(px(100.)).child(name))
                            .child(div().flex_1().child(ty))
                            .child(div().w(px(80.)).child(default))
                            .child(icon_button(
                                SharedString::from(format!("tf-x-{fid}")),
                                "×",
                                "Delete field",
                                true,
                                move |_, cx| {
                                    let f2 = f2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_type(t2.clone(), move |t| {
                                            if let Some(l) = fields_of(t) {
                                                l.retain(|x| x.id != f2)
                                            }
                                        }),
                                    )
                                },
                            )),
                    );
                }
                s
            }
            TypeBody::Enum { underlying, values } => {
                let (d, t2) = (doc.clone(), tid.clone());
                let under = form::select(
                    k("under"),
                    underlying.as_str(),
                    IntPrimitive::ALL
                        .iter()
                        .map(|x| (x.as_str().into(), x.as_str().into()))
                        .collect(),
                    move |v, _, cx| {
                        let u = IntPrimitive::parse(&v).unwrap_or(IntPrimitive::Uint8);
                        apply(
                            &d,
                            cx,
                            on_type(t2.clone(), move |t| {
                                if let TypeBody::Enum { underlying, .. } = &mut t.body {
                                    *underlying = u
                                }
                            }),
                        )
                    },
                );
                let (d, t2) = (doc.clone(), tid.clone());
                let mut s = section(
                    format!("Values ({})", values.len()),
                    Some(
                        icon_button(
                            SharedString::from(k("v-add")),
                            "+",
                            "Add value",
                            false,
                            move |_, cx| {
                                apply(
                                    &d,
                                    cx,
                                    on_type(t2.clone(), |t| {
                                        if let TypeBody::Enum { values, .. } = &mut t.body {
                                            let n =
                                                unique_name("Value", values.iter().map(|x| x.name.as_str()));
                                            let v = values.iter().map(|x| x.value + 1).max().unwrap_or(0);
                                            values.push(EnumValue {
                                                id: new_id(),
                                                name: n,
                                                value: v,
                                            });
                                        }
                                    }),
                                )
                            },
                        )
                        .into_any_element(),
                    ),
                )
                .child(row("Underlying", under));
                for v in values {
                    let vid = v.id.clone();
                    let with = {
                        let (tid, vid) = (tid.clone(), vid.clone());
                        move |g: Rc<dyn Fn(&mut EnumValue)>| {
                            let (tid, vid) = (tid.clone(), vid.clone());
                            move |p: &mut Project| {
                                if let Some(TypeBody::Enum { values, .. }) =
                                    p.types.iter_mut().find(|t| t.id == tid).map(|t| &mut t.body)
                                    && let Some(x) = values.iter_mut().find(|x| x.id == vid)
                                {
                                    g(x)
                                }
                            }
                        }
                    };
                    let w = with.clone();
                    let name = self.fields.text(
                        format!("ev-name-{vid}"),
                        &v.name,
                        "name",
                        window,
                        cx,
                        on_text(doc, move |p, s| w(Rc::new(move |x| x.name = s.clone()))(p)),
                    );
                    let w = with.clone();
                    let d = doc.clone();
                    let value = self.fields.number(
                        format!("ev-val-{vid}"),
                        Some(v.value as f64),
                        "0",
                        true,
                        window,
                        cx,
                        move |n, _, cx| {
                            if let Some(n) = n {
                                apply(&d, cx, w(Rc::new(move |x| x.value = n as i64)))
                            }
                        },
                    );
                    let (d, t2, v2) = (doc.clone(), tid.clone(), vid.clone());
                    s = s.child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(div().flex_1().child(name))
                            .child(div().w(px(80.)).child(value))
                            .child(icon_button(
                                SharedString::from(format!("ev-x-{vid}")),
                                "×",
                                "Delete value",
                                true,
                                move |_, cx| {
                                    let v2 = v2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_type(t2.clone(), move |t| {
                                            if let TypeBody::Enum { values, .. } = &mut t.body {
                                                values.retain(|x| x.id != v2)
                                            }
                                        }),
                                    )
                                },
                            )),
                    );
                }
                s
            }
            TypeBody::Bitmask { underlying, flags } => {
                let (d, t2) = (doc.clone(), tid.clone());
                let under = form::select(
                    k("under"),
                    underlying.as_str(),
                    UnsignedPrimitive::ALL
                        .iter()
                        .map(|x| (x.as_str().into(), x.as_str().into()))
                        .collect(),
                    move |v, _, cx| {
                        let u = UnsignedPrimitive::parse(&v).unwrap_or(UnsignedPrimitive::Uint32);
                        apply(
                            &d,
                            cx,
                            on_type(t2.clone(), move |t| {
                                if let TypeBody::Bitmask { underlying, .. } = &mut t.body {
                                    *underlying = u
                                }
                            }),
                        )
                    },
                );
                let (d, t2) = (doc.clone(), tid.clone());
                let mut s = section(
                    format!("Flags ({})", flags.len()),
                    Some(
                        icon_button(
                            SharedString::from(k("bf-add")),
                            "+",
                            "Add flag",
                            false,
                            move |_, cx| {
                                apply(
                                    &d,
                                    cx,
                                    on_type(t2.clone(), |t| {
                                        if let TypeBody::Bitmask { flags, .. } = &mut t.body {
                                            let n =
                                                unique_name("Flag", flags.iter().map(|x| x.name.as_str()));
                                            let bit = flags.iter().map(|x| x.bit + 1).max().unwrap_or(0);
                                            flags.push(BitmaskFlag {
                                                id: new_id(),
                                                name: n,
                                                bit,
                                            });
                                        }
                                    }),
                                )
                            },
                        )
                        .into_any_element(),
                    ),
                )
                .child(row("Underlying", under));
                for f in flags {
                    let fid = f.id.clone();
                    let with = {
                        let (tid, fid) = (tid.clone(), fid.clone());
                        move |g: Rc<dyn Fn(&mut BitmaskFlag)>| {
                            let (tid, fid) = (tid.clone(), fid.clone());
                            move |p: &mut Project| {
                                if let Some(TypeBody::Bitmask { flags, .. }) =
                                    p.types.iter_mut().find(|t| t.id == tid).map(|t| &mut t.body)
                                    && let Some(x) = flags.iter_mut().find(|x| x.id == fid)
                                {
                                    g(x)
                                }
                            }
                        }
                    };
                    let w = with.clone();
                    let name = self.fields.text(
                        format!("bf-name-{fid}"),
                        &f.name,
                        "name",
                        window,
                        cx,
                        on_text(doc, move |p, s| w(Rc::new(move |x| x.name = s.clone()))(p)),
                    );
                    let (w, d) = (with.clone(), doc.clone());
                    let bit = self.fields.number(
                        format!("bf-bit-{fid}"),
                        Some(f.bit as f64),
                        "0",
                        true,
                        window,
                        cx,
                        move |n, _, cx| {
                            if let Some(n) = n {
                                apply(&d, cx, w(Rc::new(move |x| x.bit = n.max(0.) as u32)))
                            }
                        },
                    );
                    let (d, t2, f2) = (doc.clone(), tid.clone(), fid.clone());
                    s = s.child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(div().flex_1().child(name))
                            .child(div().w(px(60.)).child(bit))
                            .child(icon_button(
                                SharedString::from(format!("bf-x-{fid}")),
                                "×",
                                "Delete flag",
                                true,
                                move |_, cx| {
                                    let f2 = f2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_type(t2.clone(), move |t| {
                                            if let TypeBody::Bitmask { flags, .. } = &mut t.body {
                                                flags.retain(|x| x.id != f2)
                                            }
                                        }),
                                    )
                                },
                            )),
                    );
                }
                s
            }
            TypeBody::Union { discriminator, cases } => {
                let t2 = tid.clone();
                let disc = self.type_field(
                    k("disc"),
                    p,
                    context.as_deref(),
                    discriminator,
                    doc,
                    window,
                    cx,
                    move |p, ty| {
                        on_type(t2.clone(), move |t| {
                            if let TypeBody::Union { discriminator, .. } = &mut t.body {
                                *discriminator = ty.clone()
                            }
                        })(p)
                    },
                );
                let (d, t2) = (doc.clone(), tid.clone());
                let mut s = section(
                    format!("Cases ({})", cases.len()),
                    Some(
                        icon_button(
                            SharedString::from(k("uc-add")),
                            "+",
                            "Add case",
                            false,
                            move |_, cx| {
                                apply(
                                    &d,
                                    cx,
                                    on_type(t2.clone(), |t| {
                                        if let TypeBody::Union { cases, .. } = &mut t.body {
                                            let n =
                                                unique_name("case", cases.iter().map(|x| x.name.as_str()));
                                            let label = cases.len() as i64;
                                            cases.push(UnionCase {
                                                id: new_id(),
                                                name: n,
                                                ty: TypeRef::primitive(Primitive::Int32),
                                                description: String::new(),
                                                labels: vec![serde_json::json!(label)],
                                                is_default: false,
                                            });
                                        }
                                    }),
                                )
                            },
                        )
                        .into_any_element(),
                    ),
                )
                .child(row("Discriminator", disc));
                for c in cases {
                    let cid = c.id.clone();
                    let with = {
                        let (tid, cid) = (tid.clone(), cid.clone());
                        move |g: Rc<dyn Fn(&mut UnionCase)>| {
                            let (tid, cid) = (tid.clone(), cid.clone());
                            move |p: &mut Project| {
                                if let Some(TypeBody::Union { cases, .. }) =
                                    p.types.iter_mut().find(|t| t.id == tid).map(|t| &mut t.body)
                                    && let Some(x) = cases.iter_mut().find(|x| x.id == cid)
                                {
                                    g(x)
                                }
                            }
                        }
                    };
                    let w = with.clone();
                    let name = self.fields.text(
                        format!("uc-name-{cid}"),
                        &c.name,
                        "name",
                        window,
                        cx,
                        on_text(doc, move |p, s| w(Rc::new(move |x| x.name = s.clone()))(p)),
                    );
                    let w = with.clone();
                    let ty = self.type_field(
                        format!("uc-type-{cid}"),
                        p,
                        context.as_deref(),
                        &c.ty,
                        doc,
                        window,
                        cx,
                        move |p, ty| w(Rc::new(move |x| x.ty = ty.clone()))(p),
                    );
                    let labels = c
                        .labels
                        .iter()
                        .map(scaffold_model::defaults::format_value)
                        .collect::<Vec<_>>()
                        .join(", ");
                    let (w, d) = (with.clone(), doc.clone());
                    let labels = self.fields.text(
                        format!("uc-labels-{cid}"),
                        &labels,
                        "labels",
                        window,
                        cx,
                        move |v, _, cx| {
                            let mut out = Vec::new();
                            for part in v.split(',').map(str::trim).filter(|x| !x.is_empty()) {
                                match scaffold_model::defaults::parse_value(part) {
                                    Ok(x) => out.push(x),
                                    Err(e) => return Some(e),
                                }
                            }
                            apply(&d, cx, w(Rc::new(move |x| x.labels = out.clone())));
                            None
                        },
                    );
                    let (w, d) = (with.clone(), doc.clone());
                    let default = checkbox(
                        SharedString::from(format!("uc-def-{cid}")),
                        "default",
                        c.is_default,
                        move |v, _, cx| apply(&d, cx, w(Rc::new(move |x| x.is_default = v))),
                    );
                    let (d, t2, c2) = (doc.clone(), tid.clone(), cid.clone());
                    s = s.child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(div().w(px(80.)).child(labels))
                            .child(default)
                            .child(div().w(px(90.)).child(name))
                            .child(div().flex_1().child(ty))
                            .child(icon_button(
                                SharedString::from(format!("uc-x-{cid}")),
                                "×",
                                "Delete case",
                                true,
                                move |_, cx| {
                                    let c2 = c2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_type(t2.clone(), move |t| {
                                            if let TypeBody::Union { cases, .. } = &mut t.body {
                                                cases.retain(|x| x.id != c2)
                                            }
                                        }),
                                    )
                                },
                            )),
                    );
                }
                s
            }
            TypeBody::Alias { ty } => {
                let t2 = tid.clone();
                let field = self.type_field(
                    k("alias"),
                    p,
                    context.as_deref(),
                    ty,
                    doc,
                    window,
                    cx,
                    move |p, x| {
                        on_type(t2.clone(), move |t| {
                            if let TypeBody::Alias { ty } = &mut t.body {
                                *ty = x.clone()
                            }
                        })(p)
                    },
                );
                section("Alias of", None).child(field)
            }
            TypeBody::Primitive { type_param } => {
                let is_param = type_param.is_some();
                let (d, t2) = (doc.clone(), tid.clone());
                let s = section("Primitive", None).child(muted(
                    "A type the generators map to a type of their language (a type parameter of a generic module when set as one).",
                ));
                if t.module.is_some() {
                    s.child(checkbox(
                        k("tparam"),
                        "Type parameter of its module",
                        is_param,
                        move |v, _, cx| {
                            apply(
                                &d,
                                cx,
                                on_type(t2.clone(), move |t| {
                                    if let TypeBody::Primitive { type_param } = &mut t.body {
                                        *type_param = v.then(TypeParam::default)
                                    }
                                }),
                            )
                        },
                    ))
                } else {
                    s
                }
            }
        };

        let usages = type_usages(p, &tid);
        let mut used = section(format!("Used by ({})", usages.len()), None);
        for u in &usages {
            used = used.child(div().text_sm().child(u.clone()));
        }
        let (d, t2) = (doc.clone(), tid.clone());
        let force = !usages.is_empty();
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading(t.name.clone(), Some(t.kind().to_string())))
            .when(readonly, |d| {
                d.child(muted("From a dependency: edited in its own project."))
            })
            .child(row("Name", name))
            .child(row("Owner", owner))
            .children(access.map(|a| row("Access", a)))
            .child(description)
            .child(body)
            .child(used)
            .child(div().pt_2().child(button(
                k("delete"),
                if force {
                    "Delete (keep usages as missing)"
                } else {
                    "Delete type"
                },
                move |_, cx| {
                    let t2 = t2.clone();
                    apply(&d, cx, move |p| {
                        delete_type(p, &t2, true);
                    })
                },
            )))
    }

    pub(super) fn interface(
        &mut self,
        id: &Id,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(i) = p.interfaces.iter().find(|i| &i.id == id).cloned() else {
            return muted("Interface deleted.");
        };
        let iid = i.id.clone();
        let k = |s: &str| format!("iface-{s}-{iid}");
        let name = self.fields.text(
            k("name"),
            &i.name,
            "Name",
            window,
            cx,
            on_checked_text(
                doc,
                {
                    let iid = iid.clone();
                    move |p, v| {
                        name_error(
                            p,
                            &NameTarget::Interface {
                                id: Some(iid.clone()),
                            },
                            v,
                        )
                    }
                },
                {
                    let iid = iid.clone();
                    move |p, v| on_iface(iid.clone(), move |i| i.name = v.clone())(p)
                },
            ),
        );
        let description = self.fields.area(
            k("desc"),
            &i.description,
            "Description",
            window,
            cx,
            on_text(doc, {
                let iid = iid.clone();
                move |p, v| on_iface(iid.clone(), move |i| i.description = v.clone())(p)
            }),
        );
        let (d, i2) = (doc.clone(), iid.clone());
        let mut messages = section(
            format!("Messages ({})", i.messages.len()),
            Some(
                icon_button(
                    SharedString::from(k("m-add")),
                    "+",
                    "Add message",
                    false,
                    move |_, cx| {
                        apply(
                            &d,
                            cx,
                            on_iface(i2.clone(), |i| {
                                let n = unique_name("message", i.messages.iter().map(|x| x.name.as_str()));
                                i.messages.push(Message {
                                    id: new_id(),
                                    name: n,
                                    description: String::new(),
                                    params: vec![],
                                    returns: None,
                                    raises: None,
                                })
                            }),
                        )
                    },
                )
                .into_any_element(),
            ),
        );
        for m in &i.messages {
            let mid = m.id.clone();
            let with = {
                let (iid, mid) = (iid.clone(), mid.clone());
                move |g: Rc<dyn Fn(&mut Message)>| {
                    let (iid, mid) = (iid.clone(), mid.clone());
                    move |p: &mut Project| {
                        if let Some(x) = p
                            .interfaces
                            .iter_mut()
                            .find(|i| i.id == iid)
                            .and_then(|i| i.messages.iter_mut().find(|x| x.id == mid))
                        {
                            g(x)
                        }
                    }
                }
            };
            let w = with.clone();
            let name = self.fields.text(
                format!("msg-name-{mid}"),
                &m.name,
                "name",
                window,
                cx,
                on_text(doc, move |p, v| w(Rc::new(move |x| x.name = v.clone()))(p)),
            );
            let (w, d) = (with.clone(), doc.clone());
            let has_ret = checkbox(
                SharedString::from(format!("msg-hasret-{mid}")),
                "returns",
                m.returns.is_some(),
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
            let ret = match &m.returns {
                Some(r) => {
                    let w = with.clone();
                    self.type_field(
                        format!("msg-ret-{mid}"),
                        p,
                        None,
                        r,
                        doc,
                        window,
                        cx,
                        move |p, t| w(Rc::new(move |x| x.returns = Some(t.clone())))(p),
                    )
                }
                None => muted("void (one-way)").into_any_element(),
            };
            let (w, d) = (with.clone(), doc.clone());
            let mut params = div().flex().flex_col().gap_1().pl_2().child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(muted(format!("Parameters ({})", m.params.len())))
                    .child(icon_button(
                        SharedString::from(format!("msg-p-add-{mid}")),
                        "+",
                        "Add parameter",
                        false,
                        move |_, cx| {
                            apply(
                                &d,
                                cx,
                                w(Rc::new(|x| {
                                    let n = unique_name("arg", x.params.iter().map(|p| p.name.as_str()));
                                    x.params.push(Param {
                                        id: new_id(),
                                        name: n,
                                        ty: TypeRef::primitive(Primitive::Int32),
                                        description: String::new(),
                                        direction: ParamDirection::In,
                                    })
                                })),
                            )
                        },
                    )),
            );
            for prm in &m.params {
                let pid = prm.id.clone();
                let on_param = {
                    let (w, pid) = (with.clone(), pid.clone());
                    move |g: Rc<dyn Fn(&mut Param)>| {
                        let pid = pid.clone();
                        w(Rc::new(move |x: &mut Message| {
                            if let Some(pr) = x.params.iter_mut().find(|pr| pr.id == pid) {
                                g(pr)
                            }
                        }))
                    }
                };
                let (op, d) = (on_param.clone(), doc.clone());
                let dir = form::select(
                    SharedString::from(format!("msg-pdir-{pid}")),
                    prm.direction.as_str(),
                    ["in", "out", "inout"]
                        .iter()
                        .map(|x| (x.to_string(), x.to_string()))
                        .collect(),
                    move |v, _, cx| {
                        let dir = ParamDirection::parse(&v).unwrap_or(ParamDirection::In);
                        apply(&d, cx, op(Rc::new(move |pr| pr.direction = dir)))
                    },
                );
                let op = on_param.clone();
                let pname = self.fields.text(
                    format!("msg-pname-{pid}"),
                    &prm.name,
                    "name",
                    window,
                    cx,
                    on_text(doc, move |p, v| op(Rc::new(move |pr| pr.name = v.clone()))(p)),
                );
                let op = on_param.clone();
                let pty = self.type_field(
                    format!("msg-ptype-{pid}"),
                    p,
                    None,
                    &prm.ty,
                    doc,
                    window,
                    cx,
                    move |p, t| op(Rc::new(move |pr| pr.ty = t.clone()))(p),
                );
                let (w, d, p2) = (with.clone(), doc.clone(), pid.clone());
                params = params.child(
                    div()
                        .flex()
                        .gap_1()
                        .items_center()
                        .child(dir)
                        .child(div().w(px(90.)).child(pname))
                        .child(div().flex_1().child(pty))
                        .child(icon_button(
                            SharedString::from(format!("msg-px-{pid}")),
                            "×",
                            "Remove parameter",
                            true,
                            move |_, cx| {
                                let p2 = p2.clone();
                                apply(&d, cx, w(Rc::new(move |x| x.params.retain(|pr| pr.id != p2))))
                            },
                        )),
                );
            }
            let (d, i2, m2) = (doc.clone(), iid.clone(), mid.clone());
            messages = messages.child(
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
                            .child(div().flex_1().child(name))
                            .child(icon_button(
                                SharedString::from(format!("msg-x-{mid}")),
                                "×",
                                "Delete message",
                                true,
                                move |_, cx| {
                                    let m2 = m2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_iface(i2.clone(), move |i| i.messages.retain(|x| x.id != m2)),
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
                            .child(has_ret)
                            .child(div().flex_1().child(ret)),
                    ),
            );
        }
        let ports: Vec<String> = p
            .modules
            .iter()
            .flat_map(|m| {
                m.ports
                    .iter()
                    .filter(|pt| pt.interface_id.as_ref() == Some(&iid))
                    .map(move |pt| format!("{}.{}", m.name, pt.name))
            })
            .collect();
        let mut used = section(format!("Ports ({})", ports.len()), None);
        for x in &ports {
            used = used.child(div().text_sm().child(x.clone()));
        }
        let (d, i2) = (doc.clone(), iid.clone());
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading(i.name.clone(), Some("interface".into())))
            .when(i.dependency.is_some(), |d| {
                d.child(muted("From a dependency: edited in its own project."))
            })
            .child(row("Name", name))
            .child(description)
            .child(messages)
            .child(used)
            .child(
                div()
                    .pt_2()
                    .child(button(k("delete"), "Delete interface", move |_, cx| {
                        let i2 = i2.clone();
                        apply(&d, cx, move |p| {
                            delete_interface(p, &i2);
                        })
                    })),
            )
    }
}
