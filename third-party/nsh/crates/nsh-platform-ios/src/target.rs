//! The Objective-C object receiving every native callback of a surface:
//! gesture actions, pull-to-refresh, scroll view and text input delegate
//! calls and display link ticks. Views are identified by their `tag` (the node id).

use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_core::{
    EventKind, EventMask, EventPayload, KeyboardTaps, NodeId, SubmitBehavior,
    geometry::{point, px},
};
use nsh_engine::EngineControl;
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_core_foundation::CGPoint;
use objc2_foundation::{NSObject, NSObjectProtocol, NSRange, NSString};
use objc2_quartz_core::CADisplayLink;
use objc2_ui_kit::{
    UIControl, UIGestureRecognizer, UIGestureRecognizerDelegate, UIGestureRecognizerState,
    UIInteraction, UIPanGestureRecognizer, UIPinchGestureRecognizer, UIPointerInteractionDelegate,
    UIRefreshControl, UIRotationGestureRecognizer, UIScrollView, UIScrollViewDelegate,
    UITapGestureRecognizer, UITextField, UITextFieldDelegate, UITextView, UITextViewDelegate,
    UITouch, UIView, UIWindow,
};

use crate::{
    input,
    mount::SharedMounter,
    press::{PressAt, PressRecognizer},
};

