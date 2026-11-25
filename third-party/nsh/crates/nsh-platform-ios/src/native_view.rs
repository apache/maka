//! `NshView`: the UIView behind `<view>` and `<image>` (and, through
//! [`crate::text_view::TextView`], `<text>`). It implements what plain
//! UIViews cannot: `pointerEvents`, `hitSlop` and accessibility computed
//! from the app's properties.

use std::cell::RefCell;

use block2::RcBlock;
use nsh_core::{
    Accessibility, AccessibilityCurrent, AccessibilityRole, Checked, ClipInset, EventKind,
    EventMask, EventPayload, NodeId, PayloadValue, PointerEvents, Points, ViewProps,
    keymap::Keystroke,
};
use nsh_engine::EngineControl;
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSObject, NSSet, NSString};
use objc2_ui_kit::{
    NSLayoutConstraint, UIAccessibilityContainerType, UIAccessibilityCustomAction,
    UIAccessibilityTraitAdjustable, UIAccessibilityTraitButton, UIAccessibilityTraitHeader,
    UIAccessibilityTraitImage, UIAccessibilityTraitKeyboardKey, UIAccessibilityTraitLink,
    UIAccessibilityTraitNone, UIAccessibilityTraitNotEnabled, UIAccessibilityTraitSearchField,
    UIAccessibilityTraitSelected, UIAccessibilityTraitStaticText,
    UIAccessibilityTraitSummaryElement, UIAccessibilityTraitUpdatesFrequently,
    UIAccessibilityTraits, UIEvent, UIFocusAnimationCoordinator, UIFocusUpdateContext,
    UIGestureRecognizer, UIGestureRecognizerState, UIKeyCommand, UIPress, UIPressesEvent,
    UIResponder, UITapGestureRecognizer, UITouch, UIView,
};

use crate::target::EventTarget;

#[derive(Default)]
pub(crate) struct NshViewIvars {
    props: RefCell<ViewProps>,
    /// Where accessibility actions are reported (set once the view is mounted).
    control: RefCell<Option<EngineControl>>,
    /// The surface's target, for raw keys and focus (set once mounted). A
    /// weak reference: the target's mounter owns this view.
    target: RefCell<Option<Weak<EventTarget>>>,
    /// The events the app listens to, which key handling reads without the
    /// mounter (`key_capture` and `on_key_down` / `on_key_up`).
    events: std::cell::Cell<EventMask>,
    /// A tap that focuses this view when it is `focusable` without taking
    /// presses (it neither claims nor cancels touches).
    focus_tap: RefCell<Option<Retained<FocusTap>>>,
    /// The view handles presses: an accessibility element by default, and
    /// "activate" presses it.
    pressable: std::cell::Cell<bool>,
    /// The area descendants cover outside the bounds (`MountItem::Overflow`):
    /// touches there are looked for in the subviews.
    overflow: std::cell::Cell<Option<CGRect>>,
    /// `clipPath`: outside it, touches reach neither the view nor its
    /// subviews.
    clip: std::cell::Cell<Option<ClipInset>>,
    /// An `increment` / `decrement` reported whose value has not arrived
    /// yet, and the value VoiceOver read since (`Some` once it asked).
    step: RefCell<Option<Option<String>>>,
    /// A header bar button's custom view: its width and height constraints
    /// (the bar sizes such a view with Auto Layout).
    size: RefCell<Option<[Retained<NSLayoutConstraint>; 2]>>,
}

