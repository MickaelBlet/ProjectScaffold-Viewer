//! An open project file: its project, undo history, selection and where it is saved. Port of the
//! document part of `store/documents.ts` and `store/projectStore.ts`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use scaffold_model::grid::snap_changes;
use scaffold_model::serialize::{Format, format_from_path, load_text, reload_text, same_content, save_text};
use scaffold_model::types::{Id, Project};

/// Edits closer than this merge into one undo step.
const MERGE: Duration = Duration::from_millis(400);
const HISTORY: usize = 200;

/// Editor settings the document edits follow.
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub snap: bool,
    pub size: f64,
}

pub const GRID: Grid = Grid {
    snap: true,
    size: 20.,
};

pub struct Document {
    pub project: Project,
    pub path: Option<PathBuf>,
    pub format: Format,
    /// Project as last saved or loaded: the document is dirty when it differs.
    saved: Project,
    undo: Vec<Project>,
    redo: Vec<Project>,
    last_edit: Option<Instant>,
    pub selected: Vec<Id>,
    /// Bumped on each change, for views to know when to redraw.
    pub version: u64,
    /// Modification time of the file as last read or written.
    disk_time: Option<SystemTime>,
    /// Text of the file changed on disk while the document had unsaved changes.
    pub conflict: Option<String>,
}

/// What a check of the file on disk found.
#[derive(Debug, PartialEq, Eq)]
pub enum DiskChange {
    None,
    /// Reloaded (the document had no unsaved changes).
    Reloaded,
    /// Changed while the document has unsaved changes: kept in `conflict`.
    Conflict,
    /// The new text does not load: the document is kept.
    Invalid(String),
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

impl Document {
    pub fn new(project: Project, path: Option<PathBuf>) -> Self {
        let format = path
            .as_deref()
            .map_or(Format::Yaml, |p| format_from_path(&p.to_string_lossy()));
        Document {
            saved: project.clone(),
            project,
            path,
            format,
            undo: Vec::new(),
            redo: Vec::new(),
            last_edit: None,
            selected: Vec::new(),
            version: 0,
            disk_time: None,
            conflict: None,
        }
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let p = load_text(&text, format_from_path(&path.to_string_lossy()))
            .map_err(|e| format!("{}:\n{e}", path.display()))?;
        let mut d = Document::new(p, Some(path.to_path_buf()));
        d.disk_time = mtime(path);
        Ok(d)
    }

    /// Reload the file when it changed on disk since it was last read or written.
    pub fn check_disk(&mut self) -> DiskChange {
        let Some(path) = self.path.clone() else {
            return DiskChange::None;
        };
        let now = mtime(&path);
        if now.is_none() || now == self.disk_time {
            return DiskChange::None;
        }
        self.disk_time = now;
        let Ok(text) = std::fs::read_to_string(&path) else {
            return DiskChange::None;
        };
        if self.dirty() {
            self.conflict = Some(text);
            self.version += 1;
            return DiskChange::Conflict;
        }
        match self.reload(&text) {
            Ok(true) => DiskChange::Reloaded,
            Ok(false) => DiskChange::None,
            Err(e) => DiskChange::Invalid(e),
        }
    }

    /// Replace the project with a text of its file, keeping entity ids, as one undo step; the
    /// document is then saved. False when nothing changed.
    pub fn reload(&mut self, text: &str) -> Result<bool, String> {
        let p = reload_text(text, self.format, &self.project).map_err(|e| e.to_string())?;
        self.conflict = None;
        if same_content(&p, &self.project) {
            self.saved = self.project.clone();
            self.version += 1;
            return Ok(false);
        }
        self.seal();
        self.undo.push(std::mem::replace(&mut self.project, p));
        self.redo.clear();
        self.saved = self.project.clone();
        self.changed();
        Ok(true)
    }

    /// Keep the unsaved changes over a change on disk.
    pub fn keep_mine(&mut self) {
        self.conflict = None;
        self.version += 1;
    }

    pub fn title(&self) -> String {
        match &self.path {
            Some(p) => p
                .file_name()
                .map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into_owned()),
            None => "Untitled".into(),
        }
    }

    pub fn dirty(&self) -> bool {
        self.project != self.saved
    }

