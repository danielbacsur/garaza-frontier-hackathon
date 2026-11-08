use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::capture::{self, Picture};
use crate::{Clicked, FrontApp, Placed, Screen, journal, publish};

const TICK: Duration = Duration::from_millis(100);
const PAUSE: Duration = Duration::from_millis(150);
const LOOK: Duration = Duration::from_millis(150);
const QUICK: Duration = Duration::from_secs(1);
const IDLE_LOOK: Duration = Duration::from_millis(500);
const KEEP_LOOKING: Duration = Duration::from_secs(10);

// How close to the spot pointed at a click still counts as being on it, in
// screen points, about the size of a small button.
const NEAR: f64 = 28.0;

// A task being followed: whether changes nobody caused count too, when the
// person last acted, when the screen was last looked at, and what that look
// saw, for telling a screen that has settled from one still changing.
#[derive(Clone)]
struct Task {
    idle: bool,
    acted: Instant,
    looked: Instant,
    seen: Option<Picture>,
}

#[derive(Default)]
pub struct Watch(Mutex<Option<Task>>);

// What the cursor is told when the screen changed: where the person clicked
// meanwhile, as parts of the pictured window, and whether that was on the
// spot the cursor was pointing at.
#[derive(Clone, Serialize)]
struct Changed {
    click: Option<(f64, f64)>,
    near: bool,
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

// Starts following the screen, or stops. The cursor turns it on as a turn
// starts, so that whatever the person does while the agent answers is seen,
// and again as the turn ends, idle too while a task is under way.
#[tauri::command]
pub fn watch(app: AppHandle, on: bool, idle: bool) {
    let state = app.state::<Watch>();
    let mut watch = state.0.lock().expect("watch lock");
    let kept = watch.take();

    journal::event(&format!("watch: on {on}, idle {idle}"));

    // A task already being followed keeps what it saw and when the person
    // acted, so an action made during the turn is still reported.
    *watch = on.then(|| match kept {
        Some(task) => Task { idle, ..task },

        None => {
            let now = Instant::now();

            Task {
                idle,
                acted: last_action(now).unwrap_or(now),
                looked: now,
                seen: None,
            }
        }
    });
}

// Stops following the task when the person dismisses the cursor, so that
// nothing is pictured or reported once they no longer want help.
pub fn stop(app: &AppHandle) {
    *app.state::<Watch>().0.lock().expect("watch lock") = None;
}

// Reads when the picture the agent last got was taken, which any action
// made since has not been seen.
fn last_taken(app: &AppHandle) -> Option<Instant> {
    app.state::<Screen>().0.lock().expect("screen lock").taken
}

// Hands over the task for a look every so often: quickly for a second after
// the person acts, then every half second for a while, or for as long as a
// task is open, since pages finish loading while nobody is acting.
fn due(app: &AppHandle, now: Instant) -> Option<(Task, bool)> {
    let taken = last_taken(app);
    let state = app.state::<Watch>();
    let mut watch = state.0.lock().expect("watch lock");
    let task = watch.as_mut()?;

    if let Some(acted) = last_action(now).filter(|&at| at > task.acted) {
        task.acted = acted;
    }

    let since_acted = now.duration_since(task.acted);
    let over = !task.idle && since_acted > KEEP_LOOKING;
    let interval = if since_acted < QUICK { LOOK } else { IDLE_LOOK };

    if since_acted < PAUSE || over || now.duration_since(task.looked) < interval
    {
        return None;
    }

    task.looked = now;

    // An action made since the agent last got a picture is still unseen.
    let prompted = taken.is_none_or(|taken| task.acted > taken);

    Some((task.clone(), prompted))
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

// Reads what the agent last saw, or is looking at right now, which is what
// any change is measured against.
fn baseline(app: &AppHandle) -> Option<Picture> {
    app.state::<Screen>()
        .0
        .lock()
        .expect("screen lock")
        .picture
        .clone()
}

// Tells whether a click landed on the spot the cursor was pointing at, which
// says that the step shown was taken.
fn near(click: (f64, f64), placed: Option<(f64, f64)>) -> bool {
    placed.is_some_and(|(x, y)| {
        (click.0 - x).abs() <= NEAR && (click.1 - y).abs() <= NEAR
    })
}

// Notes what this look saw, and tells whether the screen has settled since
// the look before, which a page still loading or a video has not.
fn settled(app: &AppHandle, picture: &Picture) -> bool {
    let state = app.state::<Watch>();
    let mut watch = state.0.lock().expect("watch lock");
    let Some(task) = watch.as_mut() else {
        return false;
    };

    let settled = task
        .seen
        .as_ref()
        .is_some_and(|seen| !picture.differs_widely(seen));

    task.seen = Some(picture.clone());
    settled
}

// Compares the screen with what the agent last saw, and lets the cursor know
// once it has settled into something new, or once the person has clicked,
// and where that click was.
fn follow(app: AppHandle) {
    loop {
        thread::sleep(TICK);

        if busy() {
            continue;
        }

        let Some((task, prompted)) = due(&app, Instant::now()) else {
            continue;
        };

        let Some(front) = capture::front_app() else {
            continue;
        };

        let generation = current_generation(&app);

        let Some(picture) = capture::capture(front) else {
            continue;
        };

        let settled = settled(&app, &picture);
        let clicked = *app.state::<Clicked>().0.lock().expect("click lock");

        // After an action, any difference counts, and a screen that will not
        // settle, such as a video playing, is reported as it is after a
        // moment; on its own, only a wide and settled change does.
        let changed = baseline(&app).is_none_or(|before| {
            if prompted {
                picture.differs(&before)
            } else {
                picture.differs_widely(&before)
            }
        });
        let forced = prompted && task.acted.elapsed() >= QUICK;

        // The prompt may have opened, or pictured the screen itself, while
        // this picture was taken.
        let stale = busy() || current_generation(&app) != generation;

        if stale || !(changed || clicked.is_some()) || !(settled || forced) {
            continue;
        }

        let frame = picture.frame;

        if !publish(&app, picture, generation, task.looked) {
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
        let placed = *app.state::<Placed>().0.lock().expect("placed lock");
        let click = clicked.and_then(|(x, y)| frame.fraction(x, y));
        let near = clicked.is_some_and(|at| near(at, placed));

        journal::event(&format!(
            "watch: the screen changed, click {}, near {near}",
            click.is_some()
        ));

        // The cursor may have been put away while the person took a moment.
        if let Some(cursor) = app.get_webview_window("cursor") {
            let _ = cursor.show();
        }

        let _ = app.emit_to("cursor", "changed", Changed { click, near });
    }
}

// Runs the watcher on its own thread, apart from the one that moves the
// prompt, because picturing the screen can take a moment.
pub fn start(app: AppHandle) {
    thread::spawn(move || follow(app));
}
