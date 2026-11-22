//! `Share.show`: the system's share sheet, `UIActivityViewController`
//! ([`nsh_core::share`]). The text and the link are items of their own, the
//! files file URLs; the title is the subject the first item gives (a mail's
//! subject line). On an iPad the sheet is a popover pointing at the anchor
//! view, or at the middle of the surface without an arrow. Its completion
//! answers the root's `Share` event: shared with the activity type that
//! finished, or dismissed. A new share closes the surface's sheet still
//! showing, once its transitions end, and shows in its place.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchTime, MainThreadBound};
use nsh_core::{
    EventKind, ROOT_ID,
    share::{ShareError, ShareOutcome, ShareSheet},
};
use nsh_engine::EngineControl;
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, ProtocolObject},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_ui_kit::{
    UIActivityItemSource, UIActivityType, UIActivityTypeSaveToCameraRoll, UIActivityViewController,
    UIPopoverArrowDirection, UIView, UIViewController, UIViewControllerTransitionCoordinator,
    UIViewControllerTransitionCoordinatorContext,
};

/// What one shared item holds: the item and the subject it gives.
pub(crate) struct ItemIvars {
    item: Retained<AnyObject>,
    subject: Option<Retained<NSString>>,
}

define_class!(
    /// An item of the sheet that also gives the share's title as its
    /// subject (`UIActivityItemSource`): a share sheet takes a title from
    /// nowhere else.
    #[unsafe(super(NSObject))]
    #[ivars = ItemIvars]
    pub(crate) struct ShareItem;

    unsafe impl NSObjectProtocol for ShareItem {}

    unsafe impl UIActivityItemSource for ShareItem {
        #[unsafe(method_id(activityViewControllerPlaceholderItem:))]
        fn placeholder(&self, _controller: &UIActivityViewController) -> Retained<AnyObject> {
            self.ivars().item.clone()
        }

        #[unsafe(method_id(activityViewController:itemForActivityType:))]
        fn item(
            &self,
            _controller: &UIActivityViewController,
            _activity: Option<&UIActivityType>,
        ) -> Option<Retained<AnyObject>> {
            Some(self.ivars().item.clone())
        }

        #[unsafe(method_id(activityViewController:subjectForActivityType:))]
        fn subject(
            &self,
            _controller: &UIActivityViewController,
            _activity: Option<&UIActivityType>,
        ) -> Retained<NSString> {
            self.ivars().subject.clone().unwrap_or_default()
        }
    }
);

impl ShareItem {
    fn new(item: Retained<AnyObject>, subject: Option<Retained<NSString>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ItemIvars { item, subject });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// `value` as the object an `NSArray` of items holds.
fn object<T: objc2::Message>(value: Retained<T>) -> Retained<AnyObject> {
    // SAFETY: every Objective-C object is an `AnyObject`.
    unsafe { Retained::cast_unchecked(value) }
}

/// A surface's share sheet: the one waiting to be presented, else the one
/// UIKit last got, while it lives. A new share replaces it.
#[derive(Default)]
pub(crate) struct Current(RefCell<Option<Last>>);

struct Last {
    /// The share while it waits to be presented (its waits hold it).
    waiting: std::rc::Weak<Presenting>,
    /// Its sheet, while UIKit holds it.
    sheet: objc2::rc::Weak<UIActivityViewController>,
    phase: Rc<Cell<Phase>>,
}

/// Where a share sheet is on its way to the screen.
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    /// Waiting for transitions to end before it is presented.
    Waiting,
    /// Handed to UIKit and not shown yet: a popover starts presenting some
    /// turns later on an iPad, and says nothing of it until then.
    Requested,
    /// Presented (and maybe closed since).
    Shown,
}

/// A sheet a share closes before it shows, while UIKit holds it: one it
/// let go of (a presentation it dropped) will not show.
struct Earlier {
    sheet: objc2::rc::Weak<UIActivityViewController>,
    phase: Rc<Cell<Phase>>,
}

impl Current {
    /// Makes `next` the surface's share, and returns the sheet it has to
    /// close first: the one shown, or the one a share still waiting was to
    /// close (that share now never shows).
    fn replace(&self, next: &Rc<Presenting>) -> Option<Earlier> {
        let last = self.0.replace(Some(Last {
            waiting: Rc::downgrade(next),
            sheet: objc2::rc::Weak::from_retained(&next.controller),
            phase: next.phase.clone(),
        }))?;
        if last.phase.get() == Phase::Waiting {
            let waiting = last.waiting.upgrade()?;
            waiting.replaced.set(true);
            return waiting.earlier.take();
        }
        last.sheet.load()?;
        Some(Earlier {
            sheet: last.sheet,
            phase: last.phase,
        })
    }
}

