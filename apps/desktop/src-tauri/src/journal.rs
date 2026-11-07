use std::backtrace::Backtrace;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_NAME: &str = "second-cursor.log";
const MAX_BYTES: u64 = 1_000_000;

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

// Opens the log in the app's log folder, starting afresh once it grows large,
// and records panics so a crash always leaves a trace behind.
pub fn start(folder: PathBuf) {
    let path = folder.join(LOG_NAME);
    let _ = fs::create_dir_all(&folder);

    let too_big = fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_BYTES);

    let file = OpenOptions::new()
        .create(true)
        .append(!too_big)
        .write(true)
        .truncate(too_big)
        .open(&path);

    if let Ok(file) = file {
        let _ = FILE.set(Mutex::new(file));
    }

    let previous = panic::take_hook();

    panic::set_hook(Box::new(move |info| {
        event(&format!("panic: {info}\n{}", Backtrace::force_capture()));
        previous(info);
    }));

    event(&format!("started, logging to {}", path.display()));
}

// Writes one timestamped line, leaving out anything on screen or typed, so the
// log can be shared when something goes wrong.
pub fn event(message: &str) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis());

    let line = format!("{millis} {message}");

    eprintln!("{line}");

    if let Some(file) = FILE.get()
        && let Ok(mut file) = file.lock()
    {
        let _ = writeln!(file, "{line}");
    }
}
