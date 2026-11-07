//! Preferences kept between runs, in `<config dir>/project-scaffold/`: recent files for now.

use std::path::{Path, PathBuf};

const RECENT_MAX: usize = 10;

/// `$XDG_CONFIG_HOME` (else `~/.config`), or `%APPDATA%` on Windows.
fn config_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.map(|b| b.join("project-scaffold"))
}

fn recent_file() -> Option<PathBuf> {
    // Tests keep their own (absent) list.
    if cfg!(test) {
        return None;
    }
    config_dir().map(|d| d.join("recent.json"))
}

/// Recently opened files, most recent first, existing ones only.
pub fn recent() -> Vec<PathBuf> {
    let Some(f) = recent_file() else { return vec![] };
    let list: Vec<PathBuf> = std::fs::read_to_string(f)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    list.into_iter().filter(|p| p.exists()).collect()
}

/// Put a file at the head of the recent files.
pub fn add_recent(path: &Path) {
    let Some(f) = recent_file() else { return };
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut list = recent();
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(RECENT_MAX);
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(f, text);
    }
}

/// Drop a file from the recent files (gone or failing to open).
pub fn remove_recent(path: &Path) {
    let Some(f) = recent_file() else { return };
    let mut list = recent();
    list.retain(|p| p != path);
    if let Ok(text) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(f, text);
    }
}