    /// Edit the project as one undo step (merged with the previous one when close in time).
    /// Whatever the edit moves or resizes lands on the grid. False when nothing changed.
    pub fn edit(&mut self, grid: Grid, f: impl FnOnce(&mut Project)) -> bool {
        let mut next = self.project.clone();
        f(&mut next);
        if grid.snap {
            snap_changes(&self.project, &mut next, grid.size);
        }
        if next == self.project {
            return false;
        }
        let now = Instant::now();
        let merge = self.last_edit.is_some_and(|t| now - t < MERGE);
        if !merge {
            self.undo.push(std::mem::replace(&mut self.project, next));
            if self.undo.len() > HISTORY {
                self.undo.remove(0);
            }
        } else {
            self.project = next;
        }
        self.last_edit = Some(now);
        self.redo.clear();
        self.changed();
        true
    }

    /// Close the current undo step: the next edit starts a new one.
    pub fn seal(&mut self) {
        self.last_edit = None;
    }

    pub fn undo(&mut self) {
        if let Some(p) = self.undo.pop() {
            self.redo.push(std::mem::replace(&mut self.project, p));
            self.after_history();
        }
    }

    pub fn redo(&mut self) {
        if let Some(p) = self.redo.pop() {
            self.undo.push(std::mem::replace(&mut self.project, p));
            self.after_history();
        }
    }

    fn after_history(&mut self) {
        self.last_edit = None;
        self.retain_selection();
        self.changed();
    }

    /// Drop selected ids no longer in the project.
    fn retain_selection(&mut self) {
        let p = &self.project;
        self.selected.retain(|id| {
            p.modules.iter().any(|m| &m.id == id)
                || p.notes.iter().any(|n| &n.id == id)
                || p.links.iter().any(|l| &l.id == id)
                || p.dependencies
                    .iter()
                    .any(|d| d.modules.iter().any(|m| &m.id == id))
        });
    }

    fn changed(&mut self) {
        self.retain_selection();
        self.version += 1;
    }

    pub fn select(&mut self, ids: Vec<Id>) {
        if ids != self.selected {
            self.selected = ids;
            self.version += 1;
        }
    }

    pub fn save_to(&mut self, path: &Path) -> Result<(), String> {
        let format = format_from_path(&path.to_string_lossy());
        let text = save_text(&self.project, format, true);
        std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))?;
        self.path = Some(path.to_path_buf());
        self.format = format;
        self.saved = self.project.clone();
        self.last_edit = None;
        self.disk_time = mtime(path);
        self.conflict = None;
        self.version += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_changes_on_disk_or_keeps_them_aside() {
        let dir = std::env::temp_dir().join(format!("scaffold-doc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.scaffold.yaml");
        let mut d = Document::new(Project::default(), None);
        d.edit(GRID, |p| p.name = "a".into());
        d.save_to(&path).unwrap();
        assert_eq!(d.check_disk(), DiskChange::None);
        // Another program renames the project.
        std::thread::sleep(Duration::from_millis(20));
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("name: a", "name: b");
        std::fs::write(&path, &text).unwrap();
        d.disk_time = None;
        assert_eq!(d.check_disk(), DiskChange::Reloaded);
        assert_eq!(d.project.name, "b");
        assert!(!d.dirty());
        d.undo();
        assert_eq!(d.project.name, "a");
        // Unsaved changes: the text on disk is kept aside.
        std::fs::write(&path, text.replace("name: b", "name: c")).unwrap();
        d.disk_time = None;
        assert_eq!(d.check_disk(), DiskChange::Conflict);
        assert_eq!(d.project.name, "a");
        let theirs = d.conflict.clone().unwrap();
        d.reload(&theirs).unwrap();
        assert_eq!(d.project.name, "c");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn undo_merges_close_edits() {
        let mut d = Document::new(Project::default(), None);
        let off = Grid {
            snap: false,
            size: 20.,
        };
        assert!(d.edit(off, |p| p.name = "a".into()));
        assert!(d.edit(off, |p| p.name = "b".into()));
        assert!(d.dirty());
        d.seal();
        assert!(d.edit(off, |p| p.name = "c".into()));
        assert!(!d.edit(off, |p| p.name = "c".into()));
        d.undo();
        assert_eq!(d.project.name, "b");
        d.undo();
        assert_eq!(d.project.name, "");
        assert!(!d.dirty());
        d.redo();
        assert_eq!(d.project.name, "b");
    }
}
