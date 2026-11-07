//! The single command registry behind menus, context menus, the command palette and shortcuts.
//! Port of `commands.ts`: the same ids, titles, categories and keys. Commands of features not
//! ported yet are listed, disabled.

use std::path::PathBuf;

use gpui_kit::component::menu::PopupMenu;
use gpui_kit::*;

use crate::document::Document;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    File,
    Edit,
    Insert,
    View,
    Arrange,
    Window,
    Help,
}

impl Category {
    pub fn name(self) -> &'static str {
        match self {
            Category::File => "File",
            Category::Edit => "Edit",
            Category::Insert => "Insert",
            Category::View => "View",
            Category::Arrange => "Arrange",
            Category::Window => "Window",
            Category::Help => "Help",
        }
    }
}

/// Where a shortcut works: anywhere in the window, or with the canvas focused (single keys,
/// arrows, Delete: they would steal typing elsewhere).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Window,
    Canvas,
}

#[derive(Clone, Copy, Debug)]
pub struct Cmd {
    pub id: &'static str,
    pub title: &'static str,
    pub category: Category,
    /// Shortcuts in the web build's notation (`Ctrl+Shift+S`, `Alt+1`, `Delete`).
    pub keys: &'static [&'static str],
    pub scope: Scope,
    /// Not listed in menus and palette (shortcut only).
    pub hidden: bool,
}

macro_rules! commands {
    ($($act:ident $id:literal $title:literal $cat:ident [$($k:literal),*] $scope:ident $hidden:literal;)*) => {
        actions!(scaffold, [$($act),*]);

        pub static COMMANDS: &[Cmd] = &[$(Cmd {
            id: $id,
            title: $title,
            category: Category::$cat,
            keys: &[$($k),*],
            scope: Scope::$scope,
            hidden: $hidden,
        }),*];

        /// The action running a command.
        pub fn action(id: &str) -> Option<Box<dyn Action>> {
            match id {
                $($id => Some(Box::new($act)),)*
                _ => None,
            }
        }

        /// Route every command action to `Workspace::run`.
        pub fn on_actions<E: InteractiveElement>(el: E, cx: &mut Context<crate::workspace::Workspace>) -> E {
            el $(.on_action(cx.listener(|w, _: &$act, window, cx| w.run($id, window, cx))))*
        }
    };
}

