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

use std::cell::{Cell, RefCell};

use nsh_core::{
    Color, EdgeInsets, EventKind, EventPayload, HeaderSystemItem, ModalAnimation, ModalConfig,
    ModalPresentation, NodeId, PayloadValue, Points, ScreenAnimation, ScreenConfig, Size,
};
use nsh_engine::EngineControl;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyClass, AnyObject, ProtocolObject},
};
use objc2_core_foundation::{CGFloat, CGSize};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};
use objc2_quartz_core::{CAMediaTiming, CATransition};
use objc2_ui_kit::{
    NSForegroundColorAttributeName, UIAdaptivePresentationControllerDelegate, UIBarButtonItem,
    UIBarButtonSystemItem, UIBehavioralStyle, UIColor, UIEdgeInsets, UIGestureRecognizer,
    UIGestureRecognizerDelegate, UIInterfaceOrientationMask, UIModalPresentationStyle,
    UIModalTransitionStyle, UINavigationBar, UINavigationBarAppearance, UINavigationController,
    UINavigationControllerDelegate, UINavigationItem, UINavigationItemLargeTitleDisplayMode,
    UIPresentationController, UIResponder, UIView, UIViewAutoresizing, UIViewController,
};

use crate::{mount::SharedMounter, native_view::NshView, target::EventTarget};

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
    /// A virtual list's logical owner is parked outside native navigation.
    parked: Cell<bool>,
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
            parked: Cell::new(false),
        });
        // SAFETY: UIViewController's designated initializer.
        unsafe {
            msg_send![super(this), initWithNibName: Option::<&NSString>::None, bundle: Option::<&NSObject>::None]
        }
    }

    pub(crate) fn screen_id(&self) -> NodeId {
        self.ivars().id
    }

    /// The screen's insets not covered by system UI or its header, for
    /// `safeAreaInsets()` inside it; and where its content starts below
    /// the header.
    pub(crate) fn report_insets(&self) {
        if self.ivars().parked.get() {
            return;
        }
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
    target: Retained<EventTarget>,
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
    /// A close already admitted by UIKit still owes its completion event.
    pending_dismiss: RefCell<Option<Box<dyn Fn()>>>,
    /// Core confirmed the old logical assignment is gone. Only this exact
    /// native shell can be collected; its node id may already be reused.
    retired: Cell<bool>,
    collecting: Cell<bool>,
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
            if self.ivars().closed.get() {
                self.collect_retired();
                return;
            }
            let id = self.ivars().id;
            self.ivars().control.dispatch_event(id, EventKind::Show, EventPayload::None);
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
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), supportedInterfaceOrientations] }
        }
    }

    unsafe impl UIAdaptivePresentationControllerDelegate for ModalController {
        /// Answered from `closeOnSwipe`: close natively (reported when
        /// done), or let `open` decide (a swipe down only asks).
        #[unsafe(method(presentationControllerShouldDismiss:))]
        fn should_dismiss(&self, _controller: &UIPresentationController) -> bool {
            !self.ivars().closed.get() && self.ivars().close_on_swipe.get()
        }

        /// The user swiped a `closeOnSwipe` sheet away.
        #[unsafe(method(presentationControllerDidDismiss:))]
        fn did_dismiss(&self, presentation: &UIPresentationController) {
            let ivars = self.ivars();
            if !ivars.closed.replace(true) {
                ivars
                    .control
                    .dispatch_event(ivars.id, EventKind::RequestClose, close_reason("swipe"));
                ivars
                    .control
                    .dispatch_event(ivars.id, EventKind::Dismiss, EventPayload::None);
            }
            self.dismissal_completed(Some(&presentation.presentingViewController()));
        }

        /// A swipe down on a sheet that stays (`closeOnSwipe` false).
        #[unsafe(method(presentationControllerDidAttemptToDismiss:))]
        fn did_attempt_to_dismiss(&self, _controller: &UIPresentationController) {
            if self.ivars().closed.get() {
                return;
            }
            let id = self.ivars().id;
            self.ivars()
                .control
                .dispatch_event(id, EventKind::RequestClose, close_reason("swipe"));
        }
    }
);

impl ModalController {
    pub(crate) fn modal_id(&self) -> NodeId {
        self.ivars().id
    }

    pub(crate) fn flush_dismiss(&self) {
        let done = self.ivars().pending_dismiss.borrow_mut().take();
        if let Some(done) = done {
            done();
        }
    }

    fn dismissal_completed(&self, presenter: Option<&UIViewController>) {
        self.flush_dismiss();
        if let Some(parent) = presenter.and_then(|parent| parent.downcast_ref::<Self>()) {
            parent.collect_retired();
        }
        self.ivars().target.navigation_completed();
    }

