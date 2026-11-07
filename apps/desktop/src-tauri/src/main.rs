// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Starts the app from the library, which is kept separate from this binary
// so the same code can also build for mobile targets.
fn main() {
    desktop_lib::run()
}
