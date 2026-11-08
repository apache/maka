//! Synthesized AppKit input and screenshots for `nsh test` (`dev`).
use std::rc::Rc;

use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSMenu, NSMenuItem, NSWindow,
};
use objc2_core_foundation::CGFloat;
use objc2_foundation::{NSPoint, NSString};

use crate::surface::Surface;

/// A point of the content view (points from its top left) in window
/// coordinates (from its bottom left).
pub(crate) fn to_window(window: &NSWindow, x: f64, y: f64) -> NSPoint {
    let height = window.contentView().map_or(0.0, |v| v.frame().size.height);
    NSPoint::new(x as CGFloat, height - y as CGFloat)
}

/// How many of the agent's latest mouse events [`from_agent`] knows.
const AGENT_EVENTS: usize = 64;

thread_local! {
    /// The type and timestamp of the agent's latest mouse events: a test's
    /// window takes only these, so the user's own mouse, moving over it or
    /// resting elsewhere, never changes what a test hovers
    /// (`View::pointer`). AppKit hands the view a copy of a posted event and
    /// keeps 16 bits of its event number, which real events reach; the
    /// timestamp survives the copy to the nanosecond (rounded), and no
    /// real event shares it.
    static AGENT: std::cell::RefCell<std::collections::VecDeque<(NSEventType, i64)>> =
        const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
}

/// Whether `event` is one of the agent's mouse events.
pub(crate) fn from_agent(event: &NSEvent) -> bool {
    let (kind, at) = (event.r#type(), nanoseconds(event));
    AGENT.with_borrow(|events| {
        events
            .iter()
            .any(|&(k, t)| k == kind && (t - at).abs() <= 1)
    })
}

/// `event`'s timestamp in whole nanoseconds.
fn nanoseconds(event: &NSEvent) -> i64 {
    (event.timestamp() * 1e9).round() as i64
}

pub(crate) fn mouse(window: &NSWindow, kind: NSEventType, x: f64, y: f64, clicks: isize) {
    mouse_with(window, kind, x, y, clicks, NSEventModifierFlags::empty());
}

/// A mouse event of `window` at `(x, y)` (content points).
pub(crate) fn mouse_event(
    window: &NSWindow,
    kind: NSEventType,
    x: f64,
    y: f64,
    clicks: isize,
    mods: NSEventModifierFlags,
) -> Option<Retained<NSEvent>> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        to_window(window, x, y),
        mods,
        timestamp(),
        window.windowNumber(),
        None,
        0,
        clicks,
        if clicks > 0 { 1.0 } else { 0.0 },
    )
    .inspect(|event| {
        AGENT.with_borrow_mut(|events| {
            if events.len() == AGENT_EVENTS {
                events.pop_front();
            }
            events.push_back((event.r#type(), nanoseconds(event)));
        });
    })
}

pub(crate) fn mouse_with(
    window: &NSWindow,
    kind: NSEventType,
    x: f64,
    y: f64,
    clicks: isize,
    mods: NSEventModifierFlags,
) {
    if let Some(event) = mouse_event(window, kind, x, y, clicks, mods) {
        // Through the event queue, as real clicks come: the event becomes
        // `NSApp.currentEvent` while it is handled (responders look at it).
        // The run loop handles it before the next step's timer.
        objc2_app_kit::NSApplication::sharedApplication(MainThreadMarker::from(window))
            .postEvent_atStart(&event, false);
    }
}

/// Seconds since the system started, as event timestamps are.
pub(crate) fn timestamp() -> f64 {
    objc2_foundation::NSProcessInfo::processInfo().systemUptime()
}

/// A scroll of `(dx, dy)`: points of a trackpad gesture in `phase` (a
/// `CGScrollPhase`), or lines of a mouse wheel (`None`), in a
/// `CGMomentumScrollPhase` (`0`: none), stamped `at` (seconds since the
/// system started).
#[allow(clippy::too_many_arguments)]
pub(crate) fn wheel_with(
    window: &NSWindow,
    x: f64,
    y: f64,
    dx: i32,
    dy: i32,
    phase: Option<i64>,
    momentum: i64,
    at: f64,
) {
    use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
    // Content follows the fingers (or the wheel), so a positive `dy`
    // (content up) is a negative delta.
    let unit = match phase {
        Some(_) => CGScrollEventUnit::Pixel,
        None => CGScrollEventUnit::Line,
    };
    let Some(event) = CGEvent::new_scroll_wheel_event2(None, unit, 2, -dy, -dx, 0) else {
        return;
    };
    // A window-less event's `locationInWindow` is its screen point, which
    // `sendEvent:` takes as a window point: place it so that they match.
    let p = to_window(window, x, y);
    let main_height = objc2_app_kit::NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    CGEvent::set_location(
        Some(&event),
        objc2_core_foundation::CGPoint::new(p.x, main_height - p.y),
    );
    if let Some(phase) = phase {
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::ScrollWheelEventScrollPhase,
            phase,
        );
    }
    if momentum != 0 {
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::ScrollWheelEventMomentumPhase,
            momentum,
        );
    }
    // Nanoseconds, as `NSEvent.timestamp` reads it.
    CGEvent::set_timestamp(Some(&event), (at * 1e9) as u64);
    let Some(ns) = NSEvent::eventWithCGEvent(&event) else {
        return;
    };
    if momentum == 0 {
        crate::view::scripted(&ns, || window.sendEvent(&ns));
        return;
    }
    // The window drops synthesized momentum events (the system's go to
    // the view that took the gesture): hand them to the view under the
    // pointer, as AppKit would.
    let view = window.contentView().and_then(|content| {
        let local = content.convertPoint_fromView(ns.locationInWindow(), None);
        // SAFETY: a superview's point, as hitTest: takes.
        let outer = unsafe { content.superview() };
        let p = outer.map_or(local, |o| {
            o.convertPoint_fromView(ns.locationInWindow(), None)
        });
        content.hitTest(p)
    });
    if let Some(view) = view {
        crate::view::scripted(&ns, || view.scrollWheel(&ns));
    }
}

