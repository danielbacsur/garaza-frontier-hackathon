mod capture;
mod journal;
mod watch;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::Duration;

use capture::Picture;
use serde::Serialize;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State,
    WebviewWindow,
};

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const PANEL_GAP: f64 = 18.0;
const MAX_PICTURE_WAIT: Duration = Duration::from_secs(3);
const FOLLOW_INTERVAL: Duration = Duration::from_millis(16);

// The latest picture of the screen, numbered so that a spot the agent picked
// on an older picture is never placed on a newer one.
#[derive(Clone, Default, Serialize)]
struct Shot {
    generation: u64,
    picture: Option<Picture>,

    // Whether the picture under this number is still being taken.
    #[serde(skip)]
    pending: bool,
}

// The latest picture, and a signal for whoever waits on one being taken.
#[derive(Default)]
struct Screen(Mutex<Shot>, Condvar);

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

// A display's area on screen in points, the unit every position here uses,
// since displays side by side can each have a scale of their own.
#[derive(Clone, Copy)]
struct Display {
    origin: LogicalPosition<f64>,
    size: LogicalSize<f64>,
}

impl Display {
    // Checks whether a spot in points lies on this display, which is all
    // that following the mouse needs to know most of the time.
    fn holds(&self, (x, y): (f64, f64)) -> bool {
        x >= self.origin.x
            && y >= self.origin.y
            && x < self.origin.x + self.size.width
            && y < self.origin.y + self.size.height
    }
}

// Reads where the mouse is in points; tauri reports it in pixels of the main
// display whichever display it is on, so that scale is the one to undo.
fn mouse_points(window: &WebviewWindow) -> tauri::Result<(f64, f64)> {
    let mouse = window.cursor_position()?;
    let main = window.primary_monitor()?;
    let scale = main.map_or(1.0, |monitor| monitor.scale_factor());

    Ok((mouse.x / scale, mouse.y / scale))
}

// Finds the display holding a spot in points, measuring each display by its
// own scale, so a retina screen beside an ordinary one is handled right.
fn display_at(
    window: &WebviewWindow,
    spot: (f64, f64),
) -> tauri::Result<Option<Display>> {
    let mut displays =
        window.available_monitors()?.into_iter().map(|monitor| {
            let scale = monitor.scale_factor();

            Display {
                origin: monitor.position().to_logical(scale),
                size: monitor.size().to_logical(scale),
            }
        });

    Ok(displays.find(|display| display.holds(spot)))
}

// Sits the prompt beside the real cursor, and flips it to the other side
// near a screen edge so that it never slides out of view.
fn place_panel(panel: &WebviewWindow) -> tauri::Result<()> {
    let (x, y) = mouse_points(panel)?;

    let Some(Display {
        origin,
        size: screen,
    }) = display_at(panel, (x, y))?
    else {
        return Ok(());
    };

    let size = panel.outer_size()?.to_logical::<f64>(panel.scale_factor()?);

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

        let Ok(mouse) = mouse_points(&panel) else {
            continue;
        };

        let moved = mouse != last;
        let was_pointed = pointed;

        pointed = app.state::<Pointing>().0.load(Ordering::Relaxed);
        last = mouse;

        if moved && panel.is_visible().unwrap_or(false) {
            let _ = place_panel(&panel);
        }

        // Pointing may have moved the overlay onto another display.
        if was_pointed && !pointed {
            covered = None;
        }

        // A hidden cursor has nobody to follow for, and takes no updates.
        let wanted = !pointed && (moved || was_pointed);

        if wanted && cursor.is_visible().unwrap_or(false) {
            let _ = share_mouse(&app, &cursor, mouse, &mut covered);
        }
    }
}

// Tells the second cursor where the mouse is, in screen points like every
// other position it is given, moving the overlay when it changes display.
fn share_mouse(
    app: &AppHandle,
    cursor: &WebviewWindow,
    mouse: (f64, f64),
    covered: &mut Option<Display>,
) -> tauri::Result<()> {
    if !covered.is_some_and(|display| display.holds(mouse)) {
        *covered = cover_display(cursor, mouse)?;
    }

    if covered.is_none() {
        return Ok(());
    }

    let (x, y) = mouse;

    app.emit_to("cursor", "mouse", Spot { x, y })
}

// Lets go of the spot being pointed at, so the second cursor comes back
// beside the mouse to say something that has nothing to do with it.
#[tauri::command]
fn release(pointing: State<Pointing>) {
    pointing.0.store(false, Ordering::Relaxed);
}