define_class!(
    /// A UIView with React Native's touch and accessibility properties.
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = NshViewIvars]
    pub(crate) struct NshView;

    impl NshView {
        /// Sets this class's ivars for subclasses (`TextView`, `CanvasView`) too.
        #[unsafe(method_id(initWithFrame:))]
        fn init_with_frame(this: objc2::rc::Allocated<Self>, frame: CGRect) -> Retained<Self> {
            let this = this.set_ivars(NshViewIvars::default());
            // SAFETY: UIView's designated initializer.
            let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
            // UIKit defaults `multipleTouchEnabled` to false and drops a second
            // finger hitting the view before `TouchTracker` sees it, breaking
            // multi-finger `onTouch` streams (e.g. pinch-to-zoom on a canvas).
            view.setMultipleTouchEnabled(true);
            view
        }

        #[unsafe(method_id(hitTest:withEvent:))]
        fn hit_test(&self, point: CGPoint, event: Option<&UIEvent>) -> Option<Retained<UIView>> {
            self.hit(point, event)
        }

        #[unsafe(method(pointInside:withEvent:))]
        fn point_inside(&self, point: CGPoint, event: Option<&UIEvent>) -> bool {
            self.inside(point, event)
        }

        #[unsafe(method(isAccessibilityElement))]
        fn is_accessibility_element(&self) -> bool {
            self.a11y_element()
        }

        #[unsafe(method_id(accessibilityLabel))]
        fn accessibility_label(&self) -> Option<Retained<NSString>> {
            self.a11y_label()
        }

        // The description, then the hint: UIKit has one place for what
        // VoiceOver reads after the name and the value.
        #[unsafe(method_id(accessibilityHint))]
        fn accessibility_hint(&self) -> Option<Retained<NSString>> {
            self.ivars()
                .props
                .borrow()
                .accessibility
                .help_text(None)
                .as_deref()
                .map(NSString::from_str)
        }

        #[unsafe(method_id(accessibilityValue))]
        fn accessibility_value(&self) -> Option<Retained<NSString>> {
            let value = self.a11y_value(&self.ivars().props.borrow());
            if let Some(read) = self.ivars().step.borrow_mut().as_mut() {
                *read = Some(value.clone().unwrap_or_default());
            }
            value.map(|v| NSString::from_str(&v))
        }

        #[unsafe(method(accessibilityTraits))]
        fn accessibility_traits(&self) -> UIAccessibilityTraits {
            self.a11y_traits()
        }

        #[unsafe(method(accessibilityContainerType))]
        fn accessibility_container_type(&self) -> UIAccessibilityContainerType {
            container_type(&self.ivars().props.borrow().accessibility)
        }

        #[unsafe(method(accessibilityElementsHidden))]
        fn accessibility_elements_hidden(&self) -> bool {
            self.ivars().props.borrow().accessibility.hidden
        }

        #[unsafe(method_id(accessibilityIdentifier))]
        fn accessibility_identifier(&self) -> Option<Retained<NSString>> {
            self.ivars().props.borrow().test_id.as_deref().map(NSString::from_str)
        }

        #[unsafe(method_id(accessibilityCustomActions))]
        fn accessibility_custom_actions(&self) -> Option<Retained<NSArray<UIAccessibilityCustomAction>>> {
            self.a11y_actions()
        }

        #[unsafe(method(accessibilityActivate))]
        fn accessibility_activate(&self) -> bool {
            self.a11y_activate()
        }

        #[unsafe(method(accessibilityIncrement))]
        fn accessibility_increment(&self) {
            self.standard_action("increment");
        }

        #[unsafe(method(accessibilityDecrement))]
        fn accessibility_decrement(&self) {
            self.standard_action("decrement");
        }

        /// A `focusable` view is a stop of the keyboard focus (`focusable`,
        /// or taking presses), as Tab and `ref.focus()` move it there. A
        /// transparent one takes it too ([`crate::keyboard::shown`]), as on
        /// the other platforms: a popup coming in from `opacity: 0` has the
        /// item it asked for focused as it opens. Tab passes over it.
        #[unsafe(method(canBecomeFirstResponder))]
        fn can_become_first_responder(&self) -> bool {
            self.is_focus_stop() && crate::keyboard::shown(self)
        }

        /// The same stop is a UIKit focus item, so the system's own Tab
        /// traversal reaches it from the window's initial focus (where
        /// available) and the focus engine follows the responder where it
        /// is visible: the engine passes over a transparent one, as Tab
        /// does.
        #[unsafe(method(canBecomeFocused))]
        fn can_become_focused(&self) -> bool {
            self.is_focus_stop() && crate::keyboard::visible(self)
        }

        /// UIKit focus entered or left this item: the first responder
        /// follows, so hardware keys go to the view the system focused.
        #[allow(deprecated)]
        #[unsafe(method(didUpdateFocusInContext:withAnimationCoordinator:))]
        fn did_update_focus(
            &self,
            context: &UIFocusUpdateContext,
            coordinator: &UIFocusAnimationCoordinator,
        ) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe {
                msg_send![
                    super(self),
                    didUpdateFocusInContext: context,
                    withAnimationCoordinator: coordinator
                ]
            };
            crate::keyboard::adopt_focus(context);
        }

        /// Key commands of a focused stop: a Tab an app shortcut binds or a
        /// mounted capture takes gets a `UIKeyCommand` with priority, so
        /// UIKit's focus traversal does not take it first. A normal
        /// (unbound, uncaptured) Tab gets none and follows the focus engine.
        #[unsafe(method_id(keyCommands))]
        fn key_commands(&self) -> Option<Retained<NSArray<UIKeyCommand>>> {
            // SAFETY: calling the superclass implementation.
            let inherited: Option<Retained<NSArray<UIKeyCommand>>> =
                unsafe { msg_send![super(self), keyCommands] };
            if self.isFirstResponder() && self.is_focus_stop() {
                crate::keyboard::tab_key_commands(self, inherited)
            } else {
                inherited
            }
        }

        /// `nshTabKeyCommand:`: a bound or captured Tab delivered with
        /// priority.
        #[unsafe(method(nshTabKeyCommand:))]
        fn nsh_tab_key_command(&self, command: &UIKeyCommand) {
            crate::keyboard::tab_command(self, command);
        }

        /// The keyboard focus moved to the view: its `focus:` styles and
        /// `onFocus` report it, as an input's do.
        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            let was = self.isFirstResponder();
            // SAFETY: calling the superclass implementation.
            let accepted: bool = unsafe { msg_send![super(self), becomeFirstResponder] };
            if accepted && !was {
                self.focus_changed(true);
            }
            accepted
        }

        /// The keyboard focus left the view: no key release is invented for
        /// the keys it held, and its `onBlur` reports the move.
        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            // SAFETY: calling the superclass implementation.
            let resigned: bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if resigned {
                self.focus_changed(false);
                if let Some(target) = self.keyboard_target() {
                    // On the next turn the root takes the keys back only if
                    // nothing (an input, a hosted view, another custom view)
                    // took the focus meanwhile.
                    target.restore_root_focus_for(self);
                }
            }
            resigned
        }

        /// Hardware keys on a focused view: the app's shortcuts, then the
        /// raw notifications and the capture rules
        /// ([`crate::keyboard::began`]).
        #[unsafe(method(pressesBegan:withEvent:))]
        fn presses_began(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keyboard::began(self, presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesBegan: presses, withEvent: event] };
            }
        }

        /// UIKit reports no keyboard transition through it: the press goes
        /// on unchanged (`crate::keyboard::changed`).
        #[unsafe(method(pressesChanged:withEvent:))]
        fn presses_changed(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keyboard::changed(self, presses) {
                // SAFETY: calling the superclass implementation.
                let _: () =
                    unsafe { msg_send![super(self), pressesChanged: presses, withEvent: event] };
            }
        }

        /// A key's release, if this view has the keyboard focus now.
        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keyboard::ended(self, presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesEnded: presses, withEvent: event] };
            }
        }

        /// A key's press was cancelled: no release is synthesized.
        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keyboard::cancelled(self, presses) {
                // SAFETY: calling the superclass implementation.
                let _: () =
                    unsafe { msg_send![super(self), pressesCancelled: presses, withEvent: event] };
            }
        }
    }
);

