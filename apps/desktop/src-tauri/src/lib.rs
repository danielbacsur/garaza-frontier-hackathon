use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const PANEL_MARGIN: f64 = 24.0;

// Keeps the panel in the corner of the main display, because the middle of
// the screen is where the cursor is most likely to need to point.
fn place_panel(panel: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = panel.primary_monitor()? else {
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let screen = monitor.size().to_logical::<f64>(scale);
    let panel_size = panel.outer_size()?.to_logical::<f64>(scale);

    panel.set_position(LogicalPosition::new(
        origin.x + screen.width - panel_size.width - PANEL_MARGIN,
        origin.y + screen.height - panel_size.height - PANEL_MARGIN,
    ))
}

// Shows the panel in its corner and tells it to take the keyboard, which
// works from any app because the shortcut is global.
fn summon(app: &AppHandle) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");

    place_panel(&panel)?;
    panel.show()?;
    panel.set_focus()?;
    app.emit_to("panel", "summoned", ())
}

// Hides the whole app rather than one window, which is what hands keyboard
// focus straight back to the app the person came from.
#[tauri::command]
fn dismiss(app: AppHandle) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");

    panel.hide()?;

    #[cfg(target_os = "macos")]
    app.hide()?;

    Ok(())
}

// Starts the app with its global hotkey and runs it as an accessory, which
// keeps it out of the dock and the app switcher.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hotkey = Shortcut::new(Some(Modifiers::ALT), Code::Space);

    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(hotkey)
        .expect("alt+space is a valid shortcut")
        .with_handler(|app, _, event| {
            if event.state() == ShortcutState::Pressed {
                summon(app).expect("panel can be shown");
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(shortcuts)
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dismiss])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