// Stores a picture under the next number, to match the agent's spots with,
// unless a newer one was started while this one was being taken.
fn publish(app: &AppHandle, picture: Picture, taken_under: u64) -> bool {
    let state = app.state::<Screen>();
    let mut shot = state.0.lock().expect("screen lock");

    if shot.generation != taken_under || shot.pending {
        return false;
    }

    shot.generation += 1;
    shot.picture = Some(picture);
    true
}

// Pictures the app in use in the background under the next number, which
// the prompt need not wait for, since the picture leaves our windows out.
fn picture_later(app: &AppHandle, front: Option<i32>) {
    let generation = {
        let state = app.state::<Screen>();
        let mut shot = state.0.lock().expect("screen lock");

        shot.generation += 1;
        shot.picture = None;
        shot.pending = true;
        shot.generation
    };

    let app = app.clone();

    thread::spawn(move || {
        let picture = front.and_then(capture::capture);
        let state = app.state::<Screen>();
        let mut shot = state.0.lock().expect("screen lock");

        journal::event(&format!("summon: pictured {}", picture.is_some()));

        // A newer picture may have been started while this one was taken.
        if shot.generation == generation {
            shot.picture = picture;
            shot.pending = false;
        }

        state.1.notify_all();
    });
}

// Opens the prompt beside the mouse straight away and pictures the screen
// meanwhile, or closes the prompt when it is already open.
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

    picture_later(app, front);
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

// Hands over the picture taken when the prompt opened, waiting for it if a
// quick question beat it, since the agent cannot see this machine.
#[tauri::command]
async fn screen(app: AppHandle) -> Shot {
    let waited = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Screen>();
        let shot = state.0.lock().expect("screen lock");

        let (shot, _) = state
            .1
            .wait_timeout_while(shot, MAX_PICTURE_WAIT, |shot| shot.pending)
            .expect("screen lock");

        shot.clone()
    });

    waited.await.unwrap_or_default()
}

// Hides the prompt on its own, for when focus moves away from an empty field,
// without touching the second cursor or the conversation.
#[tauri::command]
fn hide_panel(app: AppHandle) -> tauri::Result<()> {
    app.get_webview_window("panel")
        .expect("panel window")
        .hide()
}

// Records what happened in the windows, such as how a step was followed,
// since nothing they print reaches a place anyone could read it later.
#[tauri::command]
fn note(message: String) {
    journal::event(&message);
}

// Records a problem the windows ran into, since nothing they print reaches a
// place anyone could read it after the fact.
#[tauri::command]
fn report(message: String) {
    journal::event(&format!("window error: {message}"));
}

// Stretches the overlay over the display holding a spot, so that one window
// can serve every display the cursor needs to reach.
fn cover_display(
    cursor: &WebviewWindow,
    spot: (f64, f64),
) -> tauri::Result<Option<Display>> {
    let display = display_at(cursor, spot)?;

    if let Some(Display { origin, size }) = display {
        cursor.set_position(origin)?;
        cursor.set_size(size)?;
    }

    Ok(display)
}

// Shows the second cursor beside the real one and hands it the question, so
// the conversation runs in a window that stays on screen.
#[tauri::command]
fn think(app: AppHandle, question: String) -> tauri::Result<()> {
    let panel = app.get_webview_window("panel").expect("panel window");
    let cursor = app.get_webview_window("cursor").expect("cursor window");
    let (x, y) = mouse_points(&cursor)?;

    panel.hide()?;
    return_focus(&app);

    // A new question starts beside the mouse, not on the last spot.
    app.state::<Pointing>().0.store(false, Ordering::Relaxed);

    if cover_display(&cursor, (x, y))?.is_none() {
        journal::event("think: no display under the mouse");
        return Ok(());
    }

    cursor.show()?;
    app.emit_to("cursor", "think", Request { x, y, question })
}

// Moves the second cursor to the spot the agent picked on the picture, given
// as parts of its width and height, and reports whether it was used, since
// a spot on an older picture is ignored.
#[tauri::command]
fn point(
    app: AppHandle,
    state: State<Screen>,
    x: f64,
    y: f64,
    generation: u64,
) -> tauri::Result<bool> {
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
        return Ok(false);
    };

    journal::event(&format!("point: {x:.0},{y:.0}"));
    app.state::<Pointing>().0.store(true, Ordering::Relaxed);

    let cursor = app.get_webview_window("cursor").expect("cursor window");

    cover_display(&cursor, (x, y))?;
    app.emit_to("cursor", "point", Spot { x, y })?;

    Ok(true)
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
            note,
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