pub(crate) struct TargetIvars {
    control: EngineControl,
    mounter: SharedMounter,
    /// Scrolls the core asked for that each scroll view applied, reported
    /// with its offsets (`EngineControl::scroll`).
    scrolls_applied: std::cell::RefCell<rustc_hash::FxHashMap<NodeId, u32>>,
    /// The app's keyboard shortcuts, matched as keys are pressed.
    keymap: crate::keymap::KeymapState,
    /// Hardware keys a focused custom view holds and its modifiers.
    keyboard: crate::keyboard::Keyboard,
    /// The scroll views of the surface the embedding app may watch
    /// ([`crate::scroll_watch`]).
    scrolls: crate::scroll_watch::SurfaceScrolls,
    /// A press of the current touch became a long press: it is no tap that
    /// dismisses the keyboard.
    held: std::cell::Cell<bool>,
    /// The touch on a scroll view whose `keyboardShouldPersistTaps` is
    /// "never", where it went down in the window and when: if it is a tap,
    /// it only dismisses the keyboard.
    tap_start: std::cell::RefCell<Option<(Retained<UITouch>, CGPoint, f64)>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TargetIvars]
    pub(crate) struct EventTarget;

    unsafe impl NSObjectProtocol for EventTarget {}

    impl EventTarget {
        #[unsafe(method(handlePress:))]
        fn handle_press(&self, recognizer: &PressRecognizer) {
            if recognizer.state() != UIGestureRecognizerState::Ended {
                return;
            }
            let Some(view) = recognizer.view() else { return };
            let id = view.tag() as NodeId;
            let link = recognizer.link();
            let at = recognizer.at();
            // Press out first, then the press, as in React Native.
            if recognizer.release() {
                match link {
                    Some(link) => self.link_event(&link, EventKind::Press, id, at),
                    None => self.with_mounter(move |m| m.pressed(id, at)),
                }
            }
        }

        /// A tap on a `focusable` view that takes no presses: the non-claiming
        /// focus recognizer gives it the keyboard focus.
        #[unsafe(method(handleFocusTap:))]
        fn handle_focus_tap(&self, recognizer: &UITapGestureRecognizer) {
            if recognizer.state() != UIGestureRecognizerState::Ended {
                return;
            }
            let Some(view) = recognizer.view() else { return };
            let id = view.tag() as NodeId;
            self.with_mounter(move |m| m.focus_node(id));
        }

        #[unsafe(method(handleHover:))]
        fn handle_hover(&self, recognizer: &objc2_ui_kit::UIHoverGestureRecognizer) {
            let Some(view) = recognizer.view() else { return };
            let id = view.tag() as NodeId;
            let state = recognizer.state();
            let in_window = recognizer.locationInView(None);
            // SAFETY: UIGestureRecognizer's `modifierFlags` (iOS 13.4), a
            // UIKeyModifierFlags (NSInteger).
            let modifiers: isize = unsafe { msg_send![recognizer, modifierFlags] };
            self.with_mounter(move |m| m.hover(id, state, in_window, modifiers));
        }

        #[unsafe(method(handleContextMenu:))]
        fn handle_context_menu(&self, recognizer: &UITapGestureRecognizer) {
            if recognizer.state() != UIGestureRecognizerState::Ended {
                return;
            }
            let Some(view) = recognizer.view() else { return };
            let id = view.tag() as NodeId;
            let in_window = recognizer.locationInView(None);
            // SAFETY: UIGestureRecognizer's `modifierFlags` (iOS 13.4), a
            // UIKeyModifierFlags (NSInteger).
            let modifiers: isize = unsafe { msg_send![recognizer, modifierFlags] };
            self.with_mounter(move |m| m.context_menu(id, in_window, modifiers));
        }

        #[unsafe(method(handlePinch:))]
        fn handle_pinch(&self, recognizer: &UIPinchGestureRecognizer) {
            let Some(view) = recognizer.view() else { return };
            let (id, state) = (view.tag() as NodeId, recognizer.state());
            let (scale, velocity) = (recognizer.scale(), recognizer.velocity());
            self.with_mounter(move |m| m.transform_gesture(id, false, state, scale, velocity));
        }

        #[unsafe(method(handleRotation:))]
        fn handle_rotation(&self, recognizer: &UIRotationGestureRecognizer) {
            let Some(view) = recognizer.view() else { return };
            let (id, state) = (view.tag() as NodeId, recognizer.state());
            let (angle, velocity) = (recognizer.rotation(), recognizer.velocity());
            self.with_mounter(move |m| m.transform_gesture(id, true, state, angle, velocity));
        }

        #[unsafe(method(frame:))]
        fn frame(&self, _link: &CADisplayLink) {
            self.with_mounter(|m| m.frame());
        }

        #[unsafe(method(handlePan:))]
        fn handle_pan(&self, recognizer: &UIPanGestureRecognizer) {
            let Some(view) = recognizer.view() else { return };
            let superview = view.superview();
            let t = recognizer.translationInView(superview.as_deref());
            let v = recognizer.velocityInView(superview.as_deref());
            let id = view.tag() as NodeId;
            let state = recognizer.state();
            self.with_mounter(move |m| m.pan(id, state, t, v));
        }

        #[unsafe(method(handleRefresh:))]
        fn handle_refresh(&self, control: &UIRefreshControl) {
            // The control names its scroll view (`refresh_owner`): UIKit
            // may move it into an untagged container (iOS 26 under a large
            // title), so its superview may name nothing.
            let id = crate::mount::refresh_owner(control);
            let control = MainThreadBound::new(control.retain(), self.mtm());
            self.with_mounter(move |m| {
                let mtm = MainThreadMarker::new().expect("main thread");
                m.refresh_pulled(id, control.get(mtm));
            });
        }

        #[unsafe(method(dismissKeyboard:))]
        fn dismiss_keyboard(&self, _recognizer: &UITapGestureRecognizer) {
            self.with_mounter(|m| m.dismiss_keyboard());
        }

        #[unsafe(method(tick:))]
        fn tick(&self, _link: &CADisplayLink) {
            self.with_mounter(|m| m.tick());
        }

        #[unsafe(method(shaderFrame:))]
        fn shader_frame(&self, _link: &CADisplayLink) {
            self.with_mounter(|m| m.shader_frame());
        }

        #[unsafe(method(textColorFrame:))]
        fn text_color_frame(&self, _link: &CADisplayLink) {
            self.with_mounter(|m| m.text_color_frame());
        }

        #[unsafe(method(handleEditingChanged:))]
        fn handle_editing_changed(&self, field: &UITextField) {
            // Read now: a deferred call must report this edit's text.
            let text = field.text().map(|t| t.to_string()).unwrap_or_default();
            let marked = input::marked_text(field);
            let id = field.tag() as NodeId;
            self.with_mounter(move |m| m.input_edited(id, text, marked));
        }
    }

    unsafe impl UIPointerInteractionDelegate for EventTarget {
        #[unsafe(method_id(pointerInteraction:styleForRegion:))]
        fn pointer_style(
            &self,
            interaction: &objc2_ui_kit::UIPointerInteraction,
            _region: &objc2_ui_kit::UIPointerRegion,
        ) -> Option<Retained<objc2_ui_kit::UIPointerStyle>> {
            let id = interaction.view().map(|v| v.tag() as NodeId);
            match (id, self.ivars().mounter.get(self.mtm()).try_borrow()) {
                (Some(id), Ok(m)) => m.as_ref().and_then(|m| m.pointer_style(id)),
                _ => None,
            }
        }
    }

    unsafe impl UITextFieldDelegate for EventTarget {
        #[unsafe(method(textFieldDidBeginEditing:))]
        fn text_field_did_begin(&self, field: &UITextField) {
            let id = field.tag() as NodeId;
            self.with_mounter(move |m| m.input_focused(id, true));
        }

        #[unsafe(method(textFieldDidEndEditing:))]
        fn text_field_did_end(&self, field: &UITextField) {
            let id = field.tag() as NodeId;
            self.with_mounter(move |m| m.input_focused(id, false));
        }

        #[unsafe(method(textFieldDidChangeSelection:))]
        fn text_field_did_change_selection(&self, field: &UITextField) {
            self.selection_changed(field);
            // Unmarking keeps the text and only moves the selection.
            let text = field.text().map(|t| t.to_string()).unwrap_or_default();
            self.composition(field, text);
        }

        #[unsafe(method(textFieldShouldReturn:))]
        fn text_field_should_return(&self, field: &UITextField) -> bool {
            self.key_press(field.tag() as NodeId, "Enter".to_owned());
            let text = field.text().map(|t| t.to_string()).unwrap_or_default();
            let id = field.tag() as NodeId;
            self.with_mounter(move |m| m.input_submitted(id, text));
            false
        }

        #[unsafe(method(textField:shouldChangeCharactersInRange:replacementString:))]
        fn text_field_should_change(
            &self,
            field: &UITextField,
            range: NSRange,
            replacement: &NSString,
        ) -> bool {
            let current = field.text().unwrap_or_default();
            let fits = input::fits(&current, range, replacement, input::max_length(field));
            if fits && let Some(key) = input::key_of(range, replacement) {
                self.key_press(field.tag() as NodeId, key);
            }
            fits
        }
    }

    unsafe impl UITextViewDelegate for EventTarget {
        #[unsafe(method(textViewDidChange:))]
        fn text_view_did_change(&self, view: &UITextView) {
            let text = view.text().to_string();
            let marked = input::marked_text(view);
            let id = view.tag() as NodeId;
            self.with_mounter(move |m| m.input_edited(id, text, marked));
        }

        #[unsafe(method(textViewDidChangeSelection:))]
        fn text_view_did_change_selection(&self, view: &UITextView) {
            self.selection_changed(view);
            self.composition(view, view.text().to_string());
        }

        #[unsafe(method(textViewDidBeginEditing:))]
        fn text_view_did_begin(&self, view: &UITextView) {
            let id = view.tag() as NodeId;
            self.with_mounter(move |m| m.input_focused(id, true));
        }

        #[unsafe(method(textViewDidEndEditing:))]
        fn text_view_did_end(&self, view: &UITextView) {
            let id = view.tag() as NodeId;
            self.with_mounter(move |m| m.input_focused(id, false));
        }

        #[unsafe(method(textView:shouldChangeTextInRange:replacementText:))]
        fn text_view_should_change(
            &self,
            view: &UITextView,
            range: NSRange,
            replacement: &NSString,
        ) -> bool {
            if self.area_submits(view, replacement) {
                false
            } else {
                let fits = input::fits(&view.text(), range, replacement, input::max_length(view));
                if fits && let Some(key) = input::key_of(range, replacement) {
                    self.key_press(view.tag() as NodeId, key);
                }
                fits
            }
        }
    }

    unsafe impl UIGestureRecognizerDelegate for EventTarget {
        /// Pans, pinches and rotations on the same view work together.
        #[unsafe(method(gestureRecognizer:shouldRecognizeSimultaneouslyWithGestureRecognizer:))]
        fn should_recognize_simultaneously(
            &self,
            a: &UIGestureRecognizer,
            b: &UIGestureRecognizer,
        ) -> bool {
            if let Ok(m) = self.ivars().mounter.get(self.mtm()).try_borrow()
                && let Some(m) = m.as_ref()
                && (m.pan_shares_scroll(a, b) || m.pan_shares_scroll(b, a))
            {
                return true.into();
            }
            let transform = |r: &UIGestureRecognizer| {
                r.isKindOfClass(UIPanGestureRecognizer::class())
                    || r.isKindOfClass(UIPinchGestureRecognizer::class())
                    || r.isKindOfClass(UIRotationGestureRecognizer::class())
            };
            match (a.view(), b.view()) {
                (Some(va), Some(vb)) => {
                    std::ptr::eq::<objc2_ui_kit::UIView>(&*va, &*vb) && transform(a) && transform(b)
                }
                _ => false,
            }
        }

        #[unsafe(method(gestureRecognizerShouldBegin:))]
        fn should_begin(&self, recognizer: &UIGestureRecognizer) -> bool {
            if recognizer.isKindOfClass(UITapGestureRecognizer::class())
                && self.ivars().tap_start.borrow().is_some()
            {
                return self
                    .still_tap(
                        recognizer.locationInView(None),
                        objc2_quartz_core::CACurrentMediaTime(),
                    )
                    .into();
            }
            self.pan_should_begin(recognizer)
        }

        /// Taps the views inside the scroll view recognize (a web view's
        /// link) wait for its keyboard tap to fail: a tap that only dismisses
        /// the keyboard does nothing else.
        #[unsafe(method(gestureRecognizer:shouldBeRequiredToFailByGestureRecognizer:))]
        fn required_to_fail_by(&self, recognizer: &UIGestureRecognizer, other: &UIGestureRecognizer) -> bool {
            recognizer.isKindOfClass(UITapGestureRecognizer::class())
                && other.isKindOfClass(UITapGestureRecognizer::class())
                && match (recognizer.view(), other.view()) {
                    (Some(scroll), Some(inside)) => {
                        !std::ptr::eq::<UIView>(&*scroll, &*inside) && inside.isDescendantOfView(&scroll)
                    }
                    _ => false,
                }
        }

        /// The keyboard tap of scroll views only sees taps that dismiss the
        /// keyboard (`keyboardShouldPersistTaps`).
        #[unsafe(method(gestureRecognizer:shouldReceiveTouch:))]
        fn should_receive_touch(&self, recognizer: &UIGestureRecognizer, touch: &UITouch) -> bool {
            if recognizer.isKindOfClass(UIPanGestureRecognizer::class())
                && let (Some(view), Some(touched)) = (recognizer.view(), touch.view())
                && let Ok(mut m) = self.ivars().mounter.get(self.mtm()).try_borrow_mut()
                && let Some(m) = m.as_mut()
            {
                m.pan_touch(view.tag() as NodeId, &touched);
            }
            if !recognizer.isKindOfClass(UITapGestureRecognizer::class()) {
                return true.into();
            }
            self.ivars().held.set(false);
            let dismisses = self.tap_dismisses_keyboard(touch);
            let never = touch
                .view()
                .is_some_and(|v| self.keyboard_tap(&v) == Some(KeyboardTaps::Never));
            *self.ivars().tap_start.borrow_mut() = (dismisses && never)
                .then(|| (touch.retain(), touch.locationInView(None), touch.timestamp()));
            dismisses
        }
    }

    unsafe impl UIScrollViewDelegate for EventTarget {
        #[unsafe(method(scrollViewDidScroll:))]
        fn scroll_view_did_scroll(&self, scroll: &UIScrollView) {
            let id = scroll.tag() as NodeId;
            let offset = scroll.contentOffset();
            if let Ok(m) = self.ivars().mounter.get(self.mtm()).try_borrow()
                && let Some(m) = m.as_ref()
            {
                let clamped = m.pan_scroll_offset(scroll, offset);
                if clamped != offset {
                    scroll.setContentOffset(clamped);
                    return;
                }
            }
            // Lists need offsets to pick rows; the engine coalesces them.
            let applied = self.ivars().scrolls_applied.borrow().get(&id).copied().unwrap_or(0);
            self.ivars()
                .control
                .scroll(id, point(px(offset.x as f32), px(offset.y as f32)), applied);
            self.with_mounter(move |m| m.scrolled(id, offset));
            // The host's handle hears it in this frame, without the mounter
            // (its listener may scroll, which calls back in).
            self.ivars().scrolls.scrolled(id);
            // A text area scrolling moves its caret, and a built-in bar's
            // thumb.
            if scroll.downcast_ref::<input::Area>().is_some() {
                self.caret_moved(scroll);
                self.input_scrolled(scroll);
            }
        }

        /// Zoomable scroll views zoom their zoom view.
        #[unsafe(method_id(viewForZoomingInScrollView:))]
        fn view_for_zooming(&self, scroll: &UIScrollView) -> Option<Retained<UIView>> {
            crate::zoom::zoom_view(scroll)
        }

        #[unsafe(method(scrollViewDidZoom:))]
        fn scroll_view_did_zoom(&self, scroll: &UIScrollView) {
            let id = scroll.tag() as NodeId;
            self.ivars().control.zoom(id, scroll.zoomScale() as f32);
            self.with_mounter(move |m| m.zoomed(id));
            // The new scale goes out with an offset report.
            let offset = scroll.contentOffset();
            let applied = self.ivars().scrolls_applied.borrow().get(&id).copied().unwrap_or(0);
            self.ivars()
                .control
                .scroll(id, point(px(offset.x as f32), px(offset.y as f32)), applied);
        }

        #[unsafe(method(scrollViewDidEndZooming:withView:atScale:))]
        fn scroll_view_did_end_zooming(
            &self,
            _scroll: &UIScrollView,
            view: Option<&UIView>,
            scale: objc2_core_foundation::CGFloat,
        ) {
            if let Some(view) = view {
                crate::zoom::sharpen(view, scale);
            }
        }

        #[unsafe(method(scrollViewDidEndDecelerating:))]
        fn scroll_view_did_end_decelerating(&self, scroll: &UIScrollView) {
            self.scroll_event(scroll, EventKind::MomentumEnd);
            self.scroll_event(scroll, EventKind::ScrollEnd);
        }

        #[unsafe(method(scrollViewWillBeginDragging:))]
        fn scroll_view_will_begin_dragging(&self, scroll: &UIScrollView) {
            // The scroll view takes the touches from JS responders.
            self.with_mounter(|m| m.cancel_touches());
            // Caught while gliding: the glide ended.
            if scroll.isDecelerating() {
                self.scroll_event(scroll, EventKind::MomentumEnd);
            }
            self.scroll_event(scroll, EventKind::ScrollDragStart);
        }

        /// Snaps a fling to `snapToInterval` / `snapToOffsets` / pages.
        #[unsafe(method(scrollViewWillEndDragging:withVelocity:targetContentOffset:))]
        fn scroll_view_will_end_dragging(
            &self,
            scroll: &UIScrollView,
            velocity: CGPoint,
            target: std::ptr::NonNull<CGPoint>,
        ) {
            let id = scroll.tag() as NodeId;
            // SAFETY: UIKit passes a valid pointer for the call's duration.
            let proposed = unsafe { target.read() };
            let snapped = match self.ivars().mounter.get(self.mtm()).try_borrow() {
                // UIKit's velocity is in points per millisecond.
                Ok(m) => m.as_ref().and_then(|m| {
                    let clamped = m.pan_scroll_offset(scroll, proposed);
                    if clamped != proposed { Some(clamped) } else { m.snap_target(id, velocity, proposed) }
                }),
                Err(_) => None,
            };
            if let Some(p) = snapped {
                // SAFETY: as above.
                unsafe { target.write(p) };
            }
        }

        #[unsafe(method(scrollViewDidEndDragging:willDecelerate:))]
        fn scroll_view_did_end_dragging(&self, scroll: &UIScrollView, decelerate: bool) {
            let (id, offset) = (scroll.tag() as NodeId, scroll.contentOffset());
            self.with_mounter(move |m| m.drag_ended(id, offset));
            self.scroll_event(scroll, EventKind::ScrollDragEnd);
            if decelerate {
                self.scroll_event(scroll, EventKind::MomentumStart);
            } else {
                self.scroll_event(scroll, EventKind::ScrollEnd);
            }
        }
    }
);

