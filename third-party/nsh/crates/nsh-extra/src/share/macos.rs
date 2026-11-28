//! The share sheet on macOS: AppKit's share menu, `NSSharingServicePicker`.
//! The text, the link and the files' URLs are its items; the title becomes
//! the subject of the service the user chooses (a mail's subject line).
//! The menu shows on a later turn of the run loop, never inside the
//! main-thread task that found its views (`nsh::native_view`,
//! `nsh::presenting_view`), below the anchor's own view, in whatever window
//! it is, or at the middle of the surface's visible window. With neither
//! available, the share fails; a surface that is no AppKit one (GPUI) has
//! no share menu. A new share of the same engine replaces the menu of one
//! still open. The share is answered once: shared
//! with the service's title once the service reports it finished, or, for
//! a service that has reported nothing, once the user is back in the
//! window the menu opened from (a window since closed counts as back);
//! dismissed when the menu closed without a choice, the service reported a
//! cancel, or nothing was reported and the user stayed away for ten
//! minutes; else the service's error. AppKit tells no service that will
//! never report from one that has not yet, so a service the user came back
//! from before it reported (a mail draft still open) is shared too.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

use dispatch2::{DispatchQueue, DispatchTime, MainThreadBound};
use nsh_core::{
    ROOT_ID,
    element::{EngineId, run_on_main_thread},
};
use nsh_platform_macos::{
    objc2_app_kit::{NSApplication, NSModalPanelRunLoopMode, NSView, NSWindow},
    objc2_foundation::{
        NSArray, NSDefaultRunLoopMode, NSError, NSObject, NSObjectProtocol, NSPoint, NSRect,
        NSRunLoop, NSSize, NSString, NSURL,
    },
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};

use super::{Answered, Reply, ShareError, ShareOutcome, ShareSheet};

/// Whether this engine's surface shows a share menu: an AppKit surface.
pub(super) async fn available() -> bool {
    run_on_main_thread(|| {
        MainThreadMarker::new()
            .is_some_and(|mtm| nsh_platform_macos::native_view(mtm, ROOT_ID).is_some())
    })
    .await
    .unwrap_or(false)
}

/// Shows the share menu for `sheet` in the calling engine's surface, and
/// answers `reply` once.
pub(super) async fn show(sheet: ShareSheet, reply: Reply) {
    let task = reply.clone();
    if let Err(error) = run_on_main_thread(move || schedule(sheet, task)).await {
        reply.send(Err(ShareError::failed(format!(
            "share: the share menu cannot be shown: {error}"
        ))));
    }
}

/// `NSRectEdgeMinY`: the edge with the smaller y, below the rect in an
/// unflipped view and above it in a flipped one.
const MIN_Y: isize = 1;
/// `NSRectEdgeMaxY`: below the rect in a flipped view, above it in an
/// unflipped one.
const MAX_Y: isize = 3;

/// The edge of a rect in a view that is below it on screen: AppKit's
/// edges follow the view's y axis, which only a flipped view runs down.
fn below(flipped: bool) -> isize {
    if flipped { MAX_Y } else { MIN_Y }
}

/// The rect at the middle of `bounds` that an unanchored menu points at.
/// One point, not empty: AppKit reads an empty positioning rect as the
/// whole view, and pointing below a whole window leaves the menu no room
/// there, so it opens past the window's side (#2912).
fn middle(bounds: NSRect) -> NSRect {
    NSRect::new(
        NSPoint::new(
            bounds.origin.x + bounds.size.width / 2.0 - 0.5,
            bounds.origin.y + bounds.size.height / 2.0 - 0.5,
        ),
        NSSize::new(1.0, 1.0),
    )
}

/// `NSUserCancelledError`: the user cancelled the service (Cocoa's domain).
const USER_CANCELLED: isize = 3072;

/// How often a chosen service that has not answered is looked after.
const WATCH_MS: u64 = 250;

/// Looks after a chosen service the user never left the window for, after
/// which a service that reported nothing counts as done (it acted at once).
const STAYED: u32 = 8;

/// Looks the window must be back for before a service that reported
/// nothing counts as done: its own answer, a cancel, may come just after
/// its window closed.
const BACK: u32 = 2;

/// Looks after which a service that reported nothing, and that the user
/// did not come back from, counts as dismissed (ten minutes): the share
/// is not looked after for ever.
const GIVE_UP: u32 = (10 * 60 * 1000 / WATCH_MS) as u32;

/// An engine's open share: the menu while it shows and its delegate until
/// the share is answered (the picker and the service hold it weakly). One
/// per engine, as the module keeps one share open per engine.
struct Showing {
    picker: Option<Retained<AnyObject>>,
    delegate: Retained<PickerDelegate>,
}