commands! {
    FileNew "file.new" "New project" File ["Alt+N"] Window false;
    FileOpen "file.open" "Open…" File ["Ctrl+O"] Window false;
    FileSave "file.save" "Save" File ["Ctrl+S"] Window false;
    FileSaveAs "file.saveAs" "Save as…" File ["Ctrl+Shift+S"] Window false;
    FileSaveAll "file.saveAll" "Save all" File ["Ctrl+Alt+S"] Window false;
    FileSaveWorkspace "file.saveWorkspace" "Save workspace" File [] Window false;
    FileSaveWorkspaceAs "file.saveWorkspaceAs" "Save workspace as…" File [] Window false;
    FileImportSettings "file.importSettings" "Import settings…" File [] Window false;
    FileExportSettings "file.exportSettings" "Export settings…" File [] Window false;
    FileClose "file.close" "Close document" File ["Alt+W"] Window false;
    FileExportPng "file.exportPng" "Export diagram as PNG" File [] Window false;
    FileExportSvg "file.exportSvg" "Export diagram as SVG" File [] Window false;
    FileOpenIdlText "file.openIdlText" "Open IDL file as text…" File [] Window false;
    EditUndo "edit.undo" "Undo" Edit ["Ctrl+Z"] Window false;
    EditRedo "edit.redo" "Redo" Edit ["Ctrl+Y", "Ctrl+Shift+Z"] Window false;
    EditCut "edit.cut" "Cut" Edit ["Ctrl+X"] Canvas false;
    EditCopy "edit.copy" "Copy" Edit ["Ctrl+C"] Canvas false;
    EditPaste "edit.paste" "Paste" Edit ["Ctrl+V"] Canvas false;
    EditDuplicate "edit.duplicate" "Duplicate" Edit ["Ctrl+D"] Canvas false;
    EditDelete "edit.delete" "Delete" Edit ["Delete", "Backspace"] Canvas false;
    EditSelectAll "edit.selectAll" "Select all" Edit ["Ctrl+A"] Canvas false;
    EditDeselect "edit.deselect" "Clear selection" Edit ["Escape"] Canvas false;
    EditRename "edit.rename" "Rename module" Edit ["F2"] Canvas false;
    EditNudgeUp "edit.nudgeUp" "Move selection up" Edit ["ArrowUp"] Canvas true;
    EditNudgeUpFar "edit.nudgeUpFar" "Move selection up (far)" Edit ["Shift+ArrowUp"] Canvas true;
    EditNudgeDown "edit.nudgeDown" "Move selection down" Edit ["ArrowDown"] Canvas true;
    EditNudgeDownFar "edit.nudgeDownFar" "Move selection down (far)" Edit ["Shift+ArrowDown"] Canvas true;
    EditNudgeLeft "edit.nudgeLeft" "Move selection left" Edit ["ArrowLeft"] Canvas true;
    EditNudgeLeftFar "edit.nudgeLeftFar" "Move selection left (far)" Edit ["Shift+ArrowLeft"] Canvas true;
    EditNudgeRight "edit.nudgeRight" "Move selection right" Edit ["ArrowRight"] Canvas true;
    EditNudgeRightFar "edit.nudgeRightFar" "Move selection right (far)" Edit ["Shift+ArrowRight"] Canvas true;
    InsertModule "insert.module" "Add module" Insert ["Ctrl+M"] Window false;
    InsertSubmodule "insert.submodule" "Add submodule" Insert ["Alt+M"] Window false;
    InsertInPort "insert.inPort" "Add in port" Insert ["Alt+I"] Window false;
    InsertOutPort "insert.outPort" "Add out port" Insert ["Alt+O"] Window false;
    InsertNote "insert.note" "Add note" Insert [] Window false;
    InsertFrame "insert.frame" "Add frame" Insert [] Window false;
    InsertProjectContent "insert.projectContent" "Import projects or IDL files…" Insert [] Window false;
    InsertDependency "insert.dependency" "Add dependency…" Insert [] Window false;
    InsertRefreshDependencies "insert.refreshDependencies" "Refresh dependencies" Insert [] Window false;
    ViewPalette "view.palette" "Command palette…" View ["Ctrl+Shift+P", "F1"] Window false;
    ViewGoto "view.goto" "Go to…" View ["Ctrl+P"] Window false;
    ViewBack "view.back" "Previous selection" View ["Alt+ArrowLeft"] Window false;
    ViewForward "view.forward" "Next selection" View ["Alt+ArrowRight"] Window false;
    ViewFit "view.fit" "Fit selection" View ["F"] Canvas false;
    ViewFitAll "view.fitAll" "Fit all" View ["Shift+F"] Canvas false;
    ViewZoomIn "view.zoomIn" "Zoom in" View ["+", "="] Canvas false;
    ViewZoomOut "view.zoomOut" "Zoom out" View ["-"] Canvas false;
    ViewZoomReset "view.zoomReset" "Zoom 100%" View ["Ctrl+0"] Window false;
    ViewGlobal "view.global" "Open project view" View ["Alt+G"] Window false;
    ViewOpenModule "view.openModule" "Open module in its own view" View ["Alt+Enter"] Window false;
    ViewOpenModuleSplit "view.openModuleSplit" "Open module view to the side" View [] Window false;
    ViewKeep "view.keep" "Keep view" View [] Window false;
    ViewNew "view.new" "New view" View [] Window false;
    ViewSource "view.source" "Edit as text (YAML)" View ["Alt+U"] Window false;
    ViewHide "view.hide" "Hide selection in view" View ["H"] Canvas false;
    ViewResetLayout "view.resetLayout" "Reset view layout" View [] Window false;
    ViewShowAll "view.showAll" "Show hidden modules" View ["Shift+H"] Canvas false;
    ViewWordWrap "view.wordWrap" "Word wrap" View ["Alt+Z"] Window false;
    ArrangeAuto "arrange.auto" "Auto-arrange (selection content / view)" Arrange ["Ctrl+Alt+L"] Window false;
    ArrangeAll "arrange.all" "Auto-arrange everything" Arrange [] Window false;
    ArrangeHorizontal "arrange.horizontal" "Auto-arrange horizontally (ports left / right)" Arrange ["Ctrl+Alt+H"] Window false;
    ArrangeVertical "arrange.vertical" "Auto-arrange vertically (ports top / bottom)" Arrange ["Ctrl+Alt+V"] Window false;
    ArrangeGroup "arrange.group" "Group into a module" Arrange ["Ctrl+G"] Canvas false;
    ArrangeLock "arrange.lock" "Lock position and size" Arrange ["Ctrl+L"] Canvas false;
    ArrangeLeft "arrange.left" "Align left" Arrange [] Window false;
    ArrangeHCenter "arrange.hcenter" "Align centers horizontally" Arrange [] Window false;
    ArrangeRight "arrange.right" "Align right" Arrange [] Window false;
    ArrangeTop "arrange.top" "Align top" Arrange [] Window false;
    ArrangeVCenter "arrange.vcenter" "Align middles vertically" Arrange [] Window false;
    ArrangeBottom "arrange.bottom" "Align bottom" Arrange [] Window false;
    ArrangeDistH "arrange.distH" "Distribute horizontally" Arrange [] Window false;
    ArrangeDistV "arrange.distV" "Distribute vertically" Arrange [] Window false;
    ArrangeSameSize "arrange.sameSize" "Same size" Arrange [] Window false;
    ArrangeSnap "arrange.snap" "Snap to grid" Arrange [] Window false;
    ArrangeGuides "arrange.guides" "Alignment guides" Arrange [] Window false;
    WindowExplorer "window.explorer" "Explorer" Window [] Window false;
    WindowInspector "window.inspector" "Inspector" Window ["Ctrl+I"] Window false;
    WindowProblems "window.problems" "Problems" Window ["Ctrl+Shift+M"] Window false;
    WindowOutput "window.output" "Output" Window ["Ctrl+Shift+U"] Window false;
    WindowStateMachine "window.stateMachine" "State machine" Window [] Window false;
    WindowClearOutput "window.clearOutput" "Clear output" Window [] Window false;
    WindowSearch "window.search" "Search" Window ["Ctrl+Shift+F"] Window false;
    WindowSettings "window.settings" "Settings" Window ["Ctrl+,"] Window false;
    WindowNextDoc "window.nextDoc" "Next document" Window ["Alt+PageDown"] Window false;
    WindowPrevDoc "window.prevDoc" "Previous document" Window ["Alt+PageUp"] Window false;
    WindowResetLayout "window.resetLayout" "Reset panel layout" Window [] Window false;
    HelpTutorial "help.tutorial" "Tutorial" Help [] Window false;
    HelpShortcuts "help.shortcuts" "Keyboard shortcuts" Help ["?"] Canvas false;
    HelpResetData "help.resetData" "Reset app data…" Help [] Window false;
    HelpAbout "help.about" "About ProjectScaffold" Help [] Window false;
    Doc1 "doc.1" "Go to document 1" Window ["Alt+1"] Window true;
    Doc2 "doc.2" "Go to document 2" Window ["Alt+2"] Window true;
    Doc3 "doc.3" "Go to document 3" Window ["Alt+3"] Window true;
    Doc4 "doc.4" "Go to document 4" Window ["Alt+4"] Window true;
    Doc5 "doc.5" "Go to document 5" Window ["Alt+5"] Window true;
    Doc6 "doc.6" "Go to document 6" Window ["Alt+6"] Window true;
    Doc7 "doc.7" "Go to document 7" Window ["Alt+7"] Window true;
    Doc8 "doc.8" "Go to document 8" Window ["Alt+8"] Window true;
    Doc9 "doc.9" "Go to document 9" Window ["Alt+9"] Window true;
    Quit "app.quit" "Quit" File ["Ctrl+Q"] Window true;
}

