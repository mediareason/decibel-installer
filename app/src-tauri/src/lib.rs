mod detect;

/// Probe the machine: which Claude Desktop build, where extensions really land,
/// whether node is reachable, what else is installed.
#[tauri::command]
fn detect_environment() -> detect::Detection {
    detect::detect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![detect_environment])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