define_class!(
    /// The tap that gives a `focusable` view without press handlers the
    /// keyboard focus ([`NshView::update_focus_tap`]). It only watches the
    /// touch: a tap recognizer otherwise claims it on release, before the
    /// press of a pressable view inside the focusable one ends, and that
    /// press never arrives.
    #[unsafe(super(UITapGestureRecognizer, UIGestureRecognizer, NSObject))]
    #[thread_kind = MainThreadOnly]
    pub(crate) struct FocusTap;

    impl FocusTap {
        /// A touch on a stop inside the view is that stop's: its own focus
        /// tap focuses it, an input focuses itself, and a control (a view
        /// that takes presses) takes its press and no focus.
        #[unsafe(method(touchesBegan:withEvent:))]
        fn touches_began(&self, touches: &NSSet<UITouch>, event: &UIEvent) {
            if let (Some(view), Some(touch)) = (self.view(), touches.anyObject())
                && crate::keyboard::stop_inside(&touch, &view)
            {
                // SAFETY: `setState:` is the subclass API of
                // UIGestureRecognizer.
                let _: () = unsafe { msg_send![self, setState: UIGestureRecognizerState::Failed] };
                return;
            }
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), touchesBegan: touches, withEvent: event] };
        }

        /// The recognizers of the views inside (a press, another gesture)
        /// recognize the same touch.
        #[unsafe(method(canPreventGestureRecognizer:))]
        fn can_prevent(&self, _other: &UIGestureRecognizer) -> bool {
            false
        }
    }
);

impl FocusTap {
    fn new(mtm: MainThreadMarker, target: &EventTarget) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: the designated initializer; `handleFocusTap:` is
        // implemented by `EventTarget`, which the mounter keeps alive as
        // long as the recognizer's view.
        let this: Retained<Self> = unsafe {
            msg_send![super(this), initWithTarget: target, action: objc2::sel!(handleFocusTap:)]
        };
        // The view's own press handlers still hear the touches.
        this.setCancelsTouchesInView(false);
        this.setDelaysTouchesBegan(false);
        this.setDelaysTouchesEnded(false);
        this
    }
}

impl NshView {
    /// `pointerEvents`.
    pub(crate) fn pointer_events(&self) -> PointerEvents {
        self.ivars().props.borrow().pointer_events
    }

    fn hit(&self, point: CGPoint, event: Option<&UIEvent>) -> Option<Retained<UIView>> {
        if self.clipped_out(point) {
            return None;
        }
        let mode = self.ivars().props.borrow().pointer_events;
        // SAFETY: calling the superclass implementation.
        let hit = || -> Option<Retained<UIView>> {
            unsafe { msg_send![super(self), hitTest: point, withEvent: event] }
        };
        match mode {
            PointerEvents::Auto | PointerEvents::BoxNone
                if self.outside_in_overflow(point, event) =>
            {
                self.hit_overflow(point, event)
            }
            PointerEvents::Auto => hit(),
            PointerEvents::None => None,
            PointerEvents::BoxNone => {
                hit().filter(|v| !std::ptr::eq::<UIView>(&**v, self.as_ref()))
            }
            PointerEvents::BoxOnly => {
                let visible =
                    self.isUserInteractionEnabled() && !self.isHidden() && self.alpha() > 0.01;
                (visible && self.inside(point, event)).then(|| Retained::into_super(self.retain()))
            }
        }
    }

    /// The point is outside the view (and its hit slop) but in the area
    /// its descendants cover, which UIKit's hit test never looks at.
    fn outside_in_overflow(&self, point: CGPoint, event: Option<&UIEvent>) -> bool {
        let Some(e) = self.ivars().overflow.get() else {
            return false;
        };
        point.x >= e.origin.x
            && point.y >= e.origin.y
            && point.x < e.origin.x + e.size.width
            && point.y < e.origin.y + e.size.height
            && !self.clipsToBounds()
            && self.isUserInteractionEnabled()
            && !self.isHidden()
            && self.alpha() > 0.01
            && !self.inside(point, event)
    }

    /// UIKit's hit test of the subviews, without its bounds check: the
    /// topmost subview with a target under the point; never the view itself
    /// (the point is outside it).
    fn hit_overflow(&self, point: CGPoint, event: Option<&UIEvent>) -> Option<Retained<UIView>> {
        let subviews = self.subviews();
        for i in (0..subviews.count()).rev() {
            let sub = subviews.objectAtIndex(i);
            let local = self.convertPoint_toView(point, Some(&sub));
            if let Some(hit) = sub.hitTest_withEvent(local, event) {
                return Some(hit);
            }
        }
        None
    }

