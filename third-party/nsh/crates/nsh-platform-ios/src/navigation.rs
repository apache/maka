//! Native navigation: stacks of screens on `UINavigationController`, and
//! modals presented as view controllers.
//!
//! The core lays screens out at their stack's size (content below the
//! header) and modals at the size reported here; this module only
//! arranges controllers and reports what the user does natively (popping
//! with the back button or a swipe, swiping a sheet down).
//!
//! UIKit asks some of this synchronously (may the swipe begin, may the back
//! button pop, may the sheet close): the answers come from props already
//! mounted (`popOnSwipe`, `popOnBack`, `closeOnSwipe`, `closeOnEscape`),
//! never from JS.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
    sync::Arc,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_core::{
    Color, EdgeInsets, EventKind, EventPayload, HeaderItem, HeaderItemContent, HeaderSystemItem,
    ModalAnimation, ModalConfig, ModalPresentation, NavShader, NodeId, PayloadValue, Points,
    ScreenAnimation, ScreenConfig, SheetDetent, Size,
    desktop::{MenuAction, MenuItem},
    element::header::{KeptContent, same_right_buttons},
};
use nsh_engine::EngineControl;
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyClass, AnyObject, ProtocolObject},
    sel,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};
use objc2_quartz_core::{CAMediaTiming, CATransition};
use objc2_ui_kit::{
    NSDirectionalRectEdge, NSForegroundColorAttributeName, UIAction,
    UIAdaptivePresentationControllerDelegate, UIBarButtonItem, UIBarButtonItemStyle,
    UIBarButtonSystemItem, UIBehavioralStyle, UIColor, UIEdgeInsets, UIGestureRecognizer,
    UIGestureRecognizerDelegate, UIImage, UIInterfaceOrientationMask, UIMenu, UIMenuElement,
    UIMenuElementAttributes, UIMenuElementState, UIMenuOptions, UIModalPresentationStyle,
    UIModalTransitionStyle, UINavigationBar, UINavigationBarAppearance, UINavigationController,
    UINavigationControllerDelegate, UINavigationItem, UINavigationItemLargeTitleDisplayMode,
    UIPresentationController, UIResponder, UIScrollView, UISheetPresentationController,
    UISheetPresentationControllerDelegate, UISheetPresentationControllerDetent,
    UISheetPresentationControllerDetentIdentifierLarge,
    UISheetPresentationControllerDetentIdentifierMedium,
    UISheetPresentationControllerDetentResolutionContext, UIView, UIViewAutoresizing,
    UIViewController, UIViewControllerTransitionCoordinator,
    UIViewControllerTransitionCoordinatorContext,
};

use crate::{mount::SharedMounter, native_view::NshView};

fn insets_payload(i: EdgeInsets) -> EventPayload {
    EventPayload::Map(vec![
        ("top", PayloadValue::Number(i.top.0 as f64)),
        ("right", PayloadValue::Number(i.right.0 as f64)),
        ("bottom", PayloadValue::Number(i.bottom.0 as f64)),
        ("left", PayloadValue::Number(i.left.0 as f64)),
    ])
}

/// `RequestClose`'s payload: what the user did (`"cancel"`, `"swipe"`).
fn close_reason(reason: &str) -> EventPayload {
    EventPayload::Map(vec![("reason", PayloadValue::Str(reason.to_owned()))])
}

/// A `UIKeyCommand` for Escape that calls `nshEscape:`.
fn escape_command() -> Retained<AnyObject> {
    let class = AnyClass::get(c"UIKeyCommand").expect("UIKeyCommand");
    // SAFETY: a UIKit constant, and UIKeyCommand's documented factory.
    unsafe {
        msg_send![
            class,
            keyCommandWithInput: objc2_ui_kit::UIKeyInputEscape,
            modifierFlags: 0isize,
            action: objc2::sel!(nshEscape:)
        ]
    }
}

fn ui_color(c: Color) -> Retained<UIColor> {
    let (r, g, b, a) = c.to_f64();
    UIColor::colorWithRed_green_blue_alpha(r, g, b, a)
}

pub(crate) struct ScreenIvars {
    id: NodeId,
    control: EngineControl,
    /// Height of the header area the core laid the content out below.
    padded: Cell<f32>,
    /// The core lays the content out below the header: it gets the header's
    /// real height (`set_screen_header`).
    measure: Cell<bool>,
    /// The header height last reported to the core.
    measured: Cell<Option<f32>>,
    insets: Cell<Option<EdgeInsets>>,
    /// `headerBackgroundOnScroll`: the header follows the scroll view that
    /// runs under it (`follow_content_scroll`).
    follow_scroll: Cell<bool>,
    /// The scroll view last given to UIKit as the content scroll view.
    followed: RefCell<Option<Weak<UIScrollView>>>,
    /// `!headerVisible`: whether the bar is hidden while this screen is on
    /// top of its stack (`follow_header`).
    header_hidden: Cell<bool>,
}

define_class!(
    /// The controller of one screen; its view hosts the screen's root view.
    #[unsafe(super(UIViewController, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ScreenIvars]
    pub(crate) struct ScreenController;

    impl ScreenController {
        #[unsafe(method(viewDidLayoutSubviews))]
        fn view_did_layout_subviews(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewDidLayoutSubviews] };
            self.report_insets();
            self.follow_content_scroll();
        }

        /// The stack correcting what UIKit granted a screen beside a side
        /// bar changes its safe area without moving anything in it: the
        /// module hears the corrected insets from here, not a layout pass.
        #[unsafe(method(viewSafeAreaInsetsDidChange))]
        fn view_safe_area_insets_did_change(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewSafeAreaInsetsDidChange] };
            self.report_insets();
        }
    }
);

impl ScreenController {
    /// Reports the top of the view's safe area (the bottom of the header UIKit
    /// shows, wherever it put it) as the header the content starts below.
    /// The core's estimate (the bar's height plus the status bar) is wrong
    /// on Mac Catalyst, where the bar can sit in the window's title bar.
    fn report_header(&self, view: &UIView, top: f32) {
        let ivars = self.ivars();
        let header = if !ivars.measure.get() {
            None
        } else if view.window().is_some()
            && let Some(nav) = self.navigationController()
            && !nav.isNavigationBarHidden()
        {
            Some(top)
        } else {
            // Off screen or between headers: keep what was measured.
            return;
        };
        if ivars.measured.replace(header) != header {
            ivars
                .control
                .set_screen_header(ivars.id, header.map(Points));
        }
    }

    fn new(mtm: MainThreadMarker, id: NodeId, control: EngineControl) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ScreenIvars {
            id,
            control,
            padded: Cell::new(0.0),
            measure: Cell::new(false),
            measured: Cell::new(None),
            insets: Cell::new(None),
            follow_scroll: Cell::new(false),
            followed: RefCell::new(None),
            header_hidden: Cell::new(false),
        });
        // SAFETY: UIViewController's designated initializer.
        unsafe {
            msg_send![super(this), initWithNibName: Option::<&NSString>::None, bundle: Option::<&NSObject>::None]
        }
    }

    pub(crate) fn screen_id(&self) -> NodeId {
        self.ivars().id
    }

    /// Shows or hides the bar of the stack this screen is on top of, as its
    /// `headerVisible` says. A stack shows the bar for the screen it pushes
    /// or pops to (`willShow`); a screen already on top that changes
    /// `headerVisible` brings no transition, and the core already lays its
    /// content out for the header it asked for. A transition under way
    /// (the stack's, or a modal's over it) keeps the bar it started with:
    /// the bar follows once it ends, if this screen is still on top.
    fn follow_header(&self) {
        let Some(nav) = self.navigationController() else {
            return;
        };
        let on_top = nav
            .topViewController()
            .is_some_and(|top| std::ptr::eq::<UIViewController>(&*top, &**self));
        let hidden = self.ivars().header_hidden.get();
        if !on_top || nav.isNavigationBarHidden() == hidden {
            return;
        }
        if let Some(coordinator) = nav.transitionCoordinator() {
            let pending = Cell::new(Some(self.retain()));
            let wait = RcBlock::new(
                move |_: NonNull<
                    ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
                >| {
                    let Some(screen) = pending.take() else {
                        return;
                    };
                    let mtm = screen.mtm();
                    let bound = MainThreadBound::new(screen, mtm);
                    // The main queue's next turn: the transition is over by
                    // then.
                    DispatchQueue::main().exec_async(move || {
                        let mtm = MainThreadMarker::new().expect("the main queue");
                        bound.into_inner(mtm).follow_header();
                    });
                },
            );
            // Refused when the transition is already ending.
            if coordinator.animateAlongsideTransition_completion(None, Some(&wait)) {
                return;
            }
        }
        let animated = self.viewIfLoaded().is_some_and(|v| v.window().is_some());
        nav.setNavigationBarHidden_animated(hidden, animated);
    }

    /// With `headerBackgroundOnScroll`, the header switches to its standard
    /// appearance once the content scrolls under it. UIKit watches the
    /// controller's content scroll view for that, and before iOS 26 finds it
    /// on its own only next to the root view, not deep in the screen's
    /// content: it is pointed at the scroll view that runs under the header.
    pub(crate) fn follow_content_scroll(&self) {
        let ivars = self.ivars();
        let found = if ivars.follow_scroll.get() {
            self.view().and_then(|view| scroll_under_header(&view))
        } else {
            None
        };
        let followed = ivars.followed.borrow().as_ref().and_then(Weak::load);
        if followed.as_deref().map(|v| v as *const UIScrollView)
            != found.as_deref().map(|v| v as *const UIScrollView)
        {
            self.setContentScrollView_forEdge(found.as_deref(), NSDirectionalRectEdge::Top);
            *ivars.followed.borrow_mut() = found.as_deref().map(Weak::new);
        }
    }

    /// The screen's insets not covered by system UI or its header, for
    /// `safeAreaInsets()` inside it; and where its content starts below
    /// the header.
    pub(crate) fn report_insets(&self) {
        let Some(view) = self.view() else { return };
        let s = view.safeAreaInsets();
        self.report_header(&view, s.top as f32);
        let insets = EdgeInsets {
            top: Points((s.top as f32 - self.ivars().padded.get()).max(0.0)),
            right: Points(s.right as f32),
            bottom: Points(s.bottom as f32),
            left: Points(s.left as f32),
        };
        if self.ivars().insets.replace(Some(insets)) != Some(insets) {
            let id = self.ivars().id;
            self.ivars()
                .control
                .dispatch_event(id, EventKind::Insets, insets_payload(insets));
        }
    }
}

/// The scroll view a header follows: the visible one that starts at the top of
/// `root` (under a transparent header) and shows the most of itself, outside
/// other scroll views.
fn scroll_under_header(root: &UIView) -> Option<Retained<UIScrollView>> {
    let bounds = root.bounds();
    let mut best: Option<(CGFloat, Retained<UIScrollView>)> = None;
    let mut queue = vec![root.retain()];
    while let Some(parent) = queue.pop() {
        for child in parent.subviews().iter() {
            if child.isHidden() || child.alpha() <= 0.0 {
                continue;
            }
            let Ok(scroll) = child.clone().downcast::<UIScrollView>() else {
                queue.push(child);
                continue;
            };
            let frame = parent.convertRect_toView(scroll.frame(), Some(root));
            let width = (frame.origin.x + frame.size.width).min(bounds.size.width)
                - frame.origin.x.max(0.0);
            let height = (frame.origin.y + frame.size.height).min(bounds.size.height);
            if frame.origin.y > 0.5 || width <= 0.0 || height <= 0.0 {
                continue;
            }
            let area = width * height;
            if best.as_ref().is_none_or(|(most, _)| area > *most) {
                best = Some((area, scroll));
            }
        }
    }
    best.map(|(_, scroll)| scroll)
}