thread_local! {
    /// Each engine's open share (main thread). A share's entry goes when
    /// it is answered or a newer share replaces it, so the table holds
    /// open shares only.
    static SHOWING: RefCell<HashMap<Option<EngineId>, Showing>> = RefCell::new(HashMap::new());
}

/// Runs `f` on `owner`'s open share if `delegate` is its delegate.
fn mine<R>(
    owner: Option<EngineId>,
    delegate: &PickerDelegate,
    f: impl FnOnce(&mut HashMap<Option<EngineId>, Showing>) -> R,
) -> Option<R> {
    SHOWING.with_borrow_mut(|showing| {
        let open = showing.get(&owner)?;
        std::ptr::eq(&*open.delegate, delegate).then(|| f(showing))
    })
}

pub(crate) struct DelegateIvars {
    reply: Reply,
    owner: Option<EngineId>,
    title: Option<Retained<NSString>>,
    /// The window the menu opened from, which the user comes back to, and
    /// whether it was the key window then (a panel that never becomes key
    /// is back once it shows again).
    window: objc2::rc::Weak<NSWindow>,
    key: bool,
    /// The chosen service's title, the share's target.
    service: RefCell<Option<String>>,
    answered: Cell<bool>,
    /// Whether the user went to the chosen service: another app, a sheet on
    /// the window or a window of its own.
    left: Cell<bool>,
    /// Looks taken since the service was chosen, and those in a row that
    /// found the user back in the window.
    looks: Cell<u32>,
    back: Cell<u32>,
}

define_class!(
    /// The delegate of one share menu and of the service chosen from it:
    /// gives the service the title as its subject and reports how the
    /// share ended.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    #[name = "NshSharePickerDelegate"]
    pub(crate) struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    impl PickerDelegate {
        #[unsafe(method(sharingServicePicker:delegateForSharingService:))]
        fn delegate_for(&self, _picker: &AnyObject, service: &AnyObject) -> *mut AnyObject {
            let ivars = self.ivars();
            if let Some(title) = &ivars.title {
                // SAFETY: NSSharingService's documented `subject` setter.
                let _: () = unsafe { msg_send![service, setSubject: &**title] };
            }
            *ivars.service.borrow_mut() = service_title(service);
            // This object hears the service too (NSSharingServiceDelegate):
            // whether it shared or failed.
            self as *const Self as *mut AnyObject
        }

        #[unsafe(method(sharingServicePicker:didChooseSharingService:))]
        fn did_choose(&self, _picker: &AnyObject, service: Option<&AnyObject>) {
            match service {
                Some(service) => {
                    let title = service_title(service);
                    if title.is_some() {
                        *self.ivars().service.borrow_mut() = title;
                    }
                    // The menu is done; the service answers the share, or
                    // the user coming back from it does.
                    let owner = self.ivars().owner;
                    let picker = mine(owner, self, |showing| {
                        showing.get_mut(&owner).and_then(|s| s.picker.take())
                    });
                    release_later(picker.flatten());
                    watch(objc2::rc::Weak::from_retained(&self.retain()));
                }
                None => self.finish(Ok(ShareOutcome::dismissed())),
            }
        }

        #[unsafe(method(sharingService:didShareItems:))]
        fn did_share(&self, _service: &AnyObject, _items: &AnyObject) {
            let target = self.ivars().service.borrow().clone();
            self.finish(Ok(ShareOutcome::shared(target)));
        }

        #[unsafe(method(sharingService:didFailToShareItems:error:))]
        fn did_fail(&self, _service: &AnyObject, _items: &AnyObject, error: &NSError) {
            let cancelled = error.code() == USER_CANCELLED
                && error.domain().to_string() == "NSCocoaErrorDomain";
            let result = if cancelled {
                Ok(ShareOutcome::dismissed())
            } else {
                Err(ShareError::failed(error.localizedDescription().to_string()))
            };
            self.finish(result);
        }
    }
);

impl PickerDelegate {
    /// Answers the share once, drops its entry, and lets the menu and this
    /// delegate go once AppKit returns from the call it is making.
    fn finish(&self, result: Answered) {
        let ivars = self.ivars();
        if !ivars.answered.replace(true) {
            ivars.reply.send(result);
        }
        let open = mine(ivars.owner, self, |showing| showing.remove(&ivars.owner));
        if let Some(Showing { picker, delegate }) = open.flatten() {
            release_later(picker);
            release_later(Some(delegate));
        }
    }
}