    /// The point is outside the view's `clipPath`.
    fn clipped_out(&self, point: CGPoint) -> bool {
        self.ivars().clip.get().is_some_and(|clip| {
            let b = self.bounds();
            let size =
                nsh_core::geometry::size(Points(b.size.width as f32), Points(b.size.height as f32));
            let at = nsh_core::geometry::point(
                Points((point.x - b.origin.x) as f32),
                Points((point.y - b.origin.y) as f32),
            );
            !clip.contains(size, at)
        })
    }

    fn inside(&self, point: CGPoint, event: Option<&UIEvent>) -> bool {
        if self.clipped_out(point) {
            return false;
        }
        let slop = self.ivars().props.borrow().hit_slop.map(|v| v.0);
        if slop == Default::default() {
            // SAFETY: calling the superclass implementation.
            return unsafe { msg_send![super(self), pointInside: point, withEvent: event] };
        }
        let b = self.bounds();
        let x0 = b.origin.x - slop.left as f64;
        let y0 = b.origin.y - slop.top as f64;
        let x1 = b.origin.x + b.size.width + slop.right as f64;
        let y1 = b.origin.y + b.size.height + slop.bottom as f64;
        point.x >= x0 && point.x < x1 && point.y >= y0 && point.y < y1
    }

    fn a11y_element(&self) -> bool {
        is_element(
            &self.ivars().props.borrow().accessibility,
            self.ivars().pressable.get(),
        )
    }

    fn a11y_label(&self) -> Option<Retained<NSString>> {
        let props = self.ivars().props.borrow();
        if let Some(label) = &props.accessibility.label {
            return Some(NSString::from_str(label));
        }
        // A group's elements read their own text, unless the group was
        // made one element.
        if is_container(&props.accessibility) && props.accessibility.accessible != Some(true) {
            return None;
        }
        drop(props);
        // Like React Native: an element without a label reads the text
        // inside it.
        let mut text = String::new();
        collect_text(self, &mut text);
        (!text.is_empty()).then(|| NSString::from_str(&text))
    }

    fn a11y_traits(&self) -> UIAccessibilityTraits {
        let props = self.ivars().props.borrow();
        let mut traits = traits(&props);
        if self.ivars().pressable.get() && props.accessibility.role == AccessibilityRole::None {
            // SAFETY: an immutable UIKit constant.
            traits |= unsafe { UIAccessibilityTraitButton };
        }
        traits
    }

    fn a11y_actions(&self) -> Option<Retained<NSArray<UIAccessibilityCustomAction>>> {
        let props = self.ivars().props.borrow();
        let id = self.tag() as NodeId;
        let control = self.ivars().control.borrow().clone()?;
        let mtm = self.mtm();
        let actions: Vec<_> = props
            .accessibility
            .actions
            .iter()
            .filter(|a| !is_standard_action(&a.name))
            .map(|a| {
                let name = a.name.clone();
                let control = control.clone();
                let handler: RcBlock<
                    dyn Fn(std::ptr::NonNull<UIAccessibilityCustomAction>) -> objc2::runtime::Bool,
                > = RcBlock::new(move |_| {
                    action(&control, id, &name);
                    objc2::runtime::Bool::YES
                });
                let label = NSString::from_str(a.label.as_deref().unwrap_or(&a.name));
                // SAFETY: a block-based custom action (iOS 13+); UIKit copies
                // the block.
                unsafe {
                    UIAccessibilityCustomAction::initWithName_actionHandler(
                        UIAccessibilityCustomAction::alloc(mtm),
                        &label,
                        RcBlock::as_ptr(&handler),
                    )
                }
            })
            .collect();
        (!actions.is_empty()).then(|| NSArray::from_retained_slice(&actions))
    }

    fn a11y_activate(&self) -> bool {
        let id = self.tag() as NodeId;
        let Some(control) = self.ivars().control.borrow().clone() else {
            return false;
        };
        if self.has_action("activate") {
            action(&control, id, "activate");
            return true;
        }
        if self.ivars().pressable.get() {
            control.dispatch_event(id, EventKind::Press, EventPayload::None);
            return true;
        }
        false
    }
}

impl NshView {
    pub(crate) fn new(mtm: MainThreadMarker) -> Retained<Self> {
        // SAFETY: our designated initializer.
        unsafe {
            msg_send![Self::alloc(mtm), initWithFrame: CGRect::new(CGPoint::ZERO, CGSize::ZERO)]
        }
    }

    /// Sizes a view the system lays out with Auto Layout (a header bar
    /// button's custom view): width and height constraints, made once and
    /// updated after, so the bar lays it out again when its size changes —
    /// a frame set later is not read, and the view keeps the size, the hit
    /// area and the place the bar gave it at first.
    pub(crate) fn set_layout_size(&self, size: CGSize) {
        let mut kept = self.ivars().size.borrow_mut();
        match kept.as_ref() {
            Some([w, h]) => {
                if w.constant() != size.width {
                    w.setConstant(size.width);
                }
                if h.constant() != size.height {
                    h.setConstant(size.height);
                }
            }
            None => {
                self.setTranslatesAutoresizingMaskIntoConstraints(false);
                let w = self.widthAnchor().constraintEqualToConstant(size.width);
                let h = self.heightAnchor().constraintEqualToConstant(size.height);
                w.setActive(true);
                h.setActive(true);
                *kept = Some([w, h]);
            }
        }
        // The content lays out from the bounds; the bar places the origin.
        let origin = self.frame().origin;
        self.setFrame(CGRect::new(origin, size));
    }