/// Opens a recent file (its index in the recent list).
#[derive(Clone, PartialEq, Action)]
#[action(namespace = scaffold, no_json)]
pub struct OpenRecent {
    pub index: usize,
}

pub fn command(id: &str) -> Option<&'static Cmd> {
    COMMANDS.iter().find(|c| c.id == id)
}

/// A shortcut of the web notation in GPUI's: `Ctrl+Shift+S` → `ctrl-shift-s`.
pub fn gpui_key(keys: &str) -> String {
    let (mods, key) = match keys.rfind('+') {
        // A lone `+`, or a modifier then `+`.
        Some(i) if i + 1 == keys.len() => (&keys[..i.saturating_sub(1).min(i)], "+"),
        Some(i) => (&keys[..i], &keys[i + 1..]),
        None => ("", keys),
    };
    let key = match key {
        "ArrowUp" => "up".to_string(),
        "ArrowDown" => "down".to_string(),
        "ArrowLeft" => "left".to_string(),
        "ArrowRight" => "right".to_string(),
        "PageUp" => "pageup".to_string(),
        "PageDown" => "pagedown".to_string(),
        k => k.to_lowercase(),
    };
    let mut out: Vec<String> = mods
        .split('+')
        .filter(|m| !m.is_empty())
        .map(|m| match m {
            "Ctrl" => "ctrl".to_string(),
            "Alt" => "alt".to_string(),
            "Shift" => "shift".to_string(),
            m => m.to_lowercase(),
        })
        .collect();
    out.push(key);
    out.join("-")
}

