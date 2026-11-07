//! Settings panel: every setting of the editor, by group. Port of `SettingsPanel.tsx`.

use gpui_kit::*;

use crate::form::{self, Fields, checkbox, heading, muted, row, section};
use crate::settings::{self, Settings};

pub struct SettingsPanel {
    fields: Fields,
}

impl SettingsPanel {
    pub fn new() -> Self {
        SettingsPanel {
            fields: Fields::default(),
        }
    }
}

type Flag = (
    &'static str,
    &'static str,
    fn(&Settings) -> bool,
    fn(&mut Settings, bool),
);

macro_rules! flag {
    ($id:literal, $label:literal, $f:ident) => {
        (
            $id,
            $label,
            (|s: &Settings| s.$f) as fn(&Settings) -> bool,
            (|s: &mut Settings, v: bool| s.$f = v) as fn(&mut Settings, bool),
        )
    };
}

const CANVAS: &[Flag] = &[
    flag!("snap", "Snap to grid", snap_to_grid),
    flag!("guides", "Alignment guides", guides),
    flag!(
        "selectToMove",
        "Only selected items move when dragged",
        select_to_move
    ),
    flag!("minimap", "Minimap", minimap),
    flag!("edgeBadges", "Link badges", edge_badges),
    flag!("autoOrient", "Link ends face each other", auto_orient_links),
    flag!("inheritance", "Inheritance arrows", inheritance),
    flag!("associations", "Association arrows", associations),
    flag!(
        "autoLayout",
        "Arrange files without layout when opening them",
        auto_layout_on_open
    ),
    flag!(
        "revealInspector",
        "Selecting shows the Inspector",
        reveal_inspector
    ),
];

const EDITOR: &[Flag] = &[
    flag!("indentTabs", "Indent with tabs", editor_indent_tabs),
    flag!("indentGuides", "Indent guides", editor_indent_guides),
    flag!("wordWrap", "Word wrap", editor_word_wrap),
    flag!("lineNumbers", "Line numbers", editor_line_numbers),
    flag!("folding", "Folding", editor_folding),
    flag!("activeLine", "Highlight the active line", editor_active_line),
    flag!("brackets", "Bracket matching", editor_bracket_matching),
    flag!("closeBrackets", "Close brackets", editor_close_brackets),
    flag!("autocomplete", "Autocomplete while typing", editor_autocomplete),
    flag!(
        "selectionMatches",
        "Highlight selection matches",
        editor_selection_matches
    ),
    flag!("scrollPastEnd", "Scroll past the end", editor_scroll_past_end),
    flag!("editorMinimap", "Minimap", editor_minimap),
    flag!(
        "sourceFollow",
        "The element under the caret is selected",
        source_follow
    ),
    flag!(
        "sourceChanges",
        "Show changes since the last save",
        source_changes
    ),
];

const FEATURES: &[Flag] = &[
    flag!(
        "derives",
        "Derived operations (==, <, hash, string)",
        feature_derives
    ),
    flag!(
        "lifecycle",
        "Lifecycle: instances, copy, move, constructors",
        feature_lifecycle
    ),
    flag!(
        "contracts",
        "Contracts: invariants, pre- and postconditions",
        feature_contracts
    ),
    flag!("stateMachine", "State machines", feature_state_machine),
    flag!(
        "concurrency",
        "Concurrency: locks, active modules",
        feature_concurrency
    ),
    flag!("generics", "Generics: type parameters", feature_generics),
    flag!(
        "valueConstraints",
        "Value constraints: range, unit, pattern",
        feature_value_constraints
    ),
    flag!(
        "linkQos",
        "Link QoS: acknowledgement, performance",
        feature_link_qos
    ),
];

fn flags(group: &'static str, list: &'static [Flag], s: &Settings) -> Div {
    let mut d = div().flex().flex_col().gap_1();
    for (id, label, get, set) in list {
        let set = *set;
        d = d.child(checkbox(
            SharedString::from(format!("set-{group}-{id}")),
            *label,
            get(s),
            move |v, _, cx| {
                settings::update(|s| set(s, v));
                cx.refresh_windows();
            },
        ));
    }
    d
}

