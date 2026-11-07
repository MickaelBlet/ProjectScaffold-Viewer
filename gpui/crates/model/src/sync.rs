//! Keeping projects in sync: renames made in one project are carried to the projects depending on
//! it (see `dependencies`). Port of `sync.ts`.

use std::collections::HashMap;

use indexmap::IndexMap;

use crate::types::{Id, Project};

/// Renames between two states of a project (entities keep their id when renamed).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Renames {
    /// Old module path → new path.
    pub modules: IndexMap<String, String>,
    /// New module path → old port name → new name.
    pub ports: IndexMap<String, IndexMap<String, String>>,
    /// Old interface name → new name.
    pub interfaces: IndexMap<String, String>,
    /// Old type name → new name (own types).
    pub types: IndexMap<String, String>,
    /// Old constant name → new name (own constants).
    pub consts: IndexMap<String, String>,
    /// Types of modules, renamed or in a renamed or moved module: old `Path.Name` → new one.
    pub module_types: IndexMap<String, String>,
}

impl Renames {
    pub fn is_empty(&self) -> bool {
        self.modules.is_empty()
            && self.ports.is_empty()
            && self.interfaces.is_empty()
            && self.types.is_empty()
            && self.consts.is_empty()
            && self.module_types.is_empty()
    }
}

/// Last component of a file path.
pub fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

pub fn same_file(a: &str, b: &str) -> bool {
    base_name(a) == base_name(b)
}

fn has_folder(path: &str) -> bool {
    path.contains(['/', '\\'])
}

fn is_drive(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Whether the dependency `file` of the project saved as `from` is the file at `path`.
pub fn is_dependency_file(from: Option<&str>, file: &str, path: &str) -> bool {
    let Some(from) = from.filter(|f| has_folder(f) && has_folder(file) && has_folder(path)) else {
        return same_file(file, path);
    };
    // Windows paths ignore case.
    let key = |p: &str| {
        if is_drive(p) {
            normalize_file(p).to_lowercase()
        } else {
            normalize_file(p)
        }
    };
    key(&resolve_relative(from, file)) == key(path)
}

/// `file` relative to the folder of the project file `from`, for a dependency.
pub fn relative_file(from: Option<&str>, file: &str) -> String {
    let Some(from) = from else {
        return base_name(file).to_string();
    };
    let dir: Vec<&str> = {
        let mut v: Vec<&str> = from.split(['/', '\\']).collect();
        v.pop();
        v
    };
    let parts: Vec<&str> = file.split(['/', '\\']).collect();
    let mut common = 0;
    while common < dir.len() && common + 1 < parts.len() && dir[common] == parts[common] {
        common += 1;
    }
    if common == 0 {
        return base_name(file).to_string();
    }
    dir[common..]
        .iter()
        .map(|_| "..")
        .chain(parts[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}

/// `file` with `.` and `dir/..` steps removed, `/` separated.
pub fn normalize_file(file: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in file.split(['/', '\\']) {
        if part == "." || (part.is_empty() && !out.is_empty()) {
            continue;
        }
        if part == ".." && out.last().is_some_and(|l| *l != ".." && !l.is_empty()) {
            out.pop();
        } else {
            out.push(part);
        }
    }
    out.join("/")
}

/// `nested`, relative to the folder of `file`, made relative to the folder `file` is relative to.
pub fn resolve_relative(file: &str, nested: &str) -> String {
    if nested.starts_with(['/', '\\']) || is_drive(nested) {
        return normalize_file(nested);
    }
    let mut dir: Vec<&str> = file.split(['/', '\\']).collect();
    dir.pop();
    dir.push(nested);
    normalize_file(&dir.join("/"))
}

/// Module paths by id.
fn paths(p: &Project) -> HashMap<Id, String> {
    crate::project::module_paths(&p.modules, &[])
}

/// Renames from `prev` to `next`; None when there are none.
pub fn diff_renames(prev: &Project, next: &Project) -> Option<Renames> {
    let modules_changed = prev.modules != next.modules;
    let types_changed = prev.types != next.types;
    if !modules_changed && prev.interfaces == next.interfaces && !types_changed && prev.consts == next.consts
    {
        return None;
    }
    let mut r = Renames::default();
    let before = if modules_changed || types_changed {
        paths(prev)
    } else {
        HashMap::new()
    };
    let after = if modules_changed {
        paths(next)
    } else {
        before.clone()
    };
    if modules_changed {
        let prev_modules: HashMap<&str, _> = prev.modules.iter().map(|m| (m.id.as_str(), m)).collect();
        for m in &next.modules {
            let Some(old) = prev_modules.get(m.id.as_str()) else {
                continue;
            };
            let from = &before[&m.id];
            let to = &after[&m.id];
            if from != to {
                r.modules.insert(from.clone(), to.clone());
            }
            if old.ports == m.ports {
                continue;
            }
            let mut names = IndexMap::new();
            for pt in &m.ports {
                if let Some(was) = old.ports.iter().find(|x| x.id == pt.id) {
                    if was.name != pt.name {
                        names.insert(was.name.clone(), pt.name.clone());
                    }
                }
            }
            if !names.is_empty() {
                r.ports.insert(to.clone(), names);
            }
        }
    }
    if prev.interfaces != next.interfaces {
        for i in &next.interfaces {
            if let Some(was) = prev.interfaces.iter().find(|x| x.id == i.id) {
                if was.name != i.name && i.dependency.is_none() {
                    r.interfaces.insert(was.name.clone(), i.name.clone());
                }
            }
        }
    }
    if types_changed || modules_changed {
        for t in &next.types {
            let was = prev.types.iter().find(|x| x.id == t.id);
            if let Some(was) = was {
                if was.name != t.name && t.dependency.is_none() && t.module.is_none() && was.module.is_none()
                {
                    r.types.insert(was.name.clone(), t.name.clone());
                }
            }
            let (Some(tm), Some(wm)) = (&t.module, was.and_then(|w| w.module.as_ref())) else {
                continue;
            };
            let from = format!(
                "{}.{}",
                before.get(wm).map(String::as_str).unwrap_or("undefined"),
                was.map_or("", |w| &w.name)
            );
            let to = format!(
                "{}.{}",
                after.get(tm).map(String::as_str).unwrap_or("undefined"),
                t.name
            );
            if from != to {
                r.module_types.insert(from, to);
            }
        }
    }
    if prev.consts != next.consts {
        for c in &next.consts {
            if let Some(was) = prev.consts.iter().find(|x| x.id == c.id) {
                if was.name != c.name && c.dependency.is_none() {
                    r.consts.insert(was.name.clone(), c.name.clone());
                }
            }
        }
    }
    (!r.is_empty()).then_some(r)
}
