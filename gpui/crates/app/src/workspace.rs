//! The window's content: title bar with the menus and toolbar, document tabs, the canvas of the
//! active document and the status bar. Runs the commands of the registry. Port of the shell of the
//! web build (`shell/`, `fileOps.ts`, the editing actions of `actions.ts`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui_kit::component::command::{Command, CommandItem, CommandState};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::menu::AppMenuBar;
use gpui_kit::component::{TitleBar, WindowExt};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use scaffold_model::align::{AlignMode, SizeDim, align, distribute, same_size};
use scaffold_model::clipboard::{PasteOptions, PasteParent, copy_items, parse_clip, paste_clip, to_text};
use scaffold_model::edit::{
    add_module, add_note, add_port, add_submodule, apply_absolute, delete_items, group_modules, locked_of,
    nudge, selected_rects, set_locked,
};
use scaffold_model::project::{
    Compartments, NameTarget, absolute_position, all_imported, default_size, empty_project, find_module,
    name_error, prune_views,
};
use scaffold_model::types::{Id, NoteKind, PortRole, Project};
use scaffold_model::validate::{Severity, validate};

use crate::canvas::Canvas;
use crate::commands::{self, CmdState, OpenRecent};
use crate::document::{DiskChange, Document, Selection};
use crate::panels::explorer::ExplorerPanel;
use crate::panels::inspector::InspectorPanel;
use crate::panels::lists::{OutputPanel, ProblemsPanel, SearchPanel};
use crate::panels::settings_panel::SettingsPanel;
use crate::panels::state_machine::StateMachinePanel;
use crate::panels::{self, Dock, PanelId, Region};
use crate::{prefs, settings, theme};

struct Tab {
    doc: Entity<Document>,
    canvas: Entity<Canvas>,
}

pub struct Workspace {
    tabs: Vec<Tab>,
    active: usize,
    error: Option<String>,
    status: Option<String>,
    pub focus: FocusHandle,
    menu_bar: Entity<AppMenuBar>,
    /// State the menus were last built from, to rebuild them only when it changes.
    menu_key: Vec<(usize, bool, bool)>,
    recent: Vec<PathBuf>,
    /// Problem counts of the active document (errors, warnings) and the version they are of.
    problems: (usize, usize, Option<(usize, u64)>),
    /// Set once the user agreed to lose unsaved changes, to let the window close.
    closing: bool,
    pub dock: Dock,
    /// Messages of the Output panel.
    pub output: Vec<String>,
    explorer: Entity<ExplorerPanel>,
    inspector: Entity<InspectorPanel>,
    problems_panel: Entity<ProblemsPanel>,
    output_panel: Entity<OutputPanel>,
    search: Entity<SearchPanel>,
    settings_panel: Entity<SettingsPanel>,
    state_machine: Entity<StateMachinePanel>,
}

/// Arrow keys move by a grid cell (five when far) on the grid, else by 2px (20px).
fn nudge_step(far: bool) -> f64 {
    let s = settings::get();
    match (s.snap_to_grid, far) {
        (true, true) => s.grid_size * 5.,
        (true, false) => s.grid_size,
        (false, true) => 20.,
        (false, false) => 2.,
    }
}

/// Commands of features not ported yet.
const LATER: &[&str] = &[
    "file.saveWorkspace",
    "file.saveWorkspaceAs",
    "file.importSettings",
    "file.exportSettings",
    "file.exportPng",
    "file.exportSvg",
    "file.openIdlText",
    "insert.projectContent",
    "insert.dependency",
    "insert.refreshDependencies",
    "view.back",
    "view.forward",
    "view.openModule",
    "view.openModuleSplit",
    "view.keep",
    "view.new",
    "view.source",
    "view.hide",
    "view.resetLayout",
    "view.showAll",
    "view.wordWrap",
    "arrange.auto",
    "arrange.all",
    "arrange.horizontal",
    "arrange.vertical",
    "help.tutorial",
];