fn first_responder(view: &UIView) -> Option<Retained<UIView>> {
    if view.isFirstResponder() {
        return Some(view.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| first_responder(&child))
}

pub(crate) struct ModalIvars {
    id: NodeId,
    control: EngineControl,
    reported: Cell<Option<(CGSize, EdgeInsets)>>,
    /// `supportedOrientations`; empty keeps the presenter's.
    orientations: Cell<UIInterfaceOrientationMask>,
    /// `closeOnSwipe`: a swipe down closes the sheet natively.
    close_on_swipe: Cell<bool>,
    /// `closeOnEscape`: the Escape key (and VoiceOver's escape gesture)
    /// closes it natively.
    close_on_escape: Cell<bool>,
    /// It appears and leaves with an animation.
    animated: Cell<bool>,
    /// The user closed it natively; the app has not hidden it yet.
    closed: Cell<bool>,
    /// The app is hiding it (`ModalHost::dismiss`).
    dismissing: Cell<bool>,
    /// Its dismissal waits for a transition where it is to end
    /// ([`dismiss_settled`]): a modal presented over it meanwhile would go
    /// with it once it runs ([`transition_over`]).
    deferred: Cell<bool>,
    /// The identifiers of the sheet's UIKit detents and the detents
    /// (`detents`) they stand for, to report the one the user picks.
    detents: RefCell<Vec<(Retained<NSString>, SheetDetent)>>,
    /// The height of the window it was presented over, which decides
    /// between medium and large for a custom detent before iOS 16.
    screen: Cell<CGFloat>,
}

define_class!(
    /// The controller a modal is presented with.
    #[unsafe(super(UIViewController, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ModalIvars]
    pub(crate) struct ModalController;

    unsafe impl NSObjectProtocol for ModalController {}

    impl ModalController {
        #[unsafe(method(viewDidLayoutSubviews))]
        fn view_did_layout_subviews(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewDidLayoutSubviews] };
            self.report_size();
        }

        #[unsafe(method(viewDidAppear:))]
        fn view_did_appear(&self, animated: bool) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewDidAppear: animated] };
            let id = self.ivars().id;
            self.ivars().control.dispatch_event(id, EventKind::Show, EventPayload::None);
        }

        /// Dismissed by other code than NSH's: a close the user made in
        /// what the modal shows, as AVKit's close button of a video filling
        /// it, which dismisses the controller presenting the player. UIKit
        /// reports no such dismissal to the presentation's delegate: it is
        /// reported as Escape's (`cancel`), so the app hides it and what it
        /// shows (a playing video) goes. On the main queue's next turn,
        /// after a swipe's `presentationControllerDidDismiss:`, and once
        /// the modal is gone.
        #[unsafe(method(viewDidDisappear:))]
        fn view_did_disappear(&self, animated: bool) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewDidDisappear: animated] };
            if !self.isBeingDismissed() || self.ivars().closed.get() || self.ivars().dismissing.get() {
                return;
            }
            let mtm = self.mtm();
            let weak = MainThreadBound::new(Weak::from_retained(&self.retain()), mtm);
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("the main queue");
                let Some(this) = weak.into_inner(mtm).load() else { return };
                let ivars = this.ivars();
                if ivars.closed.get()
                    || ivars.dismissing.get()
                    || this.presentingViewController().is_some()
                {
                    return;
                }
                ivars.closed.set(true);
                ivars
                    .control
                    .dispatch_event(ivars.id, EventKind::RequestClose, close_reason("cancel"));
                ivars
                    .control
                    .dispatch_event(ivars.id, EventKind::Dismiss, EventPayload::None);
            });
        }

        /// Escape on a hardware keyboard.
        #[unsafe(method_id(keyCommands))]
        fn key_commands(&self) -> Option<Retained<NSArray<AnyObject>>> {
            // SAFETY: calling the superclass implementation.
            let inherited: Option<Retained<NSArray<AnyObject>>> =
                unsafe { msg_send![super(self), keyCommands] };
            let mut commands = inherited.map(|a| a.to_vec()).unwrap_or_default();
            commands.push(escape_command());
            Some(NSArray::from_retained_slice(&commands))
        }

        #[unsafe(method(nshEscape:))]
        fn escape(&self, _sender: Option<&AnyObject>) {
            self.cancel();
        }

        /// VoiceOver's escape gesture (a two-finger scrub).
        #[unsafe(method(accessibilityPerformEscape))]
        fn accessibility_perform_escape(&self) -> bool {
            self.cancel();
            true
        }
    }

    impl ModalController {
        #[unsafe(method(preferredStatusBarStyle))]
        fn preferred_status_bar_style(&self) -> objc2_ui_kit::UIStatusBarStyle {
            crate::system::preferred_status_bar_style()
        }

        #[unsafe(method(prefersStatusBarHidden))]
        fn prefers_status_bar_hidden(&self) -> bool {
            crate::system::prefers_status_bar_hidden()
        }

        #[unsafe(method(preferredStatusBarUpdateAnimation))]
        fn preferred_status_bar_update_animation(&self) -> objc2_ui_kit::UIStatusBarAnimation {
            crate::system::status_bar_animation()
        }

        #[unsafe(method(supportedInterfaceOrientations))]
        fn supported_interface_orientations(&self) -> UIInterfaceOrientationMask {
            let own = self.ivars().orientations.get();
            if !own.is_empty() {
                return own;
            }
            // The presenter's: the root controller answers with the page's
            // under it, NSH's own and a host's that forwards it alike, and a
            // host's that does not keeps its own for its dialogs too.
            if let Some(presenter) = self.presentingViewController() {
                return presenter.supportedInterfaceOrientations();
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), supportedInterfaceOrientations] }
        }
    }

    unsafe impl UIAdaptivePresentationControllerDelegate for ModalController {
        /// Answered from `closeOnSwipe`: close natively (reported when
        /// done), or let `open` decide (a swipe down only asks).
        #[unsafe(method(presentationControllerShouldDismiss:))]
        fn should_dismiss(&self, _controller: &UIPresentationController) -> bool {
            self.ivars().close_on_swipe.get()
        }

        /// The user swiped a `closeOnSwipe` sheet away.
        #[unsafe(method(presentationControllerDidDismiss:))]
        fn did_dismiss(&self, _controller: &UIPresentationController) {
            let ivars = self.ivars();
            ivars.closed.set(true);
            ivars
                .control
                .dispatch_event(ivars.id, EventKind::RequestClose, close_reason("swipe"));
            ivars
                .control
                .dispatch_event(ivars.id, EventKind::Dismiss, EventPayload::None);
        }

        /// A swipe down on a sheet that stays (`closeOnSwipe` false).
        #[unsafe(method(presentationControllerDidAttemptToDismiss:))]
        fn did_attempt_to_dismiss(&self, _controller: &UIPresentationController) {
            let id = self.ivars().id;
            self.ivars()
                .control
                .dispatch_event(id, EventKind::RequestClose, close_reason("swipe"));
        }
    }

    unsafe impl UISheetPresentationControllerDelegate for ModalController {
        /// The user moved the sheet to another detent (a drag, the
        /// grabber, a scroll at its edge, a screen reader).
        #[unsafe(method(sheetPresentationControllerDidChangeSelectedDetentIdentifier:))]
        fn did_change_detent(&self, sheet: &UISheetPresentationController) {
            let Some(selected) = sheet.selectedDetentIdentifier() else {
                return;
            };
            let ivars = self.ivars();
            let detent = ivars
                .detents
                .borrow()
                .iter()
                .find(|(identifier, _)| identifier.isEqualToString(&selected))
                .map(|&(_, detent)| detent);
            if let Some(detent) = detent {
                ivars.control.dispatch_event(
                    ivars.id,
                    EventKind::DetentChange,
                    detent.change_payload(),
                );
            }
        }
    }
);

impl ModalController {
    fn new(mtm: MainThreadMarker, id: NodeId, control: EngineControl) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ModalIvars {
            id,
            control,
            reported: Cell::new(None),
            orientations: Cell::new(UIInterfaceOrientationMask::empty()),
            close_on_swipe: Cell::new(false),
            close_on_escape: Cell::new(false),
            animated: Cell::new(true),
            closed: Cell::new(false),
            dismissing: Cell::new(false),
            deferred: Cell::new(false),
            detents: RefCell::new(Vec::new()),
            screen: Cell::new(0.0),
        });
        // SAFETY: UIViewController's designated initializer.
        unsafe {
            msg_send![super(this), initWithNibName: Option::<&NSString>::None, bundle: Option::<&NSObject>::None]
        }
    }

    /// Applies the close flags (also while presented).
    fn set_flags(&self, c: &ModalConfig) {
        let ivars = self.ivars();
        ivars.close_on_swipe.set(c.close_on_swipe);
        ivars.close_on_escape.set(c.close_on_escape);
        ivars.animated.set(c.animation != ModalAnimation::None);
        // A sheet that stays only reports the swipe
        // (`presentationControllerDidAttemptToDismiss:`).
        self.setModalInPresentation(!c.close_on_swipe);
    }

    /// Applies the sheet's detents, grabber and undimmed detent of `c`
    /// (a sheet presentation only), against `old`, what it had (`None`
    /// before it is presented: it opens at `detent`, else `defaultDetent`,
    /// else the smallest). The app's `detent` moves it when it changes.
    fn apply_sheet(&self, c: &ModalConfig, old: Option<&ModalConfig>) {
        let Some(sheet) = self.sheetPresentationController() else {
            return;
        };
        let has = |c: &ModalConfig| {
            !c.detents.is_empty()
                || c.grabber
                || c.detent.is_some()
                || c.default_detent.is_some()
                || c.largest_undimmed_detent.is_some()
        };
        // A sheet without the options keeps UIKit's own defaults untouched.
        if !has(c) && !old.is_some_and(has) {
            return;
        }
        let same = old.is_some_and(|o| {
            o.detents == c.detents
                && o.grabber == c.grabber
                && o.detent == c.detent
                && o.largest_undimmed_detent == c.largest_undimmed_detent
        });
        if same {
            return;
        }
        let mtm = self.mtm();
        let made = sheet_detents(mtm, &c.detents, self.ivars().screen.get());
        let identifier = |detent: Option<SheetDetent>| {
            let detent = detent?;
            made.iter()
                .find(|d| d.detent == detent)
                .map(|d| d.identifier.clone())
        };
        let selected = match old {
            None => Some(identifier(c.detent.or(c.default_detent))),
            Some(o) if o.detent != c.detent && c.detent.is_some() => Some(identifier(c.detent)),
            Some(_) => None,
        };
        let undimmed = identifier(c.largest_undimmed_detent);
        let natives: Vec<Retained<UISheetPresentationControllerDetent>> = if made.is_empty() {
            // UIKit's default: the full height.
            vec![UISheetPresentationControllerDetent::largeDetent(mtm)]
        } else {
            made.iter().map(|d| d.native.clone()).collect()
        };
        *self.ivars().detents.borrow_mut() =
            made.into_iter().map(|d| (d.identifier, d.detent)).collect();
        let apply = || {
            sheet.setDetents(&NSArray::from_retained_slice(&natives));
            sheet.setPrefersGrabberVisible(c.grabber);
            sheet.setLargestUndimmedDetentIdentifier(undimmed.as_deref());
            if let Some(selected) = &selected {
                sheet.setSelectedDetentIdentifier(selected.as_deref());
            }
        };
        if old.is_some() && self.presentingViewController().is_some() {
            sheet.animateChanges(&RcBlock::new(apply));
        } else {
            apply();
        }
    }

    /// Escape: reported as `cancel`, and closed natively with
    /// `closeOnEscape` (reported when done).
    fn cancel(&self) {
        let ivars = self.ivars();
        // Not presented, or under another modal (the top one handles it).
        if ivars.closed.get()
            || self.presentingViewController().is_none()
            || self.presentedViewController().is_some()
        {
            return;
        }
        let (id, control) = (ivars.id, ivars.control.clone());
        control.dispatch_event(id, EventKind::RequestClose, close_reason("cancel"));
        if !ivars.close_on_escape.get() {
            return;
        }
        ivars.closed.set(true);
        let block = block2::RcBlock::new(move || {
            control.dispatch_event(id, EventKind::Dismiss, EventPayload::None);
        });
        self.dismissViewControllerAnimated_completion(ivars.animated.get(), Some(&block));
    }

    /// Lays the modal's content out at the size it is presented at.
    fn report_size(&self) {
        let Some(view) = self.view() else { return };
        let size = view.bounds().size;
        let s = view.safeAreaInsets();
        let insets = EdgeInsets {
            top: Points(s.top as f32),
            right: Points(s.right as f32),
            bottom: Points(s.bottom as f32),
            left: Points(s.left as f32),
        };
        if size.width <= 0.0
            || self.ivars().reported.replace(Some((size, insets))) == Some((size, insets))
        {
            return;
        }
        let ivars = self.ivars();
        ivars.control.set_root_size(
            ivars.id,
            Size::new(Points(size.width as f32), Points(size.height as f32)),
            insets,
        );
        ivars
            .control
            .dispatch_event(ivars.id, EventKind::Insets, insets_payload(insets));
    }
}

/// A UIKit detent made for a [`SheetDetent`], with its identifier.
struct MadeDetent {
    native: Retained<UISheetPresentationControllerDetent>,
    /// Known when it is made: `-[UISheetPresentationControllerDetent
    /// identifier]` needs iOS 16.
    identifier: Retained<NSString>,
    detent: SheetDetent,
}

/// The UIKit detents of `detents`: UIKit's medium and large, and a custom
/// detent of the height asked for (iOS 16 and later; before, the nearer
/// of medium and large). A detent that comes out the same as an earlier
/// one is left out. `screen`: the height of the window, against which a
/// height is a share before iOS 16.
fn sheet_detents(
    mtm: MainThreadMarker,
    detents: &[SheetDetent],
    screen: CGFloat,
) -> Vec<MadeDetent> {
    let class = <UISheetPresentationControllerDetent as ClassType>::class();
    // SAFETY: `respondsToSelector:` on the class object.
    let custom: bool =
        unsafe { msg_send![class, respondsToSelector: sel!(customDetentWithIdentifier:resolver:)] };
    let screen = screen.max(1.0);
    let medium = || {
        // SAFETY: a constant of UIKit since iOS 15, the oldest NSH runs on.
        let identifier = unsafe { UISheetPresentationControllerDetentIdentifierMedium }.retain();
        (
            UISheetPresentationControllerDetent::mediumDetent(mtm),
            identifier,
        )
    };
    let large = || {
        // SAFETY: as `medium`'s.
        let identifier = unsafe { UISheetPresentationControllerDetentIdentifierLarge }.retain();
        (
            UISheetPresentationControllerDetent::largeDetent(mtm),
            identifier,
        )
    };
    let mut out: Vec<MadeDetent> = Vec::new();
    for &detent in detents {
        let (native, identifier) = match detent {
            SheetDetent::Medium => medium(),
            SheetDetent::Large => large(),
            // Named by their value, so a detent the app moves in its list
            // keeps its identifier and UIKit keeps it selected.
            SheetDetent::Height(height) if custom => custom_detent(
                mtm,
                &format!("nsh.height.{:08x}", height.0.to_bits()),
                detent,
            ),
            SheetDetent::Fraction(fraction) if custom => custom_detent(
                mtm,
                &format!("nsh.fraction.{:08x}", fraction.0.to_bits()),
                detent,
            ),
            SheetDetent::Height(_) | SheetDetent::Fraction(_) => {
                let share = match detent {
                    SheetDetent::Height(height) => height.0 as CGFloat / screen,
                    SheetDetent::Fraction(fraction) => fraction.0 as CGFloat,
                    SheetDetent::Medium | SheetDetent::Large => 1.0,
                };
                if share < 0.75 { medium() } else { large() }
            }
        };
        if out
            .iter()
            .any(|made| made.identifier.isEqualToString(&identifier))
        {
            continue;
        }
        out.push(MadeDetent {
            native,
            identifier,
            detent,
        });
    }
    out
}

