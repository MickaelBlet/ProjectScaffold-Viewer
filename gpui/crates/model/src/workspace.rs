//! Workspace files: the project files of a large architecture, opened together. Port of `workspace.ts`.

use serde::Deserialize;
use serde_json::Value;

use crate::emit::to_yaml;
use crate::project::PathKey;
use crate::schema::SCHEMA_VERSION;
use crate::serialize::{LoadError, LoadIssue};
use crate::sync::normalize_file;

pub const WORKSPACE_SUFFIX: &str = ".scaffold-workspace.yaml";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub name: String,
    pub description: Option<String>,
    /// Project files relative to the workspace file, `/` separated, without duplicates.
    pub projects: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileWorkspace {
    schema_version: u64,
    workspace: FileInfo,
    projects: Vec<String>,
}

#[derive(Deserialize)]
struct FileInfo {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

/// Whether parsed file data is a workspace rather than a project.
pub fn is_workspace_data(data: &Value) -> bool {
    data.get("workspace").is_some() && data.get("project").is_none()
}

pub fn workspace_from_file(data: &Value) -> Result<Workspace, LoadError> {
    let fail = |message: String, path: Vec<PathKey>| LoadError {
        issues: vec![LoadIssue {
            message,
            path: Some(path),
            line: None,
        }],
    };
    let f: FileWorkspace = serde_path_to_error::deserialize(data).map_err(|e| {
        let p = e.path().to_string();
        fail(
            format!("{}: {}", if p == "." { "<root>".into() } else { p }, e.inner()),
            vec![],
        )
    })?;
    if f.schema_version != SCHEMA_VERSION {
        return Err(fail(
            format!("schemaVersion: Invalid input: expected {SCHEMA_VERSION}"),
            vec!["schemaVersion".into()],
        ));
    }
    if let Some(i) = f.projects.iter().position(String::is_empty) {
        return Err(fail(
            format!("projects.{i}: Too small"),
            vec!["projects".into(), i.into()],
        ));
    }
    let mut projects: Vec<String> = Vec::new();
    for p in f.projects.iter().map(|p| normalize_file(p)) {
        if !projects.contains(&p) {
            projects.push(p);
        }
    }
    Ok(Workspace {
        name: f.workspace.name,
        description: f.workspace.description.filter(|d| !d.is_empty()),
        projects,
    })
}

pub fn workspace_text(ws: &Workspace) -> String {
    let mut info = serde_json::Map::new();
    info.insert("name".into(), ws.name.clone().into());
    if let Some(d) = ws.description.as_ref().filter(|d| !d.is_empty()) {
        info.insert("description".into(), d.clone().into());
    }
    let mut file = serde_json::Map::new();
    file.insert("schemaVersion".into(), SCHEMA_VERSION.into());
    file.insert("workspace".into(), Value::Object(info));
    file.insert(
        "projects".into(),
        ws.projects.iter().map(|p| Value::from(p.clone())).collect(),
    );
    to_yaml(&Value::Object(file))
}