fn choice(
    id: &'static str,
    current: &str,
    options: &[&str],
    set: fn(&mut Settings, String),
) -> impl IntoElement {
    form::select(
        id,
        current,
        options.iter().map(|o| (o.to_string(), o.to_string())).collect(),
        move |v, _, cx| {
            settings::update(|s| set(s, v));
            cx.refresh_windows();
        },
    )
}

impl Render for SettingsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let s = settings::get();
        self.fields.begin();
        let grid = self.fields.number(
            "set-grid",
            Some(s.grid_size),
            "20",
            true,
            window,
            cx,
            |v, _, cx| {
                if let Some(v) = v.filter(|v| *v >= 2.) {
                    settings::update(|s| s.grid_size = v);
                    cx.refresh_windows();
                }
            },
        );
        let font = self.fields.number(
            "set-font",
            Some(s.editor_font_size),
            "12",
            false,
            window,
            cx,
            |v, _, cx| {
                if let Some(v) = v.filter(|v| *v >= 6.) {
                    settings::update(|s| s.editor_font_size = v);
                    cx.refresh_windows();
                }
            },
        );
        let tab = self.fields.number(
            "set-tab",
            Some(s.editor_tab_size),
            "2",
            true,
            window,
            cx,
            |v, _, cx| {
                if let Some(v) = v.filter(|v| *v >= 1.) {
                    settings::update(|s| s.editor_tab_size = v);
                    cx.refresh_windows();
                }
            },
        );
        let family = self.fields.text(
            "set-family",
            &s.editor_font_family,
            "built-in monospace",
            window,
            cx,
            |v, _, cx| {
                settings::update(|s| s.editor_font_family = v.trim().to_string());
                cx.refresh_windows();
                None
            },
        );
        self.fields.end();
        div()
            .id("settings")
            .size_full()
            .overflow_y_scroll()
            .p_2()
            .text_sm()
            .flex()
            .flex_col()
            .gap_1()
            .child(heading("Settings", None))
            .child(
                section("Appearance", None)
                    .child(row(
                        "Theme",
                        choice(
                            "set-theme",
                            &s.theme,
                            &[
                                "system", "light", "dark", "black", "red", "orange", "yellow", "green",
                                "pink", "violet",
                            ],
                            |s, v| s.theme = v,
                        ),
                    ))
                    .child(row(
                        "Links",
                        choice(
                            "set-edge",
                            &s.edge_style,
                            &["bezier", "smoothstep", "step", "straight"],
                            |s, v| s.edge_style = v,
                        ),
                    ))
                    .child(row(
                        "Ports",
                        choice(
                            "set-port",
                            &s.port_style,
                            &["dots", "arrows", "hollow", "shapes"],
                            |s, v| s.port_style = v,
                        ),
                    )),
            )
            .child(
                section("Canvas", None)
                    .child(row("Grid size", grid))
                    .child(flags("canvas", CANVAS, &s)),
            )
            .child(
                section("Text editor", None)
                    .child(row("Font size", font))
                    .child(row("Font family", family))
                    .child(row("Tab size", tab))
                    .child(row(
                        "Whitespace",
                        choice(
                            "set-ws",
                            &s.editor_whitespace,
                            &["all", "trailing", "none"],
                            |s, v| s.editor_whitespace = v,
                        ),
                    ))
                    .child(row(
                        "Minimap",
                        choice(
                            "set-mm",
                            &s.editor_minimap_render,
                            &["characters", "blocks"],
                            |s, v| s.editor_minimap_render = v,
                        ),
                    ))
                    .child(flags("editor", EDITOR, &s)),
            )
            .child(
                section("Modeling features", None)
                    .child(muted("Off: their editing hides while the project holds none."))
                    .child(flags("features", FEATURES, &s)),
            )
            .child(
                div()
                    .pt_2()
                    .child(form::button("set-reset", "Reset settings", |_, cx| {
                        settings::update(|s| *s = Settings::default());
                        cx.refresh_windows();
                    })),
            )
    }
}