/// A custom UIKit detent (iOS 16 and later) named `name`, at the height
/// of `detent` (`Height` or `Fraction`) within the sheet's room.
fn custom_detent(
    mtm: MainThreadMarker,
    name: &str,
    detent: SheetDetent,
) -> (
    Retained<UISheetPresentationControllerDetent>,
    Retained<NSString>,
) {
    let identifier = NSString::from_str(name);
    let resolver = RcBlock::new(
        move |context: NonNull<
            ProtocolObject<dyn UISheetPresentationControllerDetentResolutionContext>,
        >|
              -> CGFloat {
            // SAFETY: UIKit passes a live context for the call.
            let max = unsafe { context.as_ref() }.maximumDetentValue();
            let height = match detent {
                SheetDetent::Height(height) => height.0 as CGFloat,
                SheetDetent::Fraction(fraction) => max * fraction.0 as CGFloat,
                SheetDetent::Medium | SheetDetent::Large => max,
            };
            height.clamp(0.0, max)
        },
    );
    let native = UISheetPresentationControllerDetent::customDetentWithIdentifier_resolver(
        Some(&identifier),
        &resolver,
        mtm,
    );
    (native, identifier)
}

pub(crate) struct NavIvars {
    stack: NodeId,
    mounter: SharedMounter,
    /// The app's own change of screens is being applied.
    applying: Cell<bool>,
}

/// The recognizers of `nav`'s swipe back: the screen edge's and, since
/// iOS 26, the content's, which can take an edge drag too.
pub(crate) fn back_swipes(nav: &UINavigationController) -> Vec<Retained<UIGestureRecognizer>> {
    let content = nav
        .respondsToSelector(objc2::sel!(interactiveContentPopGestureRecognizer))
        .then(|| nav.interactiveContentPopGestureRecognizer())
        .flatten();
    nav.interactivePopGestureRecognizer()
        .into_iter()
        .chain(content)
        .collect()
}

/// Whether `other` is the swipe back of a stack `view` is in (or of a stack
/// around that one): an edge pan waits for it to fail, so a swipe that can
/// go back does, and the pan takes the swipes of a screen with nothing to
/// go back to.
pub(crate) fn is_back_swipe(view: &UIView, other: &UIGestureRecognizer) -> bool {
    let Some(controller) = controller_of(view) else {
        return false;
    };
    let mut nav = match controller.clone().downcast::<UINavigationController>() {
        Ok(nav) => Some(nav),
        Err(_) => controller.navigationController(),
    };
    while let Some(n) = nav {
        if back_swipes(&n)
            .iter()
            .any(|r| std::ptr::eq::<UIGestureRecognizer>(&**r, other))
        {
            return true;
        }
        nav = n.navigationController();
    }
    false
}

/// A drag that starts at the screen's edge belongs to the stack: the top
/// screen's scroll views wait for the back gesture to fail before they pan,
/// so a swipe at the edge goes back instead of scrolling the page. The
/// gesture fails at once for a drag that is not at the edge. Scroll views
/// mounted after the screen's last stack change get it with the next one.
fn defer_to_back_swipe(nav: &UINavigationController) {
    let Some(pop) = nav.interactivePopGestureRecognizer() else {
        return;
    };
    let Some(view) = nav.topViewController().and_then(|c| c.view()) else {
        return;
    };
    let mut pending = vec![view];
    while let Some(view) = pending.pop() {
        if let Some(scroll) = view.downcast_ref::<UIScrollView>() {
            scroll
                .panGestureRecognizer()
                .requireGestureRecognizerToFail(&pop);
        }
        pending.extend(view.subviews().iter());
    }
}

/// Gives every screen whose view UIKit left empty its parent's bounds.
///
/// UIKit sizes a pushed controller's view from the navigation view, which
/// is still empty when the stack mounts: autoresizing cannot grow a zero
/// size, so the view keeps an empty frame even once the navigation view
/// has one. The screen's content is not clipped, so it draws correctly,
/// but an empty view answers `pointInside:` with false, which ends
/// `hitTest:` there, and the accessibility snapshot UI tests read drops
/// the whole subtree under it: the screen is visible and nothing in it
/// can be touched or found.
fn size_screens(nav: &UINavigationController) {
    for controller in nav.viewControllers().iter() {
        if !controller.isViewLoaded() {
            continue;
        }
        let Some(view) = controller.view() else {
            continue;
        };
        let Some(parent) = view.superview() else {
            continue;
        };
        let size = view.bounds().size;
        let bounds = parent.bounds();
        if (size.width <= 0.0 || size.height <= 0.0)
            && bounds.size.width > 0.0
            && bounds.size.height > 0.0
        {
            view.setFrame(bounds);
        }
    }
}

/// Holds a screen's horizontal safe area to the part of it its stack covers.
///
/// A bar the device keeps along one side of the screen (the iPhone Duo's
/// vertical bar) is an inset of the window, and `UINavigationController`
/// hands that inset to the screens it shows without asking whether it still
/// reaches the bar: a stack laid out in a column that stops well short of it
/// passes the bar's whole width down as trailing safe area anyway. Content
/// stays where it belongs (the core lays it out from the insets the screen
/// reports, and a scroll view here adjusts nothing), but UIKit parks scroll
/// indicators that far in from the edge, and `safeAreaInsets()` reads that
/// wide inside the module.
///
/// What a screen is owed on a side is how much of the window's unsafe strip
/// there the stack's view really covers; a negative `additionalSafeAreaInsets`
/// takes the rest back. Both numbers come from the window and the stack's
/// frame, never from what a screen's safe area currently is. Recovering the
/// inset UIKit granted by subtracting the compensation already applied is the
/// tempting shortcut, and it cannot heal. UIKit floors a safe area at zero, so
/// once a compensation overshoots (the bar changes side and yesterday's value
/// stays behind) that subtraction hands the overshoot straight back, and every
/// later pass arrives at the same wrong number again. Taken from geometry and
/// written to both sides every time, it is idempotent, and leaves nothing
/// behind on the side the bar left. The stack's frame is its untransformed
/// place: a container's transform moves the picture of the stack, not the
/// part of the window it covers (see [`hold_safe_area`]).
fn clip_side_safe_area(nav: &UINavigationController) {
    let Some(view) = nav.viewIfLoaded() else {
        return;
    };
    // Out of the window there is no bar to measure against; the layout pass
    // that follows the stack going back in works this out again.
    let Some(window) = view.window() else {
        return;
    };
    let safe = window.safeAreaInsets();
    let bounds = window.bounds();
    let frame = match untransformed_place(&view) {
        Some((above, frame)) => above.convertRect_toView(frame, Some(&window)),
        None => view.convertRect_toView(view.bounds(), Some(&window)),
    };
    let (stack_min, stack_max) = (frame.min().x, frame.max().x);
    let covered = |min: CGFloat, max: CGFloat| (stack_max.min(max) - stack_min.max(min)).max(0.0);
    let left = covered(bounds.min().x, bounds.min().x + safe.left) - safe.left;
    let right = covered(bounds.max().x - safe.right, bounds.max().x) - safe.right;
    for controller in nav.viewControllers().iter() {
        let current = controller.additionalSafeAreaInsets();
        if current.left == left && current.right == right {
            continue;
        }
        controller.setAdditionalSafeAreaInsets(UIEdgeInsets {
            left,
            right,
            ..current
        });
    }
}

/// The superview of the outermost transformed layer between `view` (itself
/// included) and its window, with `view`'s bounds where they sit in it when
/// no transform applies; `None` when no layer on the way has a transform.
fn untransformed_place(view: &UIView) -> Option<(Retained<UIView>, CGRect)> {
    let size = view.bounds().size;
    let (mut x, mut y) = (0.0, 0.0);
    let mut place = None;
    let mut v = view.retain();
    while let Some(parent) = v.superview() {
        let layer = v.layer();
        let (center, bounds, anchor) = (v.center(), v.bounds(), layer.anchorPoint());
        // Where `view` sits in `parent`'s bounds, which a scroll view moves
        // by its offset: the rectangle is kept in those coordinates.
        x += center.x - bounds.size.width * anchor.x;
        y += center.y - bounds.size.height * anchor.y;
        if !layer.transform().is_identity() {
            place = Some((parent.clone(), CGRect::new(CGPoint::new(x, y), size)));
        }
        let offset = parent.bounds().origin;
        x -= offset.x;
        y -= offset.y;
        v = parent;
    }
    place
}

/// Keeps the safe area UIKit measures through a transform from falling short
/// of what the stack's untransformed place is owed.
///
/// UIKit measures a controller's safe area through the transforms around it,
/// on its own layout passes only: a pass while a container shows the stack
/// scaled or moved (a drawer that shrinks the page into a card) hands it the
/// insets of that picture, and they stay after the transform goes, since a
/// transform starts no pass. What the stack is owed comes from the safe area
/// of the view just above the outermost transform (the window's insets and
/// whatever a host or an outer stack adds there), against the stack's
/// untransformed place in that view; what falls short goes into the stack's
/// `additionalSafeAreaInsets`. Insets added inside the transformed views (a
/// host's tab bar when the host scales its tab controller) are measured by
/// UIKit in the same picture and stay as they are: nothing here takes away
/// from what UIKit granted. With no transform around, nothing is added.
fn hold_safe_area(nav: &UINavigationController) {
    let Some(view) = nav.viewIfLoaded() else {
        return;
    };
    if view.window().is_none() {
        return;
    }
    let current = nav.additionalSafeAreaInsets();
    let wanted = match untransformed_place(&view) {
        None => UIEdgeInsets {
            top: 0.0,
            left: 0.0,
            bottom: 0.0,
            right: 0.0,
        },
        Some((above, frame)) => {
            let (bounds, area) = (above.bounds(), above.safeAreaInsets());
            let safe = view.safeAreaInsets();
            // What is added is never negative, so UIKit's floor at zero
            // never cuts the sum: less what was added, the safe area is
            // exactly what UIKit granted.
            let short = |owed: CGFloat, safe: CGFloat, added: CGFloat| {
                (owed.max(0.0) - (safe - added)).max(0.0)
            };
            UIEdgeInsets {
                top: short(
                    bounds.min().y + area.top - frame.min().y,
                    safe.top,
                    current.top,
                ),
                left: short(
                    bounds.min().x + area.left - frame.min().x,
                    safe.left,
                    current.left,
                ),
                bottom: short(
                    frame.max().y - bounds.max().y + area.bottom,
                    safe.bottom,
                    current.bottom,
                ),
                right: short(
                    frame.max().x - bounds.max().x + area.right,
                    safe.right,
                    current.right,
                ),
            }
        }
    };
    let near = |a: CGFloat, b: CGFloat| (a - b).abs() < 0.01;
    if near(current.top, wanted.top)
        && near(current.left, wanted.left)
        && near(current.bottom, wanted.bottom)
        && near(current.right, wanted.right)
    {
        return;
    }
    nav.setAdditionalSafeAreaInsets(wanted);
}

/// Gives the bar of `nav` the height of the large title its top screen asks
/// for, when UIKit left it lower and the screen's content rests at its top.
///
/// A stack laid out in the frame its first screen arrives shows that screen
/// with the bar at the height of an inline title (`sizeThatFits` already
/// gives the large title's): the screen's safe area and its scroll view's
/// offset follow that height, and UIKit then reads the content as scrolled
/// under a collapsed large title, which stays collapsed. Sized here, the
/// bar grows the safe area, UIKit keeps the scroll view at its top, and the
/// title shows large. Content the user scrolled keeps its collapsed title.
fn fit_large_title(nav: &UINavigationController) {
    let bar = nav.navigationBar();
    if nav.isNavigationBarHidden() || !bar.prefersLargeTitles() {
        return;
    }
    let Some(top) = nav.topViewController() else {
        return;
    };
    if top.navigationItem().largeTitleDisplayMode() != UINavigationItemLargeTitleDisplayMode::Always
    {
        return;
    }
    let scrolled = top
        .viewIfLoaded()
        .and_then(|view| crate::mount::first_scroll_view(&view))
        .is_some_and(|s| s.contentOffset().y > -s.adjustedContentInset().top);
    let size = bar.frame().size;
    if !scrolled && bar.sizeThatFits(size).height > size.height {
        bar.sizeToFit();
    }
}