    pub(crate) fn retire(&self) {
        self.ivars().closed.set(true);
        self.ivars().retired.set(true);
        self.flush_dismiss();
        self.collect_retired();
    }

    /// A newer, independently owned modal keeps its original presenter.
    /// Collect this exact empty shell only after every covering modal left.
    fn collect_retired(&self) {
        let ivars = self.ivars();
        if !ivars.retired.get()
            || ivars.collecting.get()
            || self.presentedViewController().is_some()
        {
            return;
        }
        let Some(presenter) = self.presentingViewController() else {
            return;
        };
        ivars.collecting.set(true);
        let restore_focus = presenter.restoresFocusAfterTransition();
        presenter.setRestoresFocusAfterTransition(false);
        let controller = self.retain();
        let parent = presenter.clone();
        let block = block2::RcBlock::new(move || {
            parent.setRestoresFocusAfterTransition(restore_focus);
            controller.ivars().collecting.set(false);
            controller.dismissal_completed(Some(&parent));
        });
        presenter.dismissViewControllerAnimated_completion(false, Some(&block));
    }

    fn new(
        mtm: MainThreadMarker,
        id: NodeId,
        control: EngineControl,
        target: Retained<EventTarget>,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ModalIvars {
            id,
            control,
            target,
            reported: Cell::new(None),
            orientations: Cell::new(UIInterfaceOrientationMask::empty()),
            close_on_swipe: Cell::new(false),
            close_on_escape: Cell::new(false),
            animated: Cell::new(true),
            closed: Cell::new(false),
            pending_dismiss: RefCell::new(None),
            retired: Cell::new(false),
            collecting: Cell::new(false),
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
        *ivars.pending_dismiss.borrow_mut() = Some(Box::new(move || {
            control.dispatch_event(id, EventKind::Dismiss, EventPayload::None);
        }));
        let controller = self.retain();
        let presenter = self.presentingViewController();
        let block =
            block2::RcBlock::new(move || controller.dismissal_completed(presenter.as_deref()));
        self.dismissViewControllerAnimated_completion(ivars.animated.get(), Some(&block));
    }

    /// Lays the modal's content out at the size it is presented at.
    fn report_size(&self) {
        if self.ivars().closed.get() {
            return;
        }
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

pub(crate) struct NavIvars {
    stack: NodeId,
    mounter: SharedMounter,
    /// The app's own change of screens is being applied.
    applying: Cell<bool>,
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
/// behind on the side the bar left.
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
    let frame = view.convertRect_toView(view.bounds(), Some(&window));
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
        }

        /// A side bar arriving, leaving or changing side moves no view of
        /// the stack, so the screens' compensation is worked out here too.
        #[unsafe(method(viewSafeAreaInsetsDidChange))]
        fn view_safe_area_insets_did_change(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewSafeAreaInsetsDidChange] };
            clip_side_safe_area(self);
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
                && first_responder(&window).is_none()
            {
                // The swipe was cancelled. Another control's focus wins.
                editor.becomeFirstResponder();
            }
            // An animated change of screens is deferred to a layout pass of
            // the navigation view, which puts the screen that arrives in the
            // hierarchy after `reconcile` has sized what was there: the one
            // it brought in is only reachable here.
            size_screens(nav);
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

/// The target of the UIKit bar button `ios={{ headerRightSystemItem }}`
/// draws: a press on it presses the screen's `headerRight`, whose element
/// the app listens to.
struct BarItemIvars {
    mounter: SharedMounter,
    /// The screen whose trailing slot the button presses.
    screen: NodeId,
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
                m.press_trailing_header(ivars.screen);
            }
        }
    }
);