/// How far a tap that dismisses the keyboard may move (points).
const TAP_MOVEMENT: f64 = 10.0;

/// A tap on a scroll view that dismisses the keyboard; its delegate
/// (`gestureRecognizer:shouldReceiveTouch:`) lets through only taps that
/// should.
pub(crate) fn keyboard_tap_recognizer(
    mtm: MainThreadMarker,
    target: &Retained<EventTarget>,
) -> Retained<UITapGestureRecognizer> {
    // SAFETY: `dismissKeyboard:` is implemented by the target, which
    // outlives the scroll view.
    let tap = unsafe {
        UITapGestureRecognizer::initWithTarget_action(
            UITapGestureRecognizer::alloc(mtm),
            Some(target),
            Some(objc2::sel!(dismissKeyboard:)),
        )
    };
    // The views under a tap that only dismisses the keyboard get a cancel.
    tap.setCancelsTouchesInView(true);
    tap.setDelegate(Some(ProtocolObject::from_ref(&**target)));
    tap
}

/// Whether `view` is (in) a text input.
fn on_input(view: &UIView) -> bool {
    let mut current = Some(view.retain());
    while let Some(v) = current {
        if v.isKindOfClass(UITextField::class()) || v.isKindOfClass(UITextView::class()) {
            return true;
        }
        if v.isKindOfClass(UIScrollView::class()) {
            return false;
        }
        current = v.superview();
    }
    false
}

