//! Input as a user's hands give it, made in process: touches as the
//! system delivers them, IOHID events handed to UIKit
//! (`-[UIApplication _enqueueHIDEvent:]`), so UIKit makes the `UITouch`es
//! and runs hit testing, the gesture recognizers and scroll views as for a
//! real finger; text as the software keyboard types it, into the first
//! responder. The agent of `nsh test --target ios` acts
//! with them ([`crate::agent`]).
//!
//! IOKit's event functions and BackBoardServices' digitizer info are
//! private: they are looked up at run time (development hosts only), as
//! UI test tools for iOS do.

use std::{ffi::c_void, sync::OnceLock};

use objc2::{
    MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, runtime::AnyObject,
};
use objc2_quartz_core::CAMediaTiming;
use objc2_ui_kit::{UIApplication, UIWindow};

type Event = *mut HidEvent;

/// IOKit's `struct __IOHIDEvent` (opaque), so messages taking an
/// `IOHIDEventRef` get their argument with its type encoding.
#[repr(C)]
pub(crate) struct HidEvent {
    _private: [u8; 0],
}

// SAFETY: a pointer to it is IOKit's `IOHIDEventRef`.
unsafe impl objc2::encode::RefEncode for HidEvent {
    const ENCODING_REF: objc2::encode::Encoding =
        objc2::encode::Encoding::Pointer(&objc2::encode::Encoding::Struct("__IOHIDEvent", &[]));
}
type Allocator = *const c_void;

/// IOKit's digitizer events, BackBoardServices' digitizer info.
struct Hid {
    digitizer: unsafe extern "C" fn(
        Allocator,
        u64,
        u32,
        u32,
        u32,
        u32,
        u32,
        f64,
        f64,
        f64,
        f64,
        f64,
        u8,
        u8,
        u32,
    ) -> Event,
    finger: unsafe extern "C" fn(
        Allocator,
        u64,
        u32,
        u32,
        u32,
        f64,
        f64,
        f64,
        f64,
        f64,
        u8,
        u8,
        u32,
    ) -> Event,
    keyboard: unsafe extern "C" fn(Allocator, u64, u32, u32, u8, u32) -> Event,
    append: unsafe extern "C" fn(Event, Event, u32),
    set_integer: unsafe extern "C" fn(Event, u32, i64),
    set_float: unsafe extern "C" fn(Event, u32, f64),
    set_sender: unsafe extern "C" fn(Event, u64),
    digitizer_info: unsafe extern "C" fn(Event, u32, u8, u8, *const c_void, f64, f32),
    release: unsafe extern "C" fn(*const c_void),
}

/// `IOHIDDigitizerTransducerType::Hand`.
const HAND: u32 = 3;
/// `IOHIDDigitizerEventMask`: in range, touching, moved.
const RANGE: u32 = 1 << 0;
const TOUCH: u32 = 1 << 1;
const POSITION: u32 = 1 << 2;
/// `kIOHIDEventFieldDigitizerIsDisplayIntegrated`: a touch screen's.
const DISPLAY_INTEGRATED: u32 = (11 << 16) | 25;
/// `kIOHIDEventFieldDigitizerMajorRadius`, `…MinorRadius`.
const MAJOR_RADIUS: u32 = (11 << 16) | 20;
const MINOR_RADIUS: u32 = (11 << 16) | 21;
/// Who sent the events: UIKit takes events of any sender, and tools for
/// UI tests use one of their own.
const SENDER: u64 = 0x0000_0000_4e53_4854;

fn hid() -> Option<&'static Hid> {
    static HID: OnceLock<Option<Hid>> = OnceLock::new();
    HID.get_or_init(load).as_ref()
}

