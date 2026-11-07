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
use scaffold_model::clipboard::{
    PasteOptions, PasteParent, copy_items, copy_project, parse_clip, paste_clip, to_text,
};
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
use crate::document::{DiskChange, Document, Grid, Selection};
use crate::panels::explorer::ExplorerPanel;
use crate::panels::inspector::InspectorPanel;
use crate::panels::lists::{OutputPanel, ProblemsPanel, SearchPanel};
use crate::panels::settings_panel::SettingsPanel;
use crate::panels::source::SourcePanel;
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
    pub source: Entity<SourcePanel>,
    /// The workspace file last opened or saved, and what it lists.
    workspace_file: Option<(PathBuf, scaffold_model::workspace::Workspace)>,
    /// Project of each document as last pushed to the documents depending on it.
    synced: std::collections::HashMap<EntityId, Project>,
    /// An IDL file edited as text beside the canvas.
    pub text_file: Option<Entity<crate::panels::text_file::TextFilePanel>>,
    /// Step of the tutorial shown, if any.
    tutorial: Option<usize>,
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
const LATER: &[&str] = &[];

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
        "view.wordWrap" => {
            return CmdState {
                enabled: true,
                checked: s.editor_word_wrap,
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
        "view.back" => on(d.can_travel(-1)),
        "view.openModule" | "view.openModuleSplit" => on(matches!(
            d.selection,
            Some(Selection::Module { .. } | Selection::Imported(_))
        )),
        "view.keep" => on(d
            .active_view()
            .is_some_and(|v| scaffold_model::project::can_keep_view(&v))),
        "view.resetLayout" => on(d
            .active_view()
            .is_some_and(|v| scaffold_layout::view_layout::has_own_layout(&v))),
        "view.showAll" => on(d.active_view().is_some_and(|v| !v.hidden.is_empty())),
        "view.hide" => on(!d.selected.is_empty()),
        "view.forward" => on(d.can_travel(1)),
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

fn is_idl(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("idl"))
}

/// IDL files by path, with the files they include read from disk.
fn idl_files(paths: &[PathBuf]) -> indexmap::IndexMap<String, String> {
    let files: indexmap::IndexMap<String, String> = paths
        .iter()
        .filter_map(|p| {
            Some((
                p.to_string_lossy().replace('\\', "/"),
                std::fs::read_to_string(p).ok()?,
            ))
        })
        .collect();
    scaffold_model::idl::read_idl_includes(&files, |p| std::fs::read_to_string(p).ok())
}

/// Add a view to the project; gives its id.
fn add_view(d: &mut Document, name: &str, root: Option<Id>) -> Id {
    let id = scaffold_model::project::new_id();
    let vid = id.clone();
    d.edit(
        Grid {
            snap: false,
            size: 1.,
        },
        |p| {
            let name = scaffold_model::project::unique_name(name, p.views.iter().map(|v| v.name.as_str()));
            p.views.push(scaffold_model::types::View {
                id: vid,
                name,
                root_module_id: root,
                hidden: Vec::new(),
                layouts: None,
                routes: None,
                port_labels: None,
                stand_ins: None,
                temporary: false,
            });
        },
    );
    id
}

/// Store the temporary view drawn in the project and draw it; gives the id of the view drawn.
fn keep_view(d: &mut Document) -> Id {
    let Some(v) = d.active_view().filter(scaffold_model::project::can_keep_view) else {
        return d.view.clone();
    };
    let id = add_view(d, &v.name, v.root_module_id.clone());
    d.set_view(id.clone());
    id
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
            source: cx.new(|cx| SourcePanel::new(ws.clone(), window, cx)),
            workspace_file: None,
            synced: Default::default(),
            tutorial: None,
            text_file: None,
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
        self.synced.insert(doc.entity_id(), doc.read(cx).project.clone());
        cx.observe(&doc, |w, doc, cx| {
            w.push_to_dependents(&doc, cx);
            cx.notify();
        })
        .detach();
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
        if path
            .to_string_lossy()
            .ends_with(scaffold_model::workspace::WORKSPACE_SUFFIX)
        {
            return self.open_workspace(path, cx);
        }
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

    /// Auto-arrange: the content of the selected module (or the view drawn), everything, or with
    /// an orientation. Port of `arrangeLayout`.
    fn auto_arrange(&mut self, id: &str, cx: &mut Context<Self>) {
        use scaffold_layout::auto_layout::{arrange, arrange_options};
        use scaffold_model::types::Orientation;
        let Some(doc) = self.doc() else { return };
        doc.update(cx, |d, cx| {
            let orientation = match id {
                "arrange.horizontal" => Orientation::Horizontal,
                "arrange.vertical" => Orientation::Vertical,
                _ => d.project.orientation,
            };
            let scope: Option<Id> = match (id, &d.selection) {
                ("arrange.all", _) => None,
                (_, Some(Selection::Module { id, .. }))
                    if d.project.modules.iter().any(|m| m.parent_id.as_ref() == Some(id)) =>
                {
                    Some(id.clone())
                }
                _ => d.active_view().and_then(|v| v.root_module_id),
            };
            let opts = arrange_options(orientation);
            d.seal();
            d.edit_layout(
                Grid {
                    snap: false,
                    size: 1.,
                },
                |p| {
                    let mut q = arrange(p, scope.as_deref(), &opts);
                    q.orientation = orientation;
                    *p = q;
                },
            );
            d.seal();
            cx.notify();
        });
    }

    /// Export the view drawn as an SVG or PNG image next to the project file.
    fn export_image(&mut self, png: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(canvas), Some(doc)) = (self.canvas(), self.doc()) else {
            return;
        };
        let svg = {
            let c = canvas.read(cx);
            let (p, scene) = c.drawn();
            crate::export::scene_svg(p, scene)
        };
        let d = doc.read(cx);
        let dir = d
            .path
            .as_deref()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default();
        let stem = d
            .path
            .as_deref()
            .and_then(|p| p.file_name())
            .map_or("project".to_string(), |n| {
                let n = n.to_string_lossy();
                n.split('.').next().unwrap_or("project").to_string()
            });
        let view = d
            .active_view()
            .map(|v| format!("-{}", v.name))
            .unwrap_or_default();
        let name = format!("{stem}{view}.{}", if png { "png" } else { "svg" });
        let rx = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(path))) = rx.await {
                let bytes = if png {
                    crate::export::svg_png(&svg, 2.)
                } else {
                    Ok(svg.into_bytes())
                };
                let result = bytes.and_then(|b| std::fs::write(&path, b).map_err(|e| e.to_string()));
                this.update(cx, |w, cx| {
                    match result {
                        Ok(()) => w.log(format!("Exported {}", path.display())),
                        Err(e) => w.error = Some(format!("{}: {e}", path.display())),
                    }
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    /// The tutorial card, over the bottom right corner of the work.
    fn tutorial_card(&self, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        use crate::tutorial::STEPS;
        let i = self.tutorial?.min(STEPS.len() - 1);
        let step = &STEPS[i];
        let t = theme::current();
        let button = |id: SharedString, label: String, enabled: bool| {
            div()
                .id(id)
                .px_2()
                .py(px(2.))
                .rounded_md()
                .border_1()
                .border_color(t.border)
                .text_sm()
                .when(enabled, |d| {
                    d.cursor_pointer().hover(|d| d.bg(theme::alpha(t.accent, 0.08)))
                })
                .when(!enabled, |d| d.opacity(0.5))
                .child(label)
        };
        let tries = step.commands.iter().filter_map(|id| {
            let c = commands::command(id)?;
            let enabled = self.command_state(id, cx).enabled;
            let key = c.keys.first().map(|k| format!(" ({k})")).unwrap_or_default();
            let id = *id;
            Some(
                button(
                    SharedString::from(format!("tut-{id}")),
                    format!("{}{key}", c.title),
                    enabled,
                )
                .when(enabled, |b| {
                    b.on_click(cx.listener(move |w, _, window, cx| w.run(id, window, cx)))
                }),
            )
        });
        let last = i + 1 >= STEPS.len();
        Some(
            div()
                .id("tutorial")
                .absolute()
                .right(px(16.))
                .bottom(px(16.))
                .w(px(380.))
                .p_3()
                .rounded_lg()
                .border_1()
                .border_color(t.border)
                .bg(t.panel)
                .shadow_lg()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(step.title))
                        .child(div().text_xs().text_color(t.muted).child(format!(
                            "{} / {}",
                            i + 1,
                            STEPS.len()
                        ))),
                )
                .children(step.text.iter().map(|x| div().text_sm().child(*x)))
                .child(div().flex().flex_wrap().gap_1().children(tries))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .justify_end()
                        .child(
                            button("tut-close".into(), "Close".into(), true).on_click(cx.listener(
                                |w, _, _, cx| {
                                    w.tutorial = None;
                                    cx.notify();
                                },
                            )),
                        )
                        .child(button("tut-back".into(), "Back".into(), i > 0).when(i > 0, |b| {
                            b.on_click(cx.listener(move |w, _, _, cx| {
                                w.tutorial = Some(i - 1);
                                cx.notify();
                            }))
                        }))
                        .child(
                            button(
                                "tut-next".into(),
                                if last { "Done".into() } else { "Next".into() },
                                true,
                            )
                            .on_click(cx.listener(move |w, _, _, cx| {
                                w.tutorial = if last { None } else { Some(i + 1) };
                                cx.notify();
                            })),
                        ),
                ),
        )
    }

    /// The project saved at `path`: an open document's, else read from the file.
    fn project_at(&self, path: &std::path::Path, cx: &App) -> Option<Project> {
        let canon = std::fs::canonicalize(path).ok()?;
        if let Some(t) = self.tabs.iter().find(|t| {
            t.doc
                .read(cx)
                .path
                .as_ref()
                .and_then(|p| std::fs::canonicalize(p).ok())
                == Some(canon.clone())
        }) {
            return Some(t.doc.read(cx).project.clone());
        }
        if is_idl(path) {
            let files = idl_files(&[path.to_path_buf()]);
            return scaffold_model::idl::idl_project(&path.to_string_lossy(), &files)
                .ok()
                .map(|r| r.project);
        }
        let text = std::fs::read_to_string(path).ok()?;
        scaffold_model::serialize::load_text(
            &text,
            scaffold_model::serialize::format_from_path(&path.to_string_lossy()),
        )
        .ok()
    }

    /// Edit a text (IDL) file beside the canvas.
    pub fn open_text(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        use crate::panels::text_file::{CloseText, TextFilePanel};
        if let Some(t) = &self.text_file
            && t.read(cx).dirty()
        {
            self.error = Some("Save or close the IDL file being edited first.".into());
            cx.notify();
            return;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                self.error = Some(format!("{}: {e}", path.display()));
                cx.notify();
                return;
            }
        };
        let panel = cx.new(|cx| TextFilePanel::new(path, text, window, cx));
        cx.subscribe(&panel, |w, _, _: &CloseText, cx| {
            w.text_file = None;
            cx.notify();
        })
        .detach();
        self.text_file = Some(panel);
        cx.notify();
    }

    /// Copy the content of picked project and IDL files into the project. Port of
    /// `importProjectContent`.
    fn pick_import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Import".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update(cx, |w, cx| w.import_content(paths, cx)).ok();
            }
        })
        .detach();
    }

    pub fn import_content(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        use scaffold_model::dependencies::add_dependency_of;
        use scaffold_model::sync::relative_file;
        let Some(doc) = self.doc() else { return };
        let (idl, projects): (Vec<PathBuf>, Vec<PathBuf>) = paths.into_iter().partition(|p| is_idl(p));
        let mut lines = Vec::new();
        let mut at = self.view_center(cx);
        let parent = doc.read(cx).selection.as_ref().and_then(|s| match s {
            Selection::Module { id, .. } => Some(id.clone()),
            _ => None,
        });
        let mut pasted: Vec<Id> = Vec::new();
        let (mut modules, mut defs) = (0, 0);
        // IDL files first, whole.
        if !idl.is_empty() {
            let files = idl_files(&idl);
            match scaffold_model::idl::parse_idl_files(&files) {
                Err(e) => lines.push(format!("Cannot read the IDL files: {e}")),
                Ok(file) => {
                    lines.extend(file.warnings.iter().cloned());
                    let target = doc.read(cx).project.clone();
                    let r = scaffold_model::idl::idl_import(&file, &target, None, true);
                    lines.extend(
                        r.unresolved
                            .iter()
                            .map(|n| format!("{n} is defined in none of the files: added empty")),
                    );
                    if let Some(clip) = r.clip {
                        modules += clip.modules.len();
                        defs += clip.types.len() + clip.interfaces.len();
                        let opts = PasteOptions {
                            parent: PasteParent::Module(None),
                            at: Some(scaffold_model::types::Point { x: at.x, y: at.y }),
                            ..Default::default()
                        };
                        doc.update(cx, |d, _| {
                            d.edit(
                                Grid {
                                    snap: false,
                                    size: 1.,
                                },
                                |p| pasted.extend(paste_clip(p, &clip, &opts)),
                            )
                        });
                    }
                }
            }
        }
        let own = doc
            .read(cx)
            .path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());
        for path in projects {
            let Some(other) = self.project_at(&path, cx) else {
                lines.push(format!("Cannot read {}", path.display()));
                continue;
            };
            let file = relative_file(own.as_deref(), &path.to_string_lossy());
            doc.update(cx, |d, _| {
                d.edit(
                    Grid {
                        snap: false,
                        size: 1.,
                    },
                    |p| {
                        // Its dependencies are used here too, not copied.
                        for n in other.dependencies.iter().filter(|n| !n.indirect) {
                            let r = add_dependency_of(p, &other, &file, &n.id);
                            lines.extend(Self::dependency_lines(&r));
                        }
                        // Below what was pasted before.
                        let below: Vec<_> = pasted
                            .iter()
                            .filter(|id| p.modules.iter().any(|m| &m.id == *id))
                            .map(|id| scaffold_model::project::absolute_rect(p, id))
                            .collect();
                        if !below.is_empty() {
                            let b = scaffold_model::project::bounds_of(&below);
                            at.y = b.y + b.height + 60.;
                        }
                        let Some(content) = copy_project(&other, p, parent.is_none()) else {
                            lines.push(format!("{} is empty", path.display()));
                            return;
                        };
                        modules += content.modules.len();
                        defs += content.types.len() + content.interfaces.len();
                        let opts = PasteOptions {
                            parent: PasteParent::Module(parent.clone()),
                            at: Some(scaffold_model::types::Point { x: at.x, y: at.y }),
                            ..Default::default()
                        };
                        pasted.extend(paste_clip(p, &content, &opts));
                    },
                );
            });
        }
        doc.update(cx, |d, cx| {
            d.seal();
            let ids: Vec<Id> = pasted
                .iter()
                .filter(|id| d.project.modules.iter().any(|m| &m.id == *id))
                .cloned()
                .collect();
            d.select(ids);
            cx.notify();
        });
        self.report(
            format!("Imported {modules} modules, {defs} types and interfaces"),
            lines,
            cx,
        );
    }

    /// Lines telling what a dependency change did.
    fn dependency_lines(r: &scaffold_model::dependencies::DependencyResult) -> Vec<String> {
        r.conflicts
            .iter()
            .map(|x| format!("Not taken: {x}"))
            .chain(r.renamed.iter().map(|x| format!("Renamed {x}")))
            .chain(
                r.detached
                    .iter()
                    .map(|x| format!("{x}: no longer in its project, kept here")),
            )
            .chain(r.missing.iter().cloned())
            .collect()
    }

    fn report(&mut self, what: String, lines: Vec<String>, cx: &mut Context<Self>) {
        if lines.is_empty() {
            self.log(what);
        } else {
            self.error = Some(format!("{what}\n{}", lines.join("\n")));
        }
        cx.notify();
    }

    /// Depend on project files picked by the user (with the dependencies they read).
    fn pick_dependency(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Depend on".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update(cx, |w, cx| w.depend_on(paths, cx)).ok();
            }
        })
        .detach();
    }

    pub fn depend_on(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        use scaffold_model::dependencies::{DependencySource, add_dependencies};
        use scaffold_model::sync::{base_name, relative_file};
        let Some(doc) = self.doc() else { return };
        let own = doc
            .read(cx)
            .path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());
        let mut lines = Vec::new();
        let mut read: Vec<(Project, String, bool)> = Vec::new();
        for path in &paths {
            let Some(p) = self.project_at(path, cx) else {
                lines.push(format!("Cannot read {}", path.display()));
                continue;
            };
            // The dependencies it reads come along, as indirect ones.
            let dir = path.parent().map(PathBuf::from).unwrap_or_default();
            for d in &p.dependencies {
                let nested = dir.join(&d.file);
                if let Some(q) = self.project_at(&nested, cx) {
                    read.push((q, relative_file(own.as_deref(), &nested.to_string_lossy()), true));
                }
            }
            read.insert(
                0,
                (p, relative_file(own.as_deref(), &path.to_string_lossy()), false),
            );
        }
        if read.is_empty() {
            return self.report("No dependency added".into(), lines, cx);
        }
        let names: Vec<String> = read
            .iter()
            .filter(|r| !r.2)
            .map(|r| base_name(&r.1).to_string())
            .collect();
        let self_name = own.as_deref().map(|o| base_name(o).to_string());
        let result = doc.update(cx, |d, cx| {
            let mut r = Default::default();
            d.edit(
                Grid {
                    snap: false,
                    size: 1.,
                },
                |p| {
                    let sources: Vec<DependencySource> = read
                        .iter()
                        .map(|(q, file, indirect)| DependencySource {
                            project: q,
                            file: file.clone(),
                            indirect: *indirect,
                        })
                        .collect();
                    r = add_dependencies(p, &sources, self_name.as_deref());
                },
            );
            cx.notify();
            r
        });
        lines.extend(Self::dependency_lines(&result));
        self.report(format!("Depending on {}", names.join(", ")), lines, cx);
    }

    /// Read the dependencies again from their projects.
    fn refresh_dependencies(&mut self, cx: &mut Context<Self>) {
        use scaffold_model::dependencies::refresh_dependencies;
        use scaffold_model::sync::base_name;
        let Some(doc) = self.doc() else { return };
        let (deps, own) = {
            let d = doc.read(cx);
            (d.project.dependencies.clone(), d.path.clone())
        };
        let dir = own
            .as_deref()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .unwrap_or_default();
        let mut lines = Vec::new();
        let mut sources = std::collections::HashMap::new();
        for x in &deps {
            match self.project_at(&dir.join(&x.file), cx) {
                Some(p) => {
                    sources.insert(x.id.clone(), p);
                }
                None if !x.indirect => {
                    lines.push(format!("{}: cannot read {} next to this file", x.name, x.file))
                }
                None => {}
            }
        }
        let n = sources.len();
        if n > 0 {
            let self_name = own
                .as_deref()
                .map(|o| base_name(&o.to_string_lossy()).to_string());
            let r = doc.update(cx, |d, cx| {
                let mut r = Default::default();
                d.edit(
                    Grid {
                        snap: false,
                        size: 1.,
                    },
                    |p| r = refresh_dependencies(p, &sources, self_name.as_deref()),
                );
                cx.notify();
                r
            });
            lines.extend(Self::dependency_lines(&r));
        }
        self.report(
            format!("Refreshed {n} dependenc{}", if n == 1 { "y" } else { "ies" }),
            lines,
            cx,
        );
    }

    /// Carry a document's renames and definitions to the open documents depending on it, each as
    /// an undoable edit of its own. Port of `store/sync.ts`.
    fn push_to_dependents(&mut self, doc: &Entity<Document>, cx: &mut Context<Self>) {
        use scaffold_model::dependencies::{apply_dependency_renames, refresh_dependencies};
        use scaffold_model::sync::{base_name, diff_renames, is_dependency_file};
        let (next, file) = {
            let d = doc.read(cx);
            (d.project.clone(), d.path.clone())
        };
        let Some(prev) = self.synced.insert(doc.entity_id(), next.clone()) else {
            return;
        };
        // What dependents read: definitions, modules and ports, and the dependencies carried along.
        if prev.types == next.types
            && prev.interfaces == next.interfaces
            && prev.consts == next.consts
            && prev.modules == next.modules
            && prev.dependencies == next.dependencies
        {
            return;
        }
        let Some(file) = file.map(|f| f.to_string_lossy().into_owned()) else {
            return;
        };
        let linked: Vec<Entity<Document>> = self
            .tabs
            .iter()
            .map(|t| t.doc.clone())
            .filter(|d| d.entity_id() != doc.entity_id())
            .filter(|d| {
                let d = d.read(cx);
                let from = d.path.as_ref().map(|p| p.to_string_lossy().into_owned());
                d.project
                    .dependencies
                    .iter()
                    .any(|x| is_dependency_file(from.as_deref(), &x.file, &file))
            })
            .collect();
        if linked.is_empty() {
            return;
        }
        let renames = diff_renames(&prev, &next);
        let mut updated = Vec::new();
        let mut conflicts = Vec::new();
        for d in linked {
            let changed = d.update(cx, |d, cx| {
                let from = d.path.as_ref().map(|p| p.to_string_lossy().into_owned());
                let self_name = from.as_deref().map(|f| base_name(f).to_string());
                let title = d.title();
                d.seal();
                let changed = d.edit(
                    Grid {
                        snap: false,
                        size: 1.,
                    },
                    |p| {
                        let Some(dep) = p
                            .dependencies
                            .iter()
                            .find(|x| is_dependency_file(from.as_deref(), &x.file, &file))
                            .map(|x| (x.id.clone(), x.file.clone()))
                        else {
                            return;
                        };
                        if let Some(r) = &renames {
                            apply_dependency_renames(p, &dep.1, r);
                        }
                        let sources = std::collections::HashMap::from([(dep.0, next.clone())]);
                        conflicts.extend(refresh_dependencies(p, &sources, self_name.as_deref()).conflicts);
                    },
                );
                d.seal();
                if changed {
                    cx.notify();
                }
                changed.then_some(title)
            });
            updated.extend(changed);
        }
        if !conflicts.is_empty() {
            self.status = Some(format!("Not taken from this project: {}", conflicts.join("; ")));
        } else if !updated.is_empty() && renames.is_some() {
            self.status = Some(format!("Renamed in dependent documents: {}", updated.join(", ")));
        }
    }

    /// Open the projects a workspace file lists.
    fn open_workspace(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        use scaffold_model::serialize::{Format, parse_text};
        use scaffold_model::workspace::workspace_from_file;
        let read = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| parse_text(&t, Format::Yaml).map_err(|e| e.to_string()))
            .and_then(|data| workspace_from_file(&data).map_err(|e| e.to_string()));
        match read {
            Ok(ws) => {
                prefs::add_recent(&path);
                self.recent = prefs::recent();
                let dir = path.parent().map(PathBuf::from).unwrap_or_default();
                for p in &ws.projects {
                    self.open_path(dir.join(p), cx);
                }
                self.log(format!(
                    "Opened workspace {} ({} projects)",
                    ws.name,
                    ws.projects.len()
                ));
                self.workspace_file = Some((path, ws));
            }
            Err(e) => {
                self.error = Some(format!("{}:\n{e}", path.display()));
                cx.notify();
            }
        }
    }

    /// Save the open project files as a workspace file.
    fn save_workspace(&mut self, save_as: bool, window: &mut Window, cx: &mut Context<Self>) {
        use scaffold_model::workspace::{WORKSPACE_SUFFIX, Workspace as Ws};
        let saved: Vec<PathBuf> = self
            .tabs
            .iter()
            .filter_map(|t| t.doc.read(cx).path.clone())
            .collect();
        if saved.is_empty() {
            self.error = Some("No project file to list in a workspace: save the open projects first.".into());
            cx.notify();
            return;
        }
        let name = self.workspace_file.as_ref().map_or_else(
            || {
                let n = self.tabs[0].doc.read(cx).project.name.clone();
                if n.is_empty() { "Workspace".into() } else { n }
            },
            |(_, w)| w.name.clone(),
        );
        let description = self
            .workspace_file
            .as_ref()
            .and_then(|(_, w)| w.description.clone());
        let target = self
            .workspace_file
            .as_ref()
            .map(|(p, _)| p.clone())
            .filter(|_| !save_as);
        let dir = saved[0].parent().map(PathBuf::from).unwrap_or_default();
        let file: String = name
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let write = move |w: &mut Self, path: PathBuf, cx: &mut Context<Self>| {
            let dir = path.parent().map(PathBuf::from).unwrap_or_default();
            // Paths relative to the workspace file when inside its folder, else file names.
            let projects: Vec<String> = saved
                .iter()
                .map(|p| {
                    p.strip_prefix(&dir).map_or_else(
                        |_| {
                            p.file_name()
                                .map_or(String::new(), |n| n.to_string_lossy().into_owned())
                        },
                        |r| r.to_string_lossy().replace('\\', "/"),
                    )
                })
                .collect();
            let ws = Ws {
                name: name.clone(),
                description: description.clone(),
                projects,
            };
            match std::fs::write(&path, scaffold_model::workspace::workspace_text(&ws)) {
                Ok(()) => {
                    w.log(format!("Saved workspace {}", path.display()));
                    prefs::add_recent(&path);
                    w.recent = prefs::recent();
                    w.workspace_file = Some((path, ws));
                }
                Err(e) => w.error = Some(format!("{}: {e}", path.display())),
            }
            cx.notify();
        };
        if let Some(path) = target {
            write(self, path, cx);
            return;
        }
        let rx = cx.prompt_for_new_path(&dir, Some(&format!("{file}{WORKSPACE_SUFFIX}")));
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(path))) = rx.await {
                this.update(cx, |w, cx| write(w, path, cx)).ok();
            }
        })
        .detach();
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
                this.update_in(cx, |w, window, cx| {
                    for path in paths {
                        // IDL files open as text.
                        if is_idl(&path) {
                            w.open_text(path, window, cx);
                        } else {
                            w.open_path(path, cx);
                        }
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
                d.edit_layout(settings::grid(), |p| next = f(p, &sel));
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
            "help.tutorial" => CmdState {
                enabled: true,
                checked: self.tutorial.is_some(),
            },
            "view.source" => CmdState {
                enabled: doc.is_some(),
                checked: self.dock.source,
            },
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
            "view.back" | "view.forward" => {
                let delta = if id == "view.back" { -1 } else { 1 };
                if let Some(doc) = self.doc() {
                    let sel = doc.update(cx, |d, _| d.travel(delta));
                    if sel.is_some() {
                        // Revealing records nothing: it is the history's own entry.
                        self.reveal(sel, window, cx);
                    }
                }
            }
            "view.new" => self.with_doc(cx, |d| {
                let id = add_view(d, "View", None);
                d.set_view(id);
            }),
            "view.openModule" | "view.openModuleSplit" => self.with_doc(cx, |d| {
                let id = match &d.selection {
                    Some(Selection::Module { id, .. } | Selection::Imported(id)) => id.clone(),
                    _ => return,
                };
                let existing = d
                    .project
                    .views
                    .iter()
                    .find(|v| v.root_module_id.as_ref() == Some(&id) && v.hidden.is_empty())
                    .map(|v| v.id.clone());
                d.set_view(existing.unwrap_or_else(|| scaffold_model::project::isolated_view_id(&id)));
            }),
            "view.keep" => self.with_doc(cx, |d| {
                keep_view(d);
            }),
            "view.hide" => self.with_doc(cx, |d| {
                let ids: Vec<Id> = d
                    .selected
                    .iter()
                    .filter(|id| d.project.modules.iter().any(|m| &m.id == *id))
                    .cloned()
                    .collect();
                if ids.is_empty() {
                    return;
                }
                // The global view and temporary views are stored first.
                let view = if d.view == scaffold_model::types::GLOBAL_VIEW {
                    let id = add_view(d, "Filtered", None);
                    d.set_view(id.clone());
                    id
                } else {
                    keep_view(d)
                };
                d.edit(
                    Grid {
                        snap: false,
                        size: 1.,
                    },
                    |p| {
                        if let Some(v) = p.views.iter_mut().find(|v| v.id == view) {
                            for id in ids {
                                if !v.hidden.contains(&id) {
                                    v.hidden.push(id);
                                }
                            }
                        }
                    },
                );
                d.select(Vec::new());
            }),
            "view.showAll" => self.with_doc(cx, |d| {
                let view = d.view.clone();
                d.edit(
                    Grid {
                        snap: false,
                        size: 1.,
                    },
                    |p| {
                        if let Some(v) = p.views.iter_mut().find(|v| v.id == view) {
                            v.hidden.clear();
                        }
                    },
                );
            }),
            "view.resetLayout" => self.with_doc(cx, |d| {
                let view = d.view.clone();
                d.edit(
                    Grid {
                        snap: false,
                        size: 1.,
                    },
                    |p| {
                        if let Some(v) = p.views.iter_mut().find(|v| v.id == view) {
                            v.layouts = None;
                            v.routes = None;
                            v.port_labels = None;
                            v.stand_ins = None;
                        }
                    },
                );
            }),
            "arrange.auto" | "arrange.all" | "arrange.horizontal" | "arrange.vertical" => {
                self.auto_arrange(id, cx);
                self.with_canvas(cx, |c, cx| c.fit_items(None, cx));
            }
            "file.exportSvg" | "file.exportPng" => self.export_image(id == "file.exportPng", window, cx),
            "insert.projectContent" => self.pick_import(window, cx),
            "file.exportSettings" => {
                let text = format!(
                    "{}\n",
                    serde_json::to_string_pretty(&settings::get()).unwrap_or_default()
                );
                let dir = std::env::current_dir().unwrap_or_default();
                let rx = cx.prompt_for_new_path(&dir, Some("project-scaffold.settings.json"));
                cx.spawn_in(window, async move |this, cx| {
                    if let Ok(Ok(Some(path))) = rx.await {
                        let r = std::fs::write(&path, text);
                        this.update(cx, |w, cx| {
                            match r {
                                Ok(()) => w.log(format!("Exported settings to {}", path.display())),
                                Err(e) => w.error = Some(format!("{}: {e}", path.display())),
                            }
                            cx.notify();
                        })
                        .ok();
                    }
                })
                .detach();
            }
            "file.importSettings" => {
                let rx = cx.prompt_for_paths(PathPromptOptions {
                    files: true,
                    directories: false,
                    multiple: false,
                    prompt: Some("Import settings".into()),
                });
                cx.spawn_in(window, async move |this, cx| {
                    if let Ok(Ok(Some(paths))) = rx.await
                        && let Some(path) = paths.into_iter().next()
                    {
                        let r = std::fs::read_to_string(&path)
                            .map_err(|e| e.to_string())
                            .and_then(|t| settings::import(&t));
                        this.update(cx, |w, cx| {
                            match r {
                                Ok(n) => w.log(format!("Imported {n} settings from {}", path.display())),
                                Err(e) => {
                                    w.error =
                                        Some(format!("Cannot import settings from {}: {e}", path.display()))
                                }
                            }
                            cx.refresh_windows();
                        })
                        .ok();
                    }
                })
                .detach();
            }
            "file.openIdlText" => {
                let rx = cx.prompt_for_paths(PathPromptOptions {
                    files: true,
                    directories: false,
                    multiple: false,
                    prompt: Some("Open IDL file".into()),
                });
                cx.spawn_in(window, async move |this, cx| {
                    if let Ok(Ok(Some(paths))) = rx.await
                        && let Some(path) = paths.into_iter().next()
                    {
                        this.update_in(cx, |w, window, cx| w.open_text(path, window, cx))
                            .ok();
                    }
                })
                .detach();
            }
            "insert.dependency" => self.pick_dependency(window, cx),
            "insert.refreshDependencies" => self.refresh_dependencies(cx),
            "file.saveWorkspace" => self.save_workspace(false, window, cx),
            "file.saveWorkspaceAs" => self.save_workspace(true, window, cx),
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
            "view.source" => {
                self.dock.source = !self.dock.source;
                prefs::save_dock(&self.dock);
                if self.dock.source {
                    let editor = self.source.read(cx).editor.clone();
                    editor.update(cx, |e, cx| e.focus(window, cx));
                }
            }
            "view.wordWrap" => settings::update(|s| s.editor_word_wrap = !s.editor_word_wrap),
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
            "help.tutorial" => self.tutorial = if self.tutorial.is_some() { None } else { Some(0) },
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
        let t = theme::current();
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
        let t = theme::current();
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
        let t = theme::current();
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
        let t = theme::current();
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
        // The system theme follows the window's appearance; the components follow the theme.
        theme::set_system_dark(matches!(
            window.appearance(),
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        ));
        let dark = theme::current().dark;
        if gpui_kit::component::theme::Theme::global(cx).is_dark() != dark {
            let mode = if dark {
                gpui_kit::component::theme::ThemeMode::Dark
            } else {
                gpui_kit::component::theme::ThemeMode::Light
            };
            gpui_kit::component::theme::Theme::change(mode, Some(window), cx);
        }
        // Focus lost with a closed document: keys go to the active canvas.
        if window.focused(cx).is_none() {
            let focus = self
                .canvas()
                .map_or(self.focus.clone(), |c| c.read(cx).focus_handle());
            window.focus(&focus, cx);
        }
        self.refresh_menus(cx);
        let t = theme::current();
        let center = match self.canvas() {
            Some(c) if self.text_file.is_some() => {
                let mut split = gpui_kit::component::resizable::h_resizable("center-text")
                    .child(gpui_kit::component::resizable::resizable_panel().child(c));
                if self.dock.source {
                    split = split.child(
                        gpui_kit::component::resizable::resizable_panel()
                            .size(px(480.))
                            .child(self.source.clone()),
                    );
                }
                div().size_full().child(
                    split.child(
                        gpui_kit::component::resizable::resizable_panel()
                            .size(px(480.))
                            .child(self.text_file.clone().unwrap()),
                    ),
                )
            }
            Some(c) if self.dock.source => div().size_full().child(
                gpui_kit::component::resizable::h_resizable("center")
                    .child(gpui_kit::component::resizable::resizable_panel().child(c))
                    .child(
                        gpui_kit::component::resizable::resizable_panel()
                            .size(px(520.))
                            .child(self.source.clone()),
                    ),
            ),
            Some(c) => div().size_full().child(c),
            None => div().size_full().child(self.start_screen(cx)),
        };
        let body = div()
            .flex_1()
            .min_h_0()
            .relative()
            .child(self.docked(center, cx))
            .children(self.tutorial_card(cx));
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