/// Whether something under the touch handles it: a pressable, a control
/// or an input.
fn handles_touches(view: &UIView) -> bool {
    let mut current = Some(view.retain());
    while let Some(v) = current {
        if v.isKindOfClass(UIControl::class())
            || v.isKindOfClass(UITextField::class())
            || v.isKindOfClass(UITextView::class())
        {
            return true;
        }
        if let Some(recognizers) = v.gestureRecognizers()
            && recognizers
                .iter()
                .any(|r| r.isEnabled() && r.isKindOfClass(PressRecognizer::class()))
        {
            return true;
        }
        if v.isKindOfClass(UIScrollView::class()) {
            return false;
        }
        current = v.superview();
    }
    false
}

impl EventTarget {
    pub(crate) fn new(
        mtm: MainThreadMarker,
        control: EngineControl,
        mounter: SharedMounter,
        scrolls: crate::scroll_watch::SurfaceScrolls,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TargetIvars {
            control,
            mounter,
            scrolls_applied: Default::default(),
            keymap: Default::default(),
            keyboard: Default::default(),
            scrolls,
            held: Default::default(),
            tap_start: Default::default(),
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    /// Counts a scroll the core asked for, before applying it (UIKit
    /// reports the new offset synchronously).
    pub(crate) fn scroll_applied(&self, id: NodeId) {
        *self
            .ivars()
            .scrolls_applied
            .borrow_mut()
            .entry(id)
            .or_default() += 1;
    }

    /// Reports how far text area `view` scrolled, if a built-in bar takes
    /// the place of its indicator and it changed (`input::report_scroll`).
    pub(crate) fn input_scrolled(&self, view: &UIView) {
        input::report_scroll(view, &self.ivars().control);
    }

    /// Forgets a deleted scroll view.
    pub(crate) fn scroll_deleted(&self, id: NodeId) {
        self.ivars().scrolls_applied.borrow_mut().remove(&id);
    }

    /// The user gave the surface input with `modality` (a finger going
    /// down, a hardware key): told before it acts, so the focus it moves
    /// shows or not (`focus-visible:`).
    pub(crate) fn input_with(&self, modality: nsh_core::platform::InputModality) {
        self.ivars().control.set_input_modality(modality);
    }

    /// The app's keyboard shortcuts.
    pub(crate) fn keymap(&self) -> &crate::keymap::KeymapState {
        &self.ivars().keymap
    }

    /// The hardware keys a focused custom view holds, and its modifiers.
    pub(crate) fn keyboard(&self) -> &crate::keyboard::Keyboard {
        &self.ivars().keyboard
    }

    /// Whether the focused view `id` or a logical ancestor listens to raw
    /// keys or mounts a capture rule (scroll views included).
    pub(crate) fn listens_keys(&self, id: NodeId) -> bool {
        let mtm = self.mtm();
        match self.ivars().mounter.get(mtm).try_borrow() {
            Ok(m) => m.as_ref().is_some_and(|m| m.listens_keys(id)),
            Err(_) => false,
        }
    }

    /// Whether the focused view `id` or a logical ancestor captures
    /// `stroke` under its mounted `capture_keys`.
    pub(crate) fn captures_stroke(
        &self,
        id: NodeId,
        stroke: Option<&nsh_core::keymap::Keystroke>,
    ) -> bool {
        let mtm = self.mtm();
        match self.ivars().mounter.get(mtm).try_borrow() {
            Ok(m) => m.as_ref().is_some_and(|m| m.captures_stroke(id, stroke)),
            Err(_) => false,
        }
    }

    /// The keyboard focus entered or left custom view `id`: the view's
    /// `FOCUSED` state and its `onFocus` / `onBlur` event. A loss forgets
    /// the keys held there, without inventing their releases.
    pub(crate) fn view_focused(&self, id: NodeId, focused: bool, events: EventMask) {
        if !focused {
            self.ivars().keyboard.clear();
        }
        self.with_mounter(move |m| m.view_focused(id, focused));
        let kind = if focused {
            EventKind::Focus
        } else {
            EventKind::Blur
        };
        if events.contains(kind) {
            self.dispatch(id, kind, EventPayload::None);
        }
    }

    /// After `view` (a focused custom view) resigns: on the next turn,
    /// where `view`'s scope is the surface root and no view in its window
    /// is first responder, the root takes the keyboard back. Deferred so a
    /// transfer to an input, a hosted view or another custom view is never
    /// stolen; a modal's scope or another window is left alone.
    pub(crate) fn restore_root_focus_for(&self, view: &UIView) {
        let Some(window) = view.window() else { return };
        let mtm = self.mtm();
        let target = MainThreadBound::new(Weak::from(self), mtm);
        let view = MainThreadBound::new(Weak::from(view), mtm);
        let window = MainThreadBound::new(window, mtm);
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue");
            let Some(target) = target.into_inner(mtm).load() else {
                return;
            };
            let Some(view) = view.into_inner(mtm).load() else {
                return;
            };
            let root = match target.ivars().mounter.get(mtm).try_borrow() {
                Ok(m) => m.as_ref().and_then(|m| m.root_view_of(&view)),
                Err(_) => None,
            };
            if let Some(root) = root {
                let window = window.into_inner(mtm);
                crate::keyboard::root_focus_if_none(&root, &window);
            }
        });
    }