pub(crate) fn type_text(surface: &Rc<Surface>, window: &NSWindow, text: &str) {
    for c in text.chars() {
        let s = c.to_string();
        key_event(surface, window, &s, 0, NSEventModifierFlags::empty());
    }
}

/// One modifier's flag.
pub(crate) fn modifier(name: &str) -> Option<NSEventModifierFlags> {
    Some(match name {
        "cmd" => NSEventModifierFlags::Command,
        "shift" => NSEventModifierFlags::Shift,
        "alt" => NSEventModifierFlags::Option,
        "ctrl" => NSEventModifierFlags::Control,
        _ => return None,
    })
}

pub(crate) fn key(surface: &Rc<Surface>, window: &NSWindow, name: &str) {
    let mut flags = NSEventModifierFlags::empty();
    let mut name = name;
    // `cmd++` is Command and `+`.
    while let Some((m, rest)) = name.split_once('+').filter(|(_, r)| !r.is_empty()) {
        let Some(flag) = modifier(m) else { break };
        flags |= flag;
        name = rest;
    }
    // (characters, virtual key code)
    let (chars, code): (String, u16) = match name {
        "Return" => ("\r".into(), 36),
        "Escape" => ("\u{1b}".into(), 53),
        // Shift+Tab types a backtab, which is what field editors read.
        "Tab" if flags.contains(NSEventModifierFlags::Shift) => ("\u{19}".into(), 48),
        "Tab" => ("\t".into(), 48),
        "BackSpace" => ("\u{7f}".into(), 51),
        "space" => (" ".into(), 49),
        "Up" => ("\u{f700}".into(), 126),
        "Down" => ("\u{f701}".into(), 125),
        "Left" => ("\u{f702}".into(), 123),
        "Right" => ("\u{f703}".into(), 124),
        "Page_Up" => ("\u{f72c}".into(), 116),
        "Page_Down" => ("\u{f72d}".into(), 121),
        "Home" => ("\u{f729}".into(), 115),
        "End" => ("\u{f72b}".into(), 119),
        "Delete" => ("\u{f728}".into(), 117),
        // F1 to F12 (`F5`).
        f if f.len() > 1
            && f.starts_with('F')
            && let Some(n) = f[1..].parse::<u16>().ok().filter(|n| (1..=12).contains(n)) =>
        {
            const CODES: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
            // With the Function flag, as a keyboard's function keys have it:
            // without it AppKit does not match one to a menu item's key
            // equivalent.
            flags |= NSEventModifierFlags::Function;
            let c = char::from_u32(0xf703 + u32::from(n)).unwrap_or('\0');
            (c.to_string(), CODES[usize::from(n - 1)])
        }
        // Shift types the shifted character, which menus' key
        // equivalents match (`cmd+shift+z` is Redo's `Z`). A character's
        // key is the US layout's, as a real event's would be.
        other => {
            let mut chars = other.chars();
            let code = match (chars.next(), chars.next()) {
                (Some(c), None) => {
                    crate::input::us_typing_key(c).map_or(crate::input::NO_KEY, |(code, _)| code)
                }
                _ => crate::input::NO_KEY,
            };
            if flags.contains(NSEventModifierFlags::Shift) {
                let mut one = other.chars();
                let typed = match (one.next(), one.next()) {
                    (Some(c), None) => nsh_core::keymap::shifted(c).to_string(),
                    _ => other.to_uppercase(),
                };
                (typed, code)
            } else {
                (other.into(), code)
            }
        }
    };
    key_event(surface, window, &chars, code, flags);
}