impl PickerDelegate {
    /// Looks whether the user is back from a chosen service that has not
    /// answered: the app active, the menu's window showing (key again if
    /// it was key) with no sheet on it, or gone. Some services (adding to
    /// a list, copying) never tell their delegate; they count as done once
    /// the user is back, or at once when the user never left, and as
    /// dismissed after [`GIVE_UP`] looks. Returns whether to look again.
    fn look(&self) -> bool {
        let ivars = self.ivars();
        if ivars.answered.get() {
            return false;
        }
        let active = NSApplication::sharedApplication(self.mtm()).isActive();
        let here = ivars.window.load().is_none_or(|w| {
            w.isVisible() && (!ivars.key || w.isKeyWindow()) && w.attachedSheet().is_none()
        });
        let looks = ivars.looks.get() + 1;
        ivars.looks.set(looks);
        if active && here {
            let back = ivars.back.get() + 1;
            ivars.back.set(back);
            let done = if ivars.left.get() {
                back >= BACK
            } else {
                looks >= STAYED
            };
            if done {
                let target = ivars.service.borrow().clone();
                self.finish(Ok(ShareOutcome::shared(target)));
                return false;
            }
        } else {
            ivars.left.set(true);
            ivars.back.set(0);
        }
        if looks >= GIVE_UP {
            self.finish(Ok(ShareOutcome::dismissed()));
            return false;
        }
        true
    }
}

/// Looks after the chosen service of `delegate`'s share every
/// [`WATCH_MS`] until the share is answered or replaced, or gives up
/// ([`PickerDelegate::look`]).
fn watch(delegate: objc2::rc::Weak<PickerDelegate>) {
    later(WATCH_MS, move || {
        // Gone: answered and let go of.
        let Some(delegate) = delegate.load() else {
            return;
        };
        if delegate.look() {
            watch(objc2::rc::Weak::from_retained(&delegate));
        }
    });
}

/// Runs `f` on the main queue after `ms` milliseconds.
fn later(ms: u64, f: impl FnOnce() + 'static) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let f = MainThreadBound::new(f, mtm);
    let when = DispatchTime::NOW.time((ms * 1_000_000) as i64);
    let scheduled = DispatchQueue::main().after(when, move || {
        let mtm = MainThreadMarker::new().expect("main queue");
        (f.into_inner(mtm))();
    });
    if let Err(err) = scheduled {
        log::warn!("share: cannot schedule a look at the service: {err:?}");
    }
}

/// A service's display title (`NSSharingService.title`).
fn service_title(service: &AnyObject) -> Option<String> {
    // SAFETY: NSSharingService's documented `title`.
    let title: Option<Retained<NSString>> = unsafe { msg_send![service, title] };
    title.map(|title| title.to_string())
}

/// Releases `object` on a later turn of the main run loop, not inside the
/// delegate call AppKit is making on it.
fn release_later<T: 'static>(object: Option<T>) {
    let Some(object) = object else { return };
    let held = RefCell::new(Some(object));
    let block = block2::RcBlock::new(move || drop(held.borrow_mut().take()));
    // SAFETY: NSRunLoop's documented `performBlock:` on the main run loop.
    unsafe {
        let run_loop: Retained<AnyObject> = msg_send![objc2::class!(NSRunLoop), mainRunLoop];
        let _: () = msg_send![&run_loop, performBlock: &*block];
    }
}

/// Where a share menu shows: the view it points below and the rect in it.
struct Place {
    view: Retained<NSView>,
    rect: NSRect,
}

/// Finds where the menu for `sheet` shows, in a main-thread task with the
/// surface current, and shows it on a later turn of the main run loop:
/// below the anchor's own view where it is in a window, else at the
/// middle of the surface's visible window.
///
/// Not in the task: the menu tracks the mouse inside the call that shows
/// it, where the batches that come meanwhile apply to the surface. In the
/// default and modal modes, as alerts: not while another menu or a drag
/// tracks the mouse.
fn schedule(sheet: ShareSheet, reply: Reply) {
    let Some(mtm) = MainThreadMarker::new() else {
        reply.send(Err(ShareError::failed("share: not on the main thread")));
        return;
    };
    if nsh_platform_macos::native_view(mtm, ROOT_ID).is_none() {
        // Not an AppKit surface (GPUI): no share menu there.
        reply.send(Err(ShareError::unavailable(
            "this surface shows no share menu",
        )));
        return;
    }
    let anchor = sheet
        .anchor
        .and_then(|anchor| nsh_platform_macos::native_view(mtm, anchor))
        .filter(|view| view.window().is_some())
        .map(|view| Place {
            rect: view.bounds(),
            view,
        });
    let place = anchor.or_else(|| {
        nsh_platform_macos::presenting_view(mtm).map(|root| Place {
            rect: middle(root.bounds()),
            view: root,
        })
    });
    let held = RefCell::new(Some((sheet, reply, place)));
    let block = block2::RcBlock::new(move || {
        if let Some((sheet, reply, place)) = held.borrow_mut().take() {
            show_menu(mtm, &sheet, reply, place);
        }
    });
    // SAFETY: immutable constants of Foundation and AppKit.
    let (default, modal) = unsafe { (NSDefaultRunLoopMode, NSModalPanelRunLoopMode) };
    let modes = NSArray::from_slice(&[default, modal]);
    // SAFETY: the block runs on the main thread, where it was made.
    unsafe { NSRunLoop::mainRunLoop().performInModes_block(&modes, &block) };
}

