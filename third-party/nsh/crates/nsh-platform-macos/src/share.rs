//! `Share.show`: AppKit's share menu, `NSSharingServicePicker`
//! ([`nsh_core::share`]). The text, the link and the files' URLs are its
//! items; the title becomes the subject of the service the user chooses (a
//! mail's subject line). The menu shows on a later turn of the run loop,
//! never from the batch that asked for it, below the anchor's own view, in
//! whatever window it is, or at the middle of a visible app window. With
//! neither available, the share fails. A new share replaces the menu of one still
//! open. The share is answered once on the root's `Share` event: shared
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
    rc::{Rc, Weak},
};

use nsh_core::{
    EventKind, ROOT_ID,
    share::{ShareError, ShareOutcome, ShareSheet},
};
use nsh_engine::EngineControl;
use objc2::{
    DefinedClass, MainThreadOnly, Message, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_app_kit::{NSApplication, NSModalPanelRunLoopMode, NSView, NSWindow};
use objc2_foundation::{
    NSArray, NSDefaultRunLoopMode, NSError, NSObject, NSObjectProtocol, NSPoint, NSRect, NSRunLoop,
    NSSize, NSString, NSURL,
};

use crate::surface::Surface;

/// `NSRectEdgeMaxY`: below the anchor in a flipped view.
const BELOW: isize = 3;

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

/// A surface's share: the menu while it shows and its delegate until the
/// share is answered (the picker and the service hold it weakly). One per
/// surface, as the core keeps one share per engine.
#[derive(Default)]
pub(crate) struct Showing {
    picker: RefCell<Option<Retained<AnyObject>>>,
    delegate: RefCell<Option<Retained<PickerDelegate>>>,
}

pub(crate) struct DelegateIvars {
    id: u32,
    control: EngineControl,
    title: Option<Retained<NSString>>,
    surface: Weak<Surface>,
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
                    if let Some(surface) = self.ivars().surface.upgrade() {
                        release_later(surface.share.picker.borrow_mut().take());
                        watch(surface.key(), self.ivars().id);
                    }
                }
                None => self.finish(ShareOutcome::dismissed().payload(self.ivars().id)),
            }
        }

        #[unsafe(method(sharingService:didShareItems:))]
        fn did_share(&self, _service: &AnyObject, _items: &AnyObject) {
            let ivars = self.ivars();
            let target = ivars.service.borrow().clone();
            self.finish(ShareOutcome::shared(target).payload(ivars.id));
        }

        #[unsafe(method(sharingService:didFailToShareItems:error:))]
        fn did_fail(&self, _service: &AnyObject, _items: &AnyObject, error: &NSError) {
            let id = self.ivars().id;
            let cancelled = error.code() == USER_CANCELLED
                && error.domain().to_string() == "NSCocoaErrorDomain";
            let payload = if cancelled {
                ShareOutcome::dismissed().payload(id)
            } else {
                ShareError::failed(error.localizedDescription().to_string()).payload(id)
            };
            self.finish(payload);
        }
    }
);

impl PickerDelegate {
    /// Answers the share once, and lets the menu and this delegate go once
    /// AppKit returns from the call it is making.
    fn finish(&self, payload: nsh_core::EventPayload) {
        let ivars = self.ivars();
        if !ivars.answered.replace(true) {
            ivars
                .control
                .dispatch_event(ROOT_ID, EventKind::Share, payload);
        }
        if let Some(surface) = ivars.surface.upgrade() {
            release_later(surface.share.picker.borrow_mut().take());
            let mine = surface
                .share
                .delegate
                .borrow()
                .as_ref()
                .is_some_and(|d| std::ptr::eq(&**d, self));
            if mine {
                release_later(surface.share.delegate.borrow_mut().take());
            }
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
                self.finish(ShareOutcome::shared(target).payload(ivars.id));
                return false;
            }
        } else {
            ivars.left.set(true);
            ivars.back.set(0);
        }
        if looks >= GIVE_UP {
            self.finish(ShareOutcome::dismissed().payload(ivars.id));
            return false;
        }
        true
    }
}

