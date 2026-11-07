//! Editor settings (the web build's `store/settings.ts`), kept in `<config dir>/settings.json`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::document::Grid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// system, light, dark, or a tinted dark theme.
    pub theme: String,
    pub snap_to_grid: bool,
    pub grid_size: f64,
    /// Alignment guides and snapping to sibling edges while dragging.
    pub guides: bool,
    /// Only selected modules, notes and frames move when dragged; others pan the view.
    pub select_to_move: bool,
    pub edge_style: String,
    pub port_style: String,
    pub minimap: bool,
    pub edge_badges: bool,
    pub auto_orient_links: bool,
    pub inheritance: bool,
    pub associations: bool,
    pub auto_layout_on_open: bool,
    pub reveal_inspector: bool,
    pub force_animations: bool,
    pub editor_font_size: f64,
    pub editor_font_family: String,
    pub editor_line_height: f64,
    pub editor_tab_size: f64,
    pub editor_indent_tabs: bool,
    pub editor_whitespace: String,
    pub editor_indent_guides: bool,
    pub editor_word_wrap: bool,
    pub editor_line_numbers: bool,
    pub editor_folding: bool,
    pub editor_active_line: bool,
    pub editor_bracket_matching: bool,
    pub editor_close_brackets: bool,
    pub editor_autocomplete: bool,
    pub editor_selection_matches: bool,
    pub editor_scroll_past_end: bool,
    pub editor_minimap: bool,
    pub editor_minimap_render: String,
    pub source_follow: bool,
    pub source_changes: bool,
    pub explorer_order: Vec<String>,
    pub explorer_hidden: Vec<String>,
    pub explorer_sticky: bool,
    pub toolbar: Vec<String>,
    pub toolbar_right: Vec<String>,
    pub feature_derives: bool,
    pub feature_lifecycle: bool,
    pub feature_contracts: bool,
    pub feature_state_machine: bool,
    pub feature_concurrency: bool,
    pub feature_generics: bool,
    pub feature_value_constraints: bool,
    pub feature_link_qos: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            snap_to_grid: true,
            grid_size: 20.,
            guides: true,
            select_to_move: true,
            edge_style: "bezier".into(),
            port_style: "hollow".into(),
            minimap: true,
            edge_badges: true,
            auto_orient_links: true,
            inheritance: true,
            associations: true,
            auto_layout_on_open: true,
            reveal_inspector: true,
            force_animations: true,
            editor_font_size: 12.,
            editor_font_family: String::new(),
            editor_line_height: 1.5,
            editor_tab_size: 2.,
            editor_indent_tabs: false,
            editor_whitespace: "all".into(),
            editor_indent_guides: true,
            editor_word_wrap: false,
            editor_line_numbers: true,
            editor_folding: true,
            editor_active_line: true,
            editor_bracket_matching: true,
            editor_close_brackets: true,
            editor_autocomplete: true,
            editor_selection_matches: true,
            editor_scroll_past_end: false,
            editor_minimap: true,
            editor_minimap_render: "characters".into(),
            source_follow: true,
            source_changes: true,
            explorer_order: vec![],
            explorer_hidden: vec![],
            explorer_sticky: true,
            toolbar: ["edit.undo", "edit.redo", "-", "view.back", "view.forward"]
                .map(String::from)
                .to_vec(),
            toolbar_right: vec!["help.tutorial".into()],
            feature_derives: true,
            feature_lifecycle: true,
            feature_contracts: true,
            feature_state_machine: true,
            feature_concurrency: true,
            feature_generics: true,
            feature_value_constraints: true,
            feature_link_qos: true,
        }
    }
}

static SETTINGS: Mutex<Option<Settings>> = Mutex::new(None);

pub fn get() -> Settings {
    let mut s = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    s.get_or_insert_with(crate::prefs::load_settings).clone()
}

/// Change the settings and keep them.
pub fn update(f: impl FnOnce(&mut Settings)) {
    let mut s = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    let current = s.get_or_insert_with(crate::prefs::load_settings);
    f(current);
    crate::prefs::save_settings(current);
}

/// The grid edits land on.
pub fn grid() -> Grid {
    let s = get();
    Grid {
        snap: s.snap_to_grid,
        size: s.grid_size,
    }
}
