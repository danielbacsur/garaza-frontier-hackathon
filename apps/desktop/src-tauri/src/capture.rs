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

    // Turns a place on screen into parts of the window's width and height,
    // the reverse of placing, for a place that lies inside the window.
    pub fn fraction(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let across = (x - self.x) / self.width;
        let down = (y - self.y) / self.height;
        let inside =
            (0.0..=1.0).contains(&across) && (0.0..=1.0).contains(&down);

        inside.then_some((across, down))
    }
}

// A picture of the window in use, scaled to screen points and encoded as a
// JPEG, with the app and window it shows.
#[derive(Clone, Default, Serialize)]
pub struct Picture {
    pub app: String,
    pub title: String,
    pub image: String,
    pub width: u32,
    pub height: u32,

    #[serde(skip)]
    pub frame: Frame,

    #[serde(skip)]
    pub thumbnail: Vec<u8>,
}

// The small grey copy kept of every picture, fine enough that a tick in a
// box still shows, and how much a cell of it must change by to count.
const THUMBNAIL: (u32, u32) = (192, 128);
const CHANGED_LEVEL: u8 = 40;

// How many cells must change for a change nobody caused to count: more than
// a caret blinking or a clock ticking take, which are never worth a look.
const WIDE_CELLS: usize = 6;

impl Picture {
    // Counts the cells of the small grey copies that differ by more than a
    // shade, so that a button merely lit under the mouse never counts.
    fn changed_cells(&self, other: &Picture) -> usize {
        self.thumbnail
            .iter()
            .zip(&other.thumbnail)
            .filter(|(a, b)| a.abs_diff(**b) > CHANGED_LEVEL)
            .count()
    }

    // Tells whether two pictures show something different anywhere, however
    // small, which after the person acted is enough to be worth a look.
    pub fn differs(&self, other: &Picture) -> bool {
        self.frame != other.frame
            || self.thumbnail.len() != other.thumbnail.len()
            || self.changed_cells(other) > 0
    }

    // Tells whether two pictures differ widely, by more than a caret or a
    // clock would, which a change nobody caused has to be worth a look.
    pub fn differs_widely(&self, other: &Picture) -> bool {
        self.frame != other.frame
            || self.thumbnail.len() != other.thumbnail.len()
            || self.changed_cells(other) >= WIDE_CELLS
    }
}