define_class!(
    /// A stack's navigation controller: the back button asks it before
    /// popping (`navigationBar:shouldPopItem:`), answered from `preventBack`.
    #[unsafe(super(UINavigationController, UIViewController, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = NavIvars]
    pub(crate) struct NavController;

    unsafe impl NSObjectProtocol for NavController {}

    impl NavController {
        /// The header's back button: a screen listening to `onBackPress`
        /// hears of it, and one with `popOnBack` false stays.
        #[unsafe(method(navigationBar:shouldPopItem:))]
        fn should_pop_item(&self, bar: &UINavigationBar, item: &UINavigationItem) -> bool {
            let ivars = self.ivars();
            // The app's own pops, and the end of an interactive swipe
            // (`popOnSwipe`, a transition already running), are no press.
            let press = !ivars.applying.get() && self.transitionCoordinator().is_none();
            let mut stay = false;
            if press
                && let Ok(m) = ivars.mounter.get(self.mtm()).try_borrow()
                && let Some(m) = m.as_ref()
                && let Some((screen, listens, prevent)) = m.stack_back_press(ivars.stack)
            {
                if listens {
                    m.dispatch(screen, EventKind::BackRequest);
                }
                stay = prevent;
            }
            if stay {
                false
            } else {
                // The page goes: its keyboard hides with the pop, as a
                // native back button's does, not once the page has left
                // the window.
                if press && let Some(view) = self.topViewController().and_then(|c| c.view()) {
                    view.endEditing(true);
                }
                // SAFETY: calling the superclass implementation.
                unsafe { msg_send![super(self), navigationBar: bar, shouldPopItem: item] }
            }
        }

        /// Whatever a layout pass left empty (a stack that grew after it
        /// mounted, a window that changed size) is sized here.
        #[unsafe(method(viewDidLayoutSubviews))]
        fn view_did_layout_subviews(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewDidLayoutSubviews] };
            size_screens(self);
            clip_side_safe_area(self);
            hold_safe_area(self);
            // A column of a split (or its compact stack): the core lays the
            // column's pages out at the size the split gives it.
            let ivars = self.ivars();
            if let Ok(mut m) = ivars.mounter.get(self.mtm()).try_borrow_mut()
                && let Some(m) = m.as_mut()
            {
                m.split_column_laid_out(ivars.stack);
            }
        }

        /// A side bar arriving, leaving or changing side moves no view of
        /// the stack, so the screens' compensation is worked out here too.
        #[unsafe(method(viewSafeAreaInsetsDidChange))]
        fn view_safe_area_insets_did_change(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewSafeAreaInsetsDidChange] };
            clip_side_safe_area(self);
            hold_safe_area(self);
        }
    }
);

impl NavController {
    fn new(mtm: MainThreadMarker, stack: NodeId, mounter: SharedMounter) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(NavIvars {
            stack,
            mounter,
            applying: Cell::new(false),
        });
        // SAFETY: UIViewController's designated initializer.
        unsafe {
            msg_send![super(this), initWithNibName: Option::<&NSString>::None, bundle: Option::<&NSObject>::None]
        }
    }
}

pub(crate) struct StackDelegateIvars {
    stack: NodeId,
    mounter: SharedMounter,
    /// An accepted gesture ended editing; return it if the same page wins.
    editor: RefCell<Option<Weak<UIView>>>,
}

define_class!(
    /// Follows the navigation controller of one stack: per-screen header
    /// visibility, swipe-back permission, and screens the user popped.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = StackDelegateIvars]
    pub(crate) struct StackDelegate;

    unsafe impl NSObjectProtocol for StackDelegate {}

    unsafe impl UINavigationControllerDelegate for StackDelegate {
        #[unsafe(method(navigationController:willShowViewController:animated:))]
        fn will_show(
            &self,
            nav: &UINavigationController,
            controller: &UIViewController,
            animated: bool,
        ) {
            // UIKit's own hook for this: it runs for pushes and pops, before
            // the transition starts, with a live `transitionCoordinator` — the
            // place a `UITabBarController` moves its bar from.
            slide_bottom_bar(nav, bottom_bar_hidden(nav));
            // A swipe back that the user cancels ends without `didShow`, so the
            // bar has to be put back where the stack now says it belongs once
            // the interaction ends (a completed one lands on the same value).
            if let Some(coordinator) = nav.transitionCoordinator() {
                let nav = unsafe {
                    Retained::retain(
                        nav as *const UINavigationController as *mut UINavigationController,
                    )
                }
                .expect("the navigation controller lives");
                let block = RcBlock::new(
                    move |_context: NonNull<
                        ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
                    >| {
                        slide_bottom_bar(&nav, bottom_bar_hidden(&nav));
                    },
                );
                coordinator.notifyWhenInteractionChangesUsingBlock(&block);
            }
            self.with_mounter(|m| m.stack_will_show(nav, controller, animated));
        }

        #[unsafe(method(navigationController:didShowViewController:animated:))]
        fn did_show(
            &self,
            nav: &UINavigationController,
            controller: &UIViewController,
            _animated: bool,
        ) {
            if let Some(editor) = self.ivars().editor.borrow_mut().take()
                && let Some(editor) = editor.load()
                && let Some(view) = controller.view()
                && editor.isDescendantOfView(&view)
                && let Some(window) = editor.window()
                && first_responder(&window).is_none_or(|r| crate::keyboard::is_root_focus(&r))
            {
                // The swipe was cancelled. Another control's focus wins; the
                // surface root, which took the keys when the editor
                // resigned, is no control's focus.
                editor.becomeFirstResponder();
            }
            // An animated change of screens is deferred to a layout pass of
            // the navigation view, which puts the screen that arrives in the
            // hierarchy after `reconcile` has sized what was there: the one
            // it brought in is only reachable here.
            size_screens(nav);
            defer_to_back_swipe(nav);
            fit_large_title(nav);
            // A bar that comes back with the transition (the screen that
            // left hid the header) is put at the top of a stack that starts
            // below the top of the window, above where UIKit keeps it at
            // rest, and nothing lays the screen out again once the
            // transition is over: this pass moves the bar to its place and
            // reports the header the screen's content starts below.
            if let Some(view) = controller.viewIfLoaded() {
                view.setNeedsLayout();
            }
            // Safety net: whatever the transition did, the bar ends where the
            // stack says it goes.
            slide_bottom_bar(nav, bottom_bar_hidden(nav));
            let stack = self.ivars().stack;
            self.with_mounter(|m| m.stack_did_show(stack));
            // UIKit installs its own pop delegate while loading the navigation
            // view. Restore ours after showing a screen so hidden headers still
            // use the mounted swipe-back policy.
            if let Some(pop) = nav.interactivePopGestureRecognizer() {
                pop.setDelegate(Some(ProtocolObject::from_ref(self)));
            }
        }
    }

    unsafe impl UIGestureRecognizerDelegate for StackDelegate {
        /// Swipe back: only with something to go back to, if the top
        /// screen allows it.
        #[unsafe(method(gestureRecognizerShouldBegin:))]
        fn should_begin(&self, recognizer: &UIGestureRecognizer) -> bool {
            let stack = self.ivars().stack;
            let mtm = self.mtm();
            let allowed = match self.ivars().mounter.get(mtm).try_borrow() {
                Ok(m) => m.as_ref().is_some_and(|m| m.stack_can_pop(stack)),
                Err(_) => false,
            };
            if allowed
                && let Some(view) = recognizer.view()
                && let Some(editor) = first_responder(&view)
            {
                // The outgoing view stays attached until the pop ends.
                // Resign now, after the permission/root/transition guards,
                // so the keyboard hides while the finger is still down.
                self.ivars()
                    .editor
                    .replace(Some(Weak::from_retained(&editor)));
                view.endEditing(true);
            }
            allowed
        }
    }
);

/// The target of a UIKit bar button (`ios={{ headerRightSystemItem }}`,
/// `ios={{ headerLeftSymbol }}`, ...): a press on it presses the screen's
/// `headerLeft` or `headerRight`, whose element the app listens to.
struct BarItemIvars {
    mounter: SharedMounter,
    /// The screen whose slot the button presses.
    screen: NodeId,
    /// The leading slot (`headerLeft`), else the trailing one.
    leading: bool,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = BarItemIvars]
    struct BarItemTarget;

    impl BarItemTarget {
        #[unsafe(method(nshPress:))]
        fn press(&self, _sender: Option<&NSObject>) {
            let ivars = self.ivars();
            if let Ok(mut m) = ivars.mounter.get(self.mtm()).try_borrow_mut()
                && let Some(m) = m.as_mut()
            {
                m.press_header(ivars.screen, ivars.leading);
            }
        }
    }
);