pub(crate) fn key_event(
    surface: &Rc<Surface>,
    window: &NSWindow,
    chars: &str,
    code: u16,
    flags: NSEventModifierFlags,
) {
    let s = NSString::from_str(chars);
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            flags,
            timestamp(),
            window.windowNumber(),
            None,
            &s,
            &s,
            false,
            code,
        );
        let Some(event) = event else { continue };
        if kind == NSEventType::KeyDown && crate::text_input::hold_nsevent(surface, &event) {
            continue;
        }
        let app = NSApplication::sharedApplication(MainThreadMarker::from(window));
        // Key equivalents (menus) and key monitors (`nsh/keymap`) are the
        // application's, which hands the key to its key window.
        if window.isKeyWindow() {
            app.sendEvent(&event);
        } else if kind == NSEventType::KeyDown && crate::keymap::fires(surface, &event) {
            // The app's key monitor never sees a window's own events: it
            // gets the key first, as it would in the key window (the test
            // window often is not one, its app left in the background).
        } else if kind == NSEventType::KeyDown && key_equivalent(window, &app, &event) {
            // A key equivalent of the window's views (Command keys) or of
            // the main menu, sent where the application would send it to
            // its key window: this one is not (an app run in the
            // background has none).
        } else if flags.contains(NSEventModifierFlags::Command) {
            app.sendEvent(&event);
        } else {
            window.sendEvent(&event);
        }
    }
}

/// Whether a key equivalent took the key-down `event`: a Command key's, of
/// `window`'s views, else the main menu's item for it (any modifiers, as in
/// the key window), in the order the application tries them. A menu's
/// action goes to its item's target, else down `window`'s responder chain
/// from its first responder: AppKit's own search for a target starts at
/// the key window, which an app in the background has none of.
fn key_equivalent(window: &NSWindow, app: &NSApplication, event: &NSEvent) -> bool {
    if event
        .modifierFlags()
        .contains(NSEventModifierFlags::Command)
        && window.performKeyEquivalent(event)
    {
        return true;
    }
    let Some(item) = app.mainMenu().and_then(|menu| menu_item(&menu, event)) else {
        return false;
    };
    let Some(action) = item.action() else {
        return false;
    };
    // SAFETY: `action` is the item's own, and the item is its sender, as
    // when the menu sends it.
    unsafe {
        match item.target() {
            Some(target) => app.sendAction_to_from(action, Some(&target), Some(&item)),
            None => window
                .firstResponder()
                .is_some_and(|responder| responder.tryToPerform_with(action, Some(&item))),
        }
    }
}

/// The item of `menu` (or of its submenus) whose key equivalent key-down
/// `event` is. Not whether it is enabled: AppKit validates that against
/// the key window's responders, and with none every item looks disabled
/// once the menu has been validated; an item nothing answers does nothing
/// when sent, and one the app disabled has an action nothing answers.
fn menu_item(menu: &NSMenu, event: &NSEvent) -> Option<Retained<NSMenuItem>> {
    let flags =
        event.modifierFlags() & (key_equivalent_modifiers() | NSEventModifierFlags::Function);
    let key = event
        .charactersIgnoringModifiers()?
        .to_string()
        .to_lowercase();
    find_item(menu, flags, &key)
}