/// State of a command that only depends on the active document.
pub fn doc_command_state(id: &str, doc: Option<&Document>) -> CmdState {
    let on = |enabled: bool| CmdState {
        enabled,
        checked: false,
    };
    if LATER.contains(&id) {
        return on(false);
    }
    let s = settings::get();
    match id {
        "arrange.snap" => {
            return CmdState {
                enabled: true,
                checked: s.snap_to_grid,
            };
        }
        "arrange.guides" => {
            return CmdState {
                enabled: true,
                checked: s.guides,
            };
        }
        _ => {}
    }
    let Some(d) = doc else {
        return on(matches!(
            id,
            "file.new"
                | "file.open"
                | "view.palette"
                | "help.shortcuts"
                | "help.about"
                | "help.resetData"
                | "app.quit"
        ) || id.starts_with("doc."));
    };
    let p = &d.project;
    let sel = &d.selected;
    let modules = sel.iter().filter(|id| find_module(p, id).is_some()).count();
    let module_selected = sel.len() == 1 && modules == 1;
    let items: Vec<bool> = sel.iter().filter_map(|id| locked_of(p, id)).collect();
    let arranged = sel
        .iter()
        .filter(|id| find_module(p, id).is_some() || p.notes.iter().any(|n| &n.id == *id))
        .count();
    match id {
        "edit.undo" => on(d.can_undo()),
        "edit.redo" => on(d.can_redo()),
        "edit.cut" | "edit.copy" | "edit.duplicate" => on(!sel.is_empty()),
        "edit.delete" => on(!sel.is_empty()),
        "edit.rename" | "insert.submodule" | "insert.inPort" | "insert.outPort" => on(module_selected),
        "arrange.group" => on(modules > 0),
        "arrange.lock" => CmdState {
            enabled: !items.is_empty(),
            checked: !items.is_empty() && items.iter().all(|l| *l),
        },
        "arrange.left" | "arrange.hcenter" | "arrange.right" | "arrange.top" | "arrange.vcenter"
        | "arrange.bottom" | "arrange.sameSize" => on(arranged >= 2),
        "arrange.distH" | "arrange.distV" => on(arranged >= 3),
        "view.fit" => on(true),
        _ => on(true),
    }
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let this = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            this.update(cx, |w, cx| w.may_close(window, cx, false))
                .unwrap_or(true)
        });
        let ws = cx.entity().downgrade();
        let explorer = cx.new(|cx| ExplorerPanel::new(ws.clone(), window, cx));
        let search = cx.new(|cx| SearchPanel::new(ws.clone(), window, cx));
        Workspace {
            dock: prefs::load_dock(),
            output: Vec::new(),
            explorer,
            inspector: cx.new(|_| InspectorPanel::new(ws.clone())),
            problems_panel: cx.new(|_| ProblemsPanel { ws: ws.clone() }),
            output_panel: cx.new(|_| OutputPanel { ws: ws.clone() }),
            search,
            settings_panel: cx.new(|_| SettingsPanel::new()),
            state_machine: cx.new(|_| StateMachinePanel::new(ws.clone())),
            tabs: Vec::new(),
            active: 0,
            error: None,
            status: None,
            focus: cx.focus_handle(),
            menu_bar: AppMenuBar::new(cx),
            menu_key: Vec::new(),
            recent: prefs::recent(),
            problems: (0, 0, None),
            closing: false,
        }
    }

    pub fn doc(&self) -> Option<Entity<Document>> {
        self.tabs.get(self.active).map(|t| t.doc.clone())
    }

    pub fn canvas(&self) -> Option<Entity<Canvas>> {
        self.tabs.get(self.active).map(|t| t.canvas.clone())
    }

    fn add_doc(&mut self, doc: Document, window: Option<&mut Window>, cx: &mut Context<Self>) {
        let doc = cx.new(|_| doc);
        cx.observe(&doc, |_, _, cx| cx.notify()).detach();
        // Follow changes of the file made by other programs.
        let watched = doc.downgrade();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let Some(doc) = watched.upgrade() else { break };
                let change = doc.update(cx, |d, cx| {
                    let c = d.check_disk();
                    if c != DiskChange::None {
                        cx.notify();
                    }
                    c
                });
                if let DiskChange::Invalid(e) = change
                    && this
                        .update(cx, |w, cx| {
                            w.error = Some(format!("The file changed on disk but does not load:\n{e}"));
                            cx.notify();
                        })
                        .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let canvas = cx.new(|cx| Canvas::new(doc.clone(), cx));
        if let Some(window) = window {
            window.focus(&canvas.read(cx).focus_handle(), cx);
        }
        self.tabs.push(Tab { doc, canvas });
        self.active = self.tabs.len() - 1;
        self.error = None;
        cx.notify();
    }

    pub fn open_path(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        // An open file is activated, not opened twice.
        let canon = std::fs::canonicalize(&path).ok();
        if let Some(i) = self.tabs.iter().position(|t| {
            let p = t.doc.read(cx).path.clone();
            p.is_some() && p.as_ref().and_then(|p| std::fs::canonicalize(p).ok()) == canon
        }) {
            self.active = i;
            cx.notify();
            return;
        }
        match Document::open(&path) {
            Ok(d) => {
                prefs::add_recent(&path);
                self.recent = prefs::recent();
                self.add_doc(d, None, cx)
            }
            Err(e) => {
                if !path.exists() {
                    prefs::remove_recent(&path);
                    self.recent = prefs::recent();
                }
                self.error = Some(e);
                cx.notify();
            }
        }
    }

    fn dirty_docs(&self, cx: &App) -> Vec<usize> {
        (0..self.tabs.len())
            .filter(|i| self.tabs[*i].doc.read(cx).dirty())
            .collect()
    }

    /// Whether the window may close (or the app quit) now; else ask about unsaved changes first.
    fn may_close(&mut self, window: &mut Window, cx: &mut Context<Self>, quit: bool) -> bool {
        let dirty = self.dirty_docs(cx);
        if self.closing || dirty.is_empty() {
            return true;
        }
        let names: Vec<String> = dirty.iter().map(|i| self.tabs[*i].doc.read(cx).title()).collect();
        let answer = window.prompt(
            PromptLevel::Warning,
            &format!("Save changes to {}?", names.join(", ")),
            Some("Your changes will be lost if you don't save them."),
            &["Save", "Don't Save", "Cancel"],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            let choice = answer.await.ok();
            this.update_in(cx, |w, window, cx| {
                match choice {
                    Some(0) => {
                        if !w.save_all(window, cx) {
                            return;
                        }
                    }
                    Some(1) => {}
                    _ => return,
                }
                w.closing = true;
                if quit {
                    cx.quit();
                } else {
                    window.remove_window();
                }
            })
            .ok();
        })
        .detach();
        false
    }

    /// Close a document, asking about its unsaved changes.
    fn close_doc(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get(index) else { return };
        let doc = tab.doc.clone();
        if !doc.read(cx).dirty() {
            self.remove_tab(index, cx);
            return;
        }
        let title = doc.read(cx).title();
        let answer = window.prompt(
            PromptLevel::Warning,
            &format!("Save changes to {title}?"),
            Some("Your changes will be lost if you don't save them."),
            &["Save", "Don't Save", "Cancel"],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            let choice = answer.await.ok();
            this.update_in(cx, |w, window, cx| {
                let Some(i) = w.tabs.iter().position(|t| t.doc == doc) else {
                    return;
                };
                match choice {
                    Some(0) => {
                        w.active = i;
                        if !w.save(window, cx) {
                            return;
                        }
                    }
                    Some(1) => {}
                    _ => return,
                }
                w.remove_tab(i, cx);
            })
            .ok();
        })
        .detach();
    }

    fn remove_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        self.tabs.remove(index);
        if self.active >= self.tabs.len() {
            self.active = self.tabs.len().saturating_sub(1);
        } else if self.active > index {
            self.active -= 1;
        }
        cx.notify();
    }

    /// Save every document with unsaved changes that has a file; false when one could not be.
    fn save_all(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let mut ok = true;
        for i in self.dirty_docs(cx) {
            let doc = self.tabs[i].doc.clone();
            match doc.read(cx).path.clone() {
                Some(path) => ok &= self.write(&doc, &path, cx),
                None => {
                    self.active = i;
                    self.save_as(window, cx);
                    ok = false;
                }
            }
        }
        ok
    }

    /// Save to the document's file, or ask where. False when not saved yet.
    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(doc) = self.doc() else {
            return false;
        };
        let Some(path) = doc.read(cx).path.clone() else {
            self.save_as(window, cx);
            return false;
        };
        self.write(&doc, &path, cx)
    }

    fn write(&mut self, doc: &Entity<Document>, path: &Path, cx: &mut Context<Self>) -> bool {
        match doc.update(cx, |d, cx| {
            let r = d.save_to(path);
            cx.notify();
            r
        }) {
            Ok(()) => {
                prefs::add_recent(path);
                self.recent = prefs::recent();
                self.log(format!("Saved {}", path.display()));
                cx.notify();
                true
            }
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                false
            }
        }
    }

    fn save_as(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.doc() else {
            return;
        };
        let current = doc.read(cx).path.clone();
        let dir = current
            .as_deref()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default();
        let name = current
            .as_deref()
            .and_then(|p| p.file_name())
            .map_or("project.scaffold.yaml".to_string(), |n| {
                n.to_string_lossy().into_owned()
            });
        let rx = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(path))) = rx.await {
                this.update(cx, |w, cx| w.write(&doc, &path, cx)).ok();
            }
        })
        .detach();
    }

    fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Open".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update(cx, |w, cx| {
                    for path in paths {
                        w.open_path(path, cx);
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    /// Run an edit of the active project with the current selection; the new selection when the
    /// edit returns one.
    fn edit(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Project, &[Id]) -> Option<Vec<Id>>) {
        if let Some(doc) = self.doc() {
            doc.update(cx, |d, cx| {
                let sel = d.selected.clone();
                let mut next = None;
                d.seal();
                d.edit(settings::grid(), |p| next = f(p, &sel));
                d.seal();
                if let Some(ids) = next {
                    d.select(ids);
                }
                cx.notify();
            });
        }
    }

    fn with_doc(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Document)) {
        if let Some(doc) = self.doc() {
            doc.update(cx, |d, cx| {
                f(d);
                cx.notify();
            });
        }
    }

    fn with_canvas(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Canvas, &mut Context<Canvas>)) {
        if let Some(c) = self.canvas() {
            c.update(cx, f);
        }
    }

    /// Where new items go: the middle of the view.
    fn view_center(&self, cx: &App) -> scaffold_layout::scene::Pt {
        self.canvas()
            .map_or(scaffold_layout::scene::Pt { x: 80., y: 80. }, |c| {
                c.read(cx).center()
            })
    }

    pub fn command_state(&self, id: &str, cx: &App) -> CmdState {
        let doc = self.doc();
        let d = doc.as_ref().map(|d| d.read(cx));
        if let Some(panel) = PanelId::from_command(id) {
            return CmdState {
                enabled: panel != PanelId::StateMachine || settings::get().feature_state_machine,
                checked: self.dock.is_shown(panel),
            };
        }
        match id {
            "window.resetLayout" | "window.clearOutput" => CmdState {
                enabled: true,
                checked: false,
            },
            "window.nextDoc" | "window.prevDoc" => CmdState {
                enabled: self.tabs.len() > 1,
                checked: false,
            },
            "file.saveAll" => CmdState {
                enabled: !self.dirty_docs(cx).is_empty(),
                checked: false,
            },
            _ => doc_command_state(id, d),
        }
    }

    pub fn run(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.command_state(id, cx).enabled {
            return;
        }
        self.status = None;
        let (tabs, active) = (self.tabs.len(), self.active);
        match id {
            "file.new" => self.add_doc(Document::new(empty_project(), None), Some(window), cx),
            "file.open" => self.open(window, cx),
            "file.save" => {
                self.save(window, cx);
            }
            "file.saveAs" => self.save_as(window, cx),
            "file.saveAll" => {
                self.save_all(window, cx);
            }
            "file.close" => self.close_doc(self.active, window, cx),
            "app.quit" => {
                if self.may_close(window, cx, true) {
                    cx.quit();
                }
            }
            "edit.undo" => self.with_doc(cx, Document::undo),
            "edit.redo" => self.with_doc(cx, Document::redo),
            "edit.copy" => {
                self.copy(cx);
            }
            "edit.cut" => {
                if self.copy(cx) {
                    self.delete(cx);
                }
            }
            "edit.paste" => self.paste(cx),
            "edit.duplicate" => self.edit(cx, |p, sel| {
                let clip = copy_items(p, sel)?;
                Some(paste_clip(p, &clip, &PasteOptions::default()))
            }),
            "edit.delete" => self.delete(cx),
            "edit.selectAll" => self.with_doc(cx, |d| {
                let p = &d.project;
                let ids = p
                    .modules
                    .iter()
                    .map(|m| m.id.clone())
                    .chain(all_imported(p).map(|m| m.id.clone()))
                    .chain(
                        p.notes
                            .iter()
                            .filter(|n| n.view_id.is_none())
                            .map(|n| n.id.clone()),
                    )
                    .collect();
                d.select(ids);
            }),
            "edit.deselect" => self.with_doc(cx, |d| d.select(Vec::new())),
            "edit.rename" => self.rename(window, cx),
            "edit.nudgeUp" => self.nudge(0., -1., false, cx),
            "edit.nudgeUpFar" => self.nudge(0., -1., true, cx),
            "edit.nudgeDown" => self.nudge(0., 1., false, cx),
            "edit.nudgeDownFar" => self.nudge(0., 1., true, cx),
            "edit.nudgeLeft" => self.nudge(-1., 0., false, cx),
            "edit.nudgeLeftFar" => self.nudge(-1., 0., true, cx),
            "edit.nudgeRight" => self.nudge(1., 0., false, cx),
            "edit.nudgeRightFar" => self.nudge(1., 0., true, cx),
            "insert.module" => {
                if self.tabs.is_empty() {
                    self.add_doc(Document::new(empty_project(), None), Some(window), cx);
                }
                let c = self.view_center(cx);
                self.edit(cx, |p, _| {
                    let size = default_size(&[], Compartments::default(), p.orientation);
                    let id = add_module(
                        p,
                        None,
                        (c.x - size.width / 2.).round(),
                        (c.y - size.height / 2.).round(),
                    );
                    Some(vec![id])
                })
            }
            "insert.submodule" => self.edit(cx, |p, sel| Some(vec![add_submodule(p, &sel[0])])),
            "insert.inPort" => self.edit(cx, |p, sel| {
                add_port(p, &sel[0], PortRole::In);
                None
            }),
            "insert.outPort" => self.edit(cx, |p, sel| {
                add_port(p, &sel[0], PortRole::Out);
                None
            }),
            "insert.note" | "insert.frame" => {
                if self.tabs.is_empty() {
                    self.add_doc(Document::new(empty_project(), None), Some(window), cx);
                }
                let c = self.view_center(cx);
                let kind = if id == "insert.note" {
                    NoteKind::Note
                } else {
                    NoteKind::Frame
                };
                self.edit(cx, |p, _| {
                    Some(vec![add_note(p, kind, c.x.round(), c.y.round(), None)])
                })
            }
            "view.palette" => self.open_palette(true, window, cx),
            "view.goto" => self.open_palette(false, window, cx),
            "view.fit" => {
                let ids = self.doc().map(|d| d.read(cx).selected.clone());
                self.with_canvas(cx, |c, cx| c.fit_items(ids, cx));
            }
            "view.fitAll" => self.with_canvas(cx, |c, cx| c.fit_items(None, cx)),
            "view.zoomIn" => self.with_canvas(cx, |c, cx| c.zoom_by(1.25, cx)),
            "view.zoomOut" => self.with_canvas(cx, |c, cx| c.zoom_by(0.8, cx)),
            "view.zoomReset" => self.with_canvas(cx, |c, cx| c.zoom_to(1., cx)),
            "view.global" => {
                if let Some(c) = self.canvas() {
                    window.focus(&c.read(cx).focus_handle(), cx);
                }
            }
            "arrange.group" => {
                let mut failed = None;
                self.edit(cx, |p, sel| match group_modules(p, sel) {
                    Ok(g) => g.map(|g| vec![g]),
                    Err(e) => {
                        failed = Some(e);
                        None
                    }
                });
                if let Some(e) = failed {
                    self.error = Some(format!("Cannot group: {e}"));
                    self.output.push(format!("Cannot group: {e}"));
                }
            }
            "arrange.lock" => {
                let lock = !self.command_state(id, cx).checked;
                self.edit(cx, |p, sel| {
                    set_locked(p, sel, lock);
                    None
                });
            }
            "arrange.left" => self.arrange(cx, |r| align(r, AlignMode::Left)),
            "arrange.hcenter" => self.arrange(cx, |r| align(r, AlignMode::HCenter)),
            "arrange.right" => self.arrange(cx, |r| align(r, AlignMode::Right)),
            "arrange.top" => self.arrange(cx, |r| align(r, AlignMode::Top)),
            "arrange.vcenter" => self.arrange(cx, |r| align(r, AlignMode::VCenter)),
            "arrange.bottom" => self.arrange(cx, |r| align(r, AlignMode::Bottom)),
            "arrange.distH" => self.arrange(cx, |r| distribute(r, true)),
            "arrange.distV" => self.arrange(cx, |r| distribute(r, false)),
            "arrange.sameSize" => self.arrange(cx, |r| same_size(r, SizeDim::Both)),
            "arrange.snap" => settings::update(|s| s.snap_to_grid = !s.snap_to_grid),
            "arrange.guides" => settings::update(|s| s.guides = !s.guides),
            "window.settings" => {
                self.dock.toggle(PanelId::Settings);
                prefs::save_dock(&self.dock);
            }
            "window.explorer"
            | "window.inspector"
            | "window.problems"
            | "window.output"
            | "window.search"
            | "window.stateMachine" => {
                if let Some(panel) = PanelId::from_command(id) {
                    self.dock.show(panel);
                    prefs::save_dock(&self.dock);
                    if panel == PanelId::Search {
                        SearchPanel::focus(&self.search.clone(), window, cx);
                    }
                }
            }
            "window.resetLayout" => {
                self.dock = Dock::default();
                prefs::save_dock(&self.dock);
            }
            "window.clearOutput" => self.output.clear(),
            "window.nextDoc" => self.cycle(1),
            "window.prevDoc" => self.cycle(-1),
            "help.shortcuts" => self.open_shortcuts(window, cx),
            "help.about" => self.open_about(window, cx),
            "help.resetData" => {
                prefs::clear();
                self.recent = Vec::new();
                settings::update(|s| *s = settings::Settings::default());
                self.status = Some("App data reset".into());
            }
            _ => {
                if let Some(n) = id.strip_prefix("doc.").and_then(|n| n.parse::<usize>().ok())
                    && n >= 1
                    && n <= self.tabs.len()
                {
                    self.active = n - 1;
                }
            }
        }
        // Another document: keys go to its canvas.
        if (self.tabs.len(), self.active) != (tabs, active)
            && let Some(c) = self.canvas()
        {
            window.focus(&c.read(cx).focus_handle(), cx);
        }
        cx.notify();
    }

    /// Show a message in the status bar and the Output panel.
    pub fn log(&mut self, message: String) {
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let (h, m, s) = ((time / 3600) % 24, (time / 60) % 60, time % 60);
        self.output.push(format!("[{h:02}:{m:02}:{s:02} UTC] {message}"));
        self.status = Some(message);
    }

    /// Show an entity in the inspector, and on the canvas when drawn there.
    pub fn reveal(&mut self, sel: Option<Selection>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.doc() else { return };
        let on_canvas = sel
            .as_ref()
            .filter(|s| s.on_canvas())
            .and_then(|s| s.id().cloned());
        doc.update(cx, |d, cx| {
            d.select_entity(sel);
            cx.notify();
        });
        if let Some(id) = on_canvas {
            self.with_canvas(cx, |c, cx| c.fit_items(Some(vec![id]), cx));
        }
        if settings::get().reveal_inspector {
            self.dock.show(PanelId::Inspector);
        }
        let _ = window;
        cx.notify();
    }

    /// Reveal an entity by id.
    pub fn reveal_id(&mut self, id: Id, window: &mut Window, cx: &mut Context<Self>) {
        let sel = self.doc().and_then(|d| Selection::of(&d.read(cx).project, &id));
        self.reveal(sel, window, cx);
    }

    fn cycle(&mut self, delta: isize) {
        let n = self.tabs.len() as isize;
        if n > 0 {
            self.active = (self.active as isize + delta).rem_euclid(n) as usize;
        }
    }

    fn arrange(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(
            &indexmap::IndexMap<Id, scaffold_model::types::Rect>,
        ) -> indexmap::IndexMap<Id, scaffold_model::types::Rect>,
    ) {
        self.edit(cx, |p, sel| {
            let rects = selected_rects(p, sel);
            apply_absolute(p, &f(&rects));
            None
        });
    }

    fn nudge(&mut self, dx: f64, dy: f64, far: bool, cx: &mut Context<Self>) {
        let step = nudge_step(far);
        if let Some(doc) = self.doc() {
            doc.update(cx, |d, cx| {
                let sel = d.selected.clone();
                d.edit(settings::grid(), |p| nudge(p, &sel, dx * step, dy * step));
                cx.notify();
            });
        }
    }

    fn delete(&mut self, cx: &mut Context<Self>) {
        self.edit(cx, |p, sel| {
            p.links.retain(|l| !sel.contains(&l.id));
            delete_items(p, sel);
            prune_views(p);
            Some(Vec::new())
        });
    }

    /// Copy the selection to the system clipboard; false when nothing can be copied.
    fn copy(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(doc) = self.doc() else { return false };
        let d = doc.read(cx);
        let Some(clip) = copy_items(&d.project, &d.selected) else {
            return false;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(to_text(&clip)));
        true
    }

    fn paste(&mut self, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) else {
            return;
        };
        let Some(clip) = parse_clip(&text) else {
            self.log("The clipboard holds no project content".into());
            return;
        };
        // Into the selected module, else where it was copied from.
        self.edit(cx, |p, sel| {
            let parent = match sel {
                [one] if find_module(p, one).is_some() => PasteParent::Module(Some(one.clone())),
                _ => PasteParent::Original,
            };
            let at = match &parent {
                PasteParent::Module(Some(m)) => {
                    let a = absolute_position(p, m);
                    Some(scaffold_model::types::Point {
                        x: a.x + 20.,
                        y: a.y + 60.,
                    })
                }
                _ => None,
            };
            Some(paste_clip(
                p,
                &clip,
                &PasteOptions {
                    parent,
                    at,
                    ..Default::default()
                },
            ))
        });
    }

    /// Rename the selected module in a dialog.
    fn rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.doc() else { return };
        let d = doc.read(cx);
        let Some(m) = d
            .selected
            .first()
            .and_then(|id| find_module(&d.project, id))
            .cloned()
        else {
            return;
        };
        let input = cx.new(|cx| InputState::new(window, cx).default_value(m.name.clone()));
        input.update(cx, |i, cx| i.focus(window, cx));
        let ws = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, _| {
            let (input, ws, doc, m) = (input.clone(), ws.clone(), doc.clone(), m.clone());
            dialog
                .title("Rename module")
                .child(Input::new(&input))
                .on_ok(move |_, _, cx| {
                    let name = input.read(cx).value().trim().to_string();
                    let target = NameTarget::Module {
                        id: Some(m.id.clone()),
                        parent_id: m.parent_id.clone(),
                    };
                    if let Some(e) = name_error(&doc.read(cx).project, &target, &name) {
                        ws.update(cx, |w, cx| {
                            w.error = Some(e);
                            cx.notify();
                        })
                        .ok();
                        return false;
                    }
                    doc.update(cx, |d, cx| {
                        d.seal();
                        d.edit(settings::grid(), |p| {
                            if let Some(x) = p.modules.iter_mut().find(|x| x.id == m.id) {
                                x.name = name.clone();
                            }
                        });
                        cx.notify();
                    });
                    true
                })
        });
    }

    /// The command palette (`commands`) or the list of the project's entities to go to.
    fn open_palette(&mut self, commands: bool, window: &mut Window, cx: &mut Context<Self>) {
        let state = cx.new(|cx| CommandState::new(window, cx));
        let ws = cx.entity().downgrade();
        let entries: Vec<(String, String, String)> = if commands {
            commands::COMMANDS
                .iter()
                .filter(|c| !c.hidden && self.command_state(c.id, cx).enabled)
                .map(|c| {
                    (
                        c.id.to_string(),
                        format!("{}: {}", c.category.name(), c.title),
                        c.keys.first().map(|k| k.to_string()).unwrap_or_default(),
                    )
                })
                .collect()
        } else {
            self.doc().map_or_else(Vec::new, |d| {
                let p = &d.read(cx).project;
                let paths = scaffold_model::project::project_module_paths(p);
                p.modules
                    .iter()
                    .map(|m| {
                        (
                            m.id.clone(),
                            paths.get(&m.id).cloned().unwrap_or_else(|| m.name.clone()),
                            "module".to_string(),
                        )
                    })
                    .chain(
                        p.links
                            .iter()
                            .map(|l| (l.id.clone(), l.name.clone(), "link".to_string())),
                    )
                    .chain(p.notes.iter().filter(|n| n.view_id.is_none()).map(|n| {
                        (
                            n.id.clone(),
                            n.text.lines().next().unwrap_or("").to_string(),
                            n.kind.to_string(),
                        )
                    }))
                    .collect()
            })
        };
        let entries = std::rc::Rc::new(entries);
        window.open_dialog(cx, move |dialog, _, _| {
            let (ws, entries, state) = (ws.clone(), entries.clone(), state.clone());
            let items: Vec<CommandItem> = entries
                .iter()
                .map(|(_, label, hint)| {
                    let (label, hint) = (label.clone(), hint.clone());
                    CommandItem::new().label(label.clone()).child(move |_, _| {
                        div()
                            .flex()
                            .w_full()
                            .justify_between()
                            .child(label.clone())
                            .child(div().text_xs().opacity(0.6).child(hint.clone()))
                    })
                })
                .collect();
            let confirm_entries = entries.clone();
            dialog.p_0().child(
                Command::new(&state)
                    .items(items)
                    .placeholder(if commands {
                        "Type a command…"
                    } else {
                        "Go to a module, link or note…"
                    })
                    .on_confirm(move |ix, window, cx| {
                        let Some((id, _, _)) = confirm_entries.get(ix.row).cloned() else {
                            return;
                        };
                        window.close_dialog(cx);
                        ws.update(cx, |w, cx| {
                            if commands {
                                w.run(&id, window, cx);
                            } else {
                                w.go_to(id, cx);
                            }
                        })
                        .ok();
                    }),
            )
        });
    }

    /// Select an entity and frame it.
    fn go_to(&mut self, id: Id, cx: &mut Context<Self>) {
        self.with_doc(cx, |d| d.select(vec![id.clone()]));
        let ids = Some(vec![id]);
        self.with_canvas(cx, |c, cx| c.fit_items(ids, cx));
    }

    fn open_shortcuts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.open_dialog(cx, |dialog, _, _| {
            let mut rows = div().flex().flex_col().gap_1().max_h(px(480.)).overflow_hidden();
            for cat in [
                commands::Category::File,
                commands::Category::Edit,
                commands::Category::Insert,
                commands::Category::View,
                commands::Category::Arrange,
                commands::Category::Window,
                commands::Category::Help,
            ] {
                let list: Vec<&commands::Cmd> = commands::COMMANDS
                    .iter()
                    .filter(|c| c.category == cat && !c.keys.is_empty() && !c.hidden)
                    .collect();
                if list.is_empty() {
                    continue;
                }
                rows = rows.child(div().mt_2().font_weight(FontWeight::SEMIBOLD).child(cat.name()));
                for c in list {
                    rows = rows.child(
                        div()
                            .flex()
                            .justify_between()
                            .text_sm()
                            .child(c.title)
                            .child(div().opacity(0.7).child(c.keys.join(", "))),
                    );
                }
            }
            rows = rows.child(
                div()
                    .mt_2()
                    .text_sm()
                    .opacity(0.7)
                    .child("Arrow keys move the selection (Shift: further)."),
            );
            dialog.title("Keyboard shortcuts").w(px(560.)).child(rows)
        });
    }

    fn open_about(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.open_dialog(cx, |dialog, _, _| {
            dialog.title("About ProjectScaffold").child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(format!("ProjectScaffold {} (native preview)", env!("CARGO_PKG_VERSION")))
                    .child(
                        "Architecture editor: modules, ports, typed interfaces and constrained links, saved as a language-agnostic YAML/JSON project file.",
                    )
                    .child(div().text_sm().opacity(0.7).child("Built with GPUI.")),
            )
        });
    }

    /// Rebuild the menu bar when what it shows changed.
    fn refresh_menus(&mut self, cx: &mut Context<Self>) {
        let key: Vec<(usize, bool, bool)> = commands::COMMANDS
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let s = self.command_state(c.id, cx);
                (i, s.enabled, s.checked)
            })
            .chain(std::iter::once((self.recent.len(), true, true)))
            .collect();
        if key == self.menu_key {
            return;
        }
        self.menu_key = key;
        cx.set_menus(commands::app_menus(
            &|id| self.command_state(id, cx),
            &self.recent,
        ));
        let menus = commands::app_menus(&|id| self.command_state(id, cx), &self.recent);
        let owned: Vec<OwnedMenu> = menus.into_iter().map(|m| m.owned()).collect();
        gpui_kit::component::GlobalState::global_mut(cx).set_app_menus(owned);
        self.menu_bar.update(cx, |m, cx| m.reload(cx));
    }

    fn problem_counts(&mut self, cx: &App) -> (usize, usize) {
        let Some(doc) = self.doc() else {
            return (0, 0);
        };
        let key = (doc.entity_id().as_u64() as usize, doc.read(cx).version);
        if self.problems.2 != Some(key) {
            let problems = validate(&doc.read(cx).project);
            let errors = problems.iter().filter(|p| p.severity == Severity::Error).count();
            self.problems = (errors, problems.len() - errors, Some(key));
        }
        (self.problems.0, self.problems.1)
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> Div {
        let t = theme::light();
        let mut bar = div().flex().items_center().gap_1();
        for id in [
            "edit.undo",
            "edit.redo",
            "-",
            "view.fitAll",
            "view.zoomOut",
            "view.zoomIn",
            "-",
            "arrange.snap",
        ] {
            if id == "-" {
                bar = bar.child(div().w(px(1.)).h(px(16.)).bg(t.border));
                continue;
            }
            let c = commands::command(id).expect("toolbar command");
            let s = self.command_state(id, cx);
            let label = match id {
                "edit.undo" => "↶",
                "edit.redo" => "↷",
                "view.fitAll" => "⤢",
                "view.zoomOut" => "−",
                "view.zoomIn" => "+",
                "arrange.snap" => "#",
                _ => c.title,
            };
            let id_owned = id.to_string();
            bar = bar.child(
                div()
                    .id(SharedString::from(format!("tool-{id}")))
                    .px_2()
                    .rounded_md()
                    .text_color(if s.enabled { t.text } else { t.muted })
                    .when(s.checked, |d| d.bg(theme::alpha(t.accent, 0.15)))
                    .when(s.enabled, |d| {
                        d.cursor_pointer().hover(|d| d.bg(theme::alpha(t.text, 0.06)))
                    })
                    .tooltip({
                        let tip = match c.keys.first() {
                            Some(k) => format!("{} ({k})", c.title),
                            None => c.title.to_string(),
                        };
                        move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(tip.clone()).build(window, cx)
                        }
                    })
                    .on_click(cx.listener(move |w, _, window, cx| w.run(&id_owned, window, cx)))
                    .child(label),
            );
        }
        bar
    }

    fn doc_tabs(&self, cx: &mut Context<Self>) -> Div {
        let t = theme::light();
        let mut row = div()
            .flex()
            .items_center()
            .h(px(30.))
            .px_1()
            .gap_1()
            .bg(theme::alpha(t.text, 0.03))
            .border_b_1()
            .border_color(t.border)
            .text_sm();
        for (i, tab) in self.tabs.iter().enumerate() {
            let d = tab.doc.read(cx);
            let active = i == self.active;
            let dirty = d.dirty();
            row = row.child(
                div()
                    .id(("doc-tab", i))
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .h(px(24.))
                    .rounded_t_md()
                    .cursor_pointer()
                    .when(active, |d| {
                        d.bg(t.bg).border_1().border_b_0().border_color(t.border)
                    })
                    .on_click(cx.listener(move |w, ev: &ClickEvent, window, cx| {
                        if ev.is_middle_click() {
                            w.close_doc(i, window, cx);
                        } else {
                            w.active = i.min(w.tabs.len().saturating_sub(1));
                            if let Some(c) = w.canvas() {
                                window.focus(&c.read(cx).focus_handle(), cx);
                            }
                            cx.notify();
                        }
                    }))
                    .child(d.title())
                    .when(i < 9, |d| {
                        d.child(
                            div()
                                .text_xs()
                                .text_color(t.muted)
                                .child(format!("Alt+{}", i + 1)),
                        )
                    })
                    .child(
                        div()
                            .id(("doc-close", i))
                            .px_1()
                            .rounded_sm()
                            .text_color(if dirty { t.accent } else { t.muted })
                            .hover(|d| d.bg(theme::alpha(t.text, 0.08)))
                            .on_click(cx.listener(move |w, _, window, cx| {
                                cx.stop_propagation();
                                w.close_doc(i, window, cx);
                            }))
                            .child(if dirty { "●" } else { "×" }),
                    ),
            );
        }
        row.child(
            div()
                .id("doc-new")
                .px_2()
                .rounded_md()
                .cursor_pointer()
                .hover(|d| d.bg(theme::alpha(t.text, 0.06)))
                .on_click(cx.listener(|w, _, window, cx| w.run("file.new", window, cx)))
                .child("+"),
        )
    }

    fn status_bar(&mut self, cx: &mut Context<Self>) -> Div {
        let t = theme::light();
        let (errors, warnings) = self.problem_counts(cx);
        let doc = self.doc();
        let snap = settings::get().snap_to_grid;
        let item = |d: Div| d.px_2();
        let mut bar = div()
            .flex()
            .items_center()
            .h(px(24.))
            .px_1()
            .text_xs()
            .bg(theme::alpha(t.text, 0.04))
            .border_t_1()
            .border_color(t.border)
            .text_color(t.muted)
            .child(
                div()
                    .flex_1()
                    .px_2()
                    .child(self.status.clone().unwrap_or_else(|| "Ready".into())),
            );
        if let Some(doc) = doc {
            let d = doc.read(cx);
            let zoom = self.canvas().map_or(1., |c| c.read(cx).zoom());
            bar = bar
                .child(item(div()).child(format!("{errors} errors, {warnings} warnings")))
                .when(!d.selected.is_empty(), |b| {
                    b.child(item(div()).child(format!("{} selected", d.selected.len())))
                })
                .child(item(div()).child("Project"))
                .child(
                    item(div())
                        .id("status-snap")
                        .cursor_pointer()
                        .when(snap, |d| d.text_color(t.accent))
                        .on_click(cx.listener(|w, _, window, cx| w.run("arrange.snap", window, cx)))
                        .child("Snap"),
                )
                .child(item(div()).child(format!("{}%", (zoom * 100.).round())))
                .child(item(div()).child(format!(
                    "{}{}",
                    d.path.as_ref().map_or("Unsaved project".to_string(), |p| p.display().to_string()),
                    if d.dirty() { " (modified)" } else { "" }
                )));
        }
        bar
    }

    fn panel_view(&self, p: PanelId) -> AnyView {
        match p {
            PanelId::Explorer => self.explorer.clone().into(),
            PanelId::Search => self.search.clone().into(),
            PanelId::Inspector => self.inspector.clone().into(),
            PanelId::Settings => self.settings_panel.clone().into(),
            PanelId::Problems => self.problems_panel.clone().into(),
            PanelId::Output => self.output_panel.clone().into(),
            PanelId::StateMachine => self.state_machine.clone().into(),
        }
    }

    /// The canvas with the panel regions around it.
    fn docked(&mut self, center: Div, cx: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::component::resizable::{h_resizable, resizable_panel, v_resizable};
        let (errors, warnings) = self.problem_counts(cx);
        let ws = cx.entity().downgrade();
        let area = |w: &Self, r: Region| {
            let a = w.dock.area(r);
            let content = a.active.map_or_else(
                || div().into_any_element(),
                |p| w.panel_view(p).into_any_element(),
            );
            let (ws1, ws2) = (ws.clone(), ws.clone());
            panels::region(
                r,
                a,
                content,
                move |p| {
                    (p == PanelId::Problems && errors + warnings > 0).then(|| (errors + warnings).to_string())
                },
                move |p, _, cx| {
                    ws1.update(cx, |w, cx| {
                        w.dock.show(p);
                        prefs::save_dock(&w.dock);
                        cx.notify();
                    })
                    .ok();
                },
                move |p, _, cx| {
                    ws2.update(cx, |w, cx| {
                        w.dock.close(p);
                        prefs::save_dock(&w.dock);
                        cx.notify();
                    })
                    .ok();
                },
            )
        };
        let (left, right, bottom) = (
            self.dock.left.clone(),
            self.dock.right.clone(),
            self.dock.bottom.clone(),
        );
        let middle = h_resizable("dock-h")
            .child(
                resizable_panel()
                    .size(px(left.size))
                    .visible(left.open && left.active.is_some())
                    .child(area(self, Region::Left)),
            )
            .child(resizable_panel().child(center))
            .child(
                resizable_panel()
                    .size(px(right.size))
                    .visible(right.open && right.active.is_some())
                    .child(area(self, Region::Right)),
            );
        v_resizable("dock-v")
            .child(resizable_panel().child(middle))
            .child(
                resizable_panel()
                    .size(px(bottom.size))
                    .visible(bottom.open && bottom.active.is_some())
                    .child(area(self, Region::Bottom)),
            )
    }

    fn start_screen(&self, cx: &mut Context<Self>) -> Div {
        let t = theme::light();
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_2()
            .bg(t.bg)
            .text_color(t.text)
            .child(div().text_xl().child("ProjectScaffold"))
            .child(
                div()
                    .text_color(t.muted)
                    .child("Open a project (Ctrl+O) or start a new one (Alt+N)"),
            )
            .when(!self.recent.is_empty(), |d| {
                d.child(div().mt_4().text_sm().text_color(t.muted).child("Recent"))
            })
            .children(self.recent.iter().cloned().enumerate().map(|(i, path)| {
                let label = path.display().to_string();
                div()
                    .id(("recent", i))
                    .px_2()
                    .rounded_md()
                    .text_color(t.accent)
                    .cursor_pointer()
                    .hover(|d| d.bg(theme::alpha(t.accent, 0.08)))
                    .on_click(cx.listener(move |w, _, _, cx| w.open_path(path.clone(), cx)))
                    .child(label)
            }))
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = match self.doc() {
            Some(d) => {
                let d = d.read(cx);
                format!(
                    "{}{} — ProjectScaffold",
                    if d.dirty() { "● " } else { "" },
                    d.title()
                )
            }
            None => "ProjectScaffold".into(),
        };
        window.set_window_title(&title);
        // Focus lost with a closed document: keys go to the active canvas.
        if window.focused(cx).is_none() {
            let focus = self
                .canvas()
                .map_or(self.focus.clone(), |c| c.read(cx).focus_handle());
            window.focus(&focus, cx);
        }
        self.refresh_menus(cx);
        let t = theme::light();
        let center = match self.canvas() {
            Some(c) => div().size_full().child(c),
            None => div().size_full().child(self.start_screen(cx)),
        };
        let body = div().flex_1().min_h_0().child(self.docked(center, cx));
        // The file changed on disk while there are unsaved changes.
        let conflict = self.doc().filter(|d| d.read(cx).conflict.is_some()).map(|_| {
            let button = |id: &'static str, label: &'static str| {
                div()
                    .id(id)
                    .px_2()
                    .rounded_md()
                    .border_1()
                    .border_color(theme::hex("#b7791f"))
                    .cursor_pointer()
                    .child(label)
            };
            div()
                .p_2()
                .flex()
                .gap_2()
                .items_center()
                .bg(theme::hex("#fef3c7"))
                .text_color(theme::hex("#744210"))
                .text_sm()
                .child(
                    div()
                        .flex_1()
                        .child("The file changed on disk. Your unsaved changes differ from it."),
                )
                .child(
                    button("reload", "Reload from disk").on_click(cx.listener(|w, _, _, cx| {
                        w.with_doc(cx, |d| {
                            if let Some(text) = d.conflict.clone() {
                                let _ = d.reload(&text);
                            }
                        })
                    })),
                )
                .child(
                    button("keep", "Keep mine")
                        .on_click(cx.listener(|w, _, _, cx| w.with_doc(cx, Document::keep_mine))),
                )
        });
        let error = self.error.clone().map(|e| {
            div()
                .p_2()
                .bg(theme::hex("#fde8e8"))
                .text_color(theme::hex("#9b1c1c"))
                .text_sm()
                .id("error")
                .cursor_pointer()
                .on_click(cx.listener(|w, _, _, cx| {
                    w.error = None;
                    cx.notify();
                }))
                .child(e)
        });
        let title_bar = TitleBar::new()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(self.menu_bar.clone())
                    .child(self.toolbar(cx)),
            )
            .child(div().flex_1().text_sm().text_color(t.muted).child(title));
        let root = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .text_color(t.text)
            .key_context("Workspace")
            .track_focus(&self.focus)
            .on_action(cx.listener(|w, a: &OpenRecent, _, cx| {
                if let Some(p) = w.recent.get(a.index).cloned() {
                    w.open_path(p, cx);
                }
            }));
        let root = commands::on_actions(root, cx);
        root.child(title_bar)
            .when(!self.tabs.is_empty(), |r| r.child(self.doc_tabs(cx)))
            .children(conflict)
            .child(body)
            .children(error)
            .child(self.status_bar(cx))
    }
}
