//! Tool panels docked around the canvas: Explorer and Search on the left, Inspector and Settings
//! on the right, Problems, Output and State machine below (the web build's default dock layout).

pub mod explorer;
pub mod inspector;
pub mod lists;
pub mod settings_panel;
pub mod source;
pub mod state_machine;

use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde::{Deserialize, Serialize};

use crate::theme;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PanelId {
    Explorer,
    Search,
    Inspector,
    Settings,
    Problems,
    Output,
    StateMachine,
}

impl PanelId {
    pub fn title(self) -> &'static str {
        match self {
            PanelId::Explorer => "Explorer",
            PanelId::Search => "Search",
            PanelId::Inspector => "Inspector",
            PanelId::Settings => "Settings",
            PanelId::Problems => "Problems",
            PanelId::Output => "Output",
            PanelId::StateMachine => "State machine",
        }
    }

    /// Region the panel goes back to when shown.
    pub fn home(self) -> Region {
        match self {
            PanelId::Explorer | PanelId::Search => Region::Left,
            PanelId::Inspector | PanelId::Settings => Region::Right,
            PanelId::Problems | PanelId::Output | PanelId::StateMachine => Region::Bottom,
        }
    }

    pub fn from_command(id: &str) -> Option<PanelId> {
        Some(match id {
            "window.explorer" => PanelId::Explorer,
            "window.search" => PanelId::Search,
            "window.inspector" => PanelId::Inspector,
            "window.settings" => PanelId::Settings,
            "window.problems" => PanelId::Problems,
            "window.output" => PanelId::Output,
            "window.stateMachine" => PanelId::StateMachine,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Region {
    Left,
    Right,
    Bottom,
}

/// Panels of one region: tabs, the active one, whether shown, and its size.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Area {
    pub tabs: Vec<PanelId>,
    pub active: Option<PanelId>,
    pub open: bool,
    pub size: f32,
}

/// Where the panels are: kept between runs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Dock {
    pub left: Area,
    pub right: Area,
    pub bottom: Area,
    /// The Source panel beside the canvas.
    #[serde(default)]
    pub source: bool,
}

impl Default for Dock {
    fn default() -> Self {
        Dock {
            left: Area {
                tabs: vec![PanelId::Explorer, PanelId::Search],
                active: Some(PanelId::Explorer),
                open: true,
                size: 300.,
            },
            right: Area {
                tabs: vec![PanelId::Inspector, PanelId::Settings],
                active: Some(PanelId::Inspector),
                open: true,
                size: 440.,
            },
            bottom: Area {
                tabs: vec![PanelId::Problems, PanelId::Output],
                active: Some(PanelId::Problems),
                open: true,
                size: 170.,
            },
            source: false,
        }
    }
}

impl Dock {
    pub fn area_mut(&mut self, r: Region) -> &mut Area {
        match r {
            Region::Left => &mut self.left,
            Region::Right => &mut self.right,
            Region::Bottom => &mut self.bottom,
        }
    }

    pub fn area(&self, r: Region) -> &Area {
        match r {
            Region::Left => &self.left,
            Region::Right => &self.right,
            Region::Bottom => &self.bottom,
        }
    }

    fn region_of(&self, p: PanelId) -> Option<Region> {
        [Region::Left, Region::Right, Region::Bottom]
            .into_iter()
            .find(|r| self.area(*r).tabs.contains(&p))
    }

    /// Whether a panel is the shown tab of an open region.
    pub fn is_shown(&self, p: PanelId) -> bool {
        self.region_of(p)
            .is_some_and(|r| self.area(r).open && self.area(r).active == Some(p))
    }

    /// Show a panel, adding it back to its region when it was closed.
    pub fn show(&mut self, p: PanelId) {
        let r = self.region_of(p).unwrap_or_else(|| p.home());
        let a = self.area_mut(r);
        if !a.tabs.contains(&p) {
            a.tabs.push(p);
        }
        a.active = Some(p);
        a.open = true;
    }

    /// Show a panel, or hide its region when it is already shown.
    pub fn toggle(&mut self, p: PanelId) {
        if self.is_shown(p) {
            let r = self.region_of(p).unwrap_or_else(|| p.home());
            self.area_mut(r).open = false;
        } else {
            self.show(p);
        }
    }

    /// Close a panel's tab.
    pub fn close(&mut self, p: PanelId) {
        if let Some(r) = self.region_of(p) {
            let a = self.area_mut(r);
            a.tabs.retain(|x| *x != p);
            if a.active == Some(p) {
                a.active = a.tabs.first().copied();
            }
            if a.tabs.is_empty() {
                a.open = false;
            }
        }
    }
}

/// The tab strip of a region, then its active panel.
pub fn region(
    r: Region,
    area: &Area,
    content: AnyElement,
    badge: impl Fn(PanelId) -> Option<String>,
    on_tab: impl Fn(PanelId, &mut Window, &mut App) + Clone + 'static,
    on_close: impl Fn(PanelId, &mut Window, &mut App) + Clone + 'static,
) -> Div {
    let t = theme::light();
    let mut tabs = div()
        .flex()
        .items_center()
        .h(px(28.))
        .px_1()
        .gap_1()
        .border_b_1()
        .border_color(t.border)
        .bg(theme::alpha(t.text, 0.03))
        .text_xs();
    for p in &area.tabs {
        let p = *p;
        let active = area.active == Some(p);
        let (on_tab, on_close) = (on_tab.clone(), on_close.clone());
        tabs = tabs.child(
            div()
                .id(SharedString::from(format!("tab-{r:?}-{p:?}")))
                .flex()
                .items_center()
                .gap_1()
                .px_2()
                .h(px(22.))
                .rounded_md()
                .cursor_pointer()
                .text_color(if active { t.text } else { t.muted })
                .when(active, |d| d.bg(t.bg).border_1().border_color(t.border))
                .on_click(move |ev: &ClickEvent, window, cx| {
                    if ev.is_middle_click() {
                        on_close(p, window, cx)
                    } else {
                        on_tab(p, window, cx)
                    }
                })
                .child(p.title().to_uppercase())
                .children(badge(p).map(|b| {
                    div()
                        .px_1()
                        .rounded_md()
                        .bg(theme::alpha(t.accent, 0.15))
                        .text_color(t.accent)
                        .child(b)
                })),
        );
    }
    div()
        .size_full()
        .flex()
        .flex_col()
        .bg(t.bg)
        .child(tabs)
        .child(div().flex_1().min_h_0().child(content))
}