impl BarItemTarget {
    fn new(
        mtm: MainThreadMarker,
        screen: NodeId,
        leading: bool,
        mounter: SharedMounter,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(BarItemIvars {
            mounter,
            screen,
            leading,
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// The target of a trailing `ios.headerRightItems` button without a menu:
/// reports the root's `Menu` event with the item's press id. The id is a
/// [`Cell`] so a kept button can take the current binding's id without
/// rebuilding the `UIBarButtonItem`.
struct HeaderItemIvars {
    mounter: SharedMounter,
    press_id: Cell<u32>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = HeaderItemIvars]
    struct HeaderItemTarget;

    impl HeaderItemTarget {
        #[unsafe(method(nshPress:))]
        fn press(&self, _sender: Option<&NSObject>) {
            let ivars = self.ivars();
            let press_id = ivars.press_id.get();
            if press_id == 0 {
                return;
            }
            if let Ok(mut m) = ivars.mounter.get(self.mtm()).try_borrow_mut()
                && let Some(m) = m.as_mut()
            {
                m.menu_id_event(press_id);
            }
        }
    }
);

impl HeaderItemTarget {
    fn new(mtm: MainThreadMarker, press_id: u32, mounter: SharedMounter) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(HeaderItemIvars {
            mounter,
            press_id: Cell::new(press_id),
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn set_press_id(&self, press_id: u32) {
        self.ivars().press_id.set(press_id);
    }
}

/// What a UIKit bar button shows.
#[derive(Debug, Clone, PartialEq)]
enum BarButton {
    /// `headerLeftSystemItem` / `headerRightSystemItem`.
    System(HeaderSystemItem),
    /// `headerLeftSymbol` / `headerRightSymbol`: an SF Symbol's name.
    Symbol(Arc<str>),
}

/// A system bar button: what it shows, the button and its target.
type SystemBarItem = (
    BarButton,
    Retained<UIBarButtonItem>,
    Retained<BarItemTarget>,
);

/// Trailing `ios.headerRightItems`: the description, buttons and press
/// targets kept while the buttons' identity stays (UIKit holds targets
/// weakly). Targets are one per button (`None` when it has a menu), so a
/// re-bind can refresh `press_id` by index. Rebuilding a bar button
/// flashes it, so menus, labels, `disabled` and press ids update in place.
type RightItemsBar = (
    Vec<HeaderItem>,
    Vec<Retained<UIBarButtonItem>>,
    Vec<Option<Retained<HeaderItemTarget>>>,
);

/// UIKit's bar button showing `kind`, pressing `target`; `None` for a
/// symbol name SF Symbols does not have.
fn make_bar_button(
    mtm: MainThreadMarker,
    kind: &BarButton,
    target: &BarItemTarget,
) -> Option<Retained<UIBarButtonItem>> {
    let action = Some(objc2::sel!(nshPress:));
    match kind {
        // SAFETY: UIKit's designated initializer of a system bar button;
        // the caller keeps the target as long as the button, and `nshPress:`
        // is the target's action.
        BarButton::System(item) => Some(unsafe {
            UIBarButtonItem::initWithBarButtonSystemItem_target_action(
                UIBarButtonItem::alloc(mtm),
                system_bar_item(*item),
                Some(target),
                action,
            )
        }),
        BarButton::Symbol(name) => {
            let image = UIImage::systemImageNamed(&NSString::from_str(name))?;
            // SAFETY: as above, with an image.
            Some(unsafe {
                UIBarButtonItem::initWithImage_style_target_action(
                    UIBarButtonItem::alloc(mtm),
                    Some(&image),
                    UIBarButtonItemStyle::Plain,
                    Some(target),
                    action,
                )
            })
        }
    }
}

/// An SF Symbol image, or `None` when the name is unknown.
fn system_image(name: &str) -> Option<Retained<UIImage>> {
    UIImage::systemImageNamed(&NSString::from_str(name))
}

/// Dispatches a menu / press id as the root's `Menu` event.
fn menu_select(mounter: &SharedMounter, mtm: MainThreadMarker, id: u32) {
    if id == 0 {
        return;
    }
    if let Ok(mut m) = mounter.get(mtm).try_borrow_mut()
        && let Some(m) = m.as_mut()
    {
        m.menu_id_event(id);
    }
}

/// A `UIAction` for a [`MenuAction`].
fn make_menu_action(
    mtm: MainThreadMarker,
    action: &MenuAction,
    mounter: SharedMounter,
) -> Retained<UIAction> {
    let title = NSString::from_str(&action.label);
    // Prefer an SF Symbol; `icon` (an image source) is for desktop menus.
    let image = action.symbol.as_deref().and_then(system_image);
    let id = action.id;
    let handler = RcBlock::new(move |_: NonNull<UIAction>| {
        menu_select(&mounter, mtm, id);
    });
    // No UIKit identifier: the API lets an app reuse an action id in two
    // menus, and UIKit may drop or merge elements that share one. The
    // handler already carries the id.
    // SAFETY: UIKit copies the handler; the block stays while the action does.
    let item = unsafe {
        UIAction::actionWithTitle_image_identifier_handler(
            &title,
            image.as_deref(),
            None,
            (&*handler as *const block2::DynBlock<_>).cast_mut(),
            mtm,
        )
    };
    let mut attrs = UIMenuElementAttributes::empty();
    if !action.enabled {
        attrs |= UIMenuElementAttributes::Disabled;
    }
    if action.destructive {
        attrs |= UIMenuElementAttributes::Destructive;
    }
    item.setAttributes(attrs);
    item.setState(if action.checked == Some(true) {
        UIMenuElementState::On
    } else {
        UIMenuElementState::Off
    });
    item
}

/// Builds a `UIMenu` tree from [`MenuItem`]s.
fn make_menu(
    mtm: MainThreadMarker,
    items: &[MenuItem],
    mounter: &SharedMounter,
) -> Retained<UIMenu> {
    let children = menu_children(mtm, items, mounter, true);
    UIMenu::menuWithTitle_children(&NSString::from_str(""), &children, mtm)
}

/// One menu element from a non-separator [`MenuItem`].
fn menu_element(
    mtm: MainThreadMarker,
    entry: &MenuItem,
    mounter: &SharedMounter,
    enabled: bool,
) -> Option<Retained<UIMenuElement>> {
    match entry {
        MenuItem::Separator => None,
        MenuItem::Action(action) => {
            let mut action = action.clone();
            if !enabled {
                action.enabled = false;
            }
            Some(Retained::into_super(make_menu_action(
                mtm,
                &action,
                mounter.clone(),
            )))
        }
        MenuItem::Submenu {
            label,
            enabled: submenu_enabled,
            items,
            icon: _,
            symbol,
            inline,
        } => {
            let child_enabled = enabled && *submenu_enabled;
            let nested = menu_children(mtm, items, mounter, child_enabled);
            let image = symbol.as_deref().and_then(system_image);
            let options = if *inline {
                UIMenuOptions::DisplayInline
            } else {
                UIMenuOptions::empty()
            };
            let submenu = UIMenu::menuWithTitle_image_identifier_options_children(
                &NSString::from_str(label),
                image.as_deref(),
                None,
                options,
                &nested,
                mtm,
            );
            Some(Retained::into_super(submenu))
        }
    }
}

/// Menu children for a list of [`MenuItem`]s. Separators split the list into
/// consecutive inline `UIMenu` groups (UIKit draws separators between those);
/// with no separators the elements stay flat. A disabled submenu has no
/// enabled state of its own, so its children are disabled instead.
fn menu_children(
    mtm: MainThreadMarker,
    entries: &[MenuItem],
    mounter: &SharedMounter,
    enabled: bool,
) -> Retained<NSArray<UIMenuElement>> {
    let has_separator = entries.iter().any(|e| matches!(e, MenuItem::Separator));
    if !has_separator {
        let children: Vec<_> = entries
            .iter()
            .filter_map(|entry| menu_element(mtm, entry, mounter, enabled))
            .collect();
        return NSArray::from_retained_slice(&children);
    }
    let mut children: Vec<Retained<UIMenuElement>> = Vec::new();
    let mut group: Vec<Retained<UIMenuElement>> = Vec::new();
    let flush = |group: &mut Vec<Retained<UIMenuElement>>,
                 children: &mut Vec<Retained<UIMenuElement>>| {
        if group.is_empty() {
            return;
        }
        let elems = NSArray::from_retained_slice(group);
        let section = UIMenu::menuWithTitle_image_identifier_options_children(
            &NSString::from_str(""),
            None,
            None,
            UIMenuOptions::DisplayInline,
            &elems,
            mtm,
        );
        children.push(Retained::into_super(section));
        group.clear();
    };
    for entry in entries {
        match entry {
            MenuItem::Separator => flush(&mut group, &mut children),
            other => {
                if let Some(el) = menu_element(mtm, other, mounter, enabled) {
                    group.push(el);
                }
            }
        }
    }
    flush(&mut group, &mut children);
    NSArray::from_retained_slice(&children)
}

/// A bar button from its content only (no menu, target or action yet).
fn make_right_item_content(
    mtm: MainThreadMarker,
    content: &HeaderItemContent,
    fallback_title: &str,
) -> Retained<UIBarButtonItem> {
    match content {
        // SAFETY: UIKit's designated initializer with no target yet; the
        // caller sets the menu or the target and action.
        HeaderItemContent::SystemItem(system) => unsafe {
            UIBarButtonItem::initWithBarButtonSystemItem_target_action(
                UIBarButtonItem::alloc(mtm),
                system_bar_item(*system),
                None,
                None,
            )
        },
        HeaderItemContent::Symbol(name) => match system_image(name) {
            Some(image) => unsafe {
                UIBarButtonItem::initWithImage_style_target_action(
                    UIBarButtonItem::alloc(mtm),
                    Some(&image),
                    UIBarButtonItemStyle::Plain,
                    None,
                    None,
                )
            },
            None => unsafe {
                UIBarButtonItem::initWithTitle_style_target_action(
                    UIBarButtonItem::alloc(mtm),
                    Some(&NSString::from_str(fallback_title)),
                    UIBarButtonItemStyle::Plain,
                    None,
                    None,
                )
            },
        },
        HeaderItemContent::Label(title) => unsafe {
            UIBarButtonItem::initWithTitle_style_target_action(
                UIBarButtonItem::alloc(mtm),
                Some(&NSString::from_str(title)),
                UIBarButtonItemStyle::Plain,
                None,
                None,
            )
        },
        _ => unsafe {
            UIBarButtonItem::initWithTitle_style_target_action(
                UIBarButtonItem::alloc(mtm),
                Some(&NSString::from_str(fallback_title)),
                UIBarButtonItemStyle::Plain,
                None,
                None,
            )
        },
    }
}

/// Title / image, menu, label, enabled and press id on an existing trailing
/// bar button (label and symbol content only: system items are rebuilt).
fn update_right_item(
    mtm: MainThreadMarker,
    item: &HeaderItem,
    button: &UIBarButtonItem,
    target: Option<&HeaderItemTarget>,
    mounter: &SharedMounter,
) {
    // What to show is the core's (`kept_button`, tested there); this applies it.
    let kept = nsh_core::element::header::kept_button(item);
    match kept.content {
        KeptContent::Title(title) => {
            button.setTitle(Some(&NSString::from_str(title)));
            button.setImage(None);
        }
        KeptContent::Symbol { name, fallback } => match system_image(name) {
            Some(image) => {
                button.setImage(Some(&image));
                button.setTitle(None);
            }
            None => {
                button.setTitle(Some(&NSString::from_str(fallback)));
                button.setImage(None);
            }
        },
        KeptContent::Unchanged => {}
    }
    if let Some(menu) = &item.menu {
        button.setMenu(Some(&make_menu(mtm, menu, mounter)));
    } else {
        button.setMenu(None);
    }
    if let Some(target) = target {
        // The previous binding's handlers are gone; take this binding's id
        // (0 when `onPress` was removed).
        target.set_press_id(item.press_id);
    }
    button.setEnabled(kept.enabled);
    {
        use objc2_ui_kit::NSObjectUIAccessibility;
        // `None` clears a label an earlier binding set.
        let label = kept.label.map(NSString::from_str);
        button.setAccessibilityLabel(label.as_deref(), mtm);
    }
    set_item_id(button, item);
}

/// The button's accessibility identifier from the item's `key`, as a view's
/// `testID` is: what UI tests (a test's selector `id:<key>`) find it by.
fn set_item_id(button: &UIBarButtonItem, item: &HeaderItem) {
    let id = item.key.as_deref().map(NSString::from_str);
    // SAFETY: UIBarButtonItem's `UIAccessibilityIdentification` setter, an
    // optional string.
    let _: () = unsafe { msg_send![button, setAccessibilityIdentifier: id.as_deref()] };
}

/// One trailing `ios.headerRightItems` button.
fn make_right_item(
    mtm: MainThreadMarker,
    item: &HeaderItem,
    mounter: SharedMounter,
    targets: &mut Vec<Option<Retained<HeaderItemTarget>>>,
) -> Retained<UIBarButtonItem> {
    let fallback = item.label.as_deref().unwrap_or(match &item.content {
        HeaderItemContent::Label(t) => t.as_ref(),
        HeaderItemContent::Symbol(s) => s.as_ref(),
        _ => "",
    });
    let button = make_right_item_content(mtm, &item.content, fallback);
    if let Some(menu) = &item.menu {
        // With no primary action, a tap opens the menu (iOS 14+).
        button.setMenu(Some(&make_menu(mtm, menu, &mounter)));
        targets.push(None);
    } else {
        let target = HeaderItemTarget::new(mtm, item.press_id, mounter);
        // SAFETY: UIKit holds the target weakly; the caller keeps it as long
        // as the button, and `nshPress:` is its action.
        unsafe {
            button.setTarget(Some(&*target));
            button.setAction(Some(objc2::sel!(nshPress:)));
        }
        targets.push(Some(target));
    }
    button.setEnabled(!item.disabled);
    if let Some(label) = item.label.as_deref() {
        use objc2_ui_kit::NSObjectUIAccessibility;
        button.setAccessibilityLabel(Some(&NSString::from_str(label)), mtm);
    }
    set_item_id(&button, item);
    button
}

/// The accessibility label of the first labelled view in `view` (itself
/// first): what VoiceOver reads for the bar button standing in for it.
fn first_label(view: &UIView) -> Option<Retained<NSString>> {
    // SAFETY: `accessibilityLabel` is UIView's (NSObject's informal
    // protocol), returning an optional string.
    let label: Option<Retained<NSString>> = unsafe { msg_send![view, accessibilityLabel] };
    if let Some(label) = label.filter(|l| l.length() > 0) {
        return Some(label);
    }
    view.subviews().iter().find_map(|v| first_label(&v))
}

/// UIKit's bar button of `item`.
fn system_bar_item(item: HeaderSystemItem) -> UIBarButtonSystemItem {
    match item {
        HeaderSystemItem::Add => UIBarButtonSystemItem::Add,
        HeaderSystemItem::Done => UIBarButtonSystemItem::Done,
        HeaderSystemItem::Close => UIBarButtonSystemItem::Close,
        HeaderSystemItem::Edit => UIBarButtonSystemItem::Edit,
        HeaderSystemItem::Compose => UIBarButtonSystemItem::Compose,
        HeaderSystemItem::Search => UIBarButtonSystemItem::Search,
        HeaderSystemItem::Share => UIBarButtonSystemItem::Action,
        HeaderSystemItem::Trash => UIBarButtonSystemItem::Trash,
        HeaderSystemItem::Save => UIBarButtonSystemItem::Save,
        HeaderSystemItem::Cancel => UIBarButtonSystemItem::Cancel,
    }
}

impl StackDelegate {
    fn new(mtm: MainThreadMarker, stack: NodeId, mounter: SharedMounter) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(StackDelegateIvars {
            stack,
            mounter,
            editor: RefCell::new(None),
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn with_mounter(&self, f: impl FnOnce(&mut crate::mount::Mounter)) {
        // Navigation callbacks can come while a batch is applied (setting
        // the view controllers): then the mounter catches up at its end.
        if let Ok(mut m) = self.ivars().mounter.get(self.mtm()).try_borrow_mut()
            && let Some(m) = m.as_mut()
        {
            f(m);
        }
    }
}

/// A navigation stack.
pub(crate) struct StackHost {
    /// Placed by the core; hosts the navigation controller's view.
    pub(crate) container: Retained<NshView>,
    pub(crate) nav: Retained<NavController>,
    _delegate: Retained<StackDelegate>,
    /// The screens, bottom to top, as the app has them.
    pub(crate) screens: Vec<NodeId>,
    /// Screens the user popped natively, until the app removes them.
    pub(crate) popped: Vec<NodeId>,
    /// The screens last given to the navigation controller (changes wait
    /// while a transition runs).
    pub(crate) applied: std::cell::RefCell<Vec<NodeId>>,
    /// The controller is a child of the surface's controller.
    contained: bool,
    /// The `SplitView` (its native component's node) whose column this
    /// stack is: the split holds its navigation controller, and while it
    /// is collapsed its pages are in the split's compact stack.
    pub(crate) split: Option<NodeId>,
}

impl StackHost {
    pub(crate) fn new(mtm: MainThreadMarker, id: NodeId, mounter: SharedMounter) -> Self {
        let container = NshView::new(mtm);
        let nav = NavController::new(mtm, id, mounter.clone());
        let delegate = StackDelegate::new(mtm, id, mounter);
        // SAFETY: the delegate lives as long as the stack.
        unsafe { nav.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
        keep_in_window(&nav.navigationBar());
        if let Some(view) = nav.view() {
            view.setAutoresizingMask(
                UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
            );
            view.setFrame(container.bounds());
            container.addSubview(&view);
        }
        // Loading the navigation view installs UIKit's gesture delegates.
        // Apply our permission delegate afterwards, to both recognizers:
        // on iOS 26 even an edge drag can use the content recognizer, whose
        // default delegate prevents popping with a hidden navigation bar.
        for pop in back_swipes(&nav) {
            pop.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        }
        Self {
            container,
            nav,
            _delegate: delegate,
            screens: Vec::new(),
            popped: Vec::new(),
            applied: Default::default(),
            contained: false,
            split: None,
        }
    }

    /// Makes the navigation controller a child of the controller showing
    /// the stack (appearance callbacks, safe areas, rotation).
    pub(crate) fn contain(&mut self) {
        // A split's column: the split is its parent.
        if self.contained || self.split.is_some() {
            return;
        }
        let Some(parent) = controller_of(&self.container) else {
            return;
        };
        // Off screen, the controller found may not be the one that shows
        // the stack yet; a dialog's is (its views are its own), and its
        // stack joins it before the dialog is presented, which happens
        // after its first screens are given, in the same batch.
        if self.container.window().is_none()
            && !parent.isKindOfClass(<ModalController as ClassType>::class())
        {
            return;
        }
        parent.addChildViewController(&self.nav);
        self.nav.didMoveToParentViewController(Some(&parent));
        self.contained = true;
    }

    /// Gives the navigation controller to `split`, as its column.
    pub(crate) fn join_split(&mut self, split: NodeId) {
        self.split = Some(split);
        // The split adds it as its child (taking it out of any parent).
        self.contained = false;
    }

    /// Takes the navigation controller back from the split it was a
    /// column of, into the stack's own container (its screens are given
    /// back by the next reconcile, if the split had them).
    pub(crate) fn leave_split(&mut self) {
        if self.split.take().is_none() {
            return;
        }
        let nav = &self.nav;
        nav.willMoveToParentViewController(None);
        if let Some(view) = nav.view() {
            view.removeFromSuperview();
            view.setFrame(self.container.bounds());
            self.container.addSubview(&view);
        }
        nav.removeFromParentViewController();
        self.contained = false;
    }

    /// Empties the navigation controller without a transition (a collapsing
    /// split takes the screens into its compact stack, an expanding one
    /// gives them back to the columns): what it was given is forgotten, so
    /// nothing reads as popped.
    pub(crate) fn detach_screens(&self) {
        self.applied.borrow_mut().clear();
        if self.nav.viewControllers().count() == 0 {
            return;
        }
        let none: Retained<NSArray<UIViewController>> = NSArray::new();
        self.nav.ivars().applying.set(true);
        self.nav.setViewControllers_animated(&none, false);
        self.nav.ivars().applying.set(false);
    }

    /// Shows the app's screens: pushes, pops or replaces as needed.
    /// `leaving` is the transition of the screen on top until now.
    /// `shaders` are the `transitionShader`s of the screen that comes and of
    /// the one on top until now: through one, the screens change at once,
    /// after `before` was given the navigation controller's view, the
    /// shader and whether it pops, and answered whether it draws it (where
    /// it cannot, the screens change with their own motion).
    pub(crate) fn reconcile(
        &self,
        screens: &[(NodeId, Retained<ScreenController>, ScreenAnimation)],
        leaving: Option<ScreenAnimation>,
        shaders: (Option<&NavShader>, Option<&NavShader>),
        before: impl FnOnce(&UIView, &NavShader, bool) -> bool,
    ) {
        let desired: Vec<Retained<UIViewController>> = screens
            .iter()
            .map(|(_, c, _)| Retained::into_super(c.clone()))
            .collect();
        let current = self.nav.viewControllers();
        let same = current.count() == desired.len()
            && desired
                .iter()
                .zip(current.iter())
                .all(|(a, b)| std::ptr::eq::<UIViewController>(&**a, &*b));
        if same {
            return;
        }
        let top_changed = match (current.lastObject(), desired.last()) {
            (Some(a), Some(b)) => !std::ptr::eq::<UIViewController>(&*a, &**b),
            _ => true,
        };
        // The animation of the screen that appears (push) or leaves (pop).
        let pushing = desired.len() >= current.count();
        let animation = if pushing {
            screens.last().map(|s| s.2)
        } else {
            leaving
        }
        .unwrap_or_default();
        let shader = if pushing { shaders.0 } else { shaders.1 }
            .filter(|_| top_changed && current.count() > 0);
        let through = match (shader, self.nav.view()) {
            (Some(shader), Some(view)) => before(&view, shader, !pushing),
            _ => false,
        };
        let animated =
            !through && top_changed && current.count() > 0 && animation == ScreenAnimation::Default;
        if !through && top_changed && current.count() > 0 && animation == ScreenAnimation::Fade {
            let fade = CATransition::new();
            fade.setDuration(0.25);
            if let Some(view) = self.nav.view() {
                view.layer().addAnimation_forKey(&fade, None);
            }
        }
        // The page on top leaves (a pop, a replace): its keyboard hides with
        // the transition.
        if top_changed
            && let Some(top) = current.lastObject()
            && !desired
                .iter()
                .any(|c| std::ptr::eq::<UIViewController>(&**c, &*top))
            && let Some(view) = top.view()
        {
            view.endEditing(true);
        }
        let array = NSArray::from_retained_slice(&desired);
        *self.applied.borrow_mut() = screens.iter().map(|(id, _, _)| *id).collect();
        self.nav.ivars().applying.set(true);
        self.nav.setViewControllers_animated(&array, animated);
        self.nav.ivars().applying.set(false);

        // A stack whose size is settled is never laid out again for the
        // screens it is given, so nothing would size a screen UIKit left
        // empty until something unrelated (a rotation, a change of
        // appearance) forces a layout pass.
        size_screens(&self.nav);
        defer_to_back_swipe(&self.nav);
    }

    /// Puts the bar where this stack says it goes, if it is the stack on
    /// screen and no transition is running: a page can turn
    /// `hidesBottomBarWhenPushed` on while it is already shown, and nothing was
    /// pushed or popped for `reconcile` to follow.
    pub(crate) fn sync_bottom_bar(&self) {
        let Some(view) = self.nav.view() else {
            return;
        };
        if view.window().is_none() || view.isHidden() || self.nav.transitionCoordinator().is_some()
        {
            return;
        }
        slide_bottom_bar(&self.nav, bottom_bar_hidden(&self.nav));
    }
}

/// A retained tab can be hidden at any enclosing container.
fn ancestors_visible(view: &UIView) -> bool {
    if view.isHidden() {
        return false;
    }
    let mut ancestor = view.superview();
    while let Some(view) = ancestor {
        if view.isHidden() {
            return false;
        }
        ancestor = view.superview();
    }
    true
}

/// Whether the bar belongs off screen: UIKit's own rule for
/// `hidesBottomBarWhenPushed` — the bar stays hidden while **any** screen of
/// the stack asks for it, until that screen is popped (Apple: "the bottom bar
/// remains hidden until the view controller is popped from the stack").
pub(crate) fn bottom_bar_hidden(nav: &UINavigationController) -> bool {
    match crate::split::bar_role(nav) {
        // An expanded split's columns show side by side: a page of any of
        // them keeps the bar off screen, as a page of one stack does.
        crate::split::BarRole::Shown { shown, .. } => shown.iter().any(|nav| hides_bar(nav)),
        _ => hides_bar(nav),
    }
}

/// Whether a screen of `nav` asks for the bar off screen.
fn hides_bar(nav: &UINavigationController) -> bool {
    let controllers = nav.viewControllers();
    controllers.iter().any(|controller| {
        // SAFETY: asking UIKit for the property it defines for every screen.
        let hides: bool = unsafe { msg_send![&*controller, hidesBottomBarWhenPushed] };
        hides
    })
}

/// Slides the app's system tab bars out (`hiding`) or back in, in the
/// running transition's animation: same duration, same curve, one step with
/// the page. Nothing is unmounted, so the bar is never rebuilt.
///
/// Called from `navigationController:willShowViewController:animated:` — the
/// hook UIKit runs for both pushes and pops, before the transition starts —
/// which is where a `UITabBarController` moves its own bar from — and from
/// `sync_bottom_bar` for a stack that did not move. The app owns its
/// independent `hidden` prop throughout both paths.
pub(crate) fn slide_bottom_bar(nav: &UINavigationController, hiding: bool) {
    let Some(view) = nav.view() else {
        return;
    };
    // NSH hides the stack's container (or a retained tab's ancestor), not
    // UINavigationController's own view. Apply this guard to transitions as
    // well as option syncs, so background stacks never control the shared bar.
    if view.window().is_none() || !ancestors_visible(&view) {
        return;
    }
    let parent = match crate::split::bar_role(nav) {
        crate::split::BarRole::Stack => match view.superview() {
            Some(parent) => parent,
            None => return,
        },
        // A split's navigation controller is in the split's own views: the
        // bar is looked for from where the split is, as from a stack there.
        crate::split::BarRole::Shown { place, .. } => place,
        // Its pages show in another of the split's, which moves the bar.
        crate::split::BarRole::Idle => return,
    };
    // The bar is a component's view, nested in the container the component
    // system puts it in: look through the siblings' subtrees for it.
    fn collect_tab_bars(view: &UIView, depth: usize, out: &mut Vec<Retained<UIView>>) {
        if depth == 0 || view.isHidden() {
            return;
        }
        for sub in view.subviews().iter() {
            if sub.isHidden() {
                continue;
            }
            // SAFETY: asking UIKit for the class of a subview.
            let is_bar: bool =
                unsafe { msg_send![&*sub, isKindOfClass: objc2_ui_kit::UITabBar::class()] };
            if is_bar {
                out.push(sub.clone());
            } else {
                collect_tab_bars(&sub, depth - 1, out);
            }
        }
    }
    // The bar is not a direct sibling of the nav view: both sit in the
    // component containers of the app's root view, so walk up until an
    // ancestor holds one.
    let mut bars: Vec<Retained<UIView>> = Vec::new();
    let mut ancestor = Some(parent.clone());
    for _ in 0..6 {
        let Some(view) = ancestor else { break };
        collect_tab_bars(&view, 4, &mut bars);
        if !bars.is_empty() {
            break;
        }
        ancestor = view.superview();
    }
    if bars.is_empty() {
        return;
    }
    // The bar moves itself (`nshSetBottomHidden:`): its own layout sets the
    // frame on every pass, so a transform set from here would be undone by
    // the next one whenever a screen below it changes size.
    let bars = Rc::new(bars);
    let apply = Rc::new(move || {
        // A retained tab may have been hidden since the coordinator queued us.
        if view.window().is_none() || !ancestors_visible(&view) {
            return;
        }
        for bar in bars.iter() {
            // SAFETY: asking a view whether it is ours before messaging it.
            let ours: bool =
                unsafe { msg_send![&**bar, respondsToSelector: sel!(nshSetBottomHidden:)] };
            if ours {
                let _: () = unsafe { msg_send![&**bar, nshSetBottomHidden: hiding] };
            }
        }
    });
    let apply = apply.clone();
    match nav.transitionCoordinator() {
        Some(coordinator) => {
            let block = RcBlock::new(
                move |_context: NonNull<
                    ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
                >| {
                    apply();
                },
            );
            coordinator.animateAlongsideTransition_completion(Some(&block), None);
        }
        // Not in a transition (the first screen, a change with nothing to
        // animate): place it at once.
        None => apply(),
    }
}

/// One screen.
pub(crate) struct ScreenHost {
    pub(crate) controller: Retained<ScreenController>,
    /// The UIKit bar buttons standing in for `headerLeft` and `headerRight`
    /// (`ios={{ headerLeftSystemItem }}`, `ios={{ headerRightSymbol }}`,
    /// ...), made once per look and kept while it stays, with their targets
    /// (UIKit keeps a bar button's target weakly).
    left_system: RefCell<Option<SystemBarItem>>,
    right_system: RefCell<Option<SystemBarItem>>,
    /// Trailing `ios.headerRightItems`: rebuilt when the description
    /// changes (a menu item's `checked` or `title` included).
    right_items: RefCell<Option<RightItemsBar>>,
    /// The screen's root view, placed by the core.
    pub(crate) view: Retained<NshView>,
    pub(crate) config: ScreenConfig,
}

impl ScreenHost {
    pub(crate) fn new(mtm: MainThreadMarker, id: NodeId, control: EngineControl) -> Self {
        let controller = ScreenController::new(mtm, id, control);
        let view = NshView::new(mtm);
        if let Some(root) = controller.view() {
            root.setBackgroundColor(Some(&UIColor::systemBackgroundColor()));
            root.addSubview(&view);
        }
        Self {
            controller,
            view,
            config: ScreenConfig::default(),
            left_system: RefCell::new(None),
            right_system: RefCell::new(None),
            right_items: RefCell::new(None),
        }
    }

    /// Applies the header options; `item` returns the view of a header item.
    /// The bar is UIKit's: a `header` slot (`header_view`, the whole bar
    /// where NSH draws it) is never placed, so it stays out of sight.
    pub(crate) fn apply_header(
        &self,
        item: impl Fn(NodeId) -> Option<Retained<UIView>>,
        press: Option<SharedMounter>,
    ) {
        let mtm = self.controller.mtm();
        let c = &self.config;
        let nav_item = self.controller.navigationItem();
        nav_item.setTitle(c.title.as_deref().map(NSString::from_str).as_deref());
        let title_view = c.title_view.and_then(&item);
        nav_item.setTitleView(title_view.as_deref());
        let custom = |id: Option<NodeId>| {
            id.and_then(&item)
                .map(|v| UIBarButtonItem::initWithCustomView(UIBarButtonItem::alloc(mtm), &v))
        };
        // UIKit's own button in place of the app's view, pressing that view
        // (none without one). The same look keeps its button: rebuilding it
        // on every header change would flash it.
        let system = |leading: bool,
                      kept: &RefCell<Option<SystemBarItem>>,
                      slot: Option<NodeId>,
                      kind: Option<BarButton>| {
            let (Some(kind), Some(slot), Some(mounter)) = (kind, slot, press.clone()) else {
                kept.borrow_mut().take();
                return None;
            };
            let mut kept = kept.borrow_mut();
            if kept.as_ref().is_none_or(|(k, ..)| *k != kind) {
                let target = BarItemTarget::new(mtm, self.controller.screen_id(), leading, mounter);
                *kept = make_bar_button(mtm, &kind, &target).map(|b| (kind, b, target));
            }
            let (_, button, _) = kept.as_ref()?;
            // VoiceOver reads the app's label of the view it stands in for.
            let label = item(slot).and_then(|v| first_label(&v));
            {
                use objc2_ui_kit::NSObjectUIAccessibility;
                button.setAccessibilityLabel(label.as_deref(), mtm);
            }
            Some(button.clone())
        };
        let look = |item: Option<HeaderSystemItem>, symbol: &Option<Arc<str>>| {
            item.map(BarButton::System)
                .or_else(|| symbol.clone().map(BarButton::Symbol))
        };
        let left = system(
            true,
            &self.left_system,
            c.left,
            look(c.left_system_item, &c.left_symbol),
        )
        .or_else(|| custom(c.left));
        nav_item.setLeftBarButtonItem(left.as_deref());
        nav_item.setLeftItemsSupplementBackButton(true);
        // `headerRightItems` (non-empty) wins over the single system /
        // symbol button and leaves `headerRight`'s view out of the bar.
        if !c.right_items.is_empty() {
            self.right_system.borrow_mut().take();
            let mut kept = self.right_items.borrow_mut();
            // Rebuild only when the buttons themselves change; a menu's
            // `checked` state would otherwise flash the bar on every choice.
            let rebuild = kept
                .as_ref()
                .is_none_or(|(items, ..)| !same_right_buttons(items, &c.right_items));
            if rebuild {
                if let Some(mounter) = press.clone() {
                    let mut targets = Vec::new();
                    let buttons: Vec<_> = c
                        .right_items
                        .iter()
                        .map(|item| make_right_item(mtm, item, mounter.clone(), &mut targets))
                        .collect();
                    *kept = Some((c.right_items.clone(), buttons, targets));
                } else {
                    *kept = None;
                }
            } else if let Some((cached, buttons, targets)) = kept.as_mut()
                && cached != &c.right_items
            {
                if let Some(mounter) = press.clone() {
                    for (item, (button, target)) in
                        c.right_items.iter().zip(buttons.iter().zip(targets.iter()))
                    {
                        update_right_item(mtm, item, button, target.as_deref(), &mounter);
                    }
                }
                *cached = c.right_items.clone();
            }
            let array = kept
                .as_ref()
                .map(|(_, buttons, _)| NSArray::from_retained_slice(buttons));
            nav_item.setRightBarButtonItems(array.as_deref());
        } else {
            self.right_items.borrow_mut().take();
            let right = system(
                false,
                &self.right_system,
                c.right,
                look(c.right_system_item, &c.right_symbol),
            )
            .or_else(|| custom(c.right));
            // The whole list, not `setRightBarButtonItem:`: given nil, that
            // clears only the first of the `headerRightItems` a page made
            // again (a region's page, the same screen) had, and the others
            // stay with their menus.
            let right: Vec<Retained<UIBarButtonItem>> = right.into_iter().collect();
            nav_item.setRightBarButtonItems(Some(&NSArray::from_retained_slice(&right)));
        }
        nav_item.setHidesBackButton(!c.back_visible);
        nav_item.setBackButtonTitle(c.back_title.as_deref().map(NSString::from_str).as_deref());
        nav_item.setLargeTitleDisplayMode(if c.large_title {
            UINavigationItemLargeTitleDisplayMode::Always
        } else {
            UINavigationItemLargeTitleDisplayMode::Never
        });
        let appearances = header_appearances(mtm, c);
        let (standard, scroll_edge) = match &appearances {
            Some((standard, scroll_edge)) => (Some(&**standard), Some(&**scroll_edge)),
            None => (None, None),
        };
        nav_item.setStandardAppearance(standard);
        nav_item.setScrollEdgeAppearance(scroll_edge);
        nav_item.setCompactAppearance(standard);
        // The bar of the screen on top, too (Catalyst does not always take
        // the item's appearance).
        if let Some(nav) = self.controller.navigationController()
            && nav
                .topViewController()
                .is_some_and(|top| std::ptr::eq::<UIViewController>(&*top, &**self.controller))
        {
            style_bar(&nav.navigationBar(), c);
        }
        let padded = if c.header_transparent || c.large_title {
            0.0
        } else {
            c.header_height.0
        };
        let ivars = self.controller.ivars();
        ivars.padded.set(padded);
        ivars
            .measure
            .set(c.header_visible && !c.header_transparent && !c.large_title);
        ivars
            .follow_scroll
            .set(c.header_transparent && c.header_background_on_scroll);
        ivars.header_hidden.set(!c.header_visible);
        // After `measure`: the safe area the bar changes reports the header.
        self.controller.follow_header();
        self.controller.report_insets();
        self.controller.follow_content_scroll();
    }
}

/// Keeps `bar` in the window with the iPad style: in Mac Catalyst's Mac
/// idiom UIKit otherwise moves a navigation bar's contents into the window's
/// toolbar (the back button next to the traffic lights), where the title,
/// the header's colors and the core's layout do not apply.
impl ScreenHost {
    /// UIKit's own `hidesBottomBarWhenPushed`, so
    /// `navigationController:willShowViewController:` reads the page's choice
    /// the way it would inside a `UITabBarController`. Set as soon as the
    /// screen's options arrive — before the push that shows it.
    pub(crate) fn set_hides_bottom_bar(&self, hides: bool) {
        // SAFETY: UIKit's property on the controller this screen wraps.
        let _: () = unsafe { msg_send![&*self.controller, setHidesBottomBarWhenPushed: hides] };
    }
}

pub(crate) fn keep_in_window(bar: &UINavigationBar) {
    // `preferredBehavioralStyle` is iOS 16+ (nsh supports iOS 15, where
    // bars always stay in the window).
    if bar.respondsToSelector(objc2::sel!(setPreferredBehavioralStyle:)) {
        bar.setPreferredBehavioralStyle(UIBehavioralStyle::Pad);
    }
}

/// The header's appearances from the screen's options (`None`: UIKit's):
/// the standard one (also the compact one), and the one while the content
/// rests at its top (the scroll edge), clear for a transparent header that
/// shows its background only on scroll.
fn header_appearances(
    mtm: MainThreadMarker,
    c: &ScreenConfig,
) -> Option<(
    Retained<UINavigationBarAppearance>,
    Retained<UINavigationBarAppearance>,
)> {
    if c.background_color.is_none()
        && c.title_color.is_none()
        && !c.header_transparent
        && c.header_shadow_visible
    {
        return None;
    }
    let on_scroll = c.header_transparent && c.header_background_on_scroll;
    let standard = header_appearance(mtm, c, c.header_transparent && !on_scroll);
    let scroll_edge = if on_scroll {
        header_appearance(mtm, c, true)
    } else {
        standard.clone()
    };
    Some((standard, scroll_edge))
}

/// One appearance of the header: `transparent`, or its background color,
/// else UIKit's default background.
fn header_appearance(
    mtm: MainThreadMarker,
    c: &ScreenConfig,
    transparent: bool,
) -> Retained<UINavigationBarAppearance> {
    let appearance = UINavigationBarAppearance::new(mtm);
    if transparent {
        appearance.configureWithTransparentBackground();
    } else if let Some(bg) = c.background_color {
        appearance.configureWithOpaqueBackground();
        appearance.setBackgroundColor(Some(&ui_color(bg)));
    } else {
        appearance.configureWithDefaultBackground();
    }
    if !c.header_shadow_visible {
        // The configured backgrounds come with UIKit's hairline (the shadow
        // image is nil after `configureWith…`): no color, no line.
        appearance.setShadowColor(None);
    }
    if let Some(color) = c.title_color {
        let attributes = objc2_foundation::NSDictionary::from_retained_objects(
            // SAFETY: an immutable UIKit constant.
            &[unsafe { NSForegroundColorAttributeName }],
            &[Retained::into_super(Retained::into_super(ui_color(color)))],
        );
        // SAFETY: a valid title attributes dictionary.
        unsafe {
            appearance.setTitleTextAttributes(&attributes);
            appearance.setLargeTitleTextAttributes(&attributes);
        }
    }
    appearance
}

/// Styles a stack's navigation bar for the screen it shows: the screen's
/// navigation item carries the same appearance, but Mac Catalyst does not
/// always apply it, so the bar gets it as well.
pub(crate) fn style_bar(bar: &UINavigationBar, c: &ScreenConfig) {
    let mtm = bar.mtm();
    bar.setPrefersLargeTitles(c.large_title);
    let tint = c.tint_color.map(ui_color);
    // SAFETY: a plain setter; `None` restores the default tint.
    unsafe { bar.setTintColor(tint.as_deref()) };
    match header_appearances(mtm, c) {
        Some((standard, scroll_edge)) => {
            bar.setStandardAppearance(&standard);
            bar.setScrollEdgeAppearance(Some(&scroll_edge));
            bar.setCompactAppearance(Some(&standard));
        }
        None => {
            let appearance = UINavigationBarAppearance::new(mtm);
            bar.setStandardAppearance(&appearance);
            bar.setScrollEdgeAppearance(None);
            bar.setCompactAppearance(None);
        }
    }
}

/// One modal.
pub(crate) struct ModalHost {
    pub(crate) controller: Retained<ModalController>,
    /// The modal's root view, placed by the core.
    pub(crate) view: Retained<NshView>,
    pub(crate) config: ModalConfig,
    pub(crate) presented: bool,
    /// Taken along by the dismissal of a modal under it while the app
    /// still showed it: presented again once that one is gone, or, hidden
    /// meanwhile, reported closed then.
    taken: bool,
}

impl ModalHost {
    pub(crate) fn new(mtm: MainThreadMarker, id: NodeId, control: EngineControl) -> Self {
        let controller = ModalController::new(mtm, id, control);
        let view = NshView::new(mtm);
        if let Some(root) = controller.view() {
            root.addSubview(&view);
        }
        Self {
            controller,
            view,
            config: ModalConfig::default(),
            presented: false,
            taken: false,
        }
    }

    /// Whether presenting it (`shown`) or dismissing it changes what shows.
    pub(crate) fn changes(&self, shown: bool) -> bool {
        let closed = self.controller.ivars().closed.get();
        if shown {
            !self.presented || closed
        } else {
            self.presented && !closed
        }
    }

    /// The modals presented over this one, the lowest first: they go when
    /// it is dismissed (through its presenter, which dismisses everything
    /// above).
    pub(crate) fn modals_above(&self) -> Vec<NodeId> {
        let mut above = Vec::new();
        let mut next = self.controller.presentedViewController();
        while let Some(c) = next {
            if let Some(modal) = c.downcast_ref::<ModalController>() {
                above.push(modal.ivars().id);
            }
            next = c.presentedViewController();
        }
        above
    }

    /// How many controllers present this one, down to the window's (0
    /// when it is not presented): a lower modal is dismissed first, and
    /// takes the ones above it.
    pub(crate) fn depth(&self) -> usize {
        let mut depth = 0;
        let mut next = self.controller.presentingViewController();
        while let Some(c) = next {
            depth += 1;
            next = c.presentingViewController();
        }
        depth
    }

    /// Dismissed with a modal under it, which takes it along: no longer
    /// presented, and not reported as closed by the user when it goes.
    /// Whether it was showing (one the user closed is already leaving, and
    /// reported).
    pub(crate) fn dismissed_under(&mut self) -> bool {
        if !self.presented || self.controller.ivars().closed.get() {
            return false;
        }
        self.presented = false;
        self.taken = true;
        self.controller.ivars().dismissing.set(true);
        if let Some(view) = self.controller.view() {
            view.endEditing(true);
        }
        true
    }

    /// Hidden by the app after a dismissal under it took it along
    /// ([`ModalHost::dismissed_under`]): `Some(true)` when it is gone
    /// already, `Some(false)` while that dismissal runs; `None` when it was
    /// not taken.
    pub(crate) fn hidden_after_taken(&mut self) -> Option<bool> {
        if !std::mem::take(&mut self.taken) {
            return None;
        }
        Some(self.gone())
    }

    /// Out of the presentation (dismissed, or never presented).
    pub(crate) fn gone(&self) -> bool {
        self.controller.presentingViewController().is_none()
    }

    /// Presents the modal over the controller showing `from` (at once
    /// when `at_once`: a shader draws its coming). The caller checks
    /// [`transition_over`] first. A modal taken along by a dismissal under
    /// it comes again as it came the first time: `Show` is reported again
    /// and a sheet opens at its first detent.
    pub(crate) fn present(&mut self, from: &UIView, at_once: bool) {
        if self.presented && !self.controller.ivars().closed.get() {
            return;
        }
        self.taken = false;
        self.controller.ivars().closed.set(false);
        self.controller.ivars().dismissing.set(false);
        let Some(mut presenter) = controller_of(from) else {
            return log::warn!("cannot present a modal: no view controller shows the app");
        };
        while let Some(next) = presenter.presentedViewController() {
            presenter = next;
        }
        let c = &self.config;
        let controller = &self.controller;
        controller
            .ivars()
            .orientations
            .set(crate::system::orientation_mask(c.orientations));
        controller.set_flags(c);
        // Full screen, the modal has no look of its own: the app's popup
        // and backdrop show over what is behind. Sheets are the system's.
        let sheet = c.presentation != ModalPresentation::FullScreen;
        controller.setModalPresentationStyle(match c.presentation {
            ModalPresentation::FullScreen => UIModalPresentationStyle::OverFullScreen,
            ModalPresentation::PageSheet => UIModalPresentationStyle::PageSheet,
            ModalPresentation::FormSheet => UIModalPresentationStyle::FormSheet,
        });
        // Catalyst's Mac idiom shows sheets as macOS sheets at a default
        // size that may not fit the window: fit them to it.
        if sheet
            && objc2_ui_kit::UIDevice::currentDevice(from.mtm()).userInterfaceIdiom()
                == objc2_ui_kit::UIUserInterfaceIdiom::Mac
            && let Some(window) = from.window()
        {
            let size = window.bounds().size;
            controller.setPreferredContentSize(objc2_core_foundation::CGSize::new(
                size.width,
                (size.height - 60.0).max(0.0),
            ));
        }
        controller.setModalTransitionStyle(match c.animation {
            ModalAnimation::Fade => UIModalTransitionStyle::CrossDissolve,
            _ => UIModalTransitionStyle::CoverVertical,
        });
        if let Some(view) = controller.view() {
            let color = if sheet {
                UIColor::systemBackgroundColor()
            } else {
                UIColor::clearColor()
            };
            view.setBackgroundColor(Some(&color));
        }
        if let Some(p) = controller.presentationController() {
            // SAFETY: the controller is its own delegate and outlives the
            // presentation.
            unsafe { p.setDelegate(Some(ProtocolObject::from_ref(&**controller))) };
        }
        // Its detents and grabber, set before it is presented, as UIKit
        // asks.
        if let Some(window) = from.window() {
            controller.ivars().screen.set(window.bounds().size.height);
        }
        controller.apply_sheet(c, None);
        // Presented outside the surface: the app's appearance is set on
        // it too.
        controller.setOverrideUserInterfaceStyle(crate::system::appearance());
        // Its container (a sheet's glass) is styled again once shown: UIKit
        // makes the views of the presentation as it runs.
        let shown = controller.clone();
        let done = RcBlock::new(move || {
            crate::system::style_presented(&shown, crate::system::appearance());
        });
        presenter.presentViewController_animated_completion(
            controller,
            c.animation != ModalAnimation::None && !at_once,
            Some(&done),
        );
        crate::system::style_presented(controller, crate::system::appearance());
        self.presented = true;
    }

    /// Applies `config` (the close flags and the sheet's detents also
    /// while presented).
    pub(crate) fn configure(&mut self, config: ModalConfig) {
        self.controller.set_flags(&config);
        if self.presented && !self.controller.ivars().closed.get() {
            self.controller.apply_sheet(&config, Some(&self.config));
        }
        self.config = config;
    }

    /// Dismisses the modal (at once when `at_once`: a shader draws its
    /// going), once no transition runs where it is; `done` runs when it is
    /// gone.
    pub(crate) fn dismiss(&mut self, at_once: bool, done: impl Fn() + 'static) {
        if !self.presented {
            return;
        }
        self.presented = false;
        // Closed by the user already (and reported).
        if self.controller.ivars().closed.replace(false) {
            return;
        }
        self.controller.ivars().dismissing.set(true);
        // Its keyboard hides with it.
        if let Some(view) = self.controller.view() {
            view.endEditing(true);
        }
        let block = block2::RcBlock::new(done);
        let animated = self.config.animation != ModalAnimation::None && !at_once;
        // Through the presenter: a modal that presents another one (a sheet
        // over it) would otherwise only dismiss that one, and stay on
        // screen with its content already gone (closing a sheet and its
        // modal together). The presenter dismisses this modal and every
        // controller above it.
        dismiss_settled(self.controller.clone(), animated, block, false);
    }
}

/// The controller in a transition (being presented or dismissed) where
/// `controller` is: its presenter, itself or one above it. UIKit refuses a
/// dismissal through the presenter while one runs ("while a presentation
/// or dismiss is in progress") and never calls its completion.
fn transition_at(controller: &UIViewController) -> Option<Retained<UIViewController>> {
    let moving = |c: &UIViewController| {
        (c.isBeingPresented() || c.isBeingDismissed()) && c.transitionCoordinator().is_some()
    };
    if let Some(presenter) = controller.presentingViewController()
        && moving(&presenter)
    {
        return Some(presenter);
    }
    let mut next = Some(controller.retain());
    while let Some(c) = next {
        if moving(&c) {
            return Some(c);
        }
        next = c.presentedViewController();
    }
    None
}

/// Dismisses `controller` through its presenter, once no transition runs
/// where it is ([`transition_at`]; meanwhile it is `deferred`); `waited`
/// after such a wait, when it may have left meanwhile (with a dismissal
/// under it, or by the user's swipe): then only `done` runs.
fn dismiss_settled(
    controller: Retained<ModalController>,
    animated: bool,
    done: RcBlock<dyn Fn()>,
    waited: bool,
) {
    if let Some(moving) = transition_at(&controller)
        && let Some(coordinator) = moving.transitionCoordinator()
    {
        let pending = Cell::new(Some((controller.clone(), done.clone())));
        let wait = RcBlock::new(
            move |_: NonNull<ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>>| {
                let Some((controller, done)) = pending.take() else {
                    return;
                };
                let mtm = controller.mtm();
                let bound = MainThreadBound::new((controller, done), mtm);
                // The main queue's next turn: the transition is over by
                // then.
                DispatchQueue::main().exec_async(move || {
                    let mtm = MainThreadMarker::new().expect("the main queue");
                    let (controller, done) = bound.into_inner(mtm);
                    controller.ivars().deferred.set(false);
                    dismiss_settled(controller, animated, done, true);
                });
            },
        );
        // Refused when the transition is already ending.
        if coordinator.animateAlongsideTransition_completion(None, Some(&wait)) {
            controller.ivars().deferred.set(true);
            return;
        }
    }
    match controller.presentingViewController() {
        Some(presenter) => {
            presenter.dismissViewControllerAnimated_completion(animated, Some(&done))
        }
        None if waited => done.call(()),
        None => controller.dismissViewControllerAnimated_completion(animated, Some(&done)),
    }
}

/// The navigation bars showing in `view`'s subtree, in drawing order (the
/// front one last).
#[cfg(feature = "dev")]
fn bars(view: &UIView, out: &mut Vec<Retained<UIView>>) {
    if view.isHidden() || view.alpha() < 0.01 {
        return;
    }
    if view.isKindOfClass(<UINavigationBar as objc2::ClassType>::class()) {
        out.push(objc2::Message::retain(view));
    }
    for sub in view.subviews().iter() {
        bars(&sub, out);
    }
}

/// Whether `view`'s class name has `part` in it (UIKit's private views are
/// found by what they are).
#[cfg(feature = "dev")]
pub(crate) fn class_named(view: &UIView, part: &str) -> bool {
    view.class().name().to_string_lossy().contains(part)
}

/// The back button a user taps in the front header shown in `root` (a
/// window, a sheet's view): the navigation bar's (UIKit draws it, so it is
/// found by what it is).
#[cfg(feature = "dev")]
pub(crate) fn back_button(root: &UIView) -> Option<Retained<UIView>> {
    // A showing bar button that carries the back chevron's mask (the bar
    // keeps a page's it left, hidden, for a while).
    fn back(view: &UIView) -> Option<Retained<UIView>> {
        if view.isHidden() || view.alpha() < 0.01 {
            return None;
        }
        let subviews = view.subviews();
        if class_named(view, "ButtonBarButton")
            && subviews.iter().any(|v| class_named(&v, "BackButton"))
        {
            return Some(objc2::Message::retain(view));
        }
        subviews.iter().find_map(|v| back(&v))
    }
    let mut found = Vec::new();
    bars(root, &mut found);
    // The front one: the last drawn.
    found.iter().rev().find_map(|bar| back(bar))
}

/// What names a bar button to a test: its identifier (the item's `key`) or
/// its accessibility label.
#[cfg(feature = "dev")]
pub(crate) enum BarName<'a> {
    Id(&'a str),
    Label(&'a str),
}

/// The button a user taps for the bar button `name` names in the front
/// header that has one over `window` (UIKit draws it for the item, which
/// carries the name).
#[cfg(feature = "dev")]
pub(crate) fn bar_button(
    window: &objc2_ui_kit::UIWindow,
    name: &BarName<'_>,
) -> Option<Retained<UIView>> {
    fn text(object: &AnyObject, getter: objc2::runtime::Sel) -> Option<String> {
        // SAFETY: an optional-string getter (`accessibilityIdentifier`,
        // `accessibilityLabel`) the object answers, checked first.
        unsafe {
            let answers: bool = msg_send![object, respondsToSelector: getter];
            if !answers {
                return None;
            }
            let text: Option<Retained<NSString>> =
                objc2::msg_send![object, performSelector: getter];
            text.map(|t| t.to_string())
        }
    }
    fn named(object: &AnyObject, name: &BarName<'_>) -> bool {
        match name {
            BarName::Id(id) => {
                text(object, objc2::sel!(accessibilityIdentifier)).as_deref() == Some(*id)
            }
            BarName::Label(label) => {
                text(object, objc2::sel!(accessibilityLabel)).is_some_and(|l| l.trim() == *label)
                    || text(object, objc2::sel!(title)).is_some_and(|l| l.trim() == *label)
            }
        }
    }
    // A showing view in the bar that carries the name itself.
    fn view_named(view: &UIView, name: &BarName<'_>) -> Option<Retained<UIView>> {
        if view.isHidden() || view.alpha() < 0.01 {
            return None;
        }
        if class_named(view, "ButtonBarButton") && named(view, name) {
            return Some(objc2::Message::retain(view));
        }
        view.subviews().iter().find_map(|v| view_named(&v, name))
    }
    let mut found = Vec::new();
    bars(window, &mut found);
    found.iter().rev().find_map(|bar| {
        let bar = bar.downcast_ref::<UINavigationBar>()?;
        let item = bar.topItem()?;
        let items = [item.rightBarButtonItems(), item.leftBarButtonItems()];
        let item = items
            .iter()
            .flatten()
            .flat_map(|items| items.to_vec())
            .find(|item| named(item, name));
        match item {
            // The view UIKit made for the item (`view`, private), else
            // the bar's button that took the item's name.
            Some(item) => {
                // SAFETY: the item's `view` getter (private), returning an
                // optional view; an item without one is asked first.
                let view: Option<Retained<UIView>> = unsafe {
                    let answers: bool = msg_send![&*item, respondsToSelector: objc2::sel!(view)];
                    if answers {
                        msg_send![&*item, view]
                    } else {
                        None
                    }
                };
                view.filter(|v| v.window().is_some() && !v.isHidden())
                    .or_else(|| view_named(bar, name))
            }
            None => view_named(bar, name),
        }
    })
}

/// Whether a navigation controller in `window`'s app (its presented
/// controllers' included) is in a transition: a push or pop UIKit is still
/// animating, which takes no gesture for a sheet until it ends.
#[cfg(feature = "dev")]
pub(crate) fn navigation_transitioning(window: &objc2_ui_kit::UIWindow) -> bool {
    fn walk(c: &UIViewController) -> bool {
        if c.isKindOfClass(<UINavigationController as objc2::ClassType>::class())
            && c.transitionCoordinator().is_some()
        {
            return true;
        }
        c.childViewControllers().iter().any(|c| walk(&c))
            || c.presentedViewController().is_some_and(|p| walk(&p))
    }
    window.rootViewController().is_some_and(|root| walk(&root))
}

/// The sheet presented over `window`'s app (a modal), whose swipe down
/// goes back; `None` without one (alerts are dialogs, not sheets).
#[cfg(feature = "dev")]
pub(crate) fn presented_sheet(window: &objc2_ui_kit::UIWindow) -> Option<Retained<UIView>> {
    let mut top = window.rootViewController()?;
    let mut sheet = None;
    while let Some(next) = top.presentedViewController() {
        if next.isKindOfClass(<objc2_ui_kit::UIAlertController as objc2::ClassType>::class()) {
            break;
        }
        sheet = next.view();
        top = next;
    }
    sheet
}

/// The controller a modal presented now over the one showing `from` waits
/// for: the lowest of those presented over it that is in a transition
/// (coming, or leaving: NSH's dismissal, a swipe, Escape), that NSH just
/// dismissed (`dismissed`, the modals dismissed in this pass, whose
/// transition may not have started yet), or whose dismissal waits for a
/// transition to end ([`dismiss_settled`], from an earlier pass): for that
/// one, the transition it waits for, or itself once that has ended and its
/// dismissal is about to run. Presented over a leaving one, the modal
/// would go with it (UIKit dismisses everything above the controller it
/// dismisses); over a moving one UIKit refuses it. A dismissal UIKit
/// refused leaves its modal in place, with no transition: no longer
/// awaited after its pass.
pub(crate) fn transition_over(
    from: &UIView,
    dismissed: &[NodeId],
) -> Option<Retained<UIViewController>> {
    let mut next = controller_of(from)?.presentedViewController();
    while let Some(c) = next {
        let modal = c.downcast_ref::<ModalController>().map(|m| m.ivars());
        let just = modal.is_some_and(|m| m.dismissing.get() && dismissed.contains(&m.id));
        let moving =
            (c.isBeingPresented() || c.isBeingDismissed()) && c.transitionCoordinator().is_some();
        if just || moving {
            return Some(c);
        }
        if modal.is_some_and(|m| m.deferred.get()) {
            return Some(transition_at(&c).unwrap_or(c));
        }
        next = c.presentedViewController();
    }
    None
}

/// The view controller whose view contains `view`.
pub(crate) fn controller_of(view: &UIView) -> Option<Retained<UIViewController>> {
    let mut responder: Option<Retained<UIResponder>> = view.nextResponder();
    while let Some(r) = responder {
        if let Ok(controller) = r.clone().downcast::<UIViewController>() {
            return Some(controller);
        }
        responder = r.nextResponder();
    }
    None
}
