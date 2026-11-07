use serde::Serialize;

// Where a window sits on screen, in points from the top left of the main
// display, which is how the second cursor is placed too.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    // Turns a spot given as parts of the window's width and height into a
    // place on screen, refusing spots outside the window.
    pub fn place(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let inside = (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y);

        inside.then(|| (self.x + x * self.width, self.y + y * self.height))
    }
}

// A picture of the window in use, scaled to screen points and encoded as a
// JPEG, with the app and window it shows.
#[derive(Clone, Default, Serialize)]
pub struct Picture {
    pub app: String,
    pub title: String,
    pub image: String,

    #[serde(skip)]
    pub frame: Frame,
}

#[cfg(target_os = "macos")]
pub use macos::{activate, capture, front_app};

// Reports no app in front on systems without a reader yet, which simply
// skips handing focus back when the prompt closes.
#[cfg(not(target_os = "macos"))]
pub fn front_app() -> Option<i32> {
    None
}

// Does nothing on systems without a reader yet, because no app was recorded
// as being in front when the prompt opened.
#[cfg(not(target_os = "macos"))]
pub fn activate(_app_id: i32) {}

// Sees nothing on systems without a reader yet, which leaves the agent able
// to answer questions but with nothing to point at.
#[cfg(not(target_os = "macos"))]
pub fn capture(_app_id: i32) -> Option<Picture> {
    None
}

#[cfg(target_os = "macos")]
mod macos {
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
        kCGWindowName, kCGWindowNumber, kCGWindowOwnerPID,
    };
    use core_graphics_types::geometry::CGRect;
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
    };

    use super::{Frame, Picture};

    const JPEG_QUALITY: u8 = 80;
    const MIN_SIZE: f64 = 40.0;

    // A window as the window server lists it, which is enough to picture it
    // and to place things on it without asking the app itself.
    struct Window {
        id: u32,
        title: String,
        frame: Frame,
    }

    // Finds which app is in front right now, so its window can be pictured
    // and focus can go straight back to it once the prompt has gone away.
    pub fn front_app() -> Option<i32> {
        let workspace = NSWorkspace::sharedWorkspace();

        Some(workspace.frontmostApplication()?.processIdentifier())
    }

    // Brings an app back to the front, because hiding our own windows does
    // not hand the keyboard back to whatever was in use before.
    #[allow(deprecated)]
    pub fn activate(app_id: i32) {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(
            app_id,
        );

        if let Some(app) = app {
            app.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }

    // Reads one entry of a window's description, whatever type it holds.
    // The window server describes windows as loosely typed dictionaries.
    fn entry(
        window: &CFDictionary<CFString, CFType>,
        key: core_foundation::string::CFStringRef,
    ) -> Option<CFType> {
        let key = unsafe { CFString::wrap_under_get_rule(key) };

        window.find(&key).map(|value| value.clone())
    }

    // Reads a number from a window's description, such as its owner or id,
    // which the window server stores as a CFNumber.
    fn number(
        window: &CFDictionary<CFString, CFType>,
        key: core_foundation::string::CFStringRef,
    ) -> Option<i64> {
        entry(window, key)?.downcast::<CFNumber>()?.to_i64()
    }

    // Finds the frontmost ordinary window of an app, skipping the menu bar,
    // panels and slivers, since that is the window someone is working in.
    fn front_window(app_id: i32) -> Option<Window> {
        let options = kCGWindowListOptionOnScreenOnly
            | kCGWindowListExcludeDesktopElements;
        let windows = copy_window_info(options, kCGNullWindowID)?;

        windows.iter().find_map(|window| {
            let window = unsafe {
                CFDictionary::<CFString, CFType>::wrap_under_get_rule(
                    *window as _,
                )
            };

            let owner = number(&window, unsafe { kCGWindowOwnerPID })?;
            let layer = number(&window, unsafe { kCGWindowLayer })?;

            if owner != i64::from(app_id) || layer != 0 {
                return None;
            }

            let bounds = entry(&window, unsafe { kCGWindowBounds })?
                .downcast::<CFDictionary>()?;
            let rect = CGRect::from_dict_representation(&bounds)?;

            if rect.size.width < MIN_SIZE || rect.size.height < MIN_SIZE {
                return None;
            }

            let title = entry(&window, unsafe { kCGWindowName })
                .and_then(|name| name.downcast::<CFString>())
                .map(|name| name.to_string())
                .unwrap_or_default();

            Some(Window {
                id: number(&window, unsafe { kCGWindowNumber })? as u32,
                title,
                frame: Frame {
                    x: rect.origin.x,
                    y: rect.origin.y,
                    width: rect.size.width,
                    height: rect.size.height,
                },
            })
        })
    }

    // Picks a file of its own for each picture, since the prompt and the
    // watcher can both be looking at the screen at the same moment.
    fn picture_path() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);

        let next = NEXT.fetch_add(1, Ordering::Relaxed);

        std::env::temp_dir()
            .join(format!("second-cursor-{}-{next}.png", std::process::id()))
    }

    // Pictures one window alone, leaving out any window above it, ours too,
    // and deletes the file straight away once it has been read.
    fn shoot(window: u32) -> Option<Vec<u8>> {
        let path = picture_path();

        let captured = Command::new("/usr/sbin/screencapture")
            .args(["-x", "-o", "-t", "png", "-l", &window.to_string()])
            .arg(&path)
            .status()
            .is_ok_and(|status| status.success());

        let bytes = captured.then(|| fs::read(&path).ok()).flatten();
        let _ = fs::remove_file(&path);

        bytes
    }

    // Pictures the window in use, at one pixel per point so that the model
    // sees what a person sees without paying for a retina copy of it.
    pub fn capture(app_id: i32) -> Option<Picture> {
        let window = front_window(app_id)?;
        let png = shoot(window.id)?;
        let full = image::load_from_memory(&png).ok()?;

        let scaled = full.resize_exact(
            window.frame.width.round() as u32,
            window.frame.height.round() as u32,
            FilterType::Triangle,
        );

        let mut jpeg = Vec::new();

        scaled
            .to_rgb8()
            .write_with_encoder(JpegEncoder::new_with_quality(
                Cursor::new(&mut jpeg),
                JPEG_QUALITY,
            ))
            .ok()?;

        let app =
            NSRunningApplication::runningApplicationWithProcessIdentifier(
                app_id,
            )
            .and_then(|app| app.localizedName())
            .map(|name| name.to_string())
            .unwrap_or_default();

        Some(Picture {
            app,
            title: window.title,
            image: STANDARD.encode(jpeg),
            frame: window.frame,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Frame;

    const FRAME: Frame = Frame {
        x: 100.0,
        y: 50.0,
        width: 800.0,
        height: 600.0,
    };

    // Places parts of the window on screen from its top left corner, which
    // is how the agent's spots become places for the cursor.
    #[test]
    fn places_spots_on_the_window() {
        assert_eq!(FRAME.place(0.0, 0.0), Some((100.0, 50.0)));
        assert_eq!(FRAME.place(0.5, 0.5), Some((500.0, 350.0)));
        assert_eq!(FRAME.place(1.0, 1.0), Some((900.0, 650.0)));
    }

    // Refuses spots outside the window, since a model that answers in
    // pixels by mistake must not send the cursor off the screen.
    #[test]
    fn refuses_spots_outside_the_window() {
        assert_eq!(FRAME.place(1.2, 0.5), None);
        assert_eq!(FRAME.place(0.5, -0.1), None);
        assert_eq!(FRAME.place(640.0, 300.0), None);
    }
}
