//! An open project file: its project, undo history, selection and where it is saved. Port of the
//! document part of `store/documents.ts` and `store/projectStore.ts`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use scaffold_model::edit::follow_interface_renames;
use scaffold_model::grid::snap_changes;
use scaffold_model::project::{has_missing_refs, resolve_missing_refs};
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
    /// What the inspector shows (None: several items, or nothing).
    pub selection: Option<Selection>,
    /// Bumped on each change, for views to know when to redraw.
    pub version: u64,
    /// Modification time of the file as last read or written.
    disk_time: Option<SystemTime>,
    /// Text of the file changed on disk while the document had unsaved changes.
    pub conflict: Option<String>,
}

/// What the inspector shows: the project, or one entity. Port of `Selection` (`store/documents.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Selection {
    Project,
    /// With `member`, one of its attributes, methods, constructors or its destructor.
    Module {
        id: Id,
        member: Option<Id>,
    },
    Link(Id),
    Type(Id),
    Interface(Id),
    Note(Id),
    Imported(Id),
    Dependency(Id),
}

impl Selection {
    pub fn id(&self) -> Option<&Id> {
        match self {
            Selection::Project => None,
            Selection::Module { id, .. }
            | Selection::Link(id)
            | Selection::Type(id)
            | Selection::Interface(id)
            | Selection::Note(id)
            | Selection::Imported(id)
            | Selection::Dependency(id) => Some(id),
        }
    }

    /// The selection of an entity of the project, by id.
    pub fn of(p: &Project, id: &str) -> Option<Selection> {
        let id = id.to_string();
        if p.modules.iter().any(|m| m.id == id) {
            Some(Selection::Module { id, member: None })
        } else if p.links.iter().any(|l| l.id == id) {
            Some(Selection::Link(id))
        } else if p.types.iter().any(|t| t.id == id) {
            Some(Selection::Type(id))
        } else if p.interfaces.iter().any(|i| i.id == id) {
            Some(Selection::Interface(id))
        } else if p.notes.iter().any(|n| n.id == id) {
            Some(Selection::Note(id))
        } else if p
            .dependencies
            .iter()
            .any(|d| d.modules.iter().any(|m| m.id == id))
        {
            Some(Selection::Imported(id))
        } else if p.dependencies.iter().any(|d| d.id == id) {
            Some(Selection::Dependency(id))
        } else {
            None
        }
    }

    /// Whether it is drawn on the canvas (selected there too).
    pub fn on_canvas(&self) -> bool {
        matches!(
            self,
            Selection::Module { .. } | Selection::Link(_) | Selection::Note(_) | Selection::Imported(_)
        )
    }
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
            selection: None,
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
        // As the web build's `update`: placed ports follow interface renames, references left
        // missing by a forced deletion follow what is named like them again.
        follow_interface_renames(&self.project, &mut next);
        if has_missing_refs(&next) {
            resolve_missing_refs(&mut next);
        }
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

    /// Replace the project with one read from its text (the Source panel), as an undo step merged
    /// with the previous one when close in time.
    pub fn set_from_text(&mut self, next: Project) {
        if next == self.project {
            return;
        }
        let now = Instant::now();
        if self.last_edit.is_some_and(|t| now - t < MERGE) {
            self.project = next;
        } else {
            self.undo.push(std::mem::replace(&mut self.project, next));
            if self.undo.len() > HISTORY {
                self.undo.remove(0);
            }
        }
        self.last_edit = Some(now);
        self.redo.clear();
        self.changed();
    }

    /// Close the current undo step: the next edit starts a new one.
    pub fn seal(&mut self) {
        self.last_edit = None;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
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
        if let Some(id) = self.selection.as_ref().and_then(Selection::id)
            && Selection::of(&self.project, id).is_none()
        {
            self.selection = None;
        }
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

    /// Select canvas items; one of them is also what the inspector shows.
    pub fn select(&mut self, ids: Vec<Id>) {
        let selection = match ids.as_slice() {
            [one] => Selection::of(&self.project, one),
            _ => None,
        };
        if ids != self.selected || selection != self.selection {
            self.selected = ids;
            self.selection = selection;
            self.version += 1;
        }
    }

    /// Show an entity in the inspector, selecting it on the canvas when drawn there.
    pub fn select_entity(&mut self, sel: Option<Selection>) {
        self.selected = match &sel {
            Some(s) if s.on_canvas() => s.id().cloned().into_iter().collect(),
            _ => Vec::new(),
        };
        self.selection = sel;
        self.version += 1;
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
        d.edit(crate::settings::grid(), |p| p.name = "a".into());
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