/// Looks after share `id`'s chosen service every [`WATCH_MS`] until the
/// share is answered or replaced, or gives up ([`PickerDelegate::look`]).
fn watch(key: u64, id: u32) {
    crate::input::later(WATCH_MS, move || {
        let Some(surface) = Surface::with_key(key) else {
            return;
        };
        let delegate = surface.share.delegate.borrow().clone();
        let Some(delegate) = delegate.filter(|d| d.ivars().id == id) else {
            return;
        };
        if delegate.look() {
            watch(key, id);
        }
    });
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

/// Shows the share menu for `sheet` in `surface` on a later turn of the
/// main run loop, and answers request `id`.
///
/// Not now: the batch that asked for it holds the surface's mounter, which
/// finding the anchor's view borrows, and the menu tracks the mouse inside
/// the call that shows it, where the batches that come meanwhile borrow
/// the mounter again. In the default and modal modes, as alerts: not while
/// another menu or a drag tracks the mouse.
pub(crate) fn schedule(surface: &Rc<Surface>, id: u32, sheet: &ShareSheet) {
    let held = RefCell::new(Some((Rc::downgrade(surface), sheet.clone())));
    let block = block2::RcBlock::new(move || {
        let Some((surface, sheet)) = held.borrow_mut().take() else {
            return;
        };
        match surface.upgrade() {
            Some(surface) => show(&surface, id, &sheet),
            None => log::warn!("share: the surface closed; request {id} is not answered"),
        }
    });
    // SAFETY: immutable constants of Foundation and AppKit.
    let (default, modal) = unsafe { (NSDefaultRunLoopMode, NSModalPanelRunLoopMode) };
    let modes = NSArray::from_slice(&[default, modal]);
    // SAFETY: the block runs on the main thread, where it was made.
    unsafe { NSRunLoop::mainRunLoop().performInModes_block(&modes, &block) };
}

/// Shows the share menu for `sheet` in `surface`, below the view of node
/// `sheet.anchor` where it is in a window, and answers request `id`.
fn show(surface: &Rc<Surface>, id: u32, sheet: &ShareSheet) {
    let Some(control) = surface.event_control() else {
        // No engine runs to hear an answer (the command came from one).
        log::warn!("share: no app runs in this surface; request {id} is not answered");
        return;
    };
    let fail = |error: ShareError| {
        control.dispatch_event(ROOT_ID, EventKind::Share, error.payload(id));
    };
    // A share still open is replaced (the core answered it already),
    // whether this one shows or fails.
    if let Some(earlier) = surface.share.delegate.borrow_mut().take() {
        earlier.ivars().answered.set(true);
        release_later(Some(earlier));
    }
    release_later(surface.share.picker.borrow_mut().take());
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
    // No batch holds the mounter on this turn; were one to, the menu shows
    // at the middle rather than wait.
    let anchor = sheet
        .anchor
        .and_then(|anchor| {
            let mounter = surface.mounter.try_borrow().ok()?;
            mounter.views.get(&anchor).cloned()
        })
        .filter(|view| view.ns().window().is_some());
    let (view, rect): (Retained<NSView>, NSRect) = match &anchor {
        Some(anchor) => (anchor.ns().retain(), anchor.ns().bounds()),
        None => {
            let root = crate::window::visible_container(surface)
                .unwrap_or_else(|| surface.root.ns().retain());
            if root.window().is_none_or(|w| !w.isVisible()) {
                // AppKit shows no menu there, and so never answers.
                return fail(ShareError::failed(
                    "share: the surface is in no visible window",
                ));
            }
            let bounds = root.bounds();
            (
                root,
                NSRect::new(
                    NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
                    NSSize::new(0.0, 0.0),
                ),
            )
        }
    };
    let window = view.window();
    let key = window.as_ref().is_some_and(|w| w.isKeyWindow());
    let delegate = PickerDelegate::alloc(surface.mtm).set_ivars(DelegateIvars {
        id,
        control: control.clone(),
        title: sheet.title.as_deref().map(NSString::from_str),
        surface: Rc::downgrade(surface),
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
    // in the surface's `share` until the share is answered.
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
        *surface.share.picker.borrow_mut() = Some(picker.clone());
        *surface.share.delegate.borrow_mut() = Some(delegate);
        let _: () =
            msg_send![&picker, showRelativeToRect: rect, ofView: &*view, preferredEdge: BELOW];
    }
}

/// `value` as the object an `NSArray` of items holds.
fn object<T: objc2::Message>(value: Retained<T>) -> Retained<AnyObject> {
    // SAFETY: every Objective-C object is an `AnyObject`.
    unsafe { Retained::cast_unchecked(value) }
}