    /// Sets the touch, accessibility and test properties.
    pub(crate) fn set_props(&self, props: ViewProps, control: &EngineControl) {
        let late = self.late_step_value(&props);
        *self.ivars().props.borrow_mut() = props;
        *self.ivars().control.borrow_mut() = Some(control.clone());
        if let Some(value) = late {
            crate::system::announce(&value);
        }
    }

    /// Remembers the surface's target, for raw keys and focus. Weak: the
    /// target's mounter owns this view, so a strong reference would keep
    /// both alive.
    pub(crate) fn set_target(&self, target: &EventTarget) {
        *self.ivars().target.borrow_mut() = Some(Weak::new(target));
    }

    /// The events the app listens to (`MountItem::Events`).
    pub(crate) fn set_events(&self, events: EventMask) {
        self.ivars().events.set(events);
    }

    /// A `focusable` view that takes no presses (one that takes keys) gets
    /// the keyboard focus from a tap recognizer that neither claims nor
    /// cancels touches. It is removed once the view stops being such a stop
    /// or starts taking presses: a tap gives a control no focus.
    pub(crate) fn update_focus_tap(&self, target: &EventTarget) {
        let wants = self.is_focus_stop() && !self.takes_presses();
        let mut kept = self.ivars().focus_tap.borrow_mut();
        match (&*kept, wants) {
            (Some(_), true) | (None, false) => {}
            (None, true) => {
                let tap = FocusTap::new(self.mtm(), target);
                self.addGestureRecognizer(&tap);
                *kept = Some(tap);
            }
            (Some(tap), false) => {
                self.removeGestureRecognizer(tap);
                *kept = None;
            }
        }
    }

    /// The events the app listens to.
    pub(crate) fn events(&self) -> EventMask {
        self.ivars().events.get()
    }

    /// The view handles presses (`onPress`), so Return and Space press it
    /// and, unless `focusable` says otherwise, Tab stops at it.
    pub(crate) fn takes_presses(&self) -> bool {
        self.ivars().pressable.get()
    }

    /// Whether the view is a stop of the keyboard focus
    /// ([`ViewProps::focus_stop`]): it shows, is not disabled and is
    /// `focusable` or takes presses.
    pub(crate) fn is_focus_stop(&self) -> bool {
        let props = self.ivars().props.borrow();
        props.focus_stop(self.ivars().pressable.get())
    }

    /// Whether this view's ancestry needs raw key notifications: a
    /// `on_key_down` / `on_key_up` listener or a capture rule.
    pub(crate) fn listens_key(&self) -> bool {
        let events = self.ivars().events.get();
        events.contains(EventKind::KeyDown)
            || events.contains(EventKind::KeyUp)
            || !self.ivars().props.borrow().key_capture.is_none()
    }

    /// Whether this view's mounted capture rule captures `stroke` (`None`
    /// for a key no keystroke names: only `KeyCapture::All` captures it).
    pub(crate) fn captures_key(&self, stroke: Option<&Keystroke>) -> bool {
        let props = self.ivars().props.borrow();
        !props.accessibility.state.disabled && props.key_capture.captures_key(stroke)
    }

    /// The spoken value: an explicit `accessibilityValue`, plus checked,
    /// mixed pressed, expanded, current and invalid states (UIKit has no
    /// traits for those), in the language of the app's text.
    fn a11y_value(&self, props: &ViewProps) -> Option<String> {
        let words = self
            .keyboard_target()
            .map_or(crate::state_words::DEFAULT, |target| target.state_words());
        state_value(props, words)
    }

    /// The surface's target, once the view is mounted.
    pub(crate) fn keyboard_target(&self) -> Option<Retained<EventTarget>> {
        self.ivars().target.borrow().as_ref().and_then(Weak::load)
    }

    /// The node id the view stands for.
    pub(crate) fn id(&self) -> NodeId {
        self.tag() as NodeId
    }

    /// The keyboard focus entered or left the view: its `focus:` styles and
    /// `onFocus` / `onBlur` follow, and a loss clears the keys held (no
    /// release is invented).
    fn focus_changed(&self, focused: bool) {
        let Some(target) = self.keyboard_target() else {
            return;
        };
        target.view_focused(self.id(), focused, self.events());
    }

    /// The value an `increment` / `decrement` led to, when it arrives after
    /// VoiceOver read the element's value (the action is answered on the
    /// engine thread, so it usually does): VoiceOver reads the value right
    /// after `accessibilityIncrement` returns and never again, so the new
    /// one is announced. A value that arrives before VoiceOver asks is the
    /// one it reads, and is not announced twice.
    fn late_step_value(&self, props: &ViewProps) -> Option<String> {
        if self.ivars().step.borrow().is_none() {
            return None;
        }
        let value = self.a11y_value(props).unwrap_or_default();
        if self
            .a11y_value(&self.ivars().props.borrow())
            .unwrap_or_default()
            == value
        {
            return None;
        }
        let read = self.ivars().step.take().flatten()?;
        // SAFETY: `UIAccessibilityFocus`'s informal protocol on NSObject.
        let focused: bool = unsafe { msg_send![self, accessibilityElementIsFocused] };
        (focused && !value.is_empty() && read != value).then_some(value)
    }