/// Shows the share sheet for `sheet` over the top controller of `root`'s
/// window (the surface's root view), pointing at `anchor` (the anchor
/// node's own view, in whatever modal it is) where it is a popover, and
/// answers request `id` once: when it closes, or at once when it cannot
/// be presented. The surface's share sheet still showing (`current`) is
/// closed first, with what its target presented over it.
pub(crate) fn show(
    id: u32,
    sheet: &ShareSheet,
    root: &UIView,
    anchor: Option<&UIView>,
    current: &Current,
    control: &EngineControl,
) {
    let fail = |error: ShareError| {
        control.dispatch_event(ROOT_ID, EventKind::Share, error.payload(id));
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return fail(ShareError::failed("share: not on the main thread"));
    };
    if root.window().is_none() {
        return fail(ShareError::failed("share: the surface is in no window"));
    }
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
    if let Some(title) = &sheet.title {
        let first = items.remove(0);
        let item = ShareItem::new(first, Some(NSString::from_str(title)));
        items.insert(0, object(item));
    }
    let items = NSArray::from_retained_slice(&items);
    // SAFETY: the items are objects a share sheet takes (strings, URLs and
    // item sources), and no application activities are given.
    let controller = unsafe {
        UIActivityViewController::initWithActivityItems_applicationActivities(
            UIActivityViewController::alloc(mtm),
            &items,
            None,
        )
    };
    if !can_save_photos() {
        // Saving an image to Photos needs the app's reason for adding to
        // the library; without it the system ends the app, so the sheet
        // does not offer it.
        // SAFETY: a constant UIKit defines.
        let save = unsafe { UIActivityTypeSaveToCameraRoll };
        controller.setExcludedActivityTypes(Some(&NSArray::from_slice(&[save])));
    }
    let answer = Rc::new(Answer {
        id,
        control: control.clone(),
        answered: Cell::new(false),
    });
    let shown = objc2::rc::Weak::from_retained(&controller);
    let completion = {
        let answer = answer.clone();
        RcBlock::new(
            move |activity: *mut UIActivityType,
                  completed: Bool,
                  _: *mut NSArray,
                  error: *mut NSError| {
                // SAFETY: UIKit passes a valid error or null.
                let error = unsafe { error.as_ref() };
                // SAFETY: UIKit passes a valid activity type or null.
                let activity = unsafe { activity.as_ref() };
                // A share extension the user cancelled leaves the sheet up
                // to choose another target: only its final call (a target
                // that finished, or the sheet closed) answers. Should that
                // call never come, the sheet gone answers.
                if !completed.as_bool() && activity.is_some() && error.is_none() && up(&shown) {
                    let presenter = shown
                        .load()
                        .and_then(|sheet| sheet.presentingViewController())
                        .map(|presenter| objc2::rc::Weak::from_retained(&presenter))
                        .unwrap_or_default();
                    return watch(mtm, shown.clone(), presenter, answer.clone());
                }
                let payload = match error {
                    Some(error) => {
                        ShareError::failed(error.localizedDescription().to_string()).payload(id)
                    }
                    None if completed.as_bool() => {
                        ShareOutcome::shared(activity.map(ToString::to_string)).payload(id)
                    }
                    None => ShareOutcome::dismissed().payload(id),
                };
                answer.send(payload);
            },
        )
    };
    // SAFETY: the block lives as long as UIKit keeps it (it copies it).
    unsafe { controller.setCompletionWithItemsHandler(RcBlock::as_ptr(&completion)) };
    controller.setOverrideUserInterfaceStyle(crate::system::appearance());
    if let Some(popover) = controller.popoverPresentationController() {
        // iPad and Mac: a popover pointing at the anchor's own view, else
        // at the middle of the surface without an arrow.
        match anchor.filter(|view| view.window().is_some()) {
            Some(view) => {
                popover.setSourceView(Some(view));
                popover.setSourceRect(view.bounds());
            }
            None => {
                popover.setSourceView(Some(root));
                let bounds = root.bounds();
                popover.setSourceRect(CGRect::new(
                    CGPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
                    CGSize::ZERO,
                ));
                popover.setPermittedArrowDirections(UIPopoverArrowDirection::empty());
            }
        }
    }
    let presenting = Rc::new(Presenting {
        mtm,
        controller,
        phase: Rc::new(Cell::new(Phase::Waiting)),
        root: root.retain(),
        answer,
        waits: Cell::new(0),
        requested: Cell::new(0),
        replaced: Cell::new(false),
        earlier: RefCell::new(None),
    });
    // The surface's earlier sheet gives way (the core answered it already).
    *presenting.earlier.borrow_mut() = current.replace(&presenting);
    presenting.go();
}