/// Key bindings of every command, in its scope's key context.
pub fn key_bindings(cx: &App) -> Vec<KeyBinding> {
    let mut out = Vec::new();
    for c in COMMANDS {
        let context = match c.scope {
            Scope::Window => "Workspace",
            Scope::Canvas => "Canvas",
        };
        let predicate = KeyBindingContextPredicate::parse(context).expect("key context");
        let predicate: std::rc::Rc<KeyBindingContextPredicate> = predicate.into();
        // The last binding shows in menus: bind the main key last.
        for k in c.keys.iter().rev() {
            if let Some(a) = action(c.id) {
                out.push(
                    KeyBinding::load(&gpui_key(k), a, Some(predicate.clone()), false, None, cx)
                        .expect("key binding"),
                );
            }
        }
    }
    out
}

/// Menus built from the registry: command ids, `-` between groups, `recent` for recent files.
pub const MENUS: &[(Category, &[&str])] = &[
    (
        Category::File,
        &[
            "file.new",
            "file.open",
            "recent",
            "-",
            "file.save",
            "file.saveAs",
            "file.saveAll",
            "-",
            "file.saveWorkspace",
            "file.saveWorkspaceAs",
            "-",
            "file.importSettings",
            "file.exportSettings",
            "-",
            "file.openIdlText",
            "-",
            "file.exportPng",
            "file.exportSvg",
            "-",
            "file.close",
        ],
    ),
    (
        Category::Edit,
        &[
            "edit.undo",
            "edit.redo",
            "-",
            "edit.cut",
            "edit.copy",
            "edit.paste",
            "edit.duplicate",
            "edit.delete",
            "-",
            "edit.selectAll",
            "edit.rename",
            "-",
            "view.goto",
            "view.palette",
        ],
    ),
    (
        Category::Insert,
        &[
            "insert.module",
            "insert.submodule",
            "insert.inPort",
            "insert.outPort",
            "-",
            "insert.note",
            "insert.frame",
            "-",
            "insert.projectContent",
            "insert.dependency",
            "insert.refreshDependencies",
        ],
    ),
    (
        Category::View,
        &[
            "view.global",
            "view.openModule",
            "view.openModuleSplit",
            "view.keep",
            "view.resetLayout",
            "view.new",
            "view.source",
            "-",
            "view.hide",
            "view.showAll",
            "-",
            "view.fit",
            "view.fitAll",
            "view.zoomIn",
            "view.zoomOut",
            "view.zoomReset",
        ],
    ),
    (
        Category::Arrange,
        &[
            "arrange.auto",
            "arrange.all",
            "arrange.horizontal",
            "arrange.vertical",
            "-",
            "arrange.group",
            "-",
            "arrange.left",
            "arrange.hcenter",
            "arrange.right",
            "arrange.top",
            "arrange.vcenter",
            "arrange.bottom",
            "-",
            "arrange.distH",
            "arrange.distV",
            "arrange.sameSize",
            "-",
            "arrange.snap",
            "arrange.guides",
        ],
    ),
    (
        Category::Window,
        &[
            "window.explorer",
            "window.inspector",
            "window.problems",
            "window.output",
            "window.stateMachine",
            "window.search",
            "window.settings",
            "-",
            "window.nextDoc",
            "window.prevDoc",
            "-",
            "window.resetLayout",
        ],
    ),
    (
        Category::Help,
        &[
            "help.tutorial",
            "help.shortcuts",
            "view.palette",
            "-",
            "help.resetData",
            "-",
            "help.about",
        ],
    ),
];

/// Whether a command can run now, and whether it shows checked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CmdState {
    pub enabled: bool,
    pub checked: bool,
}

