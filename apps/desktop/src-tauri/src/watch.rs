use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::capture::{self, Picture};
use crate::{Clicked, FrontApp, Screen, journal, publish};

const TICK: Duration = Duration::from_millis(100);
const LOOK: Duration = Duration::from_millis(300);
const PAUSE: Duration = Duration::from_millis(250);
const SETTLE: Duration = Duration::from_millis(120);
const MAX_PICTURES: usize = 5;
const KEEP_LOOKING: Duration = Duration::from_secs(10);
const MAX_REPORTS: u8 = 2;

// A task being followed: what the screen looked like when the agent last
// saw it, when the person last acted, when the screen was last looked at
// and reported, and how many changes that action has been reported for.
#[derive(Clone)]
struct Task {
    baseline: Option<Picture>,
    acted: Instant,
    looked: Instant,
    reported: Instant,
    reports: u8,
}

#[derive(Default)]
pub struct Watch(Mutex<Option<Task>>);

// What the cursor is told when the screen changed: where the person clicked
// meanwhile, as parts of the pictured window, when they did.
#[derive(Clone, Serialize)]
struct Changed {
    click: Option<(f64, f64)>,
}

#[cfg(target_os = "macos")]
mod input {
    // Event kinds a person makes on purpose: mouse buttons going down and up,
    // drags, keys and scrolls, but never plain moves, which reading makes too.
    const ACTIONS: [u32; 11] = [1, 2, 3, 4, 6, 7, 10, 22, 25, 26, 27];
    const LEFT_MOUSE_DOWN: u32 = 1;
    const COMBINED_SESSION: i32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32)
        -> f64;
    }

    // Reports how long ago an event of one kind last happened, which macos
    // keeps track of for every app without any extra permission.
    fn since(kind: u32) -> f64 {
        unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION, kind)
        }
    }

    // Reports how long ago the person last clicked, typed or scrolled.
    pub fn since_action() -> f64 {
        ACTIONS
            .iter()
            .map(|&kind| since(kind))
            .fold(f64::INFINITY, f64::min)
    }

    // Reports how long ago the person last pressed the mouse button.
    pub fn since_click() -> f64 {
        since(LEFT_MOUSE_DOWN)
    }
}

#[cfg(not(target_os = "macos"))]
mod input {
    // Reports no action on systems without a reader yet, so the app never
    // follows up on its own there.
    pub fn since_action() -> f64 {
        f64::INFINITY
    }

    // Reports no click on systems without a reader yet.
    pub fn since_click() -> f64 {
        f64::INFINITY
    }
}

// Reports how long ago the person last pressed the mouse button, which is
// how a click is noticed without any extra permission.
pub fn since_click() -> f64 {
    input::since_click()
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
    let baseline = {
        let shot = app.state::<Screen>();
        let shot = shot.0.lock().expect("screen lock");

        shot.picture.clone()
    };

    // Only clicks from now on say anything about the step just shown.
    *app.state::<Clicked>().0.lock().expect("click lock") = None;

    journal::event(if on { "watch: on" } else { "watch: off" });

    // Whatever the person did while the agent was answering counts too.
    let now = Instant::now();
    let acted = last_action(now).unwrap_or(now);

    // Nothing is owed for that action, since the agent has just seen the
    // screen; only a later action, or a page still loading after one, counts.
    *app.state::<Watch>().0.lock().expect("watch lock") = on.then(|| Task {
        baseline,
        acted,
        looked: now,
        reported: acted,
        reports: MAX_REPORTS,
    });
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

// Hands over the task for a look once a second after the person acts, for
// as long as it takes a change to show, and for a short while after one was
// reported, since pages keep loading; a change nobody caused, such as a
// video playing, is left alone, however long the person stays away.
fn due(app: &AppHandle, now: Instant) -> Option<Task> {
    let state = app.state::<Watch>();
    let mut watch = state.0.lock().expect("watch lock");
    let task = watch.as_mut()?;

    if let Some(acted) = last_action(now).filter(|&at| at > task.acted) {
        task.acted = acted;
    }

    let acting = now.duration_since(task.acted) < PAUSE;
    let soon = now.duration_since(task.looked) < LOOK;
    let unreported = task.acted > task.reported;
    let loading = now.duration_since(task.reported) < KEEP_LOOKING
        && task.reports < MAX_REPORTS;

    if acting || soon || !(unreported || loading) {
        return None;
    }

    task.looked = now;
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

// Compares the screen with what the agent last saw, and lets the cursor know
// once it has settled into something new, and where the person clicked.
fn follow(app: AppHandle) {
    loop {
        thread::sleep(TICK);

        if busy() {
            continue;
        }

        let Some(Task {
            baseline, acted, ..
        }) = due(&app, Instant::now())
        else {
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
        task.reports = if task.acted > task.reported {
            1
        } else {
            task.reports + 1
        };
        task.reported = Instant::now().max(acted);
        drop(watch);

        let frame = picture.frame;

        if !publish(&app, picture, generation) {
            continue;
        }

        // The person may have dismissed the cursor while this picture settled.
        if app.state::<Watch>().0.lock().expect("watch lock").is_none() {
            continue;
        }

        // Focus goes back to whichever app the person is working in now.
        *app.state::<FrontApp>().0.lock().expect("front lock") = Some(front);

        // The click they made meanwhile counts when it was on the window.
        let clicked =
            app.state::<Clicked>().0.lock().expect("click lock").take();
        let click = clicked.and_then(|(x, y)| frame.fraction(x, y));

        journal::event(&format!(
            "watch: the screen changed, click {}",
            click.is_some()
        ));

        // The cursor may have been put away while the person took a moment.
        if let Some(cursor) = app.get_webview_window("cursor") {
            let _ = cursor.show();
        }

        let _ = app.emit_to("cursor", "changed", Changed { click });
    }
}

// Runs the watcher on its own thread, apart from the one that moves the
// prompt, because picturing the screen can take a moment.
pub fn start(app: AppHandle) {
    thread::spawn(move || follow(app));
}
