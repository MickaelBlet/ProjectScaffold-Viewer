//! Text of the module nodes as `ModuleNode.tsx` writes it: header, attribute and method compartments.

use scaffold_model::defaults::format_value;
use scaffold_model::project::*;
use scaffold_model::typeexpr::print_type_ref;
use scaffold_model::types::*;

/// A run of text and how it is styled.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub text: String,
    pub style: RunStyle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStyle {
    Normal,
    /// Stereotypes, bases: muted, not bold.
    Muted,
    /// Qualifiers: accent, italic.
    Qualifier,
    /// Default values: accent.
    Default,
    /// Types: muted.
    Type,
    /// Name of an abstract or interface module, of a pure method: italic.
    Italic,
}

fn run(text: impl Into<String>, style: RunStyle) -> Run {
    Run {
        text: text.into(),
        style,
    }
}

/// Header of a module: stereotypes, name, type parameters, final, derives, bases, interfaces.
pub fn header(p: &Project, m: &Module) -> (Vec<Run>, Option<(String, Option<String>)>) {
    let mut out = Vec::new();
    let kinds: Vec<&str> = [m.kind.map(|k| k.as_str()), m.instantiation.map(|i| i.as_str())]
        .into_iter()
        .flatten()
        .collect();
    if !kinds.is_empty() {
        out.push(run(format!("«{}» ", kinds.join(", ")), RunStyle::Muted));
    }
    let italic = matches!(m.kind, Some(ModuleKind::Abstract | ModuleKind::Interface));
    out.push(run(
        m.name.clone(),
        if italic {
            RunStyle::Italic
        } else {
            RunStyle::Normal
        },
    ));
    let params: Vec<String> = type_params_of(p, &m.id).iter().map(|t| t.name.clone()).collect();
    if !params.is_empty() {
        out.push(run(format!("<{}>", params.join(", ")), RunStyle::Muted));
    }
    if m.r#final {
        out.push(run(" {final}", RunStyle::Muted));
    }
    if let Some(d) = m.derives.as_ref().filter(|d| !d.is_empty()) {
        out.push(run(
            format!(
                " {{{}}}",
                d.iter().map(|x| x.label()).collect::<Vec<_>>().join(", ")
            ),
            RunStyle::Muted,
        ));
    }
    let bases: Vec<String> = m
        .bases
        .iter()
        .flatten()
        .map(|b| {
            let name = match find_imported(p, b) {
                Some((dep, im)) => format!("{}/{}", dep.name, im.path.rsplit('.').next().unwrap_or("")),
                None => find_module(p, b).map_or("?".into(), |x| x.name.clone()),
            };
            match m
                .base_args
                .as_ref()
                .and_then(|a| a.get(b))
                .filter(|a| !a.is_empty())
            {
                Some(args) => {
                    let scope = type_scope(p, Some(&m.id));
                    let args: Vec<String> = args
                        .iter()
                        .map(|a| print_type_ref(a, |id| scope.name_of(id)))
                        .collect();
                    format!("{name}<{}>", args.join(", "))
                }
                None => name,
            }
        })
        .collect();
    if !bases.is_empty() {
        out.push(run(format!(" : {}", bases.join(", ")), RunStyle::Muted));
    }
    let implemented: Vec<String> = m
        .implements
        .iter()
        .flatten()
        .map(|i| {
            p.interfaces
                .iter()
                .find(|x| &x.id == i)
                .map_or("?".into(), |x| x.name.clone())
        })
        .collect();
    if !implemented.is_empty() {
        out.push(run(format!(" ⊸ {}", implemented.join(", ")), RunStyle::Muted));
    }
    let binary = m
        .binary_id
        .as_ref()
        .and_then(|b| p.binaries.iter().find(|x| &x.id == b))
        .map(|b| (b.name.clone(), b.color.clone()));
    (out, binary)
}

/// Names of types as a module's compartments show them.
fn namer<'a>(p: &'a Project, module: &str) -> impl Fn(&str) -> Option<String> + 'a {
    let scope = type_scope(p, Some(module));
    let module = module.to_string();
    move |id: &str| {
        if let Some(t) = p.types.iter().find(|t| t.id == id) {
            return if t.is_module_type() && t.module.as_deref() != Some(&module) {
                scope.name_of(id)
            } else {
                Some(t.name.clone())
            };
        }
        if let Some((dep, path)) = parse_dependency_module_ref(id) {
            return p
                .dependencies
                .iter()
                .any(|x| x.id == dep)
                .then(|| path.rsplit('.').next().unwrap_or("").to_string());
        }
        find_module(p, id).map(|m| m.name.clone())
    }
}

fn qualifier_text(q: Qualifiers) -> String {
    ATTRIBUTE_QUALIFIERS
        .iter()
        .filter(|k| q.has(**k))
        .map(|k| format!("{k} "))
        .collect()
}