fn load() -> Option<Hid> {
    let open = |path: &str| {
        let path = std::ffi::CString::new(path).ok()?;
        // SAFETY: a system framework, opened once and never closed.
        let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW) };
        (!handle.is_null()).then_some(handle)
    };
    let iokit = open("/System/Library/Frameworks/IOKit.framework/IOKit")?;
    let bbs =
        open("/System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices")?;
    let cf = open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")?;
    // SAFETY: each symbol has the C signature of the field it goes into
    // (IOKit's IOHIDEvent.h, BackBoardServices' BKSHIDEvent.h).
    unsafe {
        Some(Hid {
            digitizer: symbol(iokit, "IOHIDEventCreateDigitizerEvent")?,
            finger: symbol(iokit, "IOHIDEventCreateDigitizerFingerEvent")?,
            keyboard: symbol(iokit, "IOHIDEventCreateKeyboardEvent")?,
            append: symbol(iokit, "IOHIDEventAppendEvent")?,
            set_integer: symbol(iokit, "IOHIDEventSetIntegerValue")?,
            set_float: symbol(iokit, "IOHIDEventSetFloatValue")?,
            set_sender: symbol(iokit, "IOHIDEventSetSenderID")?,
            digitizer_info: symbol(bbs, "BKSHIDEventSetDigitizerInfo")?,
            release: symbol(cf, "CFRelease")?,
        })
    }
}

/// The function `name` of the library `handle`, as `F`.
///
/// # Safety
///
/// `F` is a function pointer type of the symbol's C signature.
unsafe fn symbol<F: Copy>(handle: *mut c_void, name: &str) -> Option<F> {
    let c = std::ffi::CString::new(name).ok()?;
    // SAFETY: looking a symbol up in a library opened before.
    let ptr = unsafe { libc::dlsym(handle, c.as_ptr()) };
    if ptr.is_null() {
        log::error!("test agent: {name} is missing");
        return None;
    }
    debug_assert_eq!(std::mem::size_of::<F>(), std::mem::size_of::<*mut c_void>());
    // SAFETY: per the contract, a function pointer of the symbol's type.
    Some(unsafe { std::mem::transmute_copy::<*mut c_void, F>(&ptr) })
}

unsafe extern "C" {
    /// libSystem's clock, in its time base's ticks.
    fn mach_absolute_time() -> u64;
}

/// Now on the clock HID events are stamped with.
fn now() -> u64 {
    // SAFETY: a plain clock read.
    unsafe { mach_absolute_time() }
}

/// Hands `event` to UIKit as the window `window`'s, then releases it.
fn enqueue(hid: &Hid, event: Event, window: &UIWindow, mtm: MainThreadMarker) {
    // SAFETY: `_contextId` is UIWindow's render context id (an unsigned
    // int); the digitizer info routes the event to that window, and UIKit
    // takes the event as it takes the system's.
    unsafe {
        let context: u32 = msg_send![window, _contextId];
        (hid.set_sender)(event, SENDER);
        (hid.digitizer_info)(event, context, 0, 0, std::ptr::null(), 0.0, 0.0);
        let app = UIApplication::sharedApplication(mtm);
        let _: () = msg_send![&*app, _enqueueHIDEvent: event];
        (hid.release)(event.cast_const().cast());
    }
}

/// A finger's phase in a touch event.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Down,
    Move,
    Up,
}

