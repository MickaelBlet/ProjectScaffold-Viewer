//! Import of OMG IDL files (IDL 4.2: CORBA, CCM, DDS / XTypes). A C-like preprocessor runs first
//! (#include, #define, #if...; `import "file";` includes like #include), then the whole grammar is
//! read: modules (template modules too), interfaces, valuetypes, eventtypes, components, connectors,
//! porttypes, homes, structs, unions, enums, bitmasks, bitsets, exceptions, typedefs, constants and
//! annotations. Modules are flattened: entities keep their simple name, qualified with their modules
//! when two share it. Components and connectors become modules with ports. What the model cannot
//! express is approximated or left out, and reported. Port of `idl.ts`.

mod expr;
mod import;
mod lexer;
mod parser;
mod preprocess;

use std::collections::HashSet;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;

use crate::schema::{FileMessage, FileTypeRef};
use crate::types::PortRole;

pub use import::{IdlImport, IdlProject, idl_import, idl_project};
pub use parser::{IdlFile, IdlOptions, parse_idl, parse_idl_files};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct IdlError(pub String);

/// Port of a component, connector or porttype.
#[derive(Clone, Debug, PartialEq)]
pub struct IdlPort {
    pub name: String,
    pub role: PortRole,
    /// Interface name; None when unknown.
    pub interface: Option<String>,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdlAttribute {
    pub name: String,
    pub ty: FileTypeRef,
    pub description: String,
    pub readonly: bool,
}

/// CCM component or connector: a module with ports.
#[derive(Clone, Debug, PartialEq)]
pub struct IdlComponent {
    pub name: String,
    pub description: String,
    /// Component it derives from.
    pub bases: Vec<String>,
    pub attributes: Vec<IdlAttribute>,
    /// Operations of the interfaces it supports.
    pub methods: Vec<FileMessage>,
    pub ports: Vec<IdlPort>,
    /// Types and interfaces it needs besides those its members reference.
    pub needs: Vec<String>,
    /// Qualified IDL name (`Plant::Tank`), for those written in the files.
    pub qualified: Option<String>,
}

// Paths

/// `/`-separated path without `.` and `..` steps.
pub(crate) fn normalize_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let path = path.replace('\\', "/");
    for (i, part) in path.split('/').enumerate() {
        if part == "." || (part.is_empty() && i > 0) {
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

pub(crate) fn dir_of(path: &str) -> &str {
    &path[..path.rfind('/').map_or(0, |k| k + 1)]
}

pub(crate) fn base_name(path: &str) -> &str {
    &path[path.rfind('/').map_or(0, |k| k + 1)..]
}

/// Where an include of `name` from file `from` may be: next to it, then in its ancestor folders.
fn include_candidates(name: &str, from: &str) -> Vec<String> {
    static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:/").unwrap());
    let n = normalize_path(name);
    if n.starts_with('/') || DRIVE.is_match(&n) {
        return vec![n];
    }
    let mut out: Vec<String> = Vec::new();
    let mut dir = dir_of(from);
    while !dir.is_empty() {
        let c = normalize_path(&format!("{dir}{n}"));
        if !out.contains(&c) {
            out.push(c);
        }
        dir = dir_of(&dir[..dir.len() - 1]);
    }
    if !out.contains(&n) {
        out.push(n);
    }
    out
}

/// The file of `files` an include names: a candidate path, else any with that path suffix or name.
pub(crate) fn find_include(name: &str, from: &str, files: &IndexMap<String, String>) -> Option<String> {
    for c in include_candidates(name, from) {
        if files.contains_key(&c) {
            return Some(c);
        }
    }
    let n = normalize_path(name);
    let suffix = format!("/{n}");
    files
        .keys()
        .find(|k| k.ends_with(&suffix))
        .or_else(|| files.keys().find(|k| base_name(k) == base_name(&n)))
        .cloned()
}

pub(crate) static INCLUDE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^[ \t]*#[ \t]*(?:include|import)[ \t]*[<"]([^>"\n]+)[>"]|\bimport\s+"([^"\n]+)""#)
        .unwrap()
});

pub(crate) fn normalize_files(files: &IndexMap<String, String>) -> IndexMap<String, String> {
    files
        .iter()
        .map(|(k, v)| (normalize_path(k), v.clone()))
        .collect()
}

/// `files` (by path) with the files they include, transitively, that `read` can read. Includes
/// found nowhere are reported by the parser.
pub fn read_idl_includes(
    files: &IndexMap<String, String>,
    mut read: impl FnMut(&str) -> Option<String>,
) -> IndexMap<String, String> {
    let mut all = normalize_files(files);
    let mut queue: std::collections::VecDeque<String> = all.keys().cloned().collect();
    let mut tried: HashSet<String> = HashSet::new();
    while let Some(from) = queue.pop_front() {
        let text = all[&from].clone();
        for m in INCLUDE_RE.captures_iter(&text) {
            let name = m.get(1).or_else(|| m.get(2)).map_or("", |g| g.as_str());
            if find_include(name, &from, &all).is_some() {
                continue;
            }
            for c in include_candidates(name, &from) {
                if !tried.insert(c.clone()) {
                    continue;
                }
                let Some(text) = read(&c) else { continue };
                all.insert(c.clone(), text);
                queue.push_back(c);
                break;
            }
        }
    }
    all
}

// Shared helpers

/// IDL escapes (`_name`) removed.
pub(crate) fn unescape_name(name: &str) -> String {
    name.strip_prefix('_').unwrap_or(name).to_string()
}

/// Last segment of a `::`-qualified name; as in the TypeScript source, a name without `::` loses
/// its first character (callers always prefix `::`).
pub(crate) fn last_segment(q: &str) -> &str {
    match q.rfind("::") {
        Some(k) => &q[k + 2..],
        None => {
            let mut c = q.chars();
            c.next();
            c.as_str()
        }
    }
}
