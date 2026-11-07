mod capture;

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use capture::Picture;
use serde::Serialize;

use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Monitor, PhysicalPosition,
    State, WebviewWindow,
};

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const PANEL_GAP: f64 = 18.0;
const CURSOR_GAP: f64 = 28.0;
const FOLLOW_INTERVAL: Duration = Duration::from_millis(16);

// The latest picture of the screen, numbered so that a spot the agent picked
// on an older picture is never placed on a newer one.
#[derive(Clone, Default, Serialize)]
struct Shot {
    generation: u64,
    picture: Option<Picture>,
}

#[derive(Default)]
struct Screen(Mutex<Shot>);

// The app that was in front when the prompt opened, which gets focus back.
#[derive(Default)]
struct FrontApp(Mutex<Option<i32>>);

#[derive(Clone, Serialize)]
struct Spot {
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize)]
struct Request {
    x: f64,
    y: f64,
    question: String,
}

// Finds the monitor under the real cursor, comparing physical pixels because
// that is the unit the mouse position arrives in.
fn monitor_under(
    window: &WebviewWindow,
    mouse: PhysicalPosition<f64>,
) -> tauri::Result<Option<Monitor>> {
    let monitor = window.available_monitors()?.into_iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();

        mouse.x >= origin.x as f64
            && mouse.y >= origin.y as f64
            && mouse.x < origin.x as f64 + size.width as f64
            && mouse.y < origin.y as f64 + size.height as f64
    });

    Ok(monitor)
}

// Sits the prompt beside the real cursor, and flips it to the other side
// near a screen edge so that it never slides out of view.
fn place_panel(panel: &WebviewWindow) -> tauri::Result<()> {
    let mouse = panel.cursor_position()?;

    let Some(monitor) = monitor_under(panel, mouse)? else {
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

// Stores a fresh picture of the screen under the next number, which is how
// the agent's later spots are matched to what it was shown.
fn publish(app: &AppHandle, picture: Option<Picture>) {
    let state = app.state::<Screen>();
    let mut shot = state.0.lock().expect("screen lock");

    shot.generation += 1;
    shot.picture = picture;
}

// Pictures the screen first and only then shows the prompt, because it would
// otherwise cover the window in use, and a second press closes it.
fn summon(app: &AppHandle) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");

    if panel.is_visible()? && panel.is_focused()? {
        return app.emit_to("panel", "close", ());
    }

    let front = capture::front_app();

    publish(app, front.and_then(capture::capture));
    *app.state::<FrontApp>().0.lock().expect("front lock") = front;

    place_panel(&panel)?;
    panel.show()?;
    panel.set_focus()?;
    app.emit_to("panel", "summoned", ())
}

// Gives the keyboard back to the app in use before the prompt opened, so
// that sending a question never interrupts what someone was doing.
fn return_focus(app: &AppHandle) {
    let front = *app.state::<FrontApp>().0.lock().expect("front lock");

    if let Some(app_id) = front {
        capture::activate(app_id);
    }
}

// Hands over the picture taken when the prompt opened, which goes along with
// the question because the agent cannot see this machine.
#[tauri::command]
fn screen(state: State<Screen>) -> Shot {
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

// Shows the second cursor beside the real one and hands it the question, so
// the conversation runs in a window that stays on screen.
#[tauri::command]
fn think(app: AppHandle, question: String) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");
    let cursor = app.get_webview_window("cursor").expect("cursor window");
    let mouse = cursor.cursor_position()?;

    panel.hide()?;
    return_focus(&app);

    let Some(monitor) = monitor_under(&cursor, mouse)? else {
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let x = mouse.x / scale + CURSOR_GAP;
    let y = mouse.y / scale + CURSOR_GAP;

    cover_monitor(&cursor, x, y)?;
    cursor.set_ignore_cursor_events(true)?;
    cursor.show()?;
    app.emit_to("cursor", "think", Request { x, y, question })
}

// Moves the second cursor to the spot the agent picked on the picture, given
// as parts of its width and height, ignoring spots on any older picture.
#[tauri::command]
fn point(
    app: AppHandle,
    state: State<Screen>,
    x: f64,
    y: f64,
    generation: u64,
) -> tauri::Result<()> {
    let spot = {
        let shot = state.0.lock().expect("screen lock");

        shot.picture
            .as_ref()
            .filter(|_| shot.generation == generation)
            .and_then(|picture| picture.frame.place(x, y))
    };

    let Some((x, y)) = spot else {
        return Ok(());
    };

    let cursor = app.get_webview_window("cursor").expect("cursor window");

    cover_monitor(&cursor, x, y)?;
    app.emit_to("cursor", "point", Spot { x, y })
}

// Sends the second cursor away once it has had its say, leaving the prompt
// alone so that a person typing a follow-up is not interrupted.
#[tauri::command]
fn rest(app: AppHandle) -> tauri::Result<()> {
    app.get_webview_window("cursor")
        .expect("cursor window")
        .hide()?;

    app.emit_to("cursor", "rest", ())
}

// Closes the prompt and the second cursor together, and hands the keyboard
// straight back to the app the person came from.
#[tauri::command]
fn dismiss(app: AppHandle) -> tauri::Result<()> {
    app.get_webview_window("panel")
        .expect("panel window")
        .hide()?;

    return_focus(&app);
    app.emit_to("cursor", "forget", ())?;
    rest(app)
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
        .manage(FrontApp::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();

            thread::spawn(move || follow_cursor(handle));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dismiss, point, rest, screen, think
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
