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
    /// real event shares it. With each, the window point it was made at
    /// ([`placed`]).
    static AGENT: std::cell::RefCell<std::collections::VecDeque<(NSEventType, i64, NSPoint)>> =
        const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
}

/// Whether `event` is one of the agent's mouse events.
pub(crate) fn from_agent(event: &NSEvent) -> bool {
    made_at(event).is_some()
}

/// The window point the agent made `event` at, when it is one of its
/// mouse events.
fn made_at(event: &NSEvent) -> Option<NSPoint> {
    let (kind, at) = (event.r#type(), nanoseconds(event));
    AGENT.with_borrow(|events| {
        events
            .iter()
            .find(|&&(k, t, _)| k == kind && (t - at).abs() <= 1)
            .map(|&(_, _, p)| p)
    })
}

/// The agent's mouse `event` at the window point it was made at, when it
/// reaches its window somewhere else: AppKit reads a posted event's place
/// again from the window server as it takes it off the queue, and while
/// the screen is locked the window server shows the windows shrunk behind
/// the lock screen (to nine tenths, around the screen's middle), so a
/// press would land on another view than the one the agent aimed at.
/// `None` for the user's events and those where they were made.
pub(crate) fn placed(event: &NSEvent) -> Option<Retained<NSEvent>> {
    let p = made_at(event)?;
    let at = event.locationInWindow();
    if (at.x - p.x).abs() < 0.5 && (at.y - p.y).abs() < 0.5 {
        return None;
    }
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        event.r#type(),
        p,
        event.modifierFlags(),
        event.timestamp(),
        event.windowNumber(),
        None,
        event.eventNumber(),
        event.clickCount(),
        event.pressure(),
    )
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
    .inspect(|event| remember(event))
}