    /// The view is a selectable view (`ViewProps::selectable_view`).
    pub(crate) fn is_selectable_view(&self) -> bool {
        self.ivars().props.borrow().selectable_view
    }

    /// The app's items of the view's selection menu (`selectionMenu`).
    pub(crate) fn selection_menu(&self) -> std::sync::Arc<[nsh_core::desktop::MenuItem]> {
        self.ivars().props.borrow().selection_menu.clone()
    }

    /// The view is a text that continues the one before it
    /// (`ViewProps::continues_text`: a wrapped line's later part).
    pub(crate) fn continues_text(&self) -> bool {
        self.ivars().props.borrow().continues_text
    }

    /// The area descendants cover outside the bounds, in the view's
    /// coordinates (`MountItem::Overflow`).
    pub(crate) fn set_overflow(&self, extent: Option<CGRect>) {
        self.ivars().overflow.set(extent);
    }

    /// `clipPath`: where touches reach the view and its subviews.
    pub(crate) fn set_clip_path(&self, clip: Option<ClipInset>) {
        self.ivars().clip.set(clip);
    }

    /// Replaces the label of the props set last (`MountItem::AccessibilityLabel`).
    pub(crate) fn set_accessibility_label(&self, label: Option<std::sync::Arc<str>>) {
        self.ivars().props.borrow_mut().accessibility.label = label;
    }

    /// Whether the view says nothing of its own to a screen reader (no
    /// role, name, value, help, actions or press, and not made one
    /// element): a text view's inline links and views can then be elements
    /// of their own ([`crate::text_access`]).
    pub(crate) fn reads_only_content(&self) -> bool {
        let a = &self.ivars().props.borrow().accessibility;
        a.role == AccessibilityRole::None
            && a.accessible != Some(true)
            && a.label.is_none()
            && a.value.is_none()
            && a.hint.is_none()
            && a.description.is_none()
            && a.actions.is_empty()
            && !self.ivars().pressable.get()
    }

    /// `accessibilityState={{ disabled: true }}`.
    pub(crate) fn accessibility_disabled(&self) -> bool {
        self.ivars().props.borrow().accessibility.state.disabled
    }

    /// The view has press handlers.
    pub(crate) fn set_pressable(&self, pressable: bool, control: &EngineControl) {
        self.ivars().pressable.set(pressable);
        if pressable && self.ivars().control.borrow().is_none() {
            *self.ivars().control.borrow_mut() = Some(control.clone());
        }
    }

    fn has_action(&self, name: &str) -> bool {
        self.ivars()
            .props
            .borrow()
            .accessibility
            .actions
            .iter()
            .any(|a| &*a.name == name)
    }

    fn standard_action(&self, name: &str) {
        if self.has_action(name)
            && let Some(control) = self.ivars().control.borrow().as_ref()
        {
            if matches!(name, "increment" | "decrement") {
                *self.ivars().step.borrow_mut() = Some(None);
            }
            action(control, self.tag() as NodeId, name);
        }
    }
}

fn action(control: &EngineControl, id: NodeId, name: &str) {
    control.dispatch_event(
        id,
        EventKind::AccessibilityAction,
        EventPayload::Map(vec![("actionName", PayloadValue::Str(name.to_owned()))]),
    );
}

/// Actions VoiceOver performs with gestures rather than from the actions
/// menu.
fn is_standard_action(name: &str) -> bool {
    matches!(
        name,
        "activate" | "increment" | "decrement" | "magicTap" | "escape"
    )
}

/// The element steps its value (`increment` / `decrement` among its
/// actions): VoiceOver performs those (swipe up / down) only on adjustable
/// elements, whatever their role.
fn steps(a: &Accessibility) -> bool {
    a.actions
        .iter()
        .any(|x| matches!(&*x.name, "increment" | "decrement"))
}

/// Whether a view is one element for VoiceOver, which then does not move
/// into it. A container's label names the group VoiceOver enters, not one
/// element that would hide what is inside it.
fn is_element(a: &Accessibility, pressable: bool) -> bool {
    !a.hidden
        && a.accessible
            .unwrap_or_else(|| pressable || (a.label.is_some() && !is_container(a)))
}

/// Roles of groups whose elements stay VoiceOver's own: a semantic
/// group, which VoiceOver names by its label as it moves into it. A
/// dialog is one (UIKit has no dialog trait): its title is said as the
/// focus enters it, and its controls stay reachable, and so is a tab's
/// panel (UIKit has no tab panel trait either). So is a list: a labelled
/// list names its items, which are reached one by one.
fn is_container(a: &Accessibility) -> bool {
    matches!(
        a.role,
        AccessibilityRole::List
            | AccessibilityRole::Listbox
            | AccessibilityRole::Group
            | AccessibilityRole::Region
            | AccessibilityRole::Navigation
            | AccessibilityRole::Tree
            | AccessibilityRole::Toolbar
            | AccessibilityRole::Radiogroup
            | AccessibilityRole::Tablist
            | AccessibilityRole::Dialog
            | AccessibilityRole::AlertDialog
            | AccessibilityRole::TabPanel
    )
}

/// How VoiceOver presents a container: a list as a list (it says where
/// the list starts and ends), the other containers as semantic groups.
fn container_type(a: &Accessibility) -> UIAccessibilityContainerType {
    match a.role {
        AccessibilityRole::List | AccessibilityRole::Listbox => UIAccessibilityContainerType::List,
        _ if is_container(a) => UIAccessibilityContainerType::SemanticGroup,
        _ => UIAccessibilityContainerType::None,
    }
}

