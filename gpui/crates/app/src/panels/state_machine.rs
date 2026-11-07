//! State machine of the selected module: states and transitions, edited as lists. Port of
//! `StateMachinePanel.tsx` / `StateMachineSection.tsx` (as lists; the diagram comes later).

use std::rc::Rc;

use gpui_kit::*;
use scaffold_model::project::{new_id, unique_name};
use scaffold_model::types::*;

use crate::document::Selection;
use crate::form::{self, Fields, apply, checkbox, heading, icon_button, muted, row, section};
use crate::theme;
use crate::workspace::Workspace;

pub struct StateMachinePanel {
    pub ws: WeakEntity<Workspace>,
    fields: Fields,
}

impl StateMachinePanel {
    pub fn new(ws: WeakEntity<Workspace>) -> Self {
        StateMachinePanel {
            ws,
            fields: Fields::default(),
        }
    }
}

fn on_machine(id: Id, f: impl Fn(&mut StateMachine) + 'static) -> impl Fn(&mut Project) + 'static {
    move |p| {
        if let Some(sm) = p
            .modules
            .iter_mut()
            .find(|m| m.id == id)
            .and_then(|m| m.state_machine.as_mut())
        {
            f(sm)
        }
    }
}

impl Render for StateMachinePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current();
        let doc = self.ws.upgrade().and_then(|w| w.read(cx).doc());
        let Some(doc) = doc else {
            return div()
                .p_2()
                .text_sm()
                .text_color(t.muted)
                .child("No document.")
                .into_any_element();
        };
        let (p, sel) = {
            let d = doc.read(cx);
            (d.project.clone(), d.selection.clone())
        };
        let Some(Selection::Module { id, .. }) = sel else {
            return div()
                .p_2()
                .text_sm()
                .text_color(t.muted)
                .child("Select a module.")
                .into_any_element();
        };
        let Some(m) = p.modules.iter().find(|m| m.id == id).cloned() else {
            return div().into_any_element();
        };
        self.fields.begin();
        let mid = m.id.clone();
        let body = match &m.state_machine {
            None => {
                let (d, mid) = (doc.clone(), mid.clone());
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(muted("This module has no state machine."))
                    .child(form::button("sm-add", "Add a state machine", move |_, cx| {
                        let mid = mid.clone();
                        apply(&d, cx, move |p| {
                            if let Some(m) = p.modules.iter_mut().find(|m| m.id == mid) {
                                let s = new_id();
                                m.state_machine = Some(StateMachine {
                                    initial: Some(s.clone()),
                                    states: vec![State {
                                        id: s,
                                        name: "Idle".into(),
                                        description: String::new(),
                                        entry: None,
                                        exit: None,
                                        r#final: false,
                                    }],
                                    transitions: vec![],
                                });
                            }
                        })
                    }))
            }
            Some(sm) => {
                let state_options: Vec<(String, String)> =
                    sm.states.iter().map(|s| (s.id.clone(), s.name.clone())).collect();
                let method_options: Vec<(String, String)> =
                    std::iter::once((String::new(), "(none)".to_string()))
                        .chain(m.methods.iter().map(|x| (x.id.clone(), x.name.clone())))
                        .collect();
                let (d, mid2) = (doc.clone(), mid.clone());
                let initial = form::select(
                    "sm-initial",
                    sm.initial.as_deref().unwrap_or(""),
                    state_options.clone(),
                    move |v, _, cx| {
                        apply(
                            &d,
                            cx,
                            on_machine(mid2.clone(), move |sm| sm.initial = Some(v.clone())),
                        )
                    },
                );
                let (d, mid2) = (doc.clone(), mid.clone());
                let mut states = form::section(
                    format!("States ({})", sm.states.len()),
                    Some(
                        icon_button("sm-state-add", "+", "Add state", false, move |_, cx| {
                            apply(
                                &d,
                                cx,
                                on_machine(mid2.clone(), |sm| {
                                    let n = unique_name("State", sm.states.iter().map(|s| s.name.as_str()));
                                    sm.states.push(State {
                                        id: new_id(),
                                        name: n,
                                        description: String::new(),
                                        entry: None,
                                        exit: None,
                                        r#final: false,
                                    })
                                }),
                            )
                        })
                        .into_any_element(),
                    ),
                );
                for s in &sm.states {
                    let sid = s.id.clone();
                    let on_state = {
                        let (mid, sid) = (mid.clone(), sid.clone());
                        move |g: Rc<dyn Fn(&mut State)>| {
                            let sid = sid.clone();
                            on_machine(mid.clone(), move |sm| {
                                if let Some(s) = sm.states.iter_mut().find(|s| s.id == sid) {
                                    g(s)
                                }
                            })
                        }
                    };
                    let os = on_state.clone();
                    let d = doc.clone();
                    let name = self.fields.text(
                        format!("sm-s-{sid}"),
                        &s.name,
                        "name",
                        window,
                        cx,
                        move |v, _, cx| {
                            apply(&d, cx, os(Rc::new(move |s| s.name = v.clone())));
                            None
                        },
                    );
                    let (os, d) = (on_state.clone(), doc.clone());
                    let entry = form::select(
                        SharedString::from(format!("sm-entry-{sid}")),
                        s.entry.as_deref().unwrap_or(""),
                        method_options.clone(),
                        move |v, _, cx| {
                            let e = (!v.is_empty()).then_some(v);
                            apply(&d, cx, os(Rc::new(move |s| s.entry = e.clone())))
                        },
                    );
                    let (os, d) = (on_state.clone(), doc.clone());
                    let exit = form::select(
                        SharedString::from(format!("sm-exit-{sid}")),
                        s.exit.as_deref().unwrap_or(""),
                        method_options.clone(),
                        move |v, _, cx| {
                            let e = (!v.is_empty()).then_some(v);
                            apply(&d, cx, os(Rc::new(move |s| s.exit = e.clone())))
                        },
                    );
                    let (os, d) = (on_state.clone(), doc.clone());
                    let fin = checkbox(
                        SharedString::from(format!("sm-final-{sid}")),
                        "final",
                        s.r#final,
                        move |v, _, cx| apply(&d, cx, os(Rc::new(move |s| s.r#final = v))),
                    );
                    let (d, mid2, s2) = (doc.clone(), mid.clone(), sid.clone());
                    states = states.child(
                        div()
                            .flex()
                            .gap_1()
                            .items_center()
                            .child(div().w(px(120.)).child(name))
                            .child(muted("entry"))
                            .child(entry)
                            .child(muted("exit"))
                            .child(exit)
                            .child(fin)
                            .child(icon_button(
                                SharedString::from(format!("sm-sx-{sid}")),
                                "×",
                                "Delete state",
                                true,
                                move |_, cx| {
                                    let s2 = s2.clone();
                                    apply(
                                        &d,
                                        cx,
                                        on_machine(mid2.clone(), move |sm| {
                                            sm.states.retain(|s| s.id != s2);
                                            sm.transitions.retain(|t| t.from != s2 && t.to != s2);
                                            if sm.initial.as_ref() == Some(&s2) {
                                                sm.initial = sm.states.first().map(|s| s.id.clone());
                                            }
                                        }),
                                    )
                                },
                            )),
                    );
                }
                let (d, mid2) = (doc.clone(), mid.clone());
                let first = sm.states.first().map(|s| s.id.clone());
                let mut transitions = section(
                    format!("Transitions ({})", sm.transitions.len()),
                    Some(
                        icon_button("sm-tr-add", "+", "Add transition", false, move |_, cx| {
                            let Some(first) = first.clone() else { return };
                            apply(
                                &d,
                                cx,
                                on_machine(mid2.clone(), move |sm| {
                                    sm.transitions.push(Transition {
                                        id: new_id(),
                                        from: first.clone(),
                                        to: first.clone(),
                                        trigger: None,
                                        guard: None,
                                        action: None,
                                    })
                                }),
                            )
                        })
                        .into_any_element(),
                    ),
                );
                for tr in &sm.transitions {
                    let tid = tr.id.clone();
                    let on_tr = {
                        let (mid, tid) = (mid.clone(), tid.clone());
                        move |g: Rc<dyn Fn(&mut Transition)>| {
                            let tid = tid.clone();
                            on_machine(mid.clone(), move |sm| {
                                if let Some(t) = sm.transitions.iter_mut().find(|t| t.id == tid) {
                                    g(t)
                                }
                            })
                        }
                    };
                    let pick = |key: &str,
                                cur: Option<&str>,
                                opts: Vec<(String, String)>,
                                set: fn(&mut Transition, Option<String>)| {
                        let (ot, d) = (on_tr.clone(), doc.clone());
                        form::select(
                            SharedString::from(format!("sm-{key}-{tid}")),
                            cur.unwrap_or(""),
                            opts,
                            move |v, _, cx| {
                                let x = (!v.is_empty()).then_some(v);
                                apply(&d, cx, ot(Rc::new(move |t| set(t, x.clone()))))
                            },
                        )
                    };
                    let from = pick("from", Some(&tr.from), state_options.clone(), |t, v| {
                        if let Some(v) = v {
                            t.from = v
                        }
                    });
                    let to = pick("to", Some(&tr.to), state_options.clone(), |t, v| {
                        if let Some(v) = v {
                            t.to = v
                        }
                    });
                    let trigger = pick("trig", tr.trigger.as_deref(), method_options.clone(), |t, v| {
                        t.trigger = v
                    });
                    let action = pick("act", tr.action.as_deref(), method_options.clone(), |t, v| {
                        t.action = v
                    });
                    let (ot, d) = (on_tr.clone(), doc.clone());
                    let guard = self.fields.text(
                        format!("sm-guard-{tid}"),
                        tr.guard.as_deref().unwrap_or(""),
                        "guard",
                        window,
                        cx,
                        move |v, _, cx| {
                            let g = (!v.trim().is_empty()).then(|| v.trim().to_string());
                            apply(&d, cx, ot(Rc::new(move |t| t.guard = g.clone())));
                            None
                        },
                    );
                    let (d, mid2, t2) = (doc.clone(), mid.clone(), tid.clone());
                    transitions = transitions.child(
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
                                    .child(from)
                                    .child("→")
                                    .child(to)
                                    .child(div().flex_1())
                                    .child(icon_button(
                                        SharedString::from(format!("sm-tx-{tid}")),
                                        "×",
                                        "Delete transition",
                                        true,
                                        move |_, cx| {
                                            let t2 = t2.clone();
                                            apply(
                                                &d,
                                                cx,
                                                on_machine(mid2.clone(), move |sm| {
                                                    sm.transitions.retain(|t| t.id != t2)
                                                }),
                                            )
                                        },
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap_1()
                                    .items_center()
                                    .child(muted("on"))
                                    .child(trigger)
                                    .child(muted("do"))
                                    .child(action),
                            )
                            .child(row("Guard", guard)),
                    );
                }
                let (d, mid2) = (doc.clone(), mid.clone());
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(row("Initial", initial))
                    .child(states)
                    .child(transitions)
                    .child(form::button(
                        "sm-remove",
                        "Remove the state machine",
                        move |_, cx| {
                            let mid2 = mid2.clone();
                            apply(&d, cx, move |p| {
                                if let Some(m) = p.modules.iter_mut().find(|m| m.id == mid2) {
                                    m.state_machine = None
                                }
                            })
                        },
                    ))
            }
        };
        self.fields.end();
        div()
            .id("state-machine")
            .size_full()
            .overflow_y_scroll()
            .p_2()
            .text_sm()
            .child(heading(m.name.clone(), Some("state machine".into())))
            .child(body)
            .into_any_element()
    }
}
