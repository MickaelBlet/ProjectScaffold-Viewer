//! Editor settings (the web build's `store/settings.ts`): the ones the editing core follows.

use std::sync::Mutex;

use crate::document::Grid;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    pub snap_to_grid: bool,
    pub grid_size: f64,
    /// Alignment guides while dragging a lone item.
    pub guides: bool,
}

impl Default for Settings {
    fn default() -> Self {
        DEFAULT
    }
}

const DEFAULT: Settings = Settings {
    snap_to_grid: true,
    grid_size: 20.,
    guides: true,
};

static SETTINGS: Mutex<Settings> = Mutex::new(DEFAULT);

pub fn get() -> Settings {
    *SETTINGS.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn update(f: impl FnOnce(&mut Settings)) {
    f(&mut SETTINGS.lock().unwrap_or_else(|e| e.into_inner()));
}

/// The grid edits land on.
pub fn grid() -> Grid {
    let s = get();
    Grid {
        snap: s.snap_to_grid,
        size: s.grid_size,
    }
}