/// Keeps `event` among the agent's latest ([`from_agent`], [`placed`]).
fn remember(event: &NSEvent) {
    AGENT.with_borrow_mut(|events| {
        if events.len() == AGENT_EVENTS {
            events.pop_front();
        }
        events.push_back((event.r#type(), nanoseconds(event), event.locationInWindow()));
    });
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
        // Key equivalents (menus) and key monitors (`nsh/keymap` and the
        // raw keys of focused views, `nsh/keyboard`) are the
        // application's, which hands the key to its key window.
        if window.isKeyWindow() {
            app.sendEvent(&event);
        } else if kind == NSEventType::KeyDown && crate::keymap::fires(surface, &event) {
            // The app's key monitor never sees a window's own events: it
            // gets the key first, as it would in the key window (the test
            // window often is not one, its app left in the background).
        } else if kind == NSEventType::KeyDown && crate::keyboard::key_down(surface, &event) {
            // The focused view captured the key: no menu, no default.
        } else if kind == NSEventType::KeyUp && crate::keyboard::key_up(surface, &event) {
            // The release of a captured key.
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
/// A window that is not on screen has no picture: what it would show is
/// not known (the host window of window model v2 never shows, and drawn
/// it is only its background).
pub(crate) fn shot(window: &NSWindow) -> Result<Vec<u8>, String> {
    shot_from(window.isVisible(), || composited(window), || drawn(window))
}

/// [`shot`] with the window's state and its pictures given.
fn shot_from(
    visible: bool,
    composited: impl FnOnce() -> Result<Vec<u8>, String>,
    drawn: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    if !visible {
        return Err("the window is not on screen".into());
    }
    composited().or_else(|why| {
        // Said where a test's output shows it: the picture is not the
        // screen's (`drawn`).
        log::warn!("screenshot drawn in process, which differs from the screen: {why}");
        drawn()
    })
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

/// Whether `image` has nothing but black or clear pixels.
///
/// Inspects the backing `CGDataProvider` bytes directly for 8-bpc 32-bpp RGB
/// images without a `decode` array instead of drawing through
/// `CGContext::draw_image`, because drawing the full window image into a
/// scratch context pins each frame's backing store (~15 MiB) into
/// CoreGraphics' 32-slot purgeable cache (`~470 MiB`).
fn blank(image: &objc2_core_graphics::CGImage) -> bool {
    blank_bytes(image).unwrap_or_else(|| blank_drawn(image))
}

/// Direct-byte blank check for 8-bpc 32-bpp RGB `CGImage`s without `decode`;
/// returns `None` when the pixel layout or color space needs CoreGraphics to
/// convert it ([`blank_drawn`]).
fn blank_bytes(image: &objc2_core_graphics::CGImage) -> Option<bool> {
    use objc2_core_graphics::{CGColorSpace, CGColorSpaceModel, CGDataProvider, CGImage};

    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    if width == 0 || height == 0 {
        return Some(true);
    }
    if CGImage::bits_per_component(Some(image)) != 8
        || CGImage::bits_per_pixel(Some(image)) != 32
        || !CGImage::decode(Some(image)).is_null()
    {
        return None;
    }
    let color_space = CGImage::color_space(Some(image))?;
    if CGColorSpace::model(Some(&color_space)) != CGColorSpaceModel::RGB {
        return None;
    }
    let (alpha_mask, rgb_mask) = pixel_masks(
        CGImage::alpha_info(Some(image)),
        CGImage::byte_order_info(Some(image)),
    )?;
    let provider = CGImage::data_provider(Some(image))?;
    let data = CGDataProvider::data(Some(&provider))?;

    let stride = CGImage::bytes_per_row(Some(image));
    let row_bytes = width.saturating_mul(4);
    let needed = height
        .checked_sub(1)?
        .checked_mul(stride)?
        .checked_add(row_bytes)?;
    let len = data.len();
    let ptr = data.byte_ptr();
    // SAFETY: `CFData` is an immutable byte buffer whose backing slice stays
    // valid while `data` is alive (`len` matches its byte count).
    let bytes = if len == 0 || ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    };
    if stride < row_bytes || bytes.len() < needed {
        return None;
    }
    Some((0..height).all(|y| {
        let row = &bytes[y * stride..y * stride + row_bytes];
        row.as_chunks::<4>().0.iter().all(|&px| {
            let word = u32::from_ne_bytes(px);
            (alpha_mask != 0 && (word & alpha_mask) == 0) || (word & rgb_mask) == 0
        })
    }))
}

/// Bitmasks `(alpha_mask, rgb_mask)` in host-endian `u32` words for 8-bpc
/// 32-bpp pixel layouts, or `None` when the layout needs CoreGraphics to
/// convert it.
fn pixel_masks(
    alpha: objc2_core_graphics::CGImageAlphaInfo,
    order: objc2_core_graphics::CGImageByteOrderInfo,
) -> Option<(u32, u32)> {
    use objc2_core_graphics::{CGImageAlphaInfo, CGImageByteOrderInfo};

    let big = match order {
        CGImageByteOrderInfo::Order32Big | CGImageByteOrderInfo::OrderDefault => true,
        CGImageByteOrderInfo::Order32Little => false,
        _ => return None,
    };
    let (alpha_first, has_alpha) = match alpha {
        CGImageAlphaInfo::PremultipliedFirst | CGImageAlphaInfo::First => (true, true),
        CGImageAlphaInfo::PremultipliedLast | CGImageAlphaInfo::Last => (false, true),
        CGImageAlphaInfo::NoneSkipFirst => (true, false),
        CGImageAlphaInfo::NoneSkipLast => (false, false),
        _ => return None,
    };
    // Byte index in memory: Big puts First at byte 0; Little reverses the 4 bytes.
    let a_byte = if alpha_first == big { 0 } else { 3 };
    let mut a_bytes = [0u8; 4];
    a_bytes[a_byte] = 0xff;
    let mut rgb_bytes = [0xffu8; 4];
    rgb_bytes[a_byte] = 0;
    let alpha_mask = if has_alpha {
        u32::from_ne_bytes(a_bytes)
    } else {
        0
    };
    Some((alpha_mask, u32::from_ne_bytes(rgb_bytes)))
}

fn blank_drawn(image: &objc2_core_graphics::CGImage) -> bool {
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGColorSpace, CGContext, CGImageAlphaInfo, CGImageByteOrderInfo,
    };
    const SIDE: usize = 32;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A left press at `(x, y)` (window points) stamped `at`.
    fn press(x: f64, y: f64, at: f64) -> Retained<NSEvent> {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDown,
            NSPoint::new(x, y),
            NSEventModifierFlags::empty(),
            at,
            0,
            None,
            0,
            1,
            1.0,
        )
        .expect("a mouse event")
    }

    #[test]
    fn a_shot_is_of_a_window_on_screen_and_says_when_it_is_drawn_in_process() {
        let composited = || Ok(b"composited".to_vec());
        let drawn = || Ok(b"drawn".to_vec());
        let refused = || Err::<Vec<u8>, String>("blank".into());

        // A window off screen (the hidden host of window model v2) has no
        // picture: never one of its background drawn in process.
        let off = shot_from(false, composited, || panic!("drawn off screen"));
        assert_eq!(off, Err("the window is not on screen".to_owned()));

        assert_eq!(
            shot_from(true, composited, drawn).as_deref(),
            Ok(&b"composited"[..])
        );
        assert_eq!(
            shot_from(true, refused, drawn).as_deref(),
            Ok(&b"drawn"[..])
        );
    }

    #[test]
    fn an_agent_press_read_elsewhere_goes_back_where_it_was_made() {
        let made = press(119.5, 70.0, 1000.25);
        remember(&made);
        // The same press as AppKit took it off the queue on a locked screen.
        let read = press(52.8, 23.7, 1000.25);
        let back = placed(&read).expect("put back");
        let at = back.locationInWindow();
        assert_eq!((at.x, at.y), (119.5, 70.0));
        assert!(from_agent(&back));
        assert_eq!(back.clickCount(), 1);
        assert!(placed(&made).is_none(), "where it was made: as it is");
        assert!(
            placed(&press(52.8, 23.7, 1001.0)).is_none(),
            "the user's: as it is"
        );
    }

    struct TestImage<'a> {
        width: usize,
        height: usize,
        bpc: usize,
        bpp: usize,
        bytes_per_row: usize,
        bytes: Vec<u8>,
        space: &'a objc2_core_graphics::CGColorSpace,
        bitmap_info: u32,
        decode: *const f64,
    }

    fn test_cg_image(
        spec: TestImage<'_>,
    ) -> objc2_core_foundation::CFRetained<objc2_core_graphics::CGImage> {
        use objc2_core_foundation::CFData;
        use objc2_core_graphics::{CGColorRenderingIntent, CGDataProvider, CGImage};
        let data = CFData::from_bytes(&spec.bytes);
        let provider = CGDataProvider::with_cf_data(Some(&data)).expect("provider");
        // SAFETY: `provider` holds `spec.bytes_per_row * spec.height` bytes
        // matching `spec.bpc`, `spec.bpp`, `spec.space`, and `spec.decode`.
        unsafe {
            CGImage::new(
                spec.width,
                spec.height,
                spec.bpc,
                spec.bpp,
                spec.bytes_per_row,
                Some(spec.space),
                objc2_core_graphics::CGBitmapInfo(spec.bitmap_info),
                Some(&provider),
                spec.decode,
                false,
                CGColorRenderingIntent::RenderingIntentDefault,
            )
        }
        .expect("cg image")
    }

    #[test]
    fn blank_bytes_checks_all_pixel_masks_and_falls_back_when_unsupported() {
        use objc2_core_graphics::{CGColorSpace, CGImageAlphaInfo, CGImageByteOrderInfo};

        let rgb = CGColorSpace::new_device_rgb().expect("rgb");
        let gray = CGColorSpace::new_device_gray().expect("gray");
        let rgba = |width, height, bytes_per_row, bytes, bitmap_info| {
            test_cg_image(TestImage {
                width,
                height,
                bpc: 8,
                bpp: 32,
                bytes_per_row,
                bytes,
                space: &rgb,
                bitmap_info,
                decode: std::ptr::null(),
            })
        };

        let cases = [
            (
                CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::OrderDefault.0,
                [255, 0, 0, 0],  // black ARGB (big-endian default)
                [0, 10, 20, 30], // clear ARGB
                [255, 0, 1, 0],  // green ARGB
            ),
            (
                CGImageAlphaInfo::First.0 | CGImageByteOrderInfo::Order32Big.0,
                [255, 0, 0, 0],  // black ARGB
                [0, 10, 20, 30], // clear ARGB
                [255, 1, 0, 0],  // red ARGB
            ),
            (
                CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0,
                [0, 0, 0, 255],  // black BGRA
                [10, 20, 30, 0], // clear BGRA
                [0, 1, 0, 255],  // green BGRA
            ),
            (
                CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
                [0, 0, 0, 255],  // black RGBA
                [10, 20, 30, 0], // clear RGBA
                [1, 0, 0, 255],  // red RGBA
            ),
            (
                CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Little.0,
                [255, 0, 0, 0], // black ABGR (Order32Little + Last puts alpha at byte 0)
                [0, 30, 20, 10], // clear ABGR
                [255, 0, 0, 1], // red ABGR
            ),
            (
                CGImageAlphaInfo::Last.0 | CGImageByteOrderInfo::Order32Little.0,
                [255, 0, 0, 0],  // black ABGR
                [0, 30, 20, 10], // clear ABGR
                [255, 0, 1, 0],  // green ABGR
            ),
            (
                CGImageAlphaInfo::NoneSkipFirst.0 | CGImageByteOrderInfo::Order32Little.0,
                [0, 0, 0, 255], // black BGRX with non-zero skip byte
                [0, 0, 0, 128], // black BGRX with non-zero skip byte
                [0, 0, 1, 255], // red BGRX
            ),
            (
                CGImageAlphaInfo::NoneSkipLast.0 | CGImageByteOrderInfo::Order32Big.0,
                [0, 0, 0, 255], // black RGBX with non-zero skip byte
                [0, 0, 0, 0],   // black RGBX
                [1, 0, 0, 255], // red RGBX
            ),
        ];

        for (info, black_px, clear_px, colored_px) in cases {
            let mut blank_pixels = Vec::with_capacity(16);
            blank_pixels.extend_from_slice(&black_px);
            blank_pixels.extend_from_slice(&clear_px);
            blank_pixels.extend_from_slice(&black_px);
            blank_pixels.extend_from_slice(&clear_px);
            let blank_img = rgba(2, 2, 8, blank_pixels.clone(), info);
            assert_eq!(blank_bytes(&blank_img), Some(true));
            assert!(blank(&blank_img));

            let mut colored_pixels = blank_pixels;
            colored_pixels[12..16].copy_from_slice(&colored_px);
            let colored_img = rgba(2, 2, 8, colored_pixels, info);
            assert_eq!(blank_bytes(&colored_img), Some(false));
            assert!(!blank(&colored_img));
        }

        // Padded row stride ignores padding bytes after the active row pixels.
        let info = CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;
        let mut padded = vec![0xffu8; 2 * 16];
        padded[0..8].copy_from_slice(&[0, 0, 0, 255, 10, 20, 30, 0]);
        padded[16..24].copy_from_slice(&[0, 0, 0, 255, 10, 20, 30, 0]);
        let padded_blank = rgba(2, 2, 16, padded.clone(), info);
        assert_eq!(blank_bytes(&padded_blank), Some(true));
        padded[20..24].copy_from_slice(&[0, 0, 1, 255]);
        let padded_colored = rgba(2, 2, 16, padded, info);
        assert_eq!(blank_bytes(&padded_colored), Some(false));

        // 16-bpc falls back to `None` (handled by `blank_drawn`).
        let wide_info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order16Big.0;
        let wide_img = test_cg_image(TestImage {
            width: 1,
            height: 1,
            bpc: 16,
            bpp: 64,
            bytes_per_row: 8,
            bytes: vec![0; 8],
            space: &rgb,
            bitmap_info: wide_info,
            decode: std::ptr::null(),
        });
        assert_eq!(blank_bytes(&wide_img), None);

        // Non-RGB color space falls back to `None`.
        let gray_img = test_cg_image(TestImage {
            width: 1,
            height: 1,
            bpc: 8,
            bpp: 8,
            bytes_per_row: 1,
            bytes: vec![0],
            space: &gray,
            bitmap_info: CGImageAlphaInfo::None.0,
            decode: std::ptr::null(),
        });
        assert_eq!(blank_bytes(&gray_img), None);

        // Non-null decode array (e.g. inverted) falls back to `None`.
        let decode = [1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let decode_img = test_cg_image(TestImage {
            width: 1,
            height: 1,
            bpc: 8,
            bpp: 32,
            bytes_per_row: 4,
            bytes: vec![0, 0, 0, 255],
            space: &rgb,
            bitmap_info: CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
            decode: decode.as_ptr(),
        });
        assert_eq!(blank_bytes(&decode_img), None);

        assert_eq!(
            pixel_masks(CGImageAlphaInfo::Only, CGImageByteOrderInfo::Order32Little),
            None
        );
        assert_eq!(
            pixel_masks(
                CGImageAlphaInfo::PremultipliedFirst,
                CGImageByteOrderInfo::Order16Little
            ),
            None
        );
    }
}
