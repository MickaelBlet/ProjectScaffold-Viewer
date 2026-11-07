//! Problems of a project file located on the lines of its text. Port of `locate.ts`.

use serde_json::Value;

use crate::path;
use crate::project::{DataPath, PathKey, find_imported, module_path};
use crate::serialize::{Format, line_of_path, load_text, parse_text};
use crate::types::Project;
use crate::validate::{Problem, ProblemTarget, Severity, validate};

#[derive(Clone, Debug, PartialEq)]
pub struct LocatedProblem {
    pub severity: Severity,
    pub message: String,
    /// From 1.
    pub line: usize,
}

fn named(key: &str, items: Option<&Value>, name: Option<&str>, field: &str) -> DataPath {
    let i = items.and_then(Value::as_array).and_then(|a| {
        a.iter()
            .position(|e| e.get(field).and_then(Value::as_str) == name && name.is_some())
    });
    match i {
        Some(i) => path![key, i],
        None => path![key],
    }
}

fn index(p: &DataPath) -> Option<usize> {
    match p.get(1) {
        Some(PathKey::Index(i)) => Some(*i),
        _ => None,
    }
}

fn dig<'a>(data: &'a Value, path: &[PathKey]) -> Option<&'a Value> {
    let mut cur = data;
    for k in path {
        cur = match k {
            PathKey::Key(k) => cur.get(k)?,
            PathKey::Index(i) => cur.get(i)?,
        };
    }
    Some(cur)
}

/// Data path of a module of the project: modules.i.modules.j... (as far as the file has it).
fn module_path_in(file: &Value, p: &Project, id: &str) -> DataPath {
    let mut out = DataPath::new();
    let mut items = file.get("modules");
    for name in module_path(p, id).split('.') {
        let Some(i) = items.and_then(Value::as_array).and_then(|a| {
            a.iter()
                .position(|m| m.get("name").and_then(Value::as_str) == Some(name))
        }) else {
            break;
        };
        out.extend(path!["modules", i]);
        items = items.and_then(|a| a.get(i)).and_then(|m| m.get("modules"));
    }
    out
}

/// Data path of an entity in the file data read from the text; list items are found by name.
pub fn target_path(file: &Value, p: &Project, target: &ProblemTarget) -> DataPath {
    match target {
        ProblemTarget::Project => path!["project"],
        ProblemTarget::Type(id) | ProblemTarget::Interface(id) | ProblemTarget::Const(id) => {
            let key = match target {
                ProblemTarget::Type(_) => "types",
                ProblemTarget::Interface(_) => "interfaces",
                _ => "constants",
            };
            let ty = p.types.iter().find(|x| &x.id == id);
            let (name, dependency) = ty
                .map(|t| (t.name.as_str(), t.dependency.as_ref()))
                .or_else(|| {
                    p.interfaces
                        .iter()
                        .find(|x| &x.id == id)
                        .map(|x| (x.name.as_str(), x.dependency.as_ref()))
                })
                .or_else(|| {
                    p.consts
                        .iter()
                        .find(|x| &x.id == id)
                        .map(|x| (x.name.as_str(), x.dependency.as_ref()))
                })
                .map_or((None, None), |(n, d)| (Some(n), d));
            if let Some(module) = ty.and_then(|t| t.module.as_ref()) {
                let mp = module_path_in(file, p, module);
                if mp.is_empty() {
                    return path!["modules"];
                }
                let items = dig(file, &mp).and_then(|m| m.get("types"));
                let mut out = mp;
                out.extend(named("types", items, name, "name"));
                return out;
            }
            let dep = dependency.and_then(|d| p.dependencies.iter().find(|x| &x.id == d));
            if let (Some(dep), Some(mpath)) = (dep, ty.and_then(|t| t.module_path.as_ref())) {
                let path = named("dependencies", file.get("dependencies"), Some(&dep.name), "name");
                let groups = index(&path).and_then(|i| file["dependencies"][i].get("moduleTypes"));
                let k = groups.and_then(Value::as_array).and_then(|g| {
                    g.iter()
                        .position(|g| g.get("module").and_then(Value::as_str) == Some(mpath))
                });
                return match k {
                    None => path,
                    Some(k) => {
                        let mut out = path;
                        out.extend(path!["moduleTypes", k]);
                        out.extend(named(
                            "types",
                            groups.and_then(|g| g[k].get("types")),
                            name,
                            "name",
                        ));
                        out
                    }
                };
            }
            let Some(dep) = dep else {
                return named(key, file.get(key), name, "name");
            };
            let path = named("dependencies", file.get("dependencies"), Some(&dep.name), "name");
            match index(&path) {
                None => path,
                Some(i) => {
                    let mut out = path;
                    out.extend(named(key, file["dependencies"][i].get(key), name, "name"));
                    out
                }
            }
        }
        ProblemTarget::Dependency(id) => named(
            "dependencies",
            file.get("dependencies"),
            p.dependencies
                .iter()
                .find(|d| &d.id == id)
                .map(|d| d.name.as_str()),
            "name",
        ),
        ProblemTarget::Link(id) => named(
            "links",
            file.get("links"),
            p.links.iter().find(|l| &l.id == id).map(|l| l.name.as_str()),
            "name",
        ),
        ProblemTarget::Module(id) => {
            if let Some((dep, m)) = find_imported(p, id) {
                let path = named("dependencies", file.get("dependencies"), Some(&dep.name), "name");
                let j = index(&path).and_then(|i| {
                    file["dependencies"][i]
                        .get("modules")
                        .and_then(Value::as_array)
                        .and_then(|a| {
                            a.iter()
                                .position(|x| x.get("module").and_then(Value::as_str) == Some(&m.path))
                        })
                });
                return match j {
                    None => path,
                    Some(j) => {
                        let mut out = path;
                        out.extend(path!["modules", j]);
                        out
                    }
                };
            }
            let mp = module_path_in(file, p, id);
            if mp.is_empty() { path!["modules"] } else { mp }
        }
    }
}

/// Load errors when the text cannot be read, else the validation problems.
pub fn locate_problems(text: &str, format: Format) -> Vec<LocatedProblem> {
    match load_text(text, format) {
        Err(e) => e
            .issues
            .into_iter()
            .map(|i| LocatedProblem {
                severity: Severity::Error,
                message: i.message,
                line: i.line.unwrap_or(1),
            })
            .collect(),
        Ok(project) => {
            let problems = validate(&project);
            locate_validation(text, format, &project, &problems)
        }
    }
}

/// Validation problems of the project read from the text, on the lines of their entities.
pub fn locate_validation(
    text: &str,
    format: Format,
    project: &Project,
    problems: &[Problem],
) -> Vec<LocatedProblem> {
    if problems.is_empty() {
        return vec![];
    }
    let Ok(data) = parse_text(text, format) else {
        return vec![];
    };
    problems
        .iter()
        .map(|pb| LocatedProblem {
            severity: pb.severity,
            message: pb.message.clone(),
            line: line_of_path(text, &target_path(&data, project, &pb.target)).unwrap_or(1),
        })
        .collect()
}
