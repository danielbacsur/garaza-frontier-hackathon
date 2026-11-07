use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::capture::{self, Picture};
use crate::{FrontApp, Screen, journal, publish};

const TICK: Duration = Duration::from_millis(250);
const PAUSE: Duration = Duration::from_millis(400);
const SETTLE: Duration = Duration::from_millis(150);
const MAX_PICTURES: usize = 5;
const GIVE_UP: Duration = Duration::from_secs(5 * 60);

// A task being followed: what the screen looked like when the agent last
// spoke, when it was last looked at, and when the person last did anything.
#[derive(Clone)]
struct Task {
    baseline: Option<Picture>,
    checked: Instant,
    acted: Instant,
}

#[derive(Default)]
pub struct Watch(Mutex<Option<Task>>);

#[cfg(target_os = "macos")]
mod input {
    // Event kinds a person makes on purpose: mouse buttons going down and up,
    // drags, keys and scrolls, but never plain moves, which reading makes too.
    const KINDS: [u32; 11] = [1, 2, 3, 4, 6, 7, 10, 22, 25, 26, 27];
    const COMBINED_SESSION: i32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32)
        -> f64;
    }

    // Reports how long ago the person last clicked, typed or scrolled, which
    // macos keeps track of for every app without any extra permission.
    pub fn since_action() -> f64 {
        KINDS
            .iter()
            .map(|&kind| unsafe {
                CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION, kind)
            })
            .fold(f64::INFINITY, f64::min)
    }
}

#[cfg(not(target_os = "macos"))]
mod input {
    // Reports no action on systems without a reader yet, so the app never
    // follows up on its own there.
    pub fn since_action() -> f64 {
        f64::INFINITY
    }
}

// Works out when the person last acted, or nothing if they never have,
// as a moment that can be compared with the task's own clock.
fn last_action(now: Instant) -> Option<Instant> {
    let since = Duration::try_from_secs_f64(input::since_action()).ok()?;

    now.checked_sub(since)
}

// Starts following from the screen the agent was just shown, or stops; the
// cursor turns it off as each turn starts and on again once a turn ends.
#[tauri::command]
pub fn watch(app: AppHandle, on: bool) {
    let (baseline, since) = {
        let shot = app.state::<Screen>();
        let shot = shot.0.lock().expect("screen lock");

        (shot.picture.clone(), shot.since)
    };

    // Whatever the person did while the agent was answering counts too.
    let since = since.unwrap_or_else(Instant::now);

    journal::event(if on { "watch: on" } else { "watch: off" });

    *app.state::<Watch>().0.lock().expect("watch lock") = on.then(|| Task {
        baseline,
        checked: since,
        acted: since,
    });
}

// Forgets whatever was done so far, because pressing the hotkey is itself a
// key press and must never read as progress on the task.
pub fn forget_actions(app: &AppHandle) {
    if let Some(task) =
        app.state::<Watch>().0.lock().expect("watch lock").as_mut()
    {
        task.checked = Instant::now();
    }
}

// Stops following the task when the person dismisses the cursor, so that
// nothing is pictured or reported once they no longer want help.
pub fn stop(app: &AppHandle) {
    *app.state::<Watch>().0.lock().expect("watch lock") = None;
}

// Pictures the window in use until two pictures in a row agree, so a page
// that is still loading is only reported once it has settled.
fn settled(app_id: i32) -> Option<Picture> {
    let mut picture = capture::capture(app_id)?;

    for _ in 1..MAX_PICTURES {
        thread::sleep(SETTLE);

        let again = capture::capture(app_id)?;
        let same = !again.differs(&picture);

        picture = again;

        if same {
            break;
        }
    }

    Some(picture)
}

// Hands over the task when the person has acted and then paused since the
// last look, updating its clock either way, and gives up after a long silence.
fn due(app: &AppHandle, now: Instant) -> Option<Task> {
    let state = app.state::<Watch>();
    let mut watch = state.0.lock().expect("watch lock");
    let task = watch.as_mut()?;

    if let Some(acted) = last_action(now).filter(|&at| at > task.acted) {
        task.acted = acted;
    }

    if now.duration_since(task.acted) > GIVE_UP {
        *watch = None;
        journal::event("watch: gave up after a long pause");
        let _ = app.emit_to("cursor", "abandoned", ());
        return None;
    }

    let ready =
        task.acted > task.checked && now.duration_since(task.acted) >= PAUSE;

    if !ready {
        return None;
    }

    task.checked = now;
    Some(task.clone())
}

// Checks whether our own app is in front, because typing into the prompt
// means the person is asking something rather than doing the task.
fn busy() -> bool {
    capture::front_app() == Some(std::process::id() as i32)
}

// Reads which picture of the screen is the latest, so a slow look of our
// own can tell when another one was published in the meantime.
fn current_generation(app: &AppHandle) -> u64 {
    app.state::<Screen>()
        .0
        .lock()
        .expect("screen lock")
        .generation
}

// Looks at the screen once the person pauses after acting, and lets the
// cursor know when it settled into something new.
fn follow(app: AppHandle) {
    loop {
        thread::sleep(TICK);

        if busy() {
            forget_actions(&app);
            continue;
        }

        let Some(Task { baseline, .. }) = due(&app, Instant::now()) else {
            continue;
        };

        let Some(front) = capture::front_app() else {
            continue;
        };

        let generation = current_generation(&app);

        let Some(picture) = settled(front) else {
            continue;
        };

        let changed = baseline.is_none_or(|before| picture.differs(&before));

        // The prompt may have opened, or pictured the screen itself, while
        // this picture settled.
        let stale = busy() || current_generation(&app) != generation;

        if stale || !changed {
            continue;
        }

        let state = app.state::<Watch>();
        let mut watch = state.0.lock().expect("watch lock");

        let Some(task) = watch.as_mut() else {
            continue;
        };

        task.baseline = Some(picture.clone());
        drop(watch);

        if !publish(&app, picture, generation) {
            continue;
        }

        // The person may have dismissed the cursor while this picture settled.
        if app.state::<Watch>().0.lock().expect("watch lock").is_none() {
            continue;
        }

        // Focus goes back to whichever app the person is working in now.
        *app.state::<FrontApp>().0.lock().expect("front lock") = Some(front);
        journal::event("watch: the screen changed");

        // The cursor may have been put away while the person took a moment.
        if let Some(cursor) = app.get_webview_window("cursor") {
            let _ = cursor.show();
        }

        let _ = app.emit_to("cursor", "changed", ());
    }
}

// Runs the watcher on its own thread, apart from the one that moves the
// prompt, because picturing the screen can take a moment.
pub fn start(app: AppHandle) {
    thread::spawn(move || follow(app));
}