/// One finger touching at `(x, y)` (the window's points), in `phase`.
pub(crate) fn touch(window: &UIWindow, x: f64, y: f64, phase: Phase) -> bool {
    let Some(hid) = hid() else { return false };
    let mtm = window.mtm();
    let touching = u8::from(phase != Phase::Up);
    let mask = match phase {
        Phase::Move => POSITION,
        Phase::Down | Phase::Up => RANGE | TOUCH,
    };
    let time = now();
    // SAFETY: IOKit's constructors with their documented arguments; the
    // finger event is owned here and released once appended.
    unsafe {
        let hand = (hid.digitizer)(
            std::ptr::null(),
            time,
            HAND,
            0,
            0,
            mask,
            0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            touching,
            touching,
            0,
        );
        if hand.is_null() {
            return false;
        }
        (hid.set_integer)(hand, DISPLAY_INTEGRATED, 1);
        let finger = (hid.finger)(
            std::ptr::null(),
            time,
            1,
            2,
            mask,
            x,
            y,
            0.0,
            f64::from(touching),
            0.0,
            touching,
            touching,
            0,
        );
        if !finger.is_null() {
            (hid.set_float)(finger, MAJOR_RADIUS, 5.0);
            (hid.set_float)(finger, MINOR_RADIUS, 5.0);
            (hid.set_integer)(finger, DISPLAY_INTEGRATED, 1);
            (hid.append)(hand, finger, 0);
            (hid.release)(finger.cast_const().cast());
        }
        enqueue(hid, hand, window, mtm);
    }
    true
}

/// `kHIDPage_KeyboardOrKeypad`.
const KEYBOARD_PAGE: u32 = 7;

/// The USB HID usages of the left Control, Shift, Option and Command keys.
pub(crate) const CONTROL: u16 = 0xE0;
pub(crate) const SHIFT: u16 = 0xE1;
pub(crate) const OPTION: u16 = 0xE2;
pub(crate) const COMMAND: u16 = 0xE3;

/// A hardware keyboard's key `usage` (a USB HID keyboard usage) going down
/// or up, to `window`, as UIKit takes a real keyboard's: it becomes the
/// presses, key commands and typing of the key.
pub(crate) fn key(window: &UIWindow, usage: u16, down: bool) -> bool {
    let Some(hid) = hid() else { return false };
    // SAFETY: IOKit's constructor with its documented arguments; the event
    // is handed over (and released) by `enqueue`.
    let event = unsafe {
        (hid.keyboard)(
            std::ptr::null(),
            now(),
            KEYBOARD_PAGE,
            u32::from(usage),
            u8::from(down),
            0,
        )
    };
    if event.is_null() {
        return false;
    }
    enqueue(hid, event, window, window.mtm());
    true
}

/// The window's first responder (the focused input).
pub(crate) fn first_responder(window: &UIWindow) -> Option<Retained<AnyObject>> {
    // SAFETY: UIWindow's `firstResponder` (private: the responder chain's).
    unsafe { msg_send![window, firstResponder] }
}

/// The software keyboard's input manager (`UIKeyboardImpl`, private), which
/// types into the first responder as its keys do: asking the input's
/// delegate first (`maxLength`, a controlled value), as UI test tools type.
fn keyboard() -> Option<Retained<AnyObject>> {
    let class = objc2::runtime::AnyClass::get(c"UIKeyboardImpl")?;
    // SAFETY: the class's singleton getter.
    unsafe { msg_send![class, activeInstance] }
}

/// Types `text` into the first responder as the software keyboard does.
pub(crate) fn insert_text(window: &UIWindow, text: &str) {
    let s = objc2_foundation::NSString::from_str(text);
    if let Some(keyboard) = keyboard() {
        // SAFETY: UIKeyboardImpl's method for a typed string.
        let _: () = unsafe { msg_send![&*keyboard, addInputString: &*s] };
        return;
    }
    let Some(responder) = first_responder(window) else {
        return log::warn!("test: no focused input to type into");
    };
    // SAFETY: UIKeyInput's method, which text inputs implement.
    let _: () = unsafe { msg_send![&*responder, insertText: &*s] };
}

/// Deletes as the keyboard's delete key does.
pub(crate) fn delete_backward(window: &UIWindow) {
    if let Some(keyboard) = keyboard() {
        // SAFETY: UIKeyboardImpl's method for the delete key.
        let _: () = unsafe { msg_send![&*keyboard, deleteFromInput] };
        return;
    }
    let Some(responder) = first_responder(window) else {
        return log::warn!("test: no focused input");
    };
    // SAFETY: UIKeyInput's method.
    let _: () = unsafe { msg_send![&*responder, deleteBackward] };
}

