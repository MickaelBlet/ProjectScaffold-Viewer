// Desktop shell: serves dist-web/index.html in a native webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{thread, time::Duration};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // The window starts hidden and the page shows it once painted (no white window): show it
        // anyway after a while, should the page fail to load.
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(5));
                    let _ = window.show();
                });
            }
            Ok(())
        })
        // File System Access: the page only holds handles the user picked in a native dialog, so
        // read-write access to them is granted without asking again (WebView2 asks on every launch).
        .on_permission_request(|_, kind| match kind {
            PermissionKind::FileSystemAccess => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