/// The traits of `props`' role, state and actions.
fn traits(props: &ViewProps) -> UIAccessibilityTraits {
    let a = &props.accessibility;
    // SAFETY: immutable UIKit constants.
    unsafe {
        let mut t = match a.role {
            AccessibilityRole::Button
            | AccessibilityRole::ImageButton
            | AccessibilityRole::Checkbox
            | AccessibilityRole::Radio
            | AccessibilityRole::Switch
            | AccessibilityRole::Tab
            | AccessibilityRole::Menuitem
            | AccessibilityRole::MenuItemCheckbox
            | AccessibilityRole::MenuItemRadio
            // UIKit has no tree item trait: an item is expanded or chosen
            // by activating it.
            | AccessibilityRole::TreeItem
            // UIKit has no option trait: an option is chosen by activating
            // it, and the selected one carries the Selected trait below.
            | AccessibilityRole::Option => UIAccessibilityTraitButton,
            AccessibilityRole::Link => UIAccessibilityTraitLink,
            AccessibilityRole::Search => UIAccessibilityTraitSearchField,
            // UIKit has no text field trait: a native text field is one by
            // its class, and a view given the role keeps no trait of its own.
            AccessibilityRole::Textbox => UIAccessibilityTraitNone,
            AccessibilityRole::Image => UIAccessibilityTraitImage,
            AccessibilityRole::KeyboardKey => UIAccessibilityTraitKeyboardKey,
            AccessibilityRole::Text => UIAccessibilityTraitStaticText,
            AccessibilityRole::Adjustable | AccessibilityRole::Spinbutton => {
                UIAccessibilityTraitAdjustable
            }
            AccessibilityRole::Header | AccessibilityRole::ColumnHeader => {
                UIAccessibilityTraitHeader
            }
            AccessibilityRole::Summary => UIAccessibilityTraitSummaryElement,
            AccessibilityRole::Progressbar | AccessibilityRole::Timer => {
                UIAccessibilityTraitUpdatesFrequently
            }
            _ => UIAccessibilityTraitNone,
        };
        if a.role == AccessibilityRole::ImageButton {
            t |= UIAccessibilityTraitImage;
        }
        if steps(a) {
            t |= UIAccessibilityTraitAdjustable;
        }
        if a.state.disabled {
            t |= UIAccessibilityTraitNotEnabled;
        }
        // A toggle button that is on reads as selected, as WebKit reads
        // ARIA's `aria-pressed` (UIKit's toggle trait is iOS 17's).
        if a.state.selected || a.state.pressed == Some(Checked::True) {
            t |= UIAccessibilityTraitSelected;
        }
        if a.state.busy {
            t |= UIAccessibilityTraitUpdatesFrequently;
        }
        t
    }
}