fn file_name(p: &std::path::Path) -> String {
    p.file_name()
        .map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// The menu bar's menus, with the state of each command.
pub fn app_menus(state: &dyn Fn(&str) -> CmdState, recent: &[PathBuf]) -> Vec<Menu> {
    MENUS
        .iter()
        .map(|(cat, ids)| Menu {
            name: cat.name().into(),
            items: ids
                .iter()
                .filter_map(|id| match *id {
                    "-" => Some(MenuItem::separator()),
                    "recent" => Some(MenuItem::submenu(Menu {
                        name: "Open Recent".into(),
                        items: recent
                            .iter()
                            .enumerate()
                            .map(|(index, p)| MenuItem::action(file_name(p), OpenRecent { index }))
                            .collect(),
                        disabled: recent.is_empty(),
                    })),
                    id => {
                        let c = command(id)?;
                        let s = state(id);
                        Some(MenuItem::Action {
                            name: c.title.into(),
                            action: action(id)?,
                            os_action: None,
                            checked: s.checked,
                            disabled: !s.enabled,
                        })
                    }
                })
                .collect(),
            disabled: false,
        })
        .collect()
}

fn item(menu: PopupMenu, id: &str, doc: &Document) -> PopupMenu {
    let (Some(c), Some(a)) = (command(id), action(id)) else {
        return menu;
    };
    let s = crate::workspace::doc_command_state(id, Some(doc));
    if s.checked {
        menu.menu_with_check(c.title, true, a)
    } else {
        menu.menu_with_disabled(c.title, a, !s.enabled)
    }
}

/// Context menu of the canvas, after what the right click selected.
pub fn canvas_menu(mut menu: PopupMenu, doc: &Entity<Document>, cx: &App) -> PopupMenu {
    let d = doc.read(cx);
    let p = &d.project;
    let modules = d
        .selected
        .iter()
        .filter(|id| p.modules.iter().any(|m| &m.id == *id))
        .count();
    let ids: &[&str] = if d.selected.is_empty() {
        &[
            "insert.module",
            "insert.note",
            "insert.frame",
            "-",
            "edit.paste",
            "edit.selectAll",
            "-",
            "view.fitAll",
            "arrange.snap",
            "arrange.guides",
        ]
    } else if d.selected.len() == 1 && modules == 1 {
        &[
            "insert.submodule",
            "insert.inPort",
            "insert.outPort",
            "-",
            "edit.cut",
            "edit.copy",
            "edit.paste",
            "edit.duplicate",
            "edit.delete",
            "-",
            "arrange.group",
            "arrange.lock",
            "-",
            "view.fit",
        ]
    } else if d.selected.len() > 1 {
        &[
            "edit.cut",
            "edit.copy",
            "edit.duplicate",
            "edit.delete",
            "-",
            "arrange.group",
            "arrange.lock",
            "-",
            "arrange.left",
            "arrange.hcenter",
            "arrange.right",
            "arrange.top",
            "arrange.vcenter",
            "arrange.bottom",
            "-",
            "arrange.distH",
            "arrange.distV",
            "arrange.sameSize",
            "-",
            "view.fit",
        ]
    } else {
        &[
            "edit.cut",
            "edit.copy",
            "edit.duplicate",
            "edit.delete",
            "-",
            "arrange.lock",
            "-",
            "view.fit",
        ]
    };
    for id in ids {
        menu = if *id == "-" {
            menu.separator()
        } else {
            item(menu, id, d)
        };
    }
    menu
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn keys_in_gpui_notation() {
        assert_eq!(gpui_key("Ctrl+Shift+S"), "ctrl-shift-s");
        assert_eq!(gpui_key("Alt+ArrowLeft"), "alt-left");
        assert_eq!(gpui_key("Delete"), "delete");
        assert_eq!(gpui_key("+"), "+");
        assert_eq!(gpui_key("-"), "-");
        assert_eq!(gpui_key("Ctrl+,"), "ctrl-,");
        assert_eq!(gpui_key("F2"), "f2");
    }

    #[::core::prelude::v1::test]
    fn menus_list_registered_commands() {
        for (_, ids) in MENUS {
            for id in *ids {
                assert!(matches!(*id, "-" | "recent") || command(id).is_some(), "{id}");
            }
        }
        for c in COMMANDS {
            assert!(action(c.id).is_some());
        }
    }
}