impl BarItemTarget {
    fn new(mtm: MainThreadMarker, screen: NodeId, mounter: SharedMounter) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(BarItemIvars { mounter, screen });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// A system bar button: its item, the button and its target.
type SystemBarItem = (
    HeaderSystemItem,
    Retained<UIBarButtonItem>,
    Retained<BarItemTarget>,
);

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
        if let Some(pop) = nav.interactivePopGestureRecognizer() {
            pop.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        }
        if nav.respondsToSelector(objc2::sel!(interactiveContentPopGestureRecognizer))
            && let Some(pop) = nav.interactiveContentPopGestureRecognizer()
        {
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
        }
    }

    /// Makes the navigation controller a child of the controller showing
    /// the stack (appearance callbacks, safe areas, rotation).
    pub(crate) fn contain(&mut self) {
        if self.contained || self.container.window().is_none() {
            return;
        }
        let Some(parent) = controller_of(&self.container) else {
            return;
        };
        parent.addChildViewController(&self.nav);
        self.nav.didMoveToParentViewController(Some(&parent));
        self.contained = true;
    }

    /// Shows the app's screens: pushes, pops or replaces as needed.
    /// `leaving` is the transition of the screen on top until now.
    pub(crate) fn reconcile(
        &self,
        screens: &[(NodeId, Retained<ScreenController>, ScreenAnimation)],
        leaving: Option<ScreenAnimation>,
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
        let animated = top_changed && current.count() > 0 && animation == ScreenAnimation::Default;
        if top_changed && current.count() > 0 && animation == ScreenAnimation::Fade {
            let fade = CATransition::new();
            fade.setDuration(0.25);
            if let Some(view) = self.nav.view() {
                view.layer().addAnimation_forKey(&fade, None);
            }
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
    }

    /// Removes a parked logical root from UIKit's controllers immediately,
    /// without a pop transition or a synthetic back event.
    pub(crate) fn park_screen(&mut self, id: NodeId) {
        // App order and a back gesture already admitted by UIKit remain
        // authoritative while parked. A cancellation must not revive a pop.
        self.applied.borrow_mut().retain(|&screen| screen != id);
        let desired: Vec<_> = self
            .nav
            .viewControllers()
            .into_iter()
            .filter(|controller| {
                controller
                    .downcast_ref::<ScreenController>()
                    .is_none_or(|screen| screen.screen_id() != id)
            })
            .collect();
        if let Some(view) = self.nav.view() {
            view.layer().removeAllAnimations();
        }
        self.nav.ivars().applying.set(true);
        self.nav
            .setViewControllers_animated(&NSArray::from_retained_slice(&desired), false);
        self.nav.ivars().applying.set(false);
    }
}

/// One screen.
pub(crate) struct ScreenHost {
    pub(crate) controller: Retained<ScreenController>,
    /// The bar button of `ios={{ headerRightSystemItem }}`, made once per
    /// item and kept while it stays, with its target (UIKit keeps a bar
    /// button's target weakly).
    right_system: RefCell<Option<SystemBarItem>>,
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
            right_system: RefCell::new(None),
        }
    }

    pub(crate) fn park(&self) {
        self.controller.ivars().parked.set(true);
        if let Some(root) = self.controller.view() {
            root.setHidden(true);
            root.setUserInteractionEnabled(false);
            root.layer().removeAllAnimations();
        }
    }

    pub(crate) fn restore(&self) {
        self.controller.ivars().parked.set(false);
        if let Some(root) = self.controller.view() {
            root.addSubview(&self.view);
            root.setHidden(false);
            root.setUserInteractionEnabled(true);
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
        let bar_item = |id: Option<NodeId>| {
            id.and_then(&item)
                .map(|v| UIBarButtonItem::initWithCustomView(UIBarButtonItem::alloc(mtm), &v))
        };
        nav_item.setLeftBarButtonItem(bar_item(c.left).as_deref());
        nav_item.setLeftItemsSupplementBackButton(true);
        // `ios={{ headerRightSystemItem }}`: UIKit's button, which presses
        // the app's `headerRight` (none without it). The same item keeps its
        // button: rebuilding it on every header change would flash it.
        let system = match (c.right_system_item, c.right, press) {
            (Some(kind), Some(_), Some(mounter)) => {
                let mut kept = self.right_system.borrow_mut();
                if kept.as_ref().is_none_or(|(k, ..)| *k != kind) {
                    let target = BarItemTarget::new(mtm, self.controller.screen_id(), mounter);
                    // SAFETY: UIKit's designated initializer of a system bar
                    // button; the target lives in `right_system` as long as
                    // the button, and `nshPress:` is its action's selector.
                    let item = unsafe {
                        UIBarButtonItem::initWithBarButtonSystemItem_target_action(
                            UIBarButtonItem::alloc(mtm),
                            system_bar_item(kind),
                            Some(&target),
                            Some(objc2::sel!(nshPress:)),
                        )
                    };
                    *kept = Some((kind, item, target));
                }
                kept.as_ref().map(|(_, item, _)| item.clone())
            }
            _ => {
                self.right_system.borrow_mut().take();
                None
            }
        };
        match system {
            Some(item) => nav_item.setRightBarButtonItem(Some(&item)),
            None => nav_item.setRightBarButtonItem(bar_item(c.right).as_deref()),
        }
        nav_item.setHidesBackButton(!c.back_visible);
        nav_item.setBackButtonTitle(c.back_title.as_deref().map(NSString::from_str).as_deref());
        nav_item.setLargeTitleDisplayMode(if c.large_title {
            UINavigationItemLargeTitleDisplayMode::Always
        } else {
            UINavigationItemLargeTitleDisplayMode::Never
        });
        let appearance = header_appearance(mtm, c);
        nav_item.setStandardAppearance(appearance.as_deref());
        nav_item.setScrollEdgeAppearance(appearance.as_deref());
        nav_item.setCompactAppearance(appearance.as_deref());
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
        self.controller.report_insets();
    }
}