/// The modifiers a menu item's key equivalent can name.
fn key_equivalent_modifiers() -> NSEventModifierFlags {
    NSEventModifierFlags::Command
        | NSEventModifierFlags::Shift
        | NSEventModifierFlags::Option
        | NSEventModifierFlags::Control
}

/// [`menu_item`]'s search, for the event's `flags` (of those modifiers and Fn)
/// and lower-case `key`.
fn find_item(
    menu: &NSMenu,
    flags: NSEventModifierFlags,
    key: &str,
) -> Option<Retained<NSMenuItem>> {
    for item in menu.itemArray() {
        if let Some(submenu) = item.submenu() {
            if item.action() == Some(crate::chrome::disabled()) {
                continue;
            }
            if let Some(found) = find_item(&submenu, flags, key) {
                return Some(found);
            }
            continue;
        }
        let equivalent = item.keyEquivalent().to_string();
        if equivalent.is_empty() {
            continue;
        }
        let mask = item.keyEquivalentModifierMask();
        // An item of the Fn (Globe) key (Fn+D Dictation, Fn+F Full Screen)
        // wants it held; other items take a key with or without it, as the
        // keyboard's function keys and arrows carry it.
        if mask.contains(NSEventModifierFlags::Function)
            && !flags.contains(NSEventModifierFlags::Function)
        {
            continue;
        }
        // An upper-case equivalent means Shift with its lower case.
        let mut wanted = mask & key_equivalent_modifiers();
        if equivalent.chars().any(char::is_uppercase) {
            wanted |= NSEventModifierFlags::Shift;
        }
        if wanted == flags & key_equivalent_modifiers()
            && if equivalent.is_ascii() {
                equivalent.eq_ignore_ascii_case(key)
            } else {
                equivalent.to_lowercase() == key
            }
        {
            return Some(item);
        }
    }
    None
}

/// A PNG of the window's content as the window server composites it
/// ([`composited`]), or, where it cannot give one, as AppKit draws it in
/// process ([`drawn`]). Neither needs the Screen Recording permission.
pub(crate) fn shot(window: &NSWindow) -> Result<Vec<u8>, String> {
    match composited(window) {
        Ok(png) => Ok(png),
        Err(why) => {
            log::debug!("screenshot drawn in process: {why}");
            drawn(window)
        }
    }
}

/// `CGWindowListCreateImageFromArray`: images of windows as the window
/// server composited them. Deprecated since macOS 14 and missing from the
/// SDK's headers since macOS 15, but still exported (macOS 27), so it is
/// looked up at run time: a system without it falls back to [`drawn`].
type CreateImageFromArray = unsafe extern "C" fn(
    objc2_core_foundation::CGRect,
    *const objc2_core_foundation::CFArray,
    u32,
) -> *mut objc2_core_graphics::CGImage;

/// `kCGWindowImageBestResolution`: pixels at the display's backing scale.
const IMAGE_BEST_RESOLUTION: u32 = 1 << 3;

