// Generates the permissions and context tauri compiles into the app, which
// is why this has to run before the crate itself builds.
fn main() {
    tauri_build::build()
}