/// Constraints after a type: ` [0..10 m/s]`, ` /[a-z]+/`.
fn constraint_text(c: Option<&Constraints>) -> String {
    let Some(c) = c else { return String::new() };
    let n = |v: f64| scaffold_model::emit::js_number(&serde_json::Number::from_f64(v).unwrap_or(0.into()));
    let bounds = match (c.min, c.max) {
        (Some(a), Some(b)) => format!("{}..{}", n(a), n(b)),
        (Some(a), None) => format!("≥ {}", n(a)),
        (None, Some(b)) => format!("≤ {}", n(b)),
        _ => String::new(),
    };
    let parts: Vec<&str> = [bounds.as_str(), c.unit.as_deref().unwrap_or("")]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let range = if parts.is_empty() {
        String::new()
    } else {
        format!(" [{}]", parts.join(" "))
    };
    format!(
        "{range}{}",
        c.pattern.as_ref().map(|x| format!(" /{x}/")).unwrap_or_default()
    )
}

fn mark(a: Option<StoredAccess>) -> &'static str {
    a.map_or(Access::Public, StoredAccess::access).marker()
}

/// Lines of the attribute compartment.
pub fn attributes(p: &Project, module: &str, attributes: &[Attribute]) -> Vec<Vec<Run>> {
    let name_of = namer(p, module);
    attributes
        .iter()
        .map(|a| {
            let mut line = vec![run(format!("{} ", mark(a.access)), RunStyle::Muted)];
            let q = format!(
                "{}{}",
                qualifier_text(a.qualifiers),
                a.field.ownership.map(|o| format!("{o} ")).unwrap_or_default()
            );
            if !q.is_empty() {
                line.push(run(q, RunStyle::Qualifier));
            }
            line.push(run(a.field.name.clone(), RunStyle::Normal));
            line.push(run(
                format!(": {}", print_type_ref(&a.field.ty, &name_of)),
                RunStyle::Type,
            ));
            let limits = constraint_text(a.field.constraints.as_ref());
            if !limits.is_empty() {
                line.push(run(limits, RunStyle::Qualifier));
            }
            if let Some(d) = &a.field.default {
                line.push(run(format!(" = {}", format_value(d)), RunStyle::Default));
            }
            line
        })
        .collect()
}

/// Lines of the method compartment: constructors, destructor, then methods.
pub fn methods(
    p: &Project,
    module: &str,
    name: &str,
    methods: &[Method],
    constructors: &[Constructor],
    destructor: Option<&Destructor>,
) -> Vec<Vec<Run>> {
    let name_of = namer(p, module);
    let params_text = |params: &[MethodParam]| -> String {
        params
            .iter()
            .map(|prm| {
                let dir = if prm.param.direction == ParamDirection::In {
                    String::new()
                } else {
                    format!("{} ", prm.param.direction)
                };
                let default = prm
                    .default
                    .as_ref()
                    .map(|d| format!(" = {}", format_value(d)))
                    .unwrap_or_default();
                format!(
                    "{dir}{}{}: {}{default}",
                    qualifier_text(prm.qualifiers),
                    prm.param.name,
                    print_type_ref(&prm.param.ty, &name_of)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let special = |access: Option<StoredAccess>, before: &str, label: String, after: &str| {
        let mut line = vec![run(format!("{} ", mark(access)), RunStyle::Muted)];
        if !before.is_empty() {
            line.push(run(before, RunStyle::Qualifier));
        }
        line.push(run(label, RunStyle::Normal));
        if !after.is_empty() {
            line.push(run(after, RunStyle::Qualifier));
        }
        line
    };
    let mut out = Vec::new();
    for c in constructors {
        let after = if c.deleted {
            " = delete"
        } else if c.defaulted {
            " = default"
        } else {
            ""
        };
        out.push(special(
            c.access,
            if c.explicit { "explicit " } else { "" },
            format!("{name}({})", params_text(&c.params)),
            after,
        ));
    }
    if let Some(d) = destructor {
        out.push(special(
            d.access,
            if d.r#virtual == Some(true) { "virtual " } else { "" },
            format!("~{name}()"),
            "",
        ));
    }
    for m in methods {
        let (before, after) = method_qualifier_text(m);
        let mut line = vec![run(format!("{} ", mark(m.access)), RunStyle::Muted)];
        if !before.is_empty() {
            line.push(run(before, RunStyle::Qualifier));
        }
        let pure = m.qualifiers.has(Qualifier::Pure);
        line.push(run(
            m.name.clone(),
            if pure { RunStyle::Italic } else { RunStyle::Normal },
        ));
        let returns = m
            .returns
            .as_ref()
            .map(|r| format!(": {}", print_type_ref(r, &name_of)))
            .unwrap_or_default();
        line.push(run(
            format!("({}){returns}", params_text(&m.params)),
            RunStyle::Type,
        ));
        if !after.is_empty() {
            line.push(run(after, RunStyle::Qualifier));
        }
        out.push(line);
    }
    out
}