/// Whether the sheet is still presented and not on its way out.
fn up(sheet: &objc2::rc::Weak<UIActivityViewController>) -> bool {
    sheet
        .load()
        .is_some_and(|c| c.presentingViewController().is_some() && !c.isBeingDismissed())
}

/// Whether the sheet, or what took its place over `presenter` (the next
/// target's view, presented once a popover closed), is still presented
/// and not on its way out. A controller presents one controller at a
/// time, so what `presenter` presents now stands where the sheet was.
fn held(
    sheet: &objc2::rc::Weak<UIActivityViewController>,
    presenter: &objc2::rc::Weak<UIViewController>,
) -> bool {
    up(sheet)
        || presenter
            .load()
            .and_then(|presenter| presenter.presentedViewController())
            .is_some_and(|presented| !presented.isBeingDismissed())
}

/// How often a sheet that may never call its completion again is looked
/// at, in milliseconds.
const WATCH_MS: u64 = 500;

/// Answers dismissed once `sheet` is gone, with nothing presented in its
/// place over `presenter`, without its completion having answered: after
/// a share extension was cancelled some systems call the completion no
/// more, whichever way the sheet then closes.
fn watch(
    mtm: MainThreadMarker,
    sheet: objc2::rc::Weak<UIActivityViewController>,
    presenter: objc2::rc::Weak<UIViewController>,
    answer: Rc<Answer>,
) {
    later(mtm, WATCH_MS, move || {
        if answer.answered.get() {
            return;
        }
        if held(&sheet, &presenter) {
            return watch(mtm, sheet, presenter, answer);
        }
        // Gone, or going: a completion still to come answers first.
        next_turn(move || answer.send(ShareOutcome::dismissed().payload(answer.id)));
    });
}

/// Runs `f` on the main queue after `ms` milliseconds.
fn later(mtm: MainThreadMarker, ms: u64, f: impl FnOnce() + 'static) {
    let f = MainThreadBound::new(f, mtm);
    let when = DispatchTime::NOW.time((ms * 1_000_000) as i64);
    let scheduled = DispatchQueue::main().after(when, move || {
        let mtm = MainThreadMarker::new().expect("main queue");
        (f.into_inner(mtm))();
    });
    if let Err(err) = scheduled {
        log::warn!("share: cannot schedule a look at the sheet: {err:?}");
    }
}

/// One share's answer, sent once whoever sends it.
struct Answer {
    id: u32,
    control: EngineControl,
    answered: Cell<bool>,
}

impl Answer {
    fn send(&self, payload: nsh_core::EventPayload) {
        if !self.answered.replace(true) {
            self.control
                .dispatch_event(ROOT_ID, EventKind::Share, payload);
        }
    }
}

/// A share sheet on its way to the screen.
struct Presenting {
    mtm: MainThreadMarker,
    controller: Retained<UIActivityViewController>,
    phase: Rc<Cell<Phase>>,
    /// The surface's root view, whose window's top controller presents.
    root: Retained<UIView>,
    answer: Rc<Answer>,
    /// The waits for transitions to end so far.
    waits: Cell<u32>,
    /// The looks so far for the earlier sheet to begin presenting.
    requested: Cell<u32>,
    /// A newer share replaced this one before it was presented: it never
    /// is (the core answered it already).
    replaced: Cell<bool>,
    /// The surface's earlier sheet, to close before this one shows.
    earlier: RefCell<Option<Earlier>>,
}

/// The most waits a share makes for transitions before it gives up: a
/// transition takes one, a look for one ending takes [`LOOK_MS`].
const MAX_WAITS: u32 = 120;

/// How long a share waits before it looks again at a transition that
/// cannot tell when it ends, in milliseconds (a frame).
const LOOK_MS: u64 = 16;

/// The most looks a share makes for an earlier sheet UIKit holds to begin
/// presenting (ten seconds: a sheet of many files loads them first).
const MAX_REQUESTED: u32 = (10_000 / LOOK_MS) as u32;

impl Presenting {
    /// Closes the earlier sheet, once no transition runs in it or what
    /// its target presented over it, then presents this one.
    fn go(self: Rc<Self>) {
        if self.replaced.get() {
            return;
        }
        let earlier = self
            .earlier
            .borrow()
            .as_ref()
            .map(|e| (e.sheet.load(), e.phase.get()));
        let Some((earlier, phase)) = earlier else {
            let Some(top) = crate::system::top_controller(&self.root) else {
                return self.refuse();
            };
            return self.present_over(top);
        };
        let Some(earlier) = earlier else {
            // UIKit let go of it: dropped before it showed, or closed.
            self.earlier.take();
            return self.go();
        };
        if phase == Phase::Requested && self.requested.get() < MAX_REQUESTED {
            // UIKit has not begun presenting it: look again shortly. (Never
            // begun after all these looks, it is not coming.)
            self.requested.set(self.requested.get() + 1);
            return later(self.mtm, LOOK_MS, move || self.go());
        }
        let Some(presenter) = earlier.presentingViewController() else {
            // Never shown, or gone.
            self.earlier.take();
            return self.go();
        };
        if let Some(moving) = moving_from(&earlier) {
            return self.wait(&moving, |this| this.go());
        }
        // Closing from its presenter closes what is over it too: a share
        // extension, or a view its target presented.
        self.earlier.take();
        let once = Cell::new(Some(self));
        let then = RcBlock::new(move || {
            if let Some(this) = once.take() {
                this.go();
            }
        });
        presenter.dismissViewControllerAnimated_completion(false, Some(&then));
    }

