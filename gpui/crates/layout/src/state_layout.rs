//! Layout of a module's state machine: states left to right, transitions routed between them.
//! Port of `model/stateLayout.ts`, with the own layered layout in place of ELK.

use std::collections::HashSet;

use scaffold_model::types::*;

use crate::layered::{Edge, Params, layered};

#[derive(Clone, Debug, PartialEq)]
pub struct StateBox {
    /// A state id, or `INITIAL` for the dot the machine starts from.
    pub id: Id,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TransitionLabel {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TransitionPath {
    /// A transition id, or `INITIAL` for the arrow to the initial state.
    pub id: Id,
    pub from: Id,
    pub to: Id,
    pub points: Vec<Point>,
    pub label: Option<TransitionLabel>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StateLayout {
    /// Size of the whole diagram, transitions included.
    pub width: f64,
    pub height: f64,
    pub states: Vec<StateBox>,
    pub transitions: Vec<TransitionPath>,
}

pub const INITIAL: &str = "__initial__";
pub const STATE_HEADER: f64 = 28.;
pub const STATE_LINE: f64 = 15.;
const LABEL_HEIGHT: f64 = 16.;
const DOT: f64 = 14.;
const PADDING: f64 = 20.;

/// Approximate width of a text in the diagram's font.
pub fn text_width(text: &str) -> f64 {
    (text.chars().count() as f64 * 6.8).ceil()
}

fn method_name(m: &Module, id: &str) -> String {
    m.methods
        .iter()
        .find(|x| x.id == id)
        .map_or_else(|| "?".to_string(), |x| x.name.clone())
}

/// `trigger [guard] / action`, as UML writes a transition.
pub fn transition_text(m: &Module, t: &Transition) -> String {
    let name = |id: &Option<Id>| id.as_deref().filter(|s| !s.is_empty()).map(|s| method_name(m, s));
    let guard = t.guard.as_deref().map(str::trim).filter(|g| !g.is_empty());
    [
        name(&t.trigger),
        guard.map(|g| format!("[{g}]")),
        name(&t.action).map(|a| format!("/ {a}()")),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

/// Lines below the name of a state: `entry / reset()`, `exit / save()`.
pub fn state_lines(m: &Module, entry: Option<&str>, exit: Option<&str>) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(e) = entry.filter(|s| !s.is_empty()) {
        lines.push(format!("entry / {}()", method_name(m, e)));
    }
    if let Some(e) = exit.filter(|s| !s.is_empty()) {
        lines.push(format!("exit / {}()", method_name(m, e)));
    }
    lines
}

/// Lays out the state machine of `m`.
pub fn layout_state_machine(m: &Module) -> StateLayout {
    let Some(sm) = m.state_machine.as_ref().filter(|sm| !sm.states.is_empty()) else {
        return StateLayout::default();
    };
    let ids: HashSet<&str> = sm.states.iter().map(|s| s.id.as_str()).collect();
    let mut nodes: Vec<(Id, f64, f64)> = Vec::new();
    let mut edges: Vec<(Id, usize, usize, Option<String>)> = Vec::new();
    let initial = sm.initial.as_deref().filter(|i| ids.contains(i));
    if initial.is_some() {
        nodes.push((INITIAL.to_string(), DOT, DOT));
    }
    let base = nodes.len();
    for s in &sm.states {
        let lines = state_lines(m, s.entry.as_deref(), s.exit.as_deref());
        let width = std::iter::once(&s.name)
            .chain(lines.iter())
            .map(|l| text_width(l) + 24.)
            .fold(90., f64::max);
        let height = STATE_HEADER + lines.len() as f64 * STATE_LINE + if lines.is_empty() { 0. } else { 6. };
        nodes.push((s.id.clone(), width, height));
    }
    let index = |id: &str| nodes.iter().position(|n| n.0 == id).unwrap_or(0);
    if let Some(i) = initial {
        edges.push((INITIAL.to_string(), 0, index(i), None));
    }
    for t in &sm.transitions {
        if ids.contains(t.from.as_str()) && ids.contains(t.to.as_str()) {
            let text = transition_text(m, t);
            edges.push((
                t.id.clone(),
                index(&t.from),
                index(&t.to),
                (!text.is_empty()).then_some(text),
            ));
        }
    }
    debug_assert!(base <= 1);

    let sizes: Vec<(f64, f64)> = nodes.iter().map(|n| (n.1, n.2)).collect();
    let engine: Vec<Edge> = edges
        .iter()
        .map(|(_, a, b, text)| Edge {
            label: text.as_deref().map_or(0., |t| text_width(t) + 8.),
            ..Edge::new(*a, *b, sizes[*a].1 / 2., sizes[*b].1 / 2.)
        })
        .collect();
    let placed = layered(
        &sizes,
        &engine,
        &Params {
            vertical: false,
            node_gap: 40.,
            layer_gap: 70.,
            edge_gap: 10.,
        },
    );

    let states: Vec<StateBox> = nodes
        .iter()
        .zip(&placed.pos)
        .map(|((id, w, h), at)| StateBox {
            id: id.clone(),
            x: at.x,
            y: at.y,
            width: *w,
            height: *h,
        })
        .collect();
    let mut transitions = Vec::new();
    for (i, (id, a, b, text)) in edges.iter().enumerate() {
        let mut points = placed.routes[i].clone();
        let mut anchor = placed.anchors[i];
        let mut label_y = None;
        if a == b {
            // A loop above the state.
            let s = &states[*a];
            let mid = s.x + s.width / 2.;
            let top = s.y - 22.;
            points = vec![
                Point { x: mid - 12., y: s.y },
                Point { x: mid - 12., y: top },
                Point { x: mid + 12., y: top },
                Point { x: mid + 12., y: s.y },
            ];
            anchor = Point { x: mid, y: top };
            label_y = Some(top - LABEL_HEIGHT - 4.);
        }
        let label = text.as_ref().map(|t| {
            let width = text_width(t) + 8.;
            TransitionLabel {
                text: t.clone(),
                x: anchor.x - width / 2.,
                y: label_y.unwrap_or(anchor.y - LABEL_HEIGHT - 4.),
                width,
            }
        });
        transitions.push(TransitionPath {
            id: id.clone(),
            from: nodes[*a].0.clone(),
            to: nodes[*b].0.clone(),
            points,
            label,
        });
    }

    // Padding around everything drawn, labels and loops included.
    let (mut lo_x, mut lo_y, mut hi_x, mut hi_y) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut grow = |x0: f64, y0: f64, x1: f64, y1: f64| {
        lo_x = lo_x.min(x0);
        lo_y = lo_y.min(y0);
        hi_x = hi_x.max(x1);
        hi_y = hi_y.max(y1);
    };
    for s in &states {
        grow(s.x, s.y, s.x + s.width, s.y + s.height);
    }
    for t in &transitions {
        for p in &t.points {
            grow(p.x, p.y, p.x, p.y);
        }
        if let Some(l) = &t.label {
            grow(l.x, l.y, l.x + l.width, l.y + LABEL_HEIGHT);
        }
    }
    let (dx, dy) = (PADDING - lo_x, PADDING - lo_y);
    let states = states
        .into_iter()
        .map(|s| StateBox {
            x: s.x + dx,
            y: s.y + dy,
            ..s
        })
        .collect();
    let transitions = transitions
        .into_iter()
        .map(|t| TransitionPath {
            points: t
                .points
                .iter()
                .map(|p| Point {
                    x: p.x + dx,
                    y: p.y + dy,
                })
                .collect(),
            label: t.label.map(|l| TransitionLabel {
                x: l.x + dx,
                y: l.y + dy,
                ..l
            }),
            ..t
        })
        .collect();
    StateLayout {
        width: hi_x - lo_x + 2. * PADDING,
        height: hi_y - lo_y + 2. * PADDING,
        states,
        transitions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn method(id: &str, name: &str) -> Method {
        Method {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            params: vec![],
            returns: None,
            raises: None,
            qualifiers: Qualifiers::default(),
            pre: None,
            post: None,
            access: None,
        }
    }

    fn state(id: &str, name: &str) -> State {
        State {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            entry: None,
            exit: None,
            r#final: false,
        }
    }

    fn transition(id: &str, from: &str, to: &str) -> Transition {
        Transition {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            trigger: None,
            guard: None,
            action: None,
        }
    }

    fn machine() -> Module {
        let mut m = blank();
        m.methods = vec![method("m1", "start"), method("m2", "reset")];
        let mut a = state("a", "Idle");
        a.entry = Some("m2".into());
        let mut t1 = transition("t1", "a", "b");
        t1.trigger = Some("m1".into());
        t1.guard = Some(" ready ".into());
        let mut t3 = transition("t3", "b", "b");
        t3.action = Some("m2".into());
        m.state_machine = Some(StateMachine {
            initial: Some("a".into()),
            states: vec![a, state("b", "Busy"), state("c", "Done")],
            transitions: vec![t1, transition("t2", "b", "a"), t3, transition("t4", "b", "c")],
        });
        m
    }

    fn blank() -> Module {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "M", "description": "", "parentId": null, "metadata": {},
            "attributes": [], "methods": [], "ports": [],
            "layout": {"x": 0, "y": 0, "width": 0, "height": 0}
        }))
        .unwrap()
    }

    #[test]
    fn formats_transitions_and_states() {
        let m = machine();
        let sm = m.state_machine.as_ref().unwrap();
        assert_eq!(transition_text(&m, &sm.transitions[0]), "start [ready]");
        assert_eq!(transition_text(&m, &sm.transitions[2]), "/ reset()");
        assert_eq!(state_lines(&m, Some("m2"), None), vec!["entry / reset()"]);
    }

    #[test]
    fn lays_states_left_to_right() {
        let m = machine();
        let l = layout_state_machine(&m);
        let at = |id: &str| l.states.iter().find(|s| s.id == id).unwrap();
        assert_eq!(l.states[0].id, INITIAL);
        assert_eq!(l.transitions[0].id, INITIAL);
        assert!(at("a").x > at(INITIAL).x + DOT);
        assert!(at("b").x > at("a").x + at("a").width);
        assert!(at("c").x > at("b").x + at("b").width);
        for s in &l.states {
            assert!(s.x >= PADDING && s.y >= PADDING);
            assert!(s.x + s.width <= l.width && s.y + s.height <= l.height);
        }
        // Idle has an entry line.
        assert_eq!(at("a").height, STATE_HEADER + STATE_LINE + 6.);
        for t in &l.transitions {
            assert!(t.points.len() >= 2, "{}", t.id);
            assert_eq!(t.label.is_some(), ["t1", "t3"].contains(&t.id.as_str()));
        }
        // The loop stays above its state.
        let b = at("b");
        let t3 = l.transitions.iter().find(|t| t.id == "t3").unwrap();
        assert!(t3.points.iter().all(|p| p.y <= b.y));
        // The back edge ends on the initial state's neighbor, going left.
        let t2 = l.transitions.iter().find(|t| t.id == "t2").unwrap();
        assert!(t2.points.first().unwrap().x > t2.points.last().unwrap().x);
    }

    #[test]
    fn empty_machine_has_no_layout() {
        assert_eq!(layout_state_machine(&blank()), StateLayout::default());
    }
}
