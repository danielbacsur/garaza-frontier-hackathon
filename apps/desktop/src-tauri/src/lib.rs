mod capture;
mod journal;
mod watch;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
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

// Whether the second cursor is holding a spot it pointed at, rather than
// trailing beside the mouse.
#[derive(Default)]
struct Pointing(AtomicBool);

// The app that was in front when the prompt opened, which gets focus back.
#[derive(Default)]
struct FrontApp(Mutex<Option<i32>>);

#[derive(Clone, Serialize)]
struct Spot {
    x: f64,
    y: f64,
}

// A question, with where the mouse was so the cursor can appear beside it.
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

// Keeps a visible prompt moving with the real cursor and tells the second
// cursor where the mouse is, skipping both while the mouse is still.
fn follow_cursor(app: AppHandle) {
    let panel = app.get_webview_window("panel").expect("panel window");
    let cursor = app.get_webview_window("cursor").expect("cursor window");
    let mut last = (0.0, 0.0);
    let mut covered = None;
    let mut pointed = false;

    loop {
        thread::sleep(FOLLOW_INTERVAL);

        let Ok(mouse) = panel.cursor_position() else {
            continue;
        };

        let moved = (mouse.x, mouse.y) != last;
        let was_pointed = pointed;

        pointed = app.state::<Pointing>().0.load(Ordering::Relaxed);
        last = (mouse.x, mouse.y);

        if moved && panel.is_visible().unwrap_or(false) {
            let _ = place_panel(&panel);
        }

        // Pointing may have moved the overlay onto another display.
        if was_pointed && !pointed {
            covered = None;
        }

        if !pointed && (moved || was_pointed) {
            let _ = share_mouse(&app, &cursor, mouse, &mut covered);
        }
    }
}

// The display the overlay currently covers, kept so that following the mouse
// costs no lookups until the mouse leaves it.
#[derive(Clone, Copy)]
struct Covered {
    origin: PhysicalPosition<f64>,
    size: (f64, f64),
    scale: f64,
}

impl Covered {
    // Checks whether the mouse is still on this display, which is all that
    // following it needs to know most of the time.
    fn holds(&self, mouse: PhysicalPosition<f64>) -> bool {
        mouse.x >= self.origin.x
            && mouse.y >= self.origin.y
            && mouse.x < self.origin.x + self.size.0
            && mouse.y < self.origin.y + self.size.1
    }
}

// Spreads the overlay over the display under the mouse and notes which one
// it is, so the next moves on the same display need no lookups.
fn cover(
    cursor: &WebviewWindow,
    mouse: PhysicalPosition<f64>,
) -> tauri::Result<Option<Covered>> {
    let Some(monitor) = monitor_under(cursor, mouse)? else {
        return Ok(None);
    };

    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let size = monitor.size();

    cover_monitor(cursor, mouse.x / scale, mouse.y / scale)?;

    Ok(Some(Covered {
        origin: PhysicalPosition::new(origin.x as f64, origin.y as f64),
        size: (size.width as f64, size.height as f64),
        scale,
    }))
}

// Tells the second cursor where the mouse is, in screen points like every
// other position it is given, so it can stay just beside it.
fn share_mouse(
    app: &AppHandle,
    cursor: &WebviewWindow,
    mouse: PhysicalPosition<f64>,
    covered: &mut Option<Covered>,
) -> tauri::Result<()> {
    if !covered.is_some_and(|display| display.holds(mouse)) {
        *covered = cover(cursor, mouse)?;
    }

    let Some(display) = *covered else {
        return Ok(());
    };

    let x = mouse.x / display.scale;
    let y = mouse.y / display.scale;

    app.emit_to("cursor", "mouse", Spot { x, y })
}

// Lets go of the spot being pointed at, so the second cursor comes back
// beside the mouse to say something that has nothing to do with it.
#[tauri::command]
fn release(pointing: State<Pointing>) {
    pointing.0.store(false, Ordering::Relaxed);
}

// Stores a fresh picture of the screen under the next number, which is how
// the agent's later spots are matched to what it was shown.
fn publish(app: &AppHandle, picture: Option<Picture>) {
    let state = app.state::<Screen>();
    let mut shot = state.0.lock().expect("screen lock");

    shot.generation += 1;
    shot.picture = picture;
}

// Stores a picture only if no newer one came in while it was being taken,
// which a slow look by the watcher must never overwrite.
fn publish_if(app: &AppHandle, picture: Picture, expected: u64) -> bool {
    let state = app.state::<Screen>();
    let mut shot = state.0.lock().expect("screen lock");

    if shot.generation != expected {
        return false;
    }

    shot.generation += 1;
    shot.picture = Some(picture);
    true
}

