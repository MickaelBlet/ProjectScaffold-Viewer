// Desktop shell: serves dist-web/index.html in a native webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::{PermissionKind, PermissionResponse};

fn main() {
    tauri::Builder::default()
        // File System Access: the page only holds handles the user picked in a native dialog, so
        // read-write access to them is granted without asking again (WebView2 asks on every launch).
        .on_permission_request(|_, kind| match kind {
            PermissionKind::FileSystemAccess => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
