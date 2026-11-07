mod elements;

use std::sync::Mutex;

use elements::Element;
use serde::Serialize;

use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, State, WebviewWindow,
};

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const PANEL_MARGIN: f64 = 24.0;

// The controls seen when the panel opened, read before it took focus.
#[derive(Default)]
struct Screen(Mutex<Vec<Element>>);

#[derive(Clone, Serialize)]
struct Target {
    x: f64,
    y: f64,
    caption: String,
}

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

// Reads the screen first and only then shows the panel, because the panel
// would otherwise become the focused window being read.
fn summon(app: &AppHandle) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");

    *app.state::<Screen>().0.lock().expect("screen lock") = elements::read();

    place_panel(&panel)?;
    panel.show()?;
    panel.set_focus()?;
    app.emit_to("panel", "summoned", ())
}

// Hands the panel the controls read when it opened, which it sends along
// with the question because the agent cannot see this machine.
#[tauri::command]
fn screen(state: State<Screen>) -> Vec<Element> {
    state.0.lock().expect("screen lock").clone()
}

// Stretches the overlay over the monitor under the target, so that one
// window can serve every display the cursor needs to reach.
fn cover_monitor(cursor: &WebviewWindow, x: f64, y: f64) -> tauri::Result<()> {
    for monitor in cursor.available_monitors()? {
        let scale = monitor.scale_factor();
        let origin = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);

        if x >= origin.x
            && y >= origin.y
            && x < origin.x + size.width
            && y < origin.y + size.height
        {
            cursor.set_position(origin)?;
            cursor.set_size(size)?;
            break;
        }
    }

    Ok(())
}

// Moves the second cursor to a control the agent picked, ignoring ids from
// any older snapshot, and lets clicks pass through to the app underneath.
#[tauri::command]
fn point(
    app: AppHandle,
    state: State<Screen>,
    element_id: usize,
    caption: String,
) -> tauri::Result<()> {
    let center = state
        .0
        .lock()
        .expect("screen lock")
        .iter()
        .find(|element| element.id == element_id)
        .map(|element| element.center);

    let Some((x, y)) = center else {
        return Ok(());
    };

    let cursor = app.get_webview_window("cursor").expect("cursor window");

    cover_monitor(&cursor, x, y)?;
    cursor.set_ignore_cursor_events(true)?;
    cursor.show()?;
    app.emit_to("cursor", "point", Target { x, y, caption })
}

// Hides the whole app rather than one window, which is what hands keyboard
// focus straight back to the app the person came from.
#[tauri::command]
fn dismiss(app: AppHandle) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");
    let cursor = app.get_webview_window("cursor").expect("cursor window");

    panel.hide()?;
    cursor.hide()?;

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
        .manage(Screen::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dismiss, point, screen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
