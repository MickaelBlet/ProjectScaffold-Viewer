//! Project inspector: name, description, metadata, constants, transports, remote defaults and
//! binaries. Port of `ProjectInspector.tsx`.

use gpui_kit::*;
use scaffold_model::entities::{add_binary, add_const, delete_binary, delete_const, rename_transport};
use scaffold_model::project::{NameTarget, binary_error, name_error, transport_error, unique_name};
use scaffold_model::transports::{DEFAULT_BASE_PORT, DEFAULT_HOST};
use scaffold_model::types::{HostOnly, Metadata, Project, RemoteDefaults, TRANSPORTS};

use super::{InspectorPanel, on_checked_text, on_text};
use crate::document::Document;
use crate::form::{apply, button, colors, heading, icon_button, muted, row, section};

/// Edit the defaults of the remote links, dropping what ends up empty.
fn with_remote_defaults(p: &mut Project, f: impl FnOnce(&mut RemoteDefaults)) {
    let mut r = p.remote_defaults.take().unwrap_or_default();
    f(&mut r);
    if r.client.as_ref().is_some_and(|c| c.host.is_none()) {
        r.client = None;
    }
    if r.server.as_ref().is_some_and(|c| c.host.is_none()) {
        r.server = None;
    }
    p.remote_defaults = (!r.is_empty()).then_some(r);
}

impl InspectorPanel {
    /// Key/value metadata of an entity, `get`/`set` reaching it in the project.
    #[allow(clippy::too_many_arguments)]
    pub fn metadata(
        &mut self,
        key: &str,
        meta: &Metadata,
        doc: &Entity<Document>,
        window: &mut Window,
        cx: &mut Context<Self>,
        at: impl Fn(&mut Project) -> Option<&mut Metadata> + Clone + 'static,
    ) -> Div {
        let mut s = section(format!("Metadata ({})", meta.len()), {
            let (d, at) = (doc.clone(), at.clone());
            Some(
                icon_button(
                    SharedString::from(format!("{key}-meta-add")),
                    "+",
                    "Add metadata",
                    false,
                    move |_, cx| {
                        let at = at.clone();
                        apply(&d, cx, move |p| {
                            if let Some(m) = at(p) {
                                let k = unique_name("key", m.keys().map(String::as_str));
                                m.insert(k, String::new());
                            }
                        })
                    },
                )
                .into_any_element(),
            )
        });
        for (i, (k, v)) in meta.iter().enumerate() {
            let (k1, at1) = (k.clone(), at.clone());
            let name = self.fields.text(
                format!("{key}-meta-k{i}"),
                k,
                "key",
                window,
                cx,
                on_checked_text(
                    doc,
                    |_, v| v.is_empty().then(|| "A key is needed".to_string()),
                    move |p, v| {
                        if let Some(m) = at1(p)
                            && let Some(i) = m.get_index_of(&k1)
                            && !m.contains_key(&v)
                        {
                            let val = m[i].clone();
                            m.shift_remove(&k1);
                            m.shift_insert(i, v, val);
                        }
                    },
                ),
            );
            let (k2, at2) = (k.clone(), at.clone());
            let value = self.fields.text(
                format!("{key}-meta-v{i}"),
                v,
                "value",
                window,
                cx,
                on_text(doc, move |p, v| {
                    if let Some(m) = at2(p)
                        && let Some(x) = m.get_mut(&k2)
                    {
                        *x = v;
                    }
                }),
            );
            let (d, k3, at3) = (doc.clone(), k.clone(), at.clone());
            s = s.child(
                div()
                    .flex()
                    .gap_1()
                    .items_center()
                    .child(div().w(px(120.)).child(name))
                    .child(div().flex_1().child(value))
                    .child(icon_button(
                        SharedString::from(format!("{key}-meta-x{i}")),
                        "×",
                        "Remove",
                        true,
                        move |_, cx| {
                            let (k3, at3) = (k3.clone(), at3.clone());
                            apply(&d, cx, move |p| {
                                if let Some(m) = at3(p) {
                                    m.shift_remove(&k3);
                                }
                            })
                        },
                    )),
            );
        }
        s
    }

