//! Full-text search over the project (names, descriptions and metadata). Port of `search.ts`.

use crate::project::{project_module_paths, type_names};
use crate::types::{Metadata, Project, TypeBody};
use crate::validate::ProblemTarget;

#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub target: ProblemTarget,
    /// Entity the hit belongs to, e.g. `Core.Sensor` or `Pose.position`.
    pub label: String,
    /// Where the text matched: name, description, metadata key...
    pub field: String,
    pub text: String,
}

/// Records a hit when the text matches: target, label, field, text.
type Check<'a> = dyn FnMut(&ProblemTarget, &str, &str, Option<&str>) + 'a;

pub fn search_project(p: &Project, query: &str) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let mut hits = Vec::new();
    let mut check = |target: &ProblemTarget, label: &str, field: &str, text: Option<&str>| {
        if let Some(text) = text.filter(|t| t.to_lowercase().contains(&q)) {
            hits.push(SearchHit {
                target: target.clone(),
                label: label.into(),
                field: field.into(),
                text: text.into(),
            });
        }
    };
    fn meta(check: &mut Check, t: &ProblemTarget, label: &str, m: &Metadata) {
        for (k, v) in m {
            check(t, label, "metadata key", Some(k));
            check(t, label, &format!("metadata {k}"), Some(v));
        }
    }
    let project = ProblemTarget::Project;
    check(&project, "Project", "name", Some(&p.name));
    check(&project, "Project", "description", Some(&p.description));
    meta(&mut check, &project, "Project", &p.metadata);
    let paths = project_module_paths(p);
    for m in &p.modules {
        let t = ProblemTarget::Module(m.id.clone());
        let path = &paths[&m.id];
        check(&t, path, "module", Some(&m.name));
        check(&t, path, "description", Some(&m.description));
        meta(&mut check, &t, path, &m.metadata);
        for a in &m.attributes {
            let l = format!("{path}.{}", a.field.name);
            check(&t, &l, "attribute", Some(&a.field.name));
            check(&t, &l, "attribute description", Some(&a.field.description));
        }
        for x in &m.methods {
            let l = format!("{path}.{}", x.name);
            check(&t, &l, "method", Some(&x.name));
            check(&t, &l, "method description", Some(&x.description));
            for prm in &x.params {
                check(
                    &t,
                    &format!("{path}.{}({})", x.name, prm.param.name),
                    "parameter",
                    Some(&prm.param.name),
                );
            }
        }
        for pt in &m.ports {
            let l = format!("{path}:{}", pt.name);
            check(&t, &l, &format!("{} port", pt.role), Some(&pt.name));
            check(&t, &l, "port description", Some(&pt.description));
        }
    }
    for c in p.consts.iter().filter(|c| c.dependency.is_none()) {
        let t = ProblemTarget::Const(c.id.clone());
        check(&t, &c.name, "constant", Some(&c.name));
        check(&t, &c.name, "description", Some(&c.description));
    }
    for l in &p.links {
        let t = ProblemTarget::Link(l.id.clone());
        check(&t, &l.name, "link", Some(&l.name));
        check(&t, &l.name, "description", Some(&l.description));
        check(
            &t,
            &l.name,
            "transport",
            l.constraints.remote.transport.as_deref(),
        );
    }
    let type_name = type_names(p);
    for ty in &p.types {
        let t = ProblemTarget::Type(ty.id.clone());
        let name = &type_name[&ty.id];
        check(&t, name, ty.kind(), Some(&ty.name));
        check(&t, name, "description", Some(&ty.description));
        match &ty.body {
            TypeBody::Struct { fields, .. } | TypeBody::Exception { fields } => {
                for f in fields {
                    let l = format!("{name}.{}", f.name);
                    check(&t, &l, "field", Some(&f.name));
                    check(&t, &l, "field description", Some(&f.description));
                }
            }
            TypeBody::Enum { values, .. } => {
                for v in values {
                    check(&t, &format!("{name}.{}", v.name), "value", Some(&v.name));
                }
            }
            TypeBody::Union { cases, .. } => {
                for c in cases {
                    let l = format!("{name}.{}", c.name);
                    check(&t, &l, "case", Some(&c.name));
                    check(&t, &l, "case description", Some(&c.description));
                }
            }
            TypeBody::Bitmask { flags, .. } => {
                for v in flags {
                    check(&t, &format!("{name}.{}", v.name), "flag", Some(&v.name));
                }
            }
            _ => {}
        }
    }
    for i in &p.interfaces {
        let t = ProblemTarget::Interface(i.id.clone());
        check(&t, &i.name, "interface", Some(&i.name));
        check(&t, &i.name, "description", Some(&i.description));
        for m in &i.messages {
            let l = format!("{}.{}", i.name, m.name);
            check(&t, &l, "message", Some(&m.name));
            check(&t, &l, "message description", Some(&m.description));
            for prm in &m.params {
                check(
                    &t,
                    &format!("{}.{}({})", i.name, m.name, prm.name),
                    "parameter",
                    Some(&prm.name),
                );
            }
        }
    }
    hits
}