// Pictures the screen first and only then shows the prompt, because it would
// otherwise cover the window in use, and a second press closes it.
fn summon(app: &AppHandle) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");

    if panel.is_visible()? && panel.is_focused()? {
        return app.emit_to("panel", "close", ());
    }

    // Our own app can still be in front just after the prompt closed, so the
    // app in use is the one remembered from the last time instead.
    let ours = std::process::id() as i32;
    let remembered = *app.state::<FrontApp>().0.lock().expect("front lock");
    let front = capture::front_app().filter(|&id| id != ours).or(remembered);
    let picture = front.and_then(capture::capture);

    journal::event(&format!("summon: pictured {}", picture.is_some()));
    publish(app, picture);
    watch::pause(app);
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

// Hides the prompt on its own, for when focus moves away from an empty field,
// without touching the second cursor or the conversation.
#[tauri::command]
fn hide_panel(app: AppHandle) -> tauri::Result<()> {
    app.get_webview_window("panel")
        .expect("panel window")
        .hide()
}

// Records a problem the windows ran into, since nothing they print reaches a
// place anyone could read it after the fact.
#[tauri::command]
fn report(message: String) {
    journal::event(&format!("window error: {message}"));
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

    // A new question starts beside the mouse, not on the last spot.
    app.state::<Pointing>().0.store(false, Ordering::Relaxed);

    let Some(monitor) = monitor_under(&cursor, mouse)? else {
        journal::event("think: no monitor under the mouse");
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let (x, y) = (mouse.x / scale, mouse.y / scale);

    cover_monitor(&cursor, x, y)?;
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
        journal::event(&format!(
            "point: refused {x:.3},{y:.3} on {generation}"
        ));
        return Ok(());
    };

    journal::event(&format!("point: {x:.0},{y:.0}"));
    app.state::<Pointing>().0.store(true, Ordering::Relaxed);

    let cursor = app.get_webview_window("cursor").expect("cursor window");

    cover_monitor(&cursor, x, y)?;
    app.emit_to("cursor", "point", Spot { x, y })
}

// Puts the second cursor away once it has had its say, leaving the prompt
// alone so that a person typing a follow-up is not interrupted.
#[tauri::command]
fn rest(app: AppHandle) -> tauri::Result<()> {
    app.state::<Pointing>().0.store(false, Ordering::Relaxed);

    app.get_webview_window("cursor")
        .expect("cursor window")
        .hide()?;

    app.emit_to("cursor", "rest", ())
}

// Closes the prompt and the second cursor together, and hands the keyboard
// straight back to the app the person came from.
#[tauri::command]
fn dismiss(app: AppHandle) -> tauri::Result<()> {
    watch::stop(&app);

    app.get_webview_window("panel")
        .expect("panel window")
        .hide()?;

    return_focus(&app);
    app.emit_to("cursor", "forget", ())?;
    rest(app)
}

// The window layer macos keeps for assistive tools, from CoreGraphics.
#[cfg(target_os = "macos")]
const ASSISTIVE_TECH_HIGH_LEVEL_KEY: i32 = 20;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
}

// Lifts the overlay into the layer kept for assistive tools, above menus
// and tooltips, so it is never hidden and can point into a menu.
#[cfg(target_os = "macos")]
fn raise_above_menus(window: &WebviewWindow) -> tauri::Result<()> {
    let ns_window = window.ns_window()? as *mut objc2::runtime::AnyObject;
    let level = unsafe { CGWindowLevelForKey(ASSISTIVE_TECH_HIGH_LEVEL_KEY) };

    unsafe {
        let _: () = objc2::msg_send![ns_window, setLevel: level as isize];
    }

    Ok(())
}

// Leaves the overlay in its layer on systems without one for assistive
// tools, where it already floats above other windows.
#[cfg(not(target_os = "macos"))]
fn raise_above_menus(_window: &WebviewWindow) -> tauri::Result<()> {
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
            if event.state() != ShortcutState::Pressed {
                return;
            }

            if let Err(error) = summon(app) {
                journal::event(&format!("summon failed: {error}"));
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(shortcuts)
        .manage(Screen::default())
        .manage(FrontApp::default())
        .manage(Pointing::default())
        .manage(watch::Watch::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            journal::start(app.path().app_log_dir()?);

            let cursor = app.get_webview_window("cursor").expect("cursor");

            cursor.set_ignore_cursor_events(true)?;
            raise_above_menus(&cursor)?;

            let handle = app.handle().clone();

            watch::start(handle.clone());
            thread::spawn(move || follow_cursor(handle));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dismiss,
            hide_panel,
            point,
            release,
            report,
            rest,
            screen,
            think,
            watch::watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
