mod elements;

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use elements::Element;
use serde::Serialize;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State,
    WebviewWindow,
};

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const PANEL_GAP: f64 = 18.0;
const PANEL_WIDTH: f64 = 380.0;
const FOLLOW_INTERVAL: Duration = Duration::from_millis(16);

// The controls seen when the panel opened, read before it took focus.
#[derive(Default)]
struct Screen(Mutex<Vec<Element>>);

#[derive(Clone, Serialize)]
struct Target {
    x: f64,
    y: f64,
    caption: String,
}

// Sits the prompt beside the real cursor, and flips it to the other side
// near a screen edge so that it never slides out of view.
fn place_panel(panel: &WebviewWindow) -> tauri::Result<()> {
    let mouse = panel.cursor_position()?;

    let monitor = panel.available_monitors()?.into_iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();

        mouse.x >= origin.x as f64
            && mouse.y >= origin.y as f64
            && mouse.x < origin.x as f64 + size.width as f64
            && mouse.y < origin.y as f64 + size.height as f64
    });

    let Some(monitor) = monitor else {
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let screen = monitor.size().to_logical::<f64>(scale);
    let size = panel.outer_size()?.to_logical::<f64>(scale);
    let (x, y) = (mouse.x / scale, mouse.y / scale);

    let left = if x + PANEL_GAP + size.width > origin.x + screen.width {
        x - PANEL_GAP - size.width
    } else {
        x + PANEL_GAP
    };

    let top = if y + PANEL_GAP + size.height > origin.y + screen.height {
        y - PANEL_GAP - size.height
    } else {
        y + PANEL_GAP
    };

    panel.set_position(LogicalPosition::new(left, top))
}

// Keeps a visible prompt moving with the real cursor, skipping the update
// when the mouse is still so that an idle prompt costs next to nothing.
fn follow_cursor(app: AppHandle) {
    let panel = app.get_webview_window("panel").expect("panel window");
    let mut last = (0.0, 0.0);

    loop {
        thread::sleep(FOLLOW_INTERVAL);

        let Ok(mouse) = panel.cursor_position() else {
            continue;
        };

        let moved = (mouse.x, mouse.y) != last;

        if moved && panel.is_visible().unwrap_or(false) {
            let _ = place_panel(&panel);
            last = (mouse.x, mouse.y);
        }
    }
}

// Reads the screen first and only then shows the prompt, because it would
// otherwise be the focused window being read, and a second press closes it.
fn summon(app: &AppHandle) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");

    if panel.is_visible()? && panel.is_focused()? {
        return app.emit_to("panel", "close", ());
    }

    *app.state::<Screen>().0.lock().expect("screen lock") = elements::read();

    place_panel(&panel)?;
    panel.show()?;
    panel.set_focus()?;
    app.emit_to("panel", "summoned", ())
}

// Resizes the prompt to fit its content, because an invisible oversized
// window beside the cursor would swallow clicks meant for the app below.
#[tauri::command]
fn fit_panel(app: AppHandle, height: f64) -> tauri::Result<()> {
    app.get_webview_window("panel")
        .expect("panel window")
        .set_size(LogicalSize::new(PANEL_WIDTH, height))
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
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();

            thread::spawn(move || follow_cursor(handle));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dismiss, fit_panel, point, screen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
