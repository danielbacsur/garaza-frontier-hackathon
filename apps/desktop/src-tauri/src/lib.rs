// Starts the tauri app with the windows named in its config, and exits with
// a clear message if the runtime cannot start at all.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