/// Focuses the text input at `(x, y)` (window points), if a tap there
/// lands in one that does not have the focus.
pub(crate) fn focus_input_at(window: &UIWindow, x: f64, y: f64) {
    use objc2_foundation::NSObjectProtocol;
    use objc2_ui_kit::{UITextField, UITextView, UIView};
    let point = objc2_core_foundation::CGPoint::new(x, y);
    let mut view: Option<Retained<UIView>> = window.hitTest_withEvent(point, None);
    while let Some(v) = view {
        let input = v.isKindOfClass(<UITextField as objc2::ClassType>::class())
            || v.isKindOfClass(<UITextView as objc2::ClassType>::class());
        if input {
            if !v.isFirstResponder() && v.canBecomeFirstResponder() {
                v.becomeFirstResponder();
            }
            return;
        }
        view = v.superview();
    }
}

/// Selects all the focused input's text (the edit menu's Select All).
pub(crate) fn select_all(window: &UIWindow) {
    let Some(responder) = first_responder(window) else {
        return log::warn!("test: no focused input");
    };
    // SAFETY: UIResponderStandardEditActions' method, with no sender.
    let _: () = unsafe { msg_send![&*responder, selectAll: std::ptr::null::<AnyObject>()] };
}

/// Whether something moves in `window`: a finite Core Animation animation
/// (a screen pushed, a sheet presented, an alert fading in; spinners and
/// other endless ones do not count), or a scroll view gliding or bouncing
/// after a finger left it (UIKit moves those itself, frame by frame).
pub(crate) fn animating(window: &UIWindow) -> bool {
    layers_animating(window) || scrolling(window)
}

fn scrolling(view: &objc2_ui_kit::UIView) -> bool {
    if let Some(scroll) = view.downcast_ref::<objc2_ui_kit::UIScrollView>()
        && scroll.isDecelerating()
    {
        return true;
    }
    view.subviews().iter().any(|v| scrolling(&v))
}

fn layers_animating(window: &UIWindow) -> bool {
    fn walk(layer: &objc2_quartz_core::CALayer) -> bool {
        if let Some(keys) = layer.animationKeys() {
            for key in keys.iter() {
                // SAFETY: a key the layer just listed.
                if let Some(a) = unsafe { layer.animationForKey(&key) }
                    && a.repeatCount().is_finite()
                    && a.duration().is_finite()
                {
                    return true;
                }
            }
        }
        // SAFETY: the layer's own sublayers, read on the main thread.
        let subs = unsafe { layer.sublayers() };
        subs.is_some_and(|subs| subs.iter().any(|l| walk(&l)))
    }
    walk(&window.layer())
}

/// A picture of the window as it shows (`drawViewHierarchyInRect:`), as
/// a PNG.
pub(crate) fn screenshot(window: &UIWindow) -> Result<Vec<u8>, String> {
    let bounds = window.bounds();
    // SAFETY: UIGraphicsImageRenderer draws on this (main) thread; the
    // block runs inside `imageWithActions:`.
    unsafe {
        let class = objc2::runtime::AnyClass::get(c"UIGraphicsImageRenderer")
            .ok_or("no UIGraphicsImageRenderer")?;
        let renderer: Retained<AnyObject> =
            msg_send![msg_send![class, alloc], initWithBounds: bounds];
        let window = window.retain();
        let draw = block2::RcBlock::new(move |_context: *mut AnyObject| {
            let _: bool =
                msg_send![&*window, drawViewHierarchyInRect: bounds, afterScreenUpdates: true];
        });
        let data: Option<Retained<objc2_foundation::NSData>> =
            msg_send![&*renderer, PNGDataWithActions: &*draw];
        data.map(|d| d.to_vec())
            .ok_or_else(|| "the window drew no picture".into())
    }
}