// The place on screen a window is pictured with: from the display's top
// left corner, where the menu bar keeps every app's menus, down to the
// window's bottom right, cut at the display's edges, so the menus, any menu
// opened from them and whatever else lies over the window show at their
// true place. A window not below the menu bar is pictured alone.
pub fn seen(window: Frame, menu_bar: f64, display: (f64, f64)) -> Frame {
    if window.y < menu_bar {
        return window;
    }

    Frame {
        x: 0.0,
        y: 0.0,
        width: (window.x + window.width).min(display.0),
        height: (window.y + window.height).min(display.1),
    }
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
    use std::ffi::c_void;
    use std::io::Cursor;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::display::CGDisplay;
    use core_graphics::image::CGImage;
    use core_graphics::window::{
        copy_window_info, create_image, create_image_from_array,
        kCGNullWindowID, kCGWindowBounds, kCGWindowImageBoundsIgnoreFraming,
        kCGWindowImageNominalResolution, kCGWindowLayer,
        kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionIncludingWindow, kCGWindowListOptionOnScreenOnly,
        kCGWindowName, kCGWindowNumber, kCGWindowOwnerPID,
    };
    use core_graphics_types::geometry::{CGPoint, CGRect, CGSize};
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::{FilterType, crop_imm};
    use image::{DynamicImage, RgbImage};
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
    };

    use super::{Frame, Picture, THUMBNAIL, seen};

    const JPEG_QUALITY: u8 = 80;
    const MIN_SIZE: f64 = 40.0;

    // How much smaller than the window its picture is sent, since the model
    // charges by the pixel and still points as well at three quarters.
    const SCALE: f64 = 0.75;

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

    // Finds how tall the menu bar is from the window server's own window for
    // it, since that is where every app keeps its menus.
    fn menu_bar() -> Option<f64> {
        let windows =
            copy_window_info(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)?;

        windows.iter().find_map(|window| {
            let window = unsafe {
                CFDictionary::<CFString, CFType>::wrap_under_get_rule(
                    *window as _,
                )
            };

            let name = entry(&window, unsafe { kCGWindowName })?
                .downcast::<CFString>()?
                .to_string();

            if name != "Menubar" {
                return None;
            }

            let bounds = entry(&window, unsafe { kCGWindowBounds })?
                .downcast::<CFDictionary>()?;
            let rect = CGRect::from_dict_representation(&bounds)?;

            (rect.origin.y == 0.0).then_some(rect.size.height)
        })
    }

    // Pictures one window alone, in process and at one pixel per point, so
    // nothing is written to disk and the model sees what a person sees.
    fn shoot(window: u32) -> Option<RgbImage> {
        let whole = CGRect::new(
            &CGPoint::new(f64::INFINITY, f64::INFINITY),
            &CGSize::new(0.0, 0.0),
        );

        pixels(create_image(
            whole,
            kCGWindowListOptionIncludingWindow,
            window,
            kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution,
        )?)
    }

    // Pictures a part of the screen as a person sees it, with every window
    // on it in front of or behind the one in use, such as a menu dropped
    // from the menu bar, except this app's own: the cursor and the prompt.
    fn shoot_screen(frame: Frame) -> Option<RgbImage> {
        let own = i64::from(std::process::id());
        let windows =
            copy_window_info(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)?;

        // The window server takes the ids themselves as the array's values,
        // not numbers wrapped as objects.
        let shown: Vec<*const c_void> = windows
            .iter()
            .filter_map(|window| {
                let window = unsafe {
                    CFDictionary::<CFString, CFType>::wrap_under_get_rule(
                        *window as _,
                    )
                };

                if number(&window, unsafe { kCGWindowOwnerPID })? == own {
                    return None;
                }

                let id = number(&window, unsafe { kCGWindowNumber })? as usize;

                Some(id as *const c_void)
            })
            .collect();

        let rect = CGRect::new(
            &CGPoint::new(frame.x, frame.y),
            &CGSize::new(frame.width, frame.height),
        );

        let image = create_image_from_array(
            rect,
            CFArray::from_copyable(&shown),
            kCGWindowImageNominalResolution,
        )?;

        // A part cut short by the screen's edge would no longer match the
        // place it is meant to show.
        let whole = image.width() == frame.width.round() as usize
            && image.height() == frame.height.round() as usize;

        whole.then(|| pixels(image)).flatten()
    }

    // Turns what the window server handed over into plain RGB pixels.
    fn pixels(image: CGImage) -> Option<RgbImage> {
        let (width, height) = (image.width(), image.height());
        let stride = image.bytes_per_row();
        let data = image.data();
        let mut rgb = Vec::with_capacity(width * height * 3);

        // The window server hands over rows of BGRA pixels, padded at the end.
        for row in data.bytes().chunks(stride).take(height) {
            for pixel in row[..width * 4].chunks_exact(4) {
                rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
        }

        RgbImage::from_raw(width as u32, height as u32, rgb)
    }

    // Pictures the window in use as a person sees it, from the menu bar down,
    // scaled down for the model, with a small grey copy of the window's own
    // part kept for telling pictures apart, so that a menu opening over it
    // counts as a change while the clock in the bar never does. A window the
    // screen cannot be pictured around is pictured alone.
    pub fn capture(app_id: i32) -> Option<Picture> {
        let window = front_window(app_id)?;
        let display = CGDisplay::main().bounds().size;
        let wanted = seen(
            window.frame,
            menu_bar().unwrap_or(0.0),
            (display.width, display.height),
        );

        let (full, frame) = match shoot_screen(wanted) {
            Some(full) => (full, wanted),
            None => (shoot(window.id)?, window.frame),
        };

        let thumbnail = crop_imm(
            &full,
            (window.frame.x - frame.x).max(0.0).round() as u32,
            (window.frame.y - frame.y).round() as u32,
            window.frame.width.round() as u32,
            window.frame.height.round() as u32,
        )
        .to_image();
        let thumbnail = DynamicImage::ImageRgb8(thumbnail)
            .resize_exact(THUMBNAIL.0, THUMBNAIL.1, FilterType::Triangle)
            .to_luma8()
            .into_raw();

        let width = (f64::from(full.width()) * SCALE).round() as u32;
        let height = (f64::from(full.height()) * SCALE).round() as u32;

        let scaled = DynamicImage::ImageRgb8(full).resize_exact(
            width,
            height,
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
            width,
            height,
            frame,
            thumbnail,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Frame, Picture, seen};

    const FRAME: Frame = Frame {
        x: 100.0,
        y: 50.0,
        width: 800.0,
        height: 600.0,
    };

    // Pictures from the display's top left corner down to the window's
    // bottom right, cut at the display's edges, unless the window sits in
    // the menu bar.
    #[test]
    fn sees_from_the_menu_bar_down_to_the_window() {
        let whole = seen(FRAME, 33.0, (1512.0, 982.0));

        assert_eq!((whole.x, whole.y), (0.0, 0.0));
        assert_eq!((whole.width, whole.height), (900.0, 650.0));

        let low = seen(FRAME, 33.0, (850.0, 600.0));

        assert_eq!((low.width, low.height), (850.0, 600.0));

        let high = Frame { y: 20.0, ..FRAME };

        assert_eq!(seen(high, 33.0, (1512.0, 982.0)), high);
    }

    // Places parts of the window on screen from its top left corner, which
    // is how the agent's spots become places for the cursor.
    #[test]
    fn places_spots_on_the_window() {
        assert_eq!(FRAME.place(0.0, 0.0), Some((100.0, 50.0)));
        assert_eq!(FRAME.place(0.5, 0.5), Some((500.0, 350.0)));
        assert_eq!(FRAME.place(1.0, 1.0), Some((900.0, 650.0)));
    }

    // Turns a click on the window back into the parts the agent points
    // with, and leaves out a click anywhere else.
    #[test]
    fn measures_clicks_on_the_window() {
        assert_eq!(FRAME.fraction(500.0, 350.0), Some((0.5, 0.5)));
        assert_eq!(FRAME.fraction(100.0, 50.0), Some((0.0, 0.0)));
        assert_eq!(FRAME.fraction(50.0, 350.0), None);
    }

    // Refuses spots outside the window, since a model that answers in
    // pixels by mistake must not send the cursor off the screen.
    #[test]
    fn refuses_spots_outside_the_window() {
        assert_eq!(FRAME.place(1.2, 0.5), None);
        assert_eq!(FRAME.place(0.5, -0.1), None);
        assert_eq!(FRAME.place(640.0, 300.0), None);
    }

    // Counts a change only when a cell of the picture really looks different,
    // and a wide one only when more cells change than a caret blinking does.
    #[test]
    fn notices_only_real_changes() {
        let picture = |thumbnail: Vec<u8>| Picture {
            frame: FRAME,
            thumbnail,
            ..Picture::default()
        };

        let before = picture(vec![100; 16]);
        let shaded = picture(vec![130; 16]);
        let mut ticked = vec![100; 16];
        let mut loaded = vec![100; 16];

        ticked[3] = 180;
        loaded[..6].fill(180);

        assert!(!before.differs(&shaded));
        assert!(before.differs(&picture(ticked.clone())));
        assert!(!before.differs_widely(&picture(ticked)));
        assert!(before.differs_widely(&picture(loaded)));
    }
}