/// The window's content view as the window server composited it, with
/// its sheets and child windows over it: what the screen shows, Core
/// Animation's own rendering (backdrop blur and glass, 3D transforms, Core
/// Image filters, `AVPlayerLayer`, web views), which no in-process
/// rendering reproduces (`CARenderer` cannot render a layer tree a window
/// shows). An app may take pictures of its own windows without the Screen
/// Recording permission; the picture is of the window's own surface, so
/// windows over it do not matter.
fn composited(window: &NSWindow) -> Result<Vec<u8>, String> {
    use objc2_app_kit::NSScreen;
    use objc2_core_foundation::{CFArray, CFRetained, CGPoint, CGRect, CGSize};

    if !window.isVisible() {
        return Err("the window is not on screen".into());
    }
    // SAFETY: `dlsym` with `RTLD_DEFAULT` and a NUL-terminated name only
    // looks the symbol up.
    let symbol = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"CGWindowListCreateImageFromArray".as_ptr(),
        )
    };
    if symbol.is_null() {
        return Err("CGWindowListCreateImageFromArray is missing".into());
    }
    // SAFETY: the symbol is CoreGraphics' function of this signature.
    let create: CreateImageFromArray = unsafe { std::mem::transmute(symbol) };
    let view = window.contentView().ok_or("the window has no content")?;
    let mtm = MainThreadMarker::from(window);
    let primary = NSScreen::screens(mtm)
        .firstObject()
        .ok_or("there is no screen")?
        .frame();
    let frame = window.convertRectToScreen(view.convertRect_toView(view.bounds(), None));
    // Screen coordinates from the primary screen's top left, as the window
    // server's.
    let rect = CGRect::new(
        CGPoint::new(
            frame.origin.x,
            primary.size.height - frame.origin.y - frame.size.height,
        ),
        CGSize::new(frame.size.width, frame.size.height),
    );
    let mut ids = Vec::new();
    front_to_back(window, &mut ids);
    let mut values: Vec<*const std::ffi::c_void> = ids
        .iter()
        .map(|&id| id as usize as *const std::ffi::c_void)
        .collect();
    // SAFETY: the array holds window numbers as its values (as the
    // function takes them), so it gets no callbacks to retain them;
    // `values` outlives the call that copies them.
    let array = unsafe {
        CFArray::new(
            None,
            values.as_mut_ptr(),
            values.len() as isize,
            std::ptr::null(),
        )
    }
    .ok_or("cannot make the window list")?;
    // SAFETY: a rectangle, an array of window numbers and image options,
    // as the function takes them; it returns a +1 image or null.
    let image = unsafe { create(rect, &*array, IMAGE_BEST_RESOLUTION) };
    let image = std::ptr::NonNull::new(image).ok_or("the window server gave no picture")?;
    // SAFETY: the function returns an image the caller owns.
    let image = unsafe { CFRetained::from_raw(image) };
    if blank(&image) {
        // A locked screen, or a window the window server has no surface of.
        return Err("the window server's picture is blank".into());
    }
    let rep = objc2_app_kit::NSBitmapImageRep::initWithCGImage(
        <objc2_app_kit::NSBitmapImageRep as objc2::AnyThread>::alloc(),
        &image,
    );
    png(&rep)
}

/// The numbers of `window`, its sheets and its visible child windows,
/// frontmost first (the order the window server composites them in).
fn front_to_back(window: &NSWindow, ids: &mut Vec<u32>) {
    if let Some(sheet) = window.attachedSheet() {
        front_to_back(&sheet, ids);
    }
    if let Some(children) = window.childWindows() {
        for child in children.to_vec().iter().rev() {
            if child.isVisible() {
                front_to_back(child, ids);
            }
        }
    }
    let id = window.windowNumber() as u32;
    if !ids.contains(&id) {
        ids.push(id);
    }
}

/// Whether `image` has nothing but black or clear pixels, judged from a
/// small copy.
fn blank(image: &objc2_core_graphics::CGImage) -> bool {
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
        CGImageByteOrderInfo,
    };
    const SIDE: usize = 32;
    if CGImage::width(Some(image)) == 0 || CGImage::height(Some(image)) == 0 {
        return true;
    }
    let Some(space) = CGColorSpace::new_device_rgb() else {
        return false;
    };
    let mut pixels = [0u8; SIDE * SIDE * 4];
    // SAFETY: `pixels` holds an RGBA context of these dimensions and
    // outlives it.
    unsafe {
        let Some(context) = CGBitmapContextCreate(
            pixels.as_mut_ptr().cast(),
            SIDE,
            SIDE,
            8,
            SIDE * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        ) else {
            return false;
        };
        CGContext::draw_image(
            Some(&context),
            CGRect::new(CGPoint::ZERO, CGSize::new(SIDE as f64, SIDE as f64)),
            Some(image),
        );
    }
    pixels
        .as_chunks::<4>()
        .0
        .iter()
        .all(|px| px[3] == 0 || px[..3] == [0, 0, 0])
}

/// A bitmap encoded as a PNG.
fn png(rep: &objc2_app_kit::NSBitmapImageRep) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey};
    use objc2_foundation::NSDictionary;
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, objc2::runtime::AnyObject>::new();
    // SAFETY: an empty property dictionary is valid for PNG.
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) };
    Ok(data.ok_or("cannot encode the picture")?.to_vec())
}

/// Renders the window's content in process (`cacheDisplayInRect:`): it
/// works wherever the window is, but AppKit's drawing is not Core
/// Animation's (`docs/dev/macos.md`).
fn drawn(window: &NSWindow) -> Result<Vec<u8>, String> {
    let rep = crate::capture::bitmap(window, None)?;
    png(&rep)
}