/// The spoken value with the state spoken in `words`
/// (`NshView::a11y_value`).
fn state_value(props: &ViewProps, words: &crate::state_words::StateWords) -> Option<String> {
    let a = &props.accessibility;
    let mut parts: Vec<String> = Vec::new();
    if let Some(v) = &a.value {
        if let Some(text) = &v.text {
            parts.push(text.to_string());
        } else if let Some(now) = v.now {
            match (v.min, v.max) {
                (Some(min), Some(max)) if max > min => {
                    parts.push(format!(
                        "{}%",
                        (((now - min) / (max - min)) * 100.0).round()
                    ));
                }
                _ => parts.push(format!("{now}")),
            }
        }
    }
    match a.state.checked {
        Some(Checked::True) => parts.push(words.checked.into()),
        Some(Checked::False) => parts.push(words.not_checked.into()),
        Some(Checked::Mixed) => parts.push(words.mixed.into()),
        None => {}
    }
    if a.state.pressed == Some(Checked::Mixed) {
        parts.push(words.mixed.into());
    }
    match a.state.expanded {
        Some(true) => parts.push(words.expanded.into()),
        Some(false) => parts.push(words.collapsed.into()),
        None => {}
    }
    if let Some(current) = a.state.current {
        let kind = match current {
            AccessibilityCurrent::True => 0,
            AccessibilityCurrent::Page => 1,
            AccessibilityCurrent::Step => 2,
            AccessibilityCurrent::Location => 3,
            AccessibilityCurrent::Date => 4,
            AccessibilityCurrent::Time => 5,
        };
        parts.push(words.current[kind].into());
    }
    // ARIA's `aria-invalid`, read after the value as WebKit reads it.
    if a.state.invalid {
        parts.push(words.invalid.into());
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// Appends the accessibility labels of the text inside `view`.
fn collect_text(view: &UIView, out: &mut String) {
    for child in view.subviews().iter() {
        if child.isHidden() {
            continue;
        }
        // SAFETY: an NSObject; asking whether it is a text view.
        let is_text: bool =
            unsafe { msg_send![&*child, isKindOfClass: crate::text_view::TextView::class()] };
        if is_text {
            let label: Option<Retained<NSString>> =
                unsafe { msg_send![&*child, accessibilityLabel] };
            if let Some(label) = label {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&label.to_string());
            }
        } else {
            collect_text(&child, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nsh_core::AccessibilityActionDef;

    use super::*;

    fn props(role: AccessibilityRole, actions: &[&str]) -> ViewProps {
        let mut props = ViewProps::default();
        props.accessibility.role = role;
        props.accessibility.actions = actions
            .iter()
            .map(|name| AccessibilityActionDef {
                name: Arc::from(*name),
                label: None,
            })
            .collect();
        props
    }

    /// `increment` / `decrement` add the adjustable trait to the role's.
    #[test]
    fn stepping_actions_make_the_element_adjustable() {
        // SAFETY: immutable UIKit constants.
        let (image, adjustable, button) = unsafe {
            (
                UIAccessibilityTraitImage,
                UIAccessibilityTraitAdjustable,
                UIAccessibilityTraitButton,
            )
        };
        let traits_of = |role, actions: &[&str]| traits(&props(role, actions));
        assert_eq!(
            traits_of(AccessibilityRole::Image, &["increment", "decrement"]),
            image | adjustable
        );
        assert_eq!(
            traits_of(AccessibilityRole::Image, &["decrement"]),
            image | adjustable
        );
        assert_eq!(
            traits_of(AccessibilityRole::None, &["increment"]),
            adjustable
        );
        assert_eq!(traits_of(AccessibilityRole::Adjustable, &[]), adjustable);
        // UIKit has no text field trait to give a text box.
        assert_eq!(traits_of(AccessibilityRole::Textbox, &[]), 0);
        // Without them every role keeps its traits.
        assert_eq!(traits_of(AccessibilityRole::Image, &[]), image);
        assert_eq!(
            traits_of(AccessibilityRole::Button, &["activate", "archive"]),
            button
        );
        assert_eq!(traits_of(AccessibilityRole::None, &["magicTap"]), 0);
    }

    /// A toggle button that is on is selected; its mixed state and a
    /// current item are spoken in the value.
    #[test]
    fn pressed_and_current_states() {
        let en = crate::state_words::for_language("en");
        // SAFETY: immutable UIKit constants.
        let (button, selected) =
            unsafe { (UIAccessibilityTraitButton, UIAccessibilityTraitSelected) };
        let mut on = props(AccessibilityRole::Button, &[]);
        on.accessibility.state.pressed = Some(Checked::True);
        assert_eq!(traits(&on), button | selected);
        assert_eq!(state_value(&on, en), None);
        let mut mixed = props(AccessibilityRole::Button, &[]);
        mixed.accessibility.state.pressed = Some(Checked::Mixed);
        assert_eq!(traits(&mixed), button);
        assert_eq!(state_value(&mixed, en).as_deref(), Some("mixed"));
        let mut page = props(AccessibilityRole::Link, &[]);
        page.accessibility.state.current = Some(AccessibilityCurrent::Page);
        assert_eq!(state_value(&page, en).as_deref(), Some("current page"));
        let zh = crate::state_words::for_language("zh-Hans");
        assert_eq!(state_value(&page, zh).as_deref(), Some("当前页面"));
        page.accessibility.state.invalid = true;
        page.accessibility.state.expanded = Some(false);
        assert_eq!(
            state_value(&page, zh).as_deref(),
            Some("已收起, 当前页面, 数据无效")
        );
        // Groups and toolbars are containers (a labelled toolbar names the
        // controls VoiceOver enters), others are not.
        assert!(is_container(
            &props(AccessibilityRole::Navigation, &[]).accessibility
        ));
        assert!(is_container(
            &props(AccessibilityRole::Toolbar, &[]).accessibility
        ));
        // A labelled radio group names the set, its radios still reached.
        assert!(is_container(
            &props(AccessibilityRole::Radiogroup, &[]).accessibility
        ));
        // A labelled tab list names the list, its tabs still reached.
        assert!(is_container(
            &props(AccessibilityRole::Tablist, &[]).accessibility
        ));
        // A labelled dialog names what VoiceOver enters, never hiding it.
        assert!(is_container(
            &props(AccessibilityRole::Dialog, &[]).accessibility
        ));
        assert!(is_container(
            &props(AccessibilityRole::AlertDialog, &[]).accessibility
        ));
        // A tab's panel keeps its content reachable.
        assert!(is_container(
            &props(AccessibilityRole::TabPanel, &[]).accessibility
        ));
        assert!(!is_container(
            &props(AccessibilityRole::Button, &[]).accessibility
        ));
    }

    /// A labelled list is a list VoiceOver moves into, not one element
    /// that hides its items; other containers stay semantic groups.
    #[test]
    fn labelled_lists_are_list_containers() {
        let labelled = |role| {
            let mut props = props(role, &[]);
            props.accessibility.label = Some(Arc::from("Ideas"));
            props.accessibility
        };
        for role in [AccessibilityRole::List, AccessibilityRole::Listbox] {
            assert!(!is_element(&labelled(role), false), "{role:?}");
            // Made one element, or pressed as a whole, it stays one.
            let mut one = labelled(role);
            one.accessible = Some(true);
            assert!(is_element(&one, false), "{role:?}");
            assert!(is_element(&labelled(role), true), "{role:?}");
            assert_eq!(
                container_type(&labelled(role)),
                UIAccessibilityContainerType::List,
                "{role:?}"
            );
        }
        // A labelled view that is not a container is still one element.
        assert!(is_element(&labelled(AccessibilityRole::Image), false));
        assert_eq!(
            container_type(&labelled(AccessibilityRole::Group)),
            UIAccessibilityContainerType::SemanticGroup
        );
        assert_eq!(
            container_type(&labelled(AccessibilityRole::Button)),
            UIAccessibilityContainerType::None
        );
    }
}