    pub(super) fn project(
        &mut self,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let name = self.fields.text(
            "project-name",
            &p.name,
            "Name",
            window,
            cx,
            on_text(doc, |p, v| p.name = v),
        );
        let description = self.fields.area(
            "project-description",
            &p.description,
            "Description",
            window,
            cx,
            on_text(doc, |p, v| p.description = v),
        );
        let metadata = self.metadata("project", &p.metadata, doc, window, cx, |p| Some(&mut p.metadata));

        // Constants.
        let own: Vec<_> = p
            .consts
            .iter()
            .filter(|c| c.dependency.is_none())
            .cloned()
            .collect();
        let d = doc.clone();
        let mut consts = section(
            format!("Constants ({})", own.len()),
            Some(
                icon_button("const-add", "+", "Add constant", false, move |_, cx| {
                    apply(&d, cx, |p| {
                        add_const(p);
                    })
                })
                .into_any_element(),
            ),
        );
        for c in &own {
            let cid = c.id.clone();
            let n = self.fields.text(
                format!("const-name-{}", c.id),
                &c.name,
                "name",
                window,
                cx,
                on_checked_text(
                    doc,
                    {
                        let cid = cid.clone();
                        move |p, v| {
                            name_error(
                                p,
                                &NameTarget::Const {
                                    id: Some(cid.clone()),
                                },
                                v,
                            )
                        }
                    },
                    {
                        let cid = cid.clone();
                        move |p, v| {
                            if let Some(c) = p.consts.iter_mut().find(|c| c.id == cid) {
                                c.name = v;
                            }
                        }
                    },
                ),
            );
            let ty = self.type_field(format!("const-type-{}", c.id), p, None, &c.ty, doc, window, cx, {
                let cid = cid.clone();
                move |p, t| {
                    if let Some(c) = p.consts.iter_mut().find(|c| c.id == cid) {
                        c.ty = t;
                    }
                }
            });
            let value = self.value_field(
                format!("const-value-{}", c.id),
                Some(&c.value),
                "value",
                doc,
                window,
                cx,
                {
                    let cid = cid.clone();
                    move |p, v| {
                        if let Some(c) = p.consts.iter_mut().find(|c| c.id == cid) {
                            c.value = v.unwrap_or(serde_json::json!(0));
                        }
                    }
                },
            );
            let d = doc.clone();
            consts = consts.child(
                div()
                    .flex()
                    .gap_1()
                    .items_center()
                    .child(div().w(px(110.)).child(n))
                    .child(div().w(px(90.)).child(ty))
                    .child(div().flex_1().child(value))
                    .child(icon_button(
                        SharedString::from(format!("const-x-{}", c.id)),
                        "×",
                        "Delete constant",
                        true,
                        move |_, cx| {
                            let cid = cid.clone();
                            apply(&d, cx, move |p| delete_const(p, &cid))
                        },
                    )),
            );
        }

        // Transports.
        let d = doc.clone();
        let mut transports = section(
            format!("Transports ({})", p.transports.len()),
            Some(
                icon_button("transport-add", "+", "Add transport", false, move |_, cx| {
                    apply(&d, cx, |p| {
                        let n = unique_name(
                            "transport",
                            TRANSPORTS
                                .iter()
                                .copied()
                                .chain(p.transports.iter().map(String::as_str)),
                        );
                        p.transports.push(n);
                    })
                })
                .into_any_element(),
            ),
        );
        for (i, tr) in p.transports.iter().enumerate() {
            let field = self.fields.text(
                format!("transport-{i}"),
                tr,
                "transport",
                window,
                cx,
                on_checked_text(
                    doc,
                    move |p, v| transport_error(p, v, Some(i)),
                    move |p, v| rename_transport(p, i, &v),
                ),
            );
            let d = doc.clone();
            transports = transports.child(
                div()
                    .flex()
                    .gap_1()
                    .items_center()
                    .child(div().flex_1().child(field))
                    .child(icon_button(
                        SharedString::from(format!("transport-x-{i}")),
                        "×",
                        "Remove transport",
                        true,
                        move |_, cx| {
                            apply(&d, cx, move |p| {
                                if i < p.transports.len() {
                                    p.transports.remove(i);
                                }
                            })
                        },
                    )),
            );
        }
        transports = transports.child(muted(format!(
            "Offered for remote links besides the built-in ones: {}.",
            TRANSPORTS.join(", ")
        )));

        // Remote defaults.
        let rd = p.remote_defaults.clone().unwrap_or_default();
        let client = self.fields.text(
            "remote-client",
            rd.client.as_ref().and_then(|c| c.host.as_deref()).unwrap_or(""),
            DEFAULT_HOST,
            window,
            cx,
            on_text(doc, |p, v| {
                with_remote_defaults(p, |r| {
                    r.client = Some(HostOnly {
                        host: (!v.is_empty()).then_some(v),
                    })
                })
            }),
        );
        let server = self.fields.text(
            "remote-server",
            rd.server.as_ref().and_then(|c| c.host.as_deref()).unwrap_or(""),
            DEFAULT_HOST,
            window,
            cx,
            on_text(doc, |p, v| {
                with_remote_defaults(p, |r| {
                    r.server = Some(HostOnly {
                        host: (!v.is_empty()).then_some(v),
                    })
                })
            }),
        );
        let d = doc.clone();
        let base = self.fields.number(
            "remote-base",
            rd.base_port.map(|x| x as f64),
            &DEFAULT_BASE_PORT.to_string(),
            true,
            window,
            cx,
            move |v, _, cx| {
                apply(&d, cx, |p| {
                    with_remote_defaults(p, |r| r.base_port = v.map(|x| x.max(1.) as u64))
                })
            },
        );

        // Binaries.
        let d = doc.clone();
        let mut binaries = section(
            format!("Binaries ({})", p.binaries.len()),
            Some(
                icon_button("binary-add", "+", "Add binary", false, move |_, cx| {
                    apply(&d, cx, |p| {
                        add_binary(p);
                    })
                })
                .into_any_element(),
            ),
        );
        for b in &p.binaries {
            let bid = b.id.clone();
            let name = self.fields.text(
                format!("binary-{}", b.id),
                &b.name,
                "name",
                window,
                cx,
                on_checked_text(
                    doc,
                    {
                        let bid = bid.clone();
                        move |p, v| binary_error(p, v, Some(&bid))
                    },
                    {
                        let bid = bid.clone();
                        move |p, v| {
                            if let Some(b) = p.binaries.iter_mut().find(|b| b.id == bid) {
                                b.name = v;
                            }
                        }
                    },
                ),
            );
            let count = p
                .modules
                .iter()
                .filter(|m| m.binary_id.as_ref() == Some(&b.id))
                .count();
            let (d, d2, bid2) = (doc.clone(), doc.clone(), bid.clone());
            binaries = binaries.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .pb_1()
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(div().flex_1().child(name))
                            .child(muted(format!("{count} modules")))
                            .child(icon_button(
                                SharedString::from(format!("binary-x-{}", b.id)),
                                "×",
                                "Remove binary",
                                true,
                                move |_, cx| {
                                    let bid = bid.clone();
                                    apply(&d, cx, move |p| delete_binary(p, &bid))
                                },
                            )),
                    )
                    .child(colors(
                        &format!("binary-color-{}", b.id),
                        b.color.as_deref(),
                        move |c, _, cx| {
                            let bid2 = bid2.clone();
                            apply(&d2, cx, move |p| {
                                if let Some(b) = p.binaries.iter_mut().find(|b| b.id == bid2) {
                                    b.color = c;
                                }
                            })
                        },
                    )),
            );
        }
        binaries = binaries.child(muted(
            "Executables the top-level modules are split into: each module names its own, and links between two binaries must be remote, with a transport.",
        ));

        let ws = self.ws.clone();
        let summary = section("Summary", None).child(muted(format!(
            "{} modules, {} links, {} types, {} interfaces, {} dependencies",
            p.modules.len(),
            p.links.len(),
            p.types.len(),
            p.interfaces.len(),
            p.dependencies.len()
        )));
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading("Project", None))
            .child(row("Name", name))
            .child(description)
            .child(metadata)
            .child(consts)
            .child(transports)
            .child(
                section("Remote defaults", None)
                    .child(row("Client host", client))
                    .child(row("Server host", server))
                    .child(row("Base port", base))
                    .child(muted(
                        "Addresses of the links between binaries without settings of their own: the n-th listens on port base + n.",
                    )),
            )
            .child(binaries)
            .child(summary)
            .child(div().pt_2().child(button("project-problems", "Show problems", move |window, cx| {
                ws.update(cx, |w, cx| w.run("window.problems", window, cx)).ok();
            })))
    }
}
