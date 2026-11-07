use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct Element {
    pub id: usize,
    pub role: String,
    pub name: String,

    #[serde(skip)]
    pub center: (f64, f64),
}

#[cfg(target_os = "macos")]
pub use macos::{activate, focused_app_id, read};

// Returns no controls on systems without a reader yet, which leaves the
// agent able to answer questions but with nothing to point at.
#[cfg(not(target_os = "macos"))]
pub fn read() -> Vec<Element> {
    Vec::new()
}

// Reports no focused app on systems without a reader yet, which simply skips
// handing focus back when the prompt closes.
#[cfg(not(target_os = "macos"))]
pub fn focused_app_id() -> Option<i32> {
    None
}

// Does nothing on systems without a reader yet, because no app was recorded
// as focused when the prompt opened.
#[cfg(not(target_os = "macos"))]
pub fn activate(_app_id: i32) {}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr;

    use accessibility_sys::{
        AXUIElementCopyAttributeValue, AXUIElementCopyElementAtPosition,
        AXUIElementCreateApplication, AXUIElementCreateSystemWide,
        AXUIElementGetPid, AXUIElementRef, AXUIElementSetAttributeValue,
        AXValueGetValue, AXValueRef, kAXErrorSuccess, kAXValueTypeCGPoint,
        kAXValueTypeCGSize,
    };

    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;
    use core_graphics_types::geometry::{CGPoint, CGSize};

    use super::Element;

    const ACTIONABLE: [&str; 15] = [
        "AXButton",
        "AXLink",
        "AXTextField",
        "AXTextArea",
        "AXCheckBox",
        "AXRadioButton",
        "AXPopUpButton",
        "AXMenuButton",
        "AXComboBox",
        "AXTab",
        "AXSearchField",
        "AXDisclosureTriangle",
        "AXSlider",
        "AXRow",
        "AXCell",
    ];

    const TEXT_INPUTS: [&str; 4] =
        ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];

    const SCROLLERS: [&str; 3] = ["AXScrollArea", "AXWebArea", "AXWindow"];
    const MAX_NODES: usize = 20_000;
    const MAX_PARENTS: usize = 16;
    const MIN_SIZE: f64 = 4.0;

    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    impl Rect {
        // Returns the part of this box inside another, which is what keeps
        // controls scrolled out of view from being offered as targets.
        fn overlap(self, other: Rect) -> Option<Rect> {
            let x = self.x.max(other.x);
            let y = self.y.max(other.y);
            let right = (self.x + self.width).min(other.x + other.width);
            let bottom = (self.y + self.height).min(other.y + other.height);

            (right > x && bottom > y).then_some(Rect {
                x,
                y,
                width: right - x,
                height: bottom - y,
            })
        }
    }

    // Reads one accessibility attribute, treating every failure as missing
    // because apps support wildly different sets of attributes.
    fn attribute(element: &CFType, name: &str) -> Option<CFType> {
        let mut value: CFTypeRef = ptr::null();

        let error = unsafe {
            AXUIElementCopyAttributeValue(
                element.as_CFTypeRef() as AXUIElementRef,
                CFString::new(name).as_concrete_TypeRef(),
                &mut value,
            )
        };

        (error == kAXErrorSuccess && !value.is_null())
            .then(|| unsafe { CFType::wrap_under_create_rule(value) })
    }

    // Reads an attribute as trimmed text, and drops empty strings so that
    // callers can simply fall through to their next choice of label.
    fn text(element: &CFType, name: &str) -> Option<String> {
        attribute(element, name)?
            .downcast::<CFString>()
            .map(|value| value.to_string().trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    // Lists the children of an element, or nothing for a leaf, so the walk
    // over the tree never has to special-case the bottom of it.
    fn children(element: &CFType) -> Vec<CFType> {
        let Some(list) = attribute(element, "AXChildren") else {
            return Vec::new();
        };

        let list = unsafe {
            CFArray::<CFType>::wrap_under_get_rule(
                list.as_CFTypeRef() as CFArrayRef
            )
        };

        list.iter().map(|child| child.clone()).collect()
    }

    // Unpacks a boxed accessibility value into its plain geometry type,
    // which is how macos hands over every position and size.
    fn value<T: Default>(value: &CFType, kind: u32) -> Option<T> {
        let mut out = T::default();

        let ok = unsafe {
            AXValueGetValue(
                value.as_CFTypeRef() as AXValueRef,
                kind,
                &mut out as *mut T as *mut c_void,
            )
        };

        ok.then_some(out)
    }

    // Reads where an element sits on screen, in points from the top left of
    // the main display, which the overlay can use directly.
    fn frame(element: &CFType) -> Option<Rect> {
        let position = attribute(element, "AXPosition")?;
        let size = attribute(element, "AXSize")?;
        let position: CGPoint = value(&position, kAXValueTypeCGPoint)?;
        let size: CGSize = value(&size, kAXValueTypeCGSize)?;

        Some(Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    }

    // Picks the best label for a control, preferring titles over values, and
    // never reads what someone typed or the contents of a password field.
    fn name(element: &CFType, role: &str) -> String {
        let secure = attribute(element, "AXSubrole")
            .and_then(|subrole| subrole.downcast::<CFString>())
            .is_some_and(|subrole| subrole == "AXSecureTextField");

        if secure {
            return "Password field".to_owned();
        }

        let typed = TEXT_INPUTS.contains(&role);

        text(element, "AXTitle")
            .or_else(|| text(element, "AXDescription"))
            .or_else(|| (!typed).then(|| text(element, "AXValue")).flatten())
            .or_else(|| text(element, "AXPlaceholderValue"))
            .or_else(|| text(element, "AXHelp"))
            .or_else(|| {
                attribute(element, "AXTitleUIElement")
                    .and_then(|title| text(&title, "AXValue"))
            })
            .or_else(|| {
                let labels: Vec<String> = children(element)
                    .iter()
                    .take(6)
                    .filter_map(|child| text(child, "AXValue"))
                    .collect();

                (!typed && !labels.is_empty()).then(|| labels.join(" "))
            })
            .unwrap_or_default()
            .chars()
            .take(80)
            .collect()
    }

    // Checks that a person could reach this control at this point, because
    // macos answers with the element on top or something inside it.
    fn reachable(system: &CFType, element: &CFType, x: f64, y: f64) -> bool {
        let mut hit: AXUIElementRef = ptr::null_mut();

        let error = unsafe {
            AXUIElementCopyElementAtPosition(
                system.as_CFTypeRef() as AXUIElementRef,
                x as f32,
                y as f32,
                &mut hit,
            )
        };

        if error != kAXErrorSuccess || hit.is_null() {
            return false;
        }

        let mut current =
            unsafe { CFType::wrap_under_create_rule(hit as CFTypeRef) };

        for _ in 0..MAX_PARENTS {
            if current == *element {
                return true;
            }

            match attribute(&current, "AXParent") {
                Some(parent) => current = parent,
                None => return false,
            }
        }

        false
    }

    // Wraps a freshly created accessibility element, so that core foundation
    // releases it once the last reference to it goes away.
    fn owned(element: AXUIElementRef) -> CFType {
        unsafe { CFType::wrap_under_create_rule(element as CFTypeRef) }
    }

    // Opens the app with this id, and asks it to build its tree if needed,
    // since chromium and electron only do that when someone requests it.
    fn open_app(app_id: i32) -> CFType {
        let app = owned(unsafe { AXUIElementCreateApplication(app_id) });

        unsafe {
            AXUIElementSetAttributeValue(
                app.as_CFTypeRef() as AXUIElementRef,
                CFString::new("AXManualAccessibility").as_concrete_TypeRef(),
                CFBoolean::true_value().as_CFTypeRef(),
            );
        }

        app
    }

    // Finds which app is in front right now, so focus can go straight back
    // to it once the prompt has gone away.
    pub fn focused_app_id() -> Option<i32> {
        let system = owned(unsafe { AXUIElementCreateSystemWide() });
        let focused = attribute(&system, "AXFocusedApplication")?;
        let mut app_id = 0;

        unsafe {
            AXUIElementGetPid(
                focused.as_CFTypeRef() as AXUIElementRef,
                &mut app_id,
            );
        }

        Some(app_id)
    }

    // Brings an app back to the front, because hiding our own windows does
    // not hand the keyboard back to whatever was in use before.
    pub fn activate(app_id: i32) {
        let app = owned(unsafe { AXUIElementCreateApplication(app_id) });

        unsafe {
            AXUIElementSetAttributeValue(
                app.as_CFTypeRef() as AXUIElementRef,
                CFString::new("AXFrontmost").as_concrete_TypeRef(),
                CFBoolean::true_value().as_CFTypeRef(),
            );
        }
    }

    // Reads the controls a person could reach in the focused window, clipped
    // to what it shows, so that nothing hidden becomes an option.
    pub fn read() -> Vec<Element> {
        let system = owned(unsafe { AXUIElementCreateSystemWide() });

        let Some(app) = focused_app_id().map(open_app) else {
            return Vec::new();
        };

        let window = attribute(&app, "AXFocusedWindow")
            .or_else(|| attribute(&app, "AXMainWindow"));

        let Some(window) = window else {
            return Vec::new();
        };

        let Some(bounds) = frame(&window) else {
            return Vec::new();
        };

        let mut found = Vec::new();
        let mut seen = 0;
        let mut stack = vec![(window, bounds)];

        while let Some((node, clip)) = stack.pop() {
            seen += 1;

            if seen > MAX_NODES {
                break;
            }

            let role = text(&node, "AXRole").unwrap_or_default();

            let box_ = frame(&node)
                .filter(|rect| rect.width > 0.0 && rect.height > 0.0);

            let visible = match box_ {
                Some(rect) => match rect.overlap(clip) {
                    Some(visible) => visible,
                    None => continue,
                },
                None => clip,
            };

            let enabled = attribute(&node, "AXEnabled")
                .and_then(|value| value.downcast::<CFBoolean>())
                .is_none_or(bool::from);

            if ACTIONABLE.contains(&role.as_str())
                && box_.is_some()
                && visible.width >= MIN_SIZE
                && visible.height >= MIN_SIZE
                && enabled
            {
                let center = (
                    visible.x + visible.width / 2.0,
                    visible.y + visible.height / 2.0,
                );

                if reachable(&system, &node, center.0, center.1) {
                    found.push(Element {
                        id: found.len(),
                        name: name(&node, &role),
                        role: role.trim_start_matches("AX").to_owned(),
                        center,
                    });
                }
            }

            // Scroll areas hide whatever overflows them.
            let inner = if SCROLLERS.contains(&role.as_str()) {
                visible
            } else {
                clip
            };

            stack.extend(
                children(&node).into_iter().map(|child| (child, inner)),
            );
        }

        found
    }
}