/// Keeps `bar` in the window with the iPad style: in Mac Catalyst's Mac
/// idiom UIKit otherwise moves a navigation bar's contents into the window's
/// toolbar (the back button next to the traffic lights), where the title,
/// the header's colors and the core's layout do not apply.
pub(crate) fn keep_in_window(bar: &UINavigationBar) {
    // `preferredBehavioralStyle` is iOS 16+ (nsh supports iOS 15, where
    // bars always stay in the window).
    if bar.respondsToSelector(objc2::sel!(setPreferredBehavioralStyle:)) {
        bar.setPreferredBehavioralStyle(UIBehavioralStyle::Pad);
    }
}

/// The header's appearance from the screen's options (`None`: UIKit's).
fn header_appearance(
    mtm: MainThreadMarker,
    c: &ScreenConfig,
) -> Option<Retained<UINavigationBarAppearance>> {
    if c.background_color.is_none() && c.title_color.is_none() && !c.header_transparent {
        return None;
    }
    let appearance = UINavigationBarAppearance::new(mtm);
    if c.header_transparent {
        appearance.configureWithTransparentBackground();
    } else if let Some(bg) = c.background_color {
        appearance.configureWithOpaqueBackground();
        appearance.setBackgroundColor(Some(&ui_color(bg)));
    } else {
        appearance.configureWithDefaultBackground();
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
    Some(appearance)
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
    match header_appearance(mtm, c) {
        Some(appearance) => {
            bar.setStandardAppearance(&appearance);
            bar.setScrollEdgeAppearance(Some(&appearance));
            bar.setCompactAppearance(Some(&appearance));
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
    /// Native presentation/close eligibility before a reversible park.
    parked: Option<(bool, bool)>,
}

impl ModalHost {
    pub(crate) fn new(
        mtm: MainThreadMarker,
        id: NodeId,
        control: EngineControl,
        target: Retained<EventTarget>,
    ) -> Self {
        Self::with_view(mtm, id, control, target, NshView::new(mtm))
    }

    fn with_view(
        mtm: MainThreadMarker,
        id: NodeId,
        control: EngineControl,
        target: Retained<EventTarget>,
        view: Retained<NshView>,
    ) -> Self {
        let controller = ModalController::new(mtm, id, control, target);
        if let Some(root) = controller.view() {
            root.addSubview(&view);
        }
        Self {
            controller,
            view,
            config: ModalConfig::default(),
            presented: false,
            parked: None,
        }
    }

    /// Confirmation severs the old native shell from the active node table.
    /// A future projection of this view uses a fresh controller, so an old
    /// SDK completion can never withdraw a newer logical owner's content.
    pub(crate) fn confirmed_retirement(&self) -> Self {
        self.controller.ivars().closed.set(true);
        self.controller.ivars().retired.set(true);
        let mut current = Self::with_view(
            self.controller.mtm(),
            self.controller.modal_id(),
            self.controller.ivars().control.clone(),
            self.controller.ivars().target.clone(),
            self.view.clone(),
        );
        current.configure(self.config);
        self.controller.retire();
        current
    }

    /// Source deletion of an already parked owner cannot wait for a Core
    /// confirmation that source revocation has invalidated.
    pub(crate) fn revoke_parked(&mut self) -> bool {
        if self.parked.is_none() {
            return false;
        }
        *self = self.confirmed_retirement();
        true
    }

    /// Presents the modal over the controller showing `from`.
    pub(crate) fn present(&mut self, from: &UIView) -> bool {
        if let Some((presented, closed)) = self.parked
            && closed
        {
            // A native close was already admitted before parking. Repeated
            // projections cannot revive it; real source removal clears it.
            self.presented = presented;
            return true;
        }
        self.parked = None;
        if self.presented && !self.controller.ivars().closed.get() {
            return true;
        }
        self.controller.ivars().closed.set(false);
        self.controller.set_flags(&self.config);
        if let Some(root) = self.controller.view() {
            root.addSubview(&self.view);
            root.setHidden(false);
            root.setUserInteractionEnabled(true);
        }
        if self.controller.presentingViewController().is_some() {
            // Cancellation restored the original native presentation slot;
            // never re-present it above an unrelated covering modal.
            self.presented = true;
            return true;
        }
        let Some(mut presenter) = controller_of(from) else {
            log::warn!("cannot present a modal: no view controller shows the app");
            return false;
        };
        while let Some(next) = presenter.presentedViewController() {
            if let Some(retired) = next.downcast_ref::<ModalController>()
                && retired.ivars().retired.get()
                && retired.presentedViewController().is_none()
            {
                retired.collect_retired();
                return false;
            }
            presenter = next;
        }
        let c = self.config;
        let controller = &self.controller;
        let mut mask = UIInterfaceOrientationMask::empty();
        for (bit, m) in [
            (ModalConfig::PORTRAIT, UIInterfaceOrientationMask::Portrait),
            (
                ModalConfig::PORTRAIT_UPSIDE_DOWN,
                UIInterfaceOrientationMask::PortraitUpsideDown,
            ),
            (
                ModalConfig::LANDSCAPE_LEFT,
                UIInterfaceOrientationMask::LandscapeLeft,
            ),
            (
                ModalConfig::LANDSCAPE_RIGHT,
                UIInterfaceOrientationMask::LandscapeRight,
            ),
        ] {
            if c.orientations & bit != 0 {
                mask |= m;
            }
        }
        controller.ivars().orientations.set(mask);
        controller.set_flags(&c);
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
        // Presented outside the surface: the app's appearance is set on
        // it too.
        controller.setOverrideUserInterfaceStyle(crate::system::appearance());
        presenter.presentViewController_animated_completion(
            controller,
            c.animation != ModalAnimation::None,
            None,
        );
        self.presented = true;
        true
    }

    /// Applies `config` (the close flags also while presented).
    pub(crate) fn configure(&mut self, config: ModalConfig) {
        self.controller.set_flags(&config);
        self.config = config;
    }

    /// Parks a virtual owner's native content without changing the original
    /// SDK presentation slot. A cancellation restores that same slot.
    pub(crate) fn park(&mut self) {
        self.parked
            .get_or_insert((self.presented, self.controller.ivars().closed.get()));
        self.presented = false;
        self.controller.ivars().closed.set(true);
        self.controller.setModalInPresentation(true);
        if let Some(root) = self.controller.view() {
            root.setHidden(true);
            root.setUserInteractionEnabled(false);
            root.layer().removeAllAnimations();
        }
    }

    /// Dismisses the modal; `done` runs when it is gone.
    pub(crate) fn dismiss(&mut self, done: impl Fn() + 'static) {
        if !self.presented {
            return;
        }
        self.presented = false;
        // Closed by the user already (and reported).
        if self.controller.ivars().closed.replace(false) {
            return;
        }
        *self.controller.ivars().pending_dismiss.borrow_mut() = Some(Box::new(done));
        let controller = self.controller.clone();
        let presenter = self.controller.presentingViewController();
        let block =
            block2::RcBlock::new(move || controller.dismissal_completed(presenter.as_deref()));
        let animated = self.config.animation != ModalAnimation::None;
        // Through the presenter: a modal that presents another one (a sheet
        // over it) would otherwise only dismiss that one, and stay on
        // screen with its content already gone (closing a sheet and its
        // modal together). The presenter dismisses this modal and every
        // controller above it.
        match self.controller.presentingViewController() {
            Some(presenter) => {
                presenter.dismissViewControllerAnimated_completion(animated, Some(&block))
            }
            None => self
                .controller
                .dismissViewControllerAnimated_completion(animated, Some(&block)),
        }
    }
}

/// The back button a user taps in the header shown over `window`: the
/// navigation bar's (UIKit draws it, so it is found by what it is).
#[cfg(feature = "dev")]
pub(crate) fn back_button(window: &objc2_ui_kit::UIWindow) -> Option<Retained<UIView>> {
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
    fn named(view: &UIView, part: &str) -> bool {
        view.class().name().to_string_lossy().contains(part)
    }
    // A bar button that carries the back chevron's mask.
    fn back(view: &UIView) -> Option<Retained<UIView>> {
        let subviews = view.subviews();
        if named(view, "ButtonBarButton")
            && !view.isHidden()
            && view.alpha() > 0.01
            && subviews.iter().any(|v| named(&v, "BackButton"))
        {
            return Some(objc2::Message::retain(view));
        }
        subviews.iter().find_map(|v| back(&v))
    }
    let mut found = Vec::new();
    bars(window, &mut found);
    // The front one: the last drawn.
    found.iter().rev().find_map(|bar| back(bar))
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