    /// The root (the surface's, not a modal's) takes the keyboard back
    /// once the removal or the input blur that left the window without a
    /// responder has settled; another responder that took the focus in the
    /// meantime keeps it.
    pub(crate) fn restore_root_focus(&self, root: Retained<UIView>, window: Retained<UIWindow>) {
        let mtm = self.mtm();
        let root = MainThreadBound::new(root, mtm);
        let window = MainThreadBound::new(window, mtm);
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue");
            let root = root.into_inner(mtm);
            let window = window.into_inner(mtm);
            crate::keyboard::root_focus_if_none(&root, &window);
        });
    }

    /// The native view whose subtree Tab walks from `view`: the modal view
    /// it is in, else the surface's root view, so a Tab never reaches the
    /// stops a presented modal covers. `None` when neither is known (the
    /// caller falls back to the window).
    pub(crate) fn focus_scope(&self, view: &UIView) -> Option<Retained<UIView>> {
        let mtm = self.mtm();
        match self.ivars().mounter.get(mtm).try_borrow() {
            Ok(m) => m.as_ref().and_then(|m| m.focus_scope(view)),
            Err(_) => None,
        }
    }

    pub(crate) fn dispatch(&self, id: NodeId, event: EventKind, payload: EventPayload) {
        self.ivars().control.dispatch_event(id, event, payload);
    }

    fn pan_should_begin(&self, recognizer: &UIGestureRecognizer) -> bool {
        let Some(pan) = recognizer.downcast_ref::<UIPanGestureRecognizer>() else {
            return true;
        };
        let Some(view) = pan.view() else { return true };
        let velocity = pan.velocityInView(Some(&view));
        let id = view.tag() as NodeId;
        match self.ivars().mounter.get(self.mtm()).try_borrow() {
            Ok(m) => m.as_ref().is_none_or(|m| m.pan_should_begin(id, velocity)),
            Err(_) => true,
        }
    }

    /// A finger went down on (or left) pressable view `id`.
    pub(crate) fn press_changed(&self, id: NodeId, pressed: bool, at: PressAt) {
        self.with_mounter(move |m| m.press_changed(id, pressed, at));
    }

    /// A press of the current touch became a long press.
    pub(crate) fn press_held(&self) {
        self.ivars().held.set(true);
    }

    /// Whether `touch`, ending, is a tap that only dismisses the keyboard
    /// (`keyboardShouldPersistTaps` "never"): JS responders get a cancel.
    pub(crate) fn dismissing_tap(&self, touch: &UITouch) -> bool {
        let same = self
            .ivars()
            .tap_start
            .borrow()
            .as_ref()
            .is_some_and(|(t, _, _)| std::ptr::eq::<UITouch>(&**t, touch));
        same && self.still_tap(touch.locationInView(None), touch.timestamp())
    }

    /// Whether the touch `tap_start` holds, at `at` (in the window) at
    /// `time`, is still a tap: quick, not held, and it moved nothing.
    fn still_tap(&self, at: CGPoint, time: f64) -> bool {
        let Some((_, start, since)) = self.ivars().tap_start.borrow().clone() else {
            return false;
        };
        !self.ivars().held.get()
            && (at.x - start.x).hypot(at.y - start.y) <= TAP_MOVEMENT
            && time - since < crate::press::LONG_PRESS
    }

    /// A press on view `id` was held long enough.
    pub(crate) fn long_press(&self, id: NodeId, at: PressAt) {
        self.with_mounter(move |m| m.long_pressed(id, at));
    }

    /// The node under a touch on `view` and the nodes around it that listen
    /// to touches; `None` when none does.
    pub(crate) fn touch_target(
        &self,
        view: &UIView,
        point: CGPoint,
    ) -> Option<(NodeId, objc2::rc::Retained<UIView>, Vec<NodeId>)> {
        match self.ivars().mounter.get(self.mtm()).try_borrow() {
            Ok(m) => m.as_ref().and_then(|m| m.touch_target(view, point)),
            Err(_) => None,
        }
    }

    /// `onKeyPress` on input `id`.
    /// A return typed in a text area that submits (`submitBehavior`):
    /// reports it and submits instead of inserting the line break.
    fn area_submits(&self, view: &UITextView, replacement: &NSString) -> bool {
        let submits = matches!(
            input::area_submit(view),
            Some(SubmitBehavior::Submit | SubmitBehavior::BlurAndSubmit)
        );
        if !submits || replacement.to_string() != "\n" {
            return false;
        }
        let id = view.tag() as NodeId;
        self.key_press(id, "Enter".to_owned());
        let text = view.text().to_string();
        self.with_mounter(move |m| m.input_submitted(id, text));
        true
    }

    pub(crate) fn key_press(&self, id: NodeId, key: String) {
        self.with_mounter(move |m| {
            m.input_event(
                id,
                EventKind::KeyPress,
                EventPayload::Map(vec![("key", nsh_core::PayloadValue::Str(key))]),
            )
        });
    }

    /// `onSelectionChange` of the input `view` belongs to.
    fn selection_changed(&self, view: &UIView) {
        let id = view.tag() as NodeId;
        let Some((start, end)) = input::selection(view) else {
            return;
        };
        self.with_mounter(move |m| {
            m.input_event(
                id,
                EventKind::SelectionChange,
                EventPayload::Map(vec![
                    ("start", nsh_core::PayloadValue::Number(start as f64)),
                    ("end", nsh_core::PayloadValue::Number(end as f64)),
                ]),
            )
        });
        self.caret_moved(view);
    }

    /// `onPaste` of input `id`: what the user pasted.
    pub(crate) fn pasted(&self, id: NodeId, paste: nsh_core::PasteEvent) {
        self.with_mounter(move |m| {
            m.input_event(id, EventKind::Paste, EventPayload::Paste(Box::new(paste)))
        });
    }

    /// `onCaretMove` of the input `view` belongs to if its caret moved:
    /// with the selection, or as a text area scrolled or the input was laid
    /// out again, while it edits.
    pub(crate) fn caret_moved(&self, view: &UIView) {
        if !view.isFirstResponder() {
            return;
        }
        let Some(caret) = input::caret(view) else {
            return;
        };
        if !input::caret_changed(view, caret) {
            return;
        }
        let id = view.tag() as NodeId;
        self.with_mounter(move |m| {
            m.input_event(id, EventKind::CaretMove, EventPayload::caret(caret))
        });
    }

    /// The composition of the input `view` belongs to, as it is with
    /// `text` in it.
    fn composition(&self, view: &UIView, text: String) {
        let id = view.tag() as NodeId;
        let marked = input::marked_text(view);
        self.with_mounter(move |m| m.input_composition(id, text, marked));
    }

    /// A press event on a pressable text span of text view `view`.
    pub(crate) fn link_event(
        &self,
        link: &nsh_core::TextLink,
        kind: EventKind,
        view: NodeId,
        at: PressAt,
    ) {
        if link.events.contains(kind) {
            let node = link.node;
            self.with_mounter(move |m| m.link_event(node, kind, view, at));
        }
    }

    /// Touches for the JS responder system.
    pub(crate) fn touches(&self, event: Box<nsh_core::TouchEvent>) {
        self.dispatch(
            nsh_core::ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(event),
        );
    }

    fn keyboard_tap(&self, view: &UIView) -> Option<KeyboardTaps> {
        match self.ivars().mounter.get(self.mtm()).try_borrow() {
            Ok(m) => m.as_ref().and_then(|m| m.keyboard_tap(view)),
            Err(_) => None,
        }
    }

    /// Whether a tap dismisses the keyboard (when it ends without
    /// scrolling), as `keyboardShouldPersistTaps` says: "never" on anything
    /// but an input, "handled" when nothing under it handles taps.
    fn tap_dismisses_keyboard(&self, touch: &UITouch) -> bool {
        let Some(view) = touch.view() else {
            return false;
        };
        match self.keyboard_tap(&view) {
            Some(KeyboardTaps::Never) => !on_input(&view),
            Some(KeyboardTaps::Handled) => !handles_touches(&view),
            Some(KeyboardTaps::Always) | None => false,
        }
    }

    /// A press starts on `view`: true while the keyboard is up and a tap
    /// only dismisses it (`keyboardShouldPersistTaps` "never"), a long
    /// press still goes through.
    pub(crate) fn tap_only(&self, view: &UIView) -> bool {
        self.keyboard_tap(view) == Some(KeyboardTaps::Never) && !on_input(view)
    }

    /// The host stopped `scroll`'s glide ([`crate::ScrollHandle::stop_scrolling`]):
    /// UIKit reports no end of it, so the app hears it here.
    pub(crate) fn glide_stopped(&self, scroll: &UIScrollView) {
        self.scroll_event(scroll, EventKind::MomentumEnd);
        self.scroll_event(scroll, EventKind::ScrollEnd);
    }

    fn scroll_event(&self, scroll: &UIScrollView, event: EventKind) {
        if event == EventKind::ScrollEnd {
            // Snapping animated values that follow it settle.
            let id = scroll.tag() as NodeId;
            self.with_mounter(move |m| m.scroll_ended(id));
        }
        let offset = scroll.contentOffset();
        self.dispatch(
            scroll.tag() as NodeId,
            event,
            EventPayload::Scroll(nsh_core::geometry::point(
                nsh_core::Points(offset.x as f32),
                nsh_core::Points(offset.y as f32),
            )),
        );
    }

    /// Runs `f` on the mounter. UIKit can call back synchronously while the
    /// mounter applies a batch (e.g. setting `contentOffset`); then the call
    /// is deferred to the next main-queue turn instead of re-entering.
    fn with_mounter(&self, f: impl FnOnce(&mut crate::mount::Mounter) + Send + 'static) {
        let mtm = self.mtm();
        let shared = &self.ivars().mounter;
        let busy = match shared.get(mtm).try_borrow_mut() {
            Ok(mut guard) => {
                if let Some(m) = guard.as_mut() {
                    f(m);
                }
                return;
            }
            Err(_) => true,
        };
        if busy {
            let shared = shared.clone();
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                if let Some(m) = shared.get(mtm).borrow_mut().as_mut() {
                    f(m);
                }
            });
        }
    }
}
