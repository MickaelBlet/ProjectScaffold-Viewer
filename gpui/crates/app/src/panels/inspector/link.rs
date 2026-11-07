//! Link inspector: name, ends, direction, acknowledgement, performance, remote transport and its
//! settings, color. Port of `LinkInspector.tsx`.

use std::rc::Rc;

use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::entities::{delete_link, reverse_link};
use scaffold_model::project::endpoint_label;
use scaffold_model::transports::{prune_settings, transport_fields};
use scaffold_model::types::*;
use serde_json::{Map, Value as Json};

use super::{InspectorPanel, on_checked_text, on_text};
use crate::document::{Document, Selection};
use crate::form::{self, apply, button, checkbox, colors, heading, muted, row, section};

fn on_link(id: Id, f: impl Fn(&mut Link) + 'static) -> impl Fn(&mut Project) + 'static {
    move |p| {
        if let Some(l) = p.links.iter_mut().find(|l| l.id == id) {
            f(l)
        }
    }
}

/// Settings of a link's transport as JSON, edited field by field.
fn settings_json(l: &Link) -> Map<String, Json> {
    match l.constraints.remote.settings.as_ref().map(serde_json::to_value) {
        Some(Ok(Json::Object(o))) => o,
        _ => Map::new(),
    }
}

/// Set a field (`path`: one key, or a key and a sub key) of a link's transport settings.
fn set_setting(l: &mut Link, path: &[&str], value: Option<Json>) {
    let mut o = settings_json(l);
    match path {
        [k] => match value {
            Some(v) => {
                o.insert(k.to_string(), v);
            }
            None => {
                o.remove(*k);
            }
        },
        [k, sub] => {
            let mut inner = match o.remove(*k) {
                Some(Json::Object(m)) => m,
                _ => Map::new(),
            };
            match value {
                Some(v) => {
                    inner.insert(sub.to_string(), v);
                }
                None => {
                    inner.remove(*sub);
                }
            }
            if !inner.is_empty() {
                o.insert(k.to_string(), Json::Object(inner));
            }
        }
        _ => {}
    }
    let s: Option<TransportSettings> = serde_json::from_value(Json::Object(o)).ok();
    let t = l.constraints.remote.transport.clone();
    l.constraints.remote.settings = prune_settings(s.as_ref(), t.as_deref());
}

const NUMBERS: &[&str] = &["capacity", "maxMessages", "messageSize", "id", "baud"];

impl InspectorPanel {
    pub(super) fn link(
        &mut self,
        id: &Id,
        doc: &Entity<Document>,
        p: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(l) = p.links.iter().find(|l| &l.id == id).cloned() else {
            return muted("Link deleted.");
        };
        let lid = l.id.clone();
        let k = |s: &str| format!("link-{s}-{lid}");
        let name = self.fields.text(
            k("name"),
            &l.name,
            "Name",
            window,
            cx,
            on_checked_text(
                doc,
                {
                    let lid = lid.clone();
                    move |p, v| {
                        if !scaffold_model::project::is_identifier(v) {
                            Some("Must be an identifier".into())
                        } else if p.links.iter().any(|x| x.id != lid && x.name == v) {
                            Some(format!("A link named '{v}' already exists"))
                        } else {
                            None
                        }
                    }
                },
                {
                    let lid = lid.clone();
                    move |p, v| on_link(lid.clone(), move |l| l.name = v.clone())(p)
                },
            ),
        );
        let description = self.fields.area(
            k("desc"),
            &l.description,
            "Description",
            window,
            cx,
            on_text(doc, {
                let lid = lid.clone();
                move |p, v| on_link(lid.clone(), move |l| l.description = v.clone())(p)
            }),
        );
        let all_paths = scaffold_model::project::project_module_paths(p);
        let end = |e: &Endpoint| endpoint_label(p, &all_paths, e);
        let ends = |e: Endpoint| {
            let d = doc.clone();
            form::link(
                SharedString::from(format!("end-{}-{}", lid, e.port_id)),
                end(&e),
                move |_, cx| {
                    let sel = Selection::Module {
                        id: e.module_id.clone(),
                        member: None,
                    };
                    d.update(cx, |d, cx| {
                        d.select_entity(Some(sel.clone()));
                        cx.notify();
                    })
                },
            )
        };
        let c = l.constraints.clone();
        let (d, l2) = (doc.clone(), lid.clone());
        let direction = form::select(
            k("dir"),
            c.direction.as_str(),
            Direction::ALL
                .iter()
                .map(|x| (x.as_str().into(), x.as_str().into()))
                .collect(),
            move |v, _, cx| {
                let dir = Direction::parse(&v).unwrap_or(Direction::Unidirectional);
                apply(
                    &d,
                    cx,
                    on_link(l2.clone(), move |l| l.constraints.direction = dir),
                )
            },
        );
        let (d, l2) = (doc.clone(), lid.clone());
        let ack = checkbox(k("ack"), "Acknowledged", c.ack.required, move |v, _, cx| {
            apply(
                &d,
                cx,
                on_link(l2.clone(), move |l| l.constraints.ack.required = v),
            )
        });
        let ack_timeout = c.ack.required.then(|| {
            let (d, l2) = (doc.clone(), lid.clone());
            self.fields.number(
                k("ackto"),
                c.ack.timeout_ms,
                "none",
                false,
                window,
                cx,
                move |v, _, cx| {
                    apply(
                        &d,
                        cx,
                        on_link(l2.clone(), move |l| l.constraints.ack.timeout_ms = v),
                    )
                },
            )
        });
        let (d, l2) = (doc.clone(), lid.clone());
        let class = form::select(
            k("class"),
            c.performance.class.as_str(),
            PerformanceClass::ALL
                .iter()
                .map(|x| (x.as_str().into(), x.as_str().into()))
                .collect(),
            move |v, _, cx| {
                let pc = PerformanceClass::parse(&v).unwrap_or(PerformanceClass::Normal);
                apply(
                    &d,
                    cx,
                    on_link(l2.clone(), move |l| l.constraints.performance.class = pc),
                )
            },
        );
        let (d, l2) = (doc.clone(), lid.clone());
        let latency = self.fields.number(
            k("lat"),
            c.performance.max_latency_ms,
            "none",
            false,
            window,
            cx,
            move |v, _, cx| {
                apply(
                    &d,
                    cx,
                    on_link(l2.clone(), move |l| l.constraints.performance.max_latency_ms = v),
                )
            },
        );
        let (d, l2) = (doc.clone(), lid.clone());
        let rate = self.fields.number(
            k("rate"),
            c.performance.rate_hz,
            "none",
            false,
            window,
            cx,
            move |v, _, cx| {
                apply(
                    &d,
                    cx,
                    on_link(l2.clone(), move |l| l.constraints.performance.rate_hz = v),
                )
            },
        );

        // Remote: transport and its settings.
        let (d, l2) = (doc.clone(), lid.clone());
        let remote = checkbox(
            k("remote"),
            "Remote (between binaries)",
            c.remote.enabled,
            move |v, _, cx| {
                apply(
                    &d,
                    cx,
                    on_link(l2.clone(), move |l| {
                        l.constraints.remote.enabled = v;
                        if !v {
                            l.constraints.remote.transport = None;
                            l.constraints.remote.settings = None;
                        }
                    }),
                )
            },
        );
        let mut remote_rows = div().flex().flex_col().gap_1();
        if c.remote.enabled {
            let options: Vec<(String, String)> = std::iter::once((String::new(), "(none)".to_string()))
                .chain(TRANSPORTS.iter().map(|t| (t.to_string(), t.to_string())))
                .chain(p.transports.iter().map(|t| (t.clone(), format!("{t} (custom)"))))
                .collect();
            let (d, l2) = (doc.clone(), lid.clone());
            remote_rows = remote_rows.child(row(
                "Transport",
                form::select(
                    k("transport"),
                    c.remote.transport.as_deref().unwrap_or(""),
                    options,
                    move |v, _, cx| {
                        let t = (!v.is_empty()).then_some(v);
                        apply(
                            &d,
                            cx,
                            on_link(l2.clone(), move |l| {
                                l.constraints.remote.transport = t.clone();
                                let s = l.constraints.remote.settings.clone();
                                l.constraints.remote.settings = prune_settings(s.as_ref(), t.as_deref());
                            }),
                        )
                    },
                ),
            ));
            let json = settings_json(&l);
            for f in transport_fields(c.remote.transport.as_deref()) {
                let f: &'static str = f;
                if matches!(f, "client" | "server" | "broker") {
                    for sub in ["host", "port"] {
                        let v = json.get(f).and_then(|o| o.get(sub));
                        let shown = v
                            .map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()))
                            .unwrap_or_default();
                        let l2 = lid.clone();
                        let field = self
                            .fields
                            .text(k(&format!("s-{f}-{sub}")), &shown, sub, window, cx, {
                                let d = doc.clone();
                                move |v, _, cx| {
                                    let v = v.trim().to_string();
                                    let value = if v.is_empty() {
                                        None
                                    } else if sub == "port" {
                                        match v.parse::<u64>() {
                                            Ok(n) => Some(Json::from(n)),
                                            Err(_) => return Some("A port number is expected".into()),
                                        }
                                    } else {
                                        Some(Json::from(v))
                                    };
                                    apply(
                                        &d,
                                        cx,
                                        on_link(l2.clone(), move |l| {
                                            set_setting(l, &[f, sub], value.clone())
                                        }),
                                    );
                                    None
                                }
                            });
                        remote_rows = remote_rows.child(row(format!("{f} {sub}"), field));
                    }
                } else {
                    let v = json.get(f);
                    let shown = v
                        .map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()))
                        .unwrap_or_default();
                    let l2 = lid.clone();
                    let number = NUMBERS.contains(&f);
                    let field = self.fields.text(k(&format!("s-{f}")), &shown, f, window, cx, {
                        let d = doc.clone();
                        move |v, _, cx| {
                            let v = v.trim().to_string();
                            let value = if v.is_empty() {
                                None
                            } else if number {
                                match v.parse::<u64>() {
                                    Ok(n) => Some(Json::from(n)),
                                    Err(_) => return Some("An integer is expected".into()),
                                }
                            } else {
                                Some(Json::from(v))
                            };
                            apply(
                                &d,
                                cx,
                                on_link(l2.clone(), move |l| set_setting(l, &[f], value.clone())),
                            );
                            None
                        }
                    });
                    remote_rows = remote_rows.child(row(f.to_string(), field));
                }
            }
        }

        let (d, l2) = (doc.clone(), lid.clone());
        let color = colors(&k("color"), l.color.as_deref(), move |col, _, cx| {
            apply(&d, cx, on_link(l2.clone(), move |l| l.color = col.clone()))
        });
        let (d, d2, l2, l3) = (doc.clone(), doc.clone(), lid.clone(), lid.clone());
        let _ = Rc::new(());
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading(l.name.clone(), Some("link".into())))
            .child(row("Name", name))
            .child(row("From", ends(l.from.clone())))
            .child(row("To", ends(l.to.clone())))
            .child(description)
            .child(
                section("Constraints", None)
                    .child(row("Direction", direction))
                    .child(ack)
                    .children(ack_timeout.map(|f| row("Timeout (ms)", f)))
                    .child(row("Performance", class))
                    .child(row("Max latency (ms)", latency))
                    .child(row("Rate (Hz)", rate)),
            )
            .child(
                section("Remote", None)
                    .child(remote)
                    .when(c.remote.enabled, |s| s.child(remote_rows)),
            )
            .child(section("Color", None).child(color))
            .child(
                div()
                    .flex()
                    .gap_1()
                    .pt_2()
                    .child(button(k("reverse"), "Reverse", move |_, cx| {
                        let l2 = l2.clone();
                        apply(&d, cx, move |p| reverse_link(p, &l2))
                    }))
                    .child(button(k("delete"), "Delete link", move |_, cx| {
                        let l3 = l3.clone();
                        apply(&d2, cx, move |p| delete_link(p, &l3))
                    })),
            )
    }
}