/// Shows the share menu for `sheet` at `place`, and answers `reply` once.
fn show_menu(mtm: MainThreadMarker, sheet: &ShareSheet, reply: Reply, place: Option<Place>) {
    let owner = reply.0.owner;
    // A share still open is replaced (the module answered it already),
    // whether this one shows or fails.
    let earlier = SHOWING.with_borrow_mut(|showing| showing.remove(&owner));
    if let Some(Showing { picker, delegate }) = earlier {
        delegate.ivars().answered.set(true);
        release_later(Some(delegate));
        release_later(picker);
    }
    if reply.is_answered() {
        // A newer share of the engine replaced this one before it showed.
        return;
    }
    let fail = |error: ShareError| {
        reply.send(Err(error));
    };
    let Some(class) = AnyClass::get(c"NSSharingServicePicker") else {
        return fail(ShareError::unavailable("this system has no share menu"));
    };
    let mut items: Vec<Retained<AnyObject>> = Vec::new();
    if let Some(text) = &sheet.text {
        items.push(object(NSString::from_str(text)));
    }
    if let Some(url) = &sheet.url {
        match NSURL::URLWithString(&NSString::from_str(url)) {
            Some(url) => items.push(object(url)),
            None => return fail(ShareError::failed(format!("share: not a URL ({url})"))),
        }
    }
    for path in &sheet.files {
        items.push(object(NSURL::fileURLWithPath(&NSString::from_str(path))));
    }
    if items.is_empty() {
        return fail(ShareError::failed("share: nothing to share"));
    }
    let Some(Place { view, rect }) = place.filter(|place| place.view.window().is_some()) else {
        // AppKit shows no menu there, and so never answers.
        return fail(ShareError::failed(
            "share: the surface is in no visible window",
        ));
    };
    // The window's container is not flipped, an anchor (an NSH view) is.
    let edge = below(view.isFlipped());
    let window = view.window();
    let key = window.as_ref().is_some_and(|w| w.isKeyWindow());
    let delegate = PickerDelegate::alloc(mtm).set_ivars(DelegateIvars {
        reply: reply.clone(),
        owner,
        title: sheet.title.as_deref().map(NSString::from_str),
        window: window
            .as_ref()
            .map(objc2::rc::Weak::from_retained)
            .unwrap_or_default(),
        key,
        service: RefCell::new(None),
        answered: Cell::new(false),
        left: Cell::new(false),
        looks: Cell::new(0),
        back: Cell::new(0),
    });
    // SAFETY: NSObject's designated initializer.
    let delegate: Retained<PickerDelegate> = unsafe { msg_send![super(delegate), init] };
    let items = NSArray::from_retained_slice(&items);
    // SAFETY: NSSharingServicePicker's documented API (macOS 10.8), on the
    // main thread; its items are strings and URLs, and the delegate is kept
    // in the engine's `Showing` until the share is answered.
    unsafe {
        let picker: Allocated<AnyObject> = msg_send![class, alloc];
        let picker: Option<Retained<AnyObject>> = msg_send![picker, initWithItems: &*items];
        let Some(picker) = picker else {
            return fail(ShareError::failed(
                "share: the share menu could not be made",
            ));
        };
        let _: () = msg_send![&picker, setDelegate: &*delegate];
        // Kept before it shows: the menu tracks inside this call, and the
        // choice comes before it returns.
        SHOWING.with_borrow_mut(|showing| {
            showing.insert(
                owner,
                Showing {
                    picker: Some(picker.clone()),
                    delegate,
                },
            )
        });
        let _: () =
            msg_send![&picker, showRelativeToRect: rect, ofView: &*view, preferredEdge: edge];
    }
}

/// `value` as the object an `NSArray` of items holds.
fn object<T: objc2::Message>(value: Retained<T>) -> Retained<AnyObject> {
    // SAFETY: every Objective-C object is an `AnyObject`.
    unsafe { Retained::cast_unchecked(value) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unanchored_menu_points_at_one_point_in_the_middle() {
        let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(480.0, 860.0));
        let rect = middle(bounds);
        assert_eq!(rect.size, NSSize::new(1.0, 1.0));
        assert_eq!(rect.origin, NSPoint::new(239.5, 429.5));
        let shifted = NSRect::new(NSPoint::new(10.0, 20.0), NSSize::new(100.0, 50.0));
        assert_eq!(middle(shifted).origin, NSPoint::new(59.5, 44.5));
    }

    #[test]
    fn the_menu_opens_below_in_flipped_and_unflipped_views() {
        assert_eq!(below(true), MAX_Y);
        assert_eq!(below(false), MIN_Y);
    }
}