    /// Presents the sheet over `top`, once a transition `top` is in ends.
    /// UIKit presents nothing over a controller that is presenting another
    /// one, being presented, or out of the window (and then calls no
    /// completion), so those are decided here, before presenting: what
    /// passes is presented, what cannot is answered as refused.
    fn present_over(self: Rc<Self>, top: Retained<UIViewController>) {
        if self.replaced.get() {
            return;
        }
        let moving = match top.presentedViewController() {
            Some(leaving) if leaving.isBeingDismissed() => Some(leaving),
            Some(_) => return self.refuse(),
            None if top.isBeingPresented() => Some(top.clone()),
            None => None,
        };
        let Some(moving) = moving else {
            if top.viewIfLoaded().and_then(|view| view.window()).is_none() {
                return self.refuse();
            }
            return self.present(&top);
        };
        self.wait(&moving, move |this| this.present_over(top));
    }

    /// Runs `then` once the transition `moving` is in ends, or refuses
    /// the share after too many turns.
    fn wait(self: Rc<Self>, moving: &UIViewController, then: impl FnOnce(Rc<Self>) + 'static) {
        if self.waits.replace(self.waits.get() + 1) >= MAX_WAITS {
            return self.refuse();
        }
        let self_mtm = self.mtm;
        let once = Cell::new(Some((self, then)));
        let then = Rc::new(move || {
            if let Some((this, then)) = once.take() {
                then(this);
            }
        });
        let done = {
            let then = then.clone();
            RcBlock::new(
                move |_: NonNull<
                    ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
                >| { then() },
            )
        };
        // Refused when the transition is already ending: look again on the
        // next turn.
        let waiting = moving.transitionCoordinator().is_some_and(|coordinator| {
            coordinator.animateAlongsideTransition_completion(None, Some(&done))
        });
        if !waiting {
            let mtm = self_mtm;
            later(mtm, LOOK_MS, move || then());
        }
    }

    /// Presents the sheet over `top`. Its answer comes from the sheet's
    /// completion. (A popover's presentation starts some turns later on an
    /// iPad, so the controller says nothing of it right after this call.)
    fn present(self: Rc<Self>, top: &UIViewController) {
        self.phase.set(Phase::Requested);
        let phase = self.phase.clone();
        let shown = RcBlock::new(move || phase.set(Phase::Shown));
        top.presentViewController_animated_completion(&self.controller, true, Some(&shown));
    }

    /// Answers the request as a sheet UIKit cannot show.
    fn refuse(&self) {
        self.answer.send(
            ShareError::failed(
                "share: the share sheet could not be presented (another view is being presented)",
            )
            .payload(self.answer.id),
        );
    }
}

/// The first controller in a transition from `sheet` up through what is
/// presented over it.
fn moving_from(sheet: &UIViewController) -> Option<Retained<UIViewController>> {
    let mut next = Some(sheet.retain());
    while let Some(controller) = next {
        if controller.isBeingPresented() || controller.isBeingDismissed() {
            return Some(controller);
        }
        next = controller.presentedViewController();
    }
    None
}

/// Runs `f` on a later turn of the main run loop.
fn next_turn(f: impl FnOnce() + 'static) {
    let once = Cell::new(Some(f));
    let block = RcBlock::new(move || {
        if let Some(f) = once.take() {
            f();
        }
    });
    // SAFETY: NSRunLoop's documented `performBlock:` on the main run loop,
    // called on the main thread.
    unsafe {
        let run_loop: Retained<AnyObject> = msg_send![objc2::class!(NSRunLoop), mainRunLoop];
        let _: () = msg_send![&run_loop, performBlock: &*block];
    }
}

/// Whether the app gives a reason for adding to the photo library
/// (`NSPhotoLibraryAddUsageDescription` in its Info.plist), without which
/// saving an image to Photos ends the app.
fn can_save_photos() -> bool {
    NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&NSString::from_str("NSPhotoLibraryAddUsageDescription"))
        .is_some()
}
