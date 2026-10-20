//! Div is the central, reusable element that most GPUI trees will be built from.
//! It functions as a container for other elements, and provides a number of
//! useful features for laying out and styling its children as well as binding
//! mouse events and action handlers. It is meant to be similar to the HTML `<div>`
//! element, but for GPUI.
//!
//! # Build your own div
//!
//! GPUI does not directly provide APIs for stateful, multi step events like `click`
//! and `drag`. We want GPUI users to be able to build their own abstractions for
//! their own needs. However, as a UI framework, we're also obliged to provide some
//! building blocks to make the process of building your own elements easier.
//! For this we have the [`Interactivity`] and the [`StyleRefinement`] structs, as well
//! as several associated traits. Together, these provide the full suite of Dom-like events
//! and Tailwind-like styling that you can use to build your own custom elements. Div is
//! constructed by combining these two systems into an all-in-one element.

use crate::gestures::{ScrollLatch, ScrollTurn};
use crate::{
    AccessibilityClickEvent, Action, AnyDrag, AnyElement, AnyTooltip, AnyView, App, Axis, Bounds,
    ClickEvent, DispatchPhase, Display, Element, ElementId, Entity, EntityId, ExternalDragPayload,
    ExternalDragPayloadSource, FileDropEvent, FocusHandle, Global, GlobalElementId, Hitbox,
    HitboxBehavior, HitboxId, InspectorElementId, IntoElement, IsZero, KeyContext, KeyDownEvent,
    KeyUpEvent, KeyboardButton, KeyboardClickEvent, LayoutId, LongPressEvent,
    ModifiersChangedEvent, MouseButton, MouseClickEvent, MouseDownEvent, MouseExitEvent,
    MouseMoveEvent, MousePressureEvent, MouseUpEvent, OngoingScroll, Overflow, ParentElement,
    PinchEvent, Pixels, Point, Render, ScrollWheelEvent, SharedString, Size, Style,
    StyleRefinement, Styled, Task, TooltipId, TouchPhase, Visibility, Window, WindowControlArea,
    point, px, size,
};
use collections::HashMap;
use gpui_util::ResultExt;
use refineable::Refineable;
use smallvec::SmallVec;
use std::{
    any::{Any, TypeId},
    cell::{Cell, RefCell},
    cmp::Ordering,
    fmt::Debug,
    marker::PhantomData,
    mem,
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

mod scroll;
use scroll::{Attempt, ScrollLayout, ScrollPresentation};
pub use scroll::{
    ScrollCommand, ScrollObservation, ScrollReadingWitness, ScrollRequestId, ScrollRequestStatus,
    ScrollRetention,
};

use super::ImageCacheProvider;

#[cfg(feature = "stacker")]
type StackSafe<T> = stacksafe::StackSafe<T>;
#[cfg(not(feature = "stacker"))]
type StackSafe<T> = T;

const DRAG_THRESHOLD: f64 = 2.;
const DEFAULT_TOOLTIP_SHOW_DELAY: Duration = Duration::from_millis(500);
const HOVERABLE_TOOLTIP_HIDE_DELAY: Duration = Duration::from_millis(500);

/// The styling information for a given group.
pub struct GroupStyle {
    /// The identifier for this group.
    pub group: SharedString,

    /// The specific style refinement that this group would apply
    /// to its children.
    pub style: Box<StyleRefinement>,
}

/// An event for when a drag is moving over this element, with the given state type.
pub struct DragMoveEvent<T> {
    /// The mouse move event that triggered this drag move event.
    pub event: MouseMoveEvent,

    /// The bounds of this element.
    pub bounds: Bounds<Pixels>,
    drag: PhantomData<T>,
    dragged_item: Arc<dyn Any>,
}

impl<T: 'static> DragMoveEvent<T> {
    /// Returns the drag state for this event.
    pub fn drag<'b>(&self, cx: &'b App) -> &'b T {
        cx.active_drag
            .as_ref()
            .and_then(|drag| drag.value.downcast_ref::<T>())
            .expect("DragMoveEvent is only valid when the stored active drag is of the same type.")
    }

    /// An item that is about to be dropped.
    pub fn dragged_item(&self) -> &dyn Any {
        self.dragged_item.as_ref()
    }
}

impl Interactivity {
    /// Create an `Interactivity`, capturing the caller location in debug mode.
    #[cfg(any(feature = "inspector", debug_assertions))]
    #[track_caller]
    pub fn new() -> Interactivity {
        Interactivity {
            source_location: Some(core::panic::Location::caller()),
            ..Default::default()
        }
    }

    /// Create an `Interactivity`, capturing the caller location in debug mode.
    #[cfg(not(any(feature = "inspector", debug_assertions)))]
    pub fn new() -> Interactivity {
        Interactivity::default()
    }

    /// Gets the source location of construction. Returns `None` when not in debug mode.
    pub fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        #[cfg(any(feature = "inspector", debug_assertions))]
        {
            self.source_location
        }

        #[cfg(not(any(feature = "inspector", debug_assertions)))]
        {
            None
        }
    }

    /// Bind the given callback to the mouse down event for the given mouse button, during the bubble phase.
    /// The imperative API equivalent of [`InteractiveElement::on_mouse_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to the view state from this callback.
    pub fn on_mouse_down(
        &mut self,
        button: MouseButton,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_down_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble
                    && event.button == button
                    && hitbox.is_hovered(window)
                {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse down event for any button, during the capture phase.
    /// The imperative API equivalent of [`InteractiveElement::capture_any_mouse_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn capture_any_mouse_down(
        &mut self,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_down_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Capture && hitbox.is_hovered(window) {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse down event for any button, during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_any_mouse_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_any_mouse_down(
        &mut self,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_down_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse pressure event, during the bubble phase
    /// the imperative API equivalent to [`InteractiveElement::on_mouse_pressure`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_mouse_pressure(
        &mut self,
        listener: impl Fn(&MousePressureEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_pressure_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse pressure event, during the capture phase
    /// the imperative API equivalent to [`InteractiveElement::on_mouse_pressure`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn capture_mouse_pressure(
        &mut self,
        listener: impl Fn(&MousePressureEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_pressure_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Capture && hitbox.is_hovered(window) {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse up event for the given button, during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_mouse_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_mouse_up(
        &mut self,
        button: MouseButton,
        listener: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_up_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble
                    && event.button == button
                    && hitbox.is_hovered(window)
                {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse up event for any button, during the capture phase.
    /// The imperative API equivalent to [`InteractiveElement::capture_any_mouse_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn capture_any_mouse_up(
        &mut self,
        listener: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_up_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Capture && hitbox.is_hovered(window) {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse up event for any button, during the bubble phase.
    /// The imperative API equivalent to [`Interactivity::on_any_mouse_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_any_mouse_up(
        &mut self,
        listener: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_up_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse down event, on any button, during the capture phase,
    /// when the mouse is outside of the bounds of this element.
    /// The imperative API equivalent to [`InteractiveElement::on_mouse_down_out`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_mouse_down_out(
        &mut self,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_down_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Capture
                    && !window.has_active_prompt()
                    && !hitbox.contains(&window.mouse_position())
                {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to the mouse up event, for the given button, during the capture phase,
    /// when the mouse is outside of the bounds of this element.
    /// The imperative API equivalent to [`InteractiveElement::on_mouse_up_out`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_mouse_up_out(
        &mut self,
        button: MouseButton,
        listener: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_up_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Capture
                    && event.button == button
                    && !hitbox.is_hovered(window)
                {
                    (listener)(event, window, cx);
                }
            }));
    }

    /// Bind the given callback to the mouse move event, during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_mouse_move`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_mouse_move(
        &mut self,
        listener: impl Fn(&MouseMoveEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_move_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    (listener)(event, window, cx);
                }
            }));
    }

    /// Bind the given callback to the mouse exit event, during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_mouse_exit`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_mouse_exit(
        &mut self,
        listener: impl Fn(&MouseExitEvent, &mut Window, &mut App) + 'static,
    ) {
        self.mouse_exit_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    (listener)(event, window, cx);
                }
            }));
    }

    /// Bind the given callback to [`FileDropEvent::Exited`] when a platform file drag
    /// leaves this element's window while the element is hovered.
    ///
    /// This is a window-local exit event, not notification that the platform drag session ended.
    /// The imperative API equivalent to [`InteractiveElement::on_file_drop_exit`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_file_drop_exit(
        &mut self,
        listener: impl Fn(&FileDropEvent, &mut Window, &mut App) + 'static,
    ) {
        self.file_drop_exit_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble
                    && matches!(event, FileDropEvent::Exited)
                    && hitbox.id.is_hovered_ignoring_last_input(window)
                {
                    (listener)(event, window, cx);
                }
            }));
    }

    /// Bind the given callback to the mouse drag event of the given type. Note that this
    /// will be called for all move events, inside or outside of this element, as long as the
    /// drag was started with this element under the mouse. Useful for implementing draggable
    /// UIs that don't conform to a drag and drop style interaction, like resizing.
    /// The imperative API equivalent to [`InteractiveElement::on_drag_move`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_drag_move<T>(
        &mut self,
        listener: impl Fn(&DragMoveEvent<T>, &mut Window, &mut App) + 'static,
    ) where
        T: 'static,
    {
        self.mouse_move_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Capture
                    && let Some(drag) = &cx.active_drag
                    && drag.value.as_ref().type_id() == TypeId::of::<T>()
                {
                    (listener)(
                        &DragMoveEvent {
                            event: event.clone(),
                            bounds: hitbox.bounds,
                            drag: PhantomData,
                            dragged_item: Arc::clone(&drag.value),
                        },
                        window,
                        cx,
                    );
                }
            }));
    }

    /// Bind the given callback to scroll wheel events during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_scroll_wheel`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_scroll_wheel(
        &mut self,
        listener: impl Fn(&ScrollWheelEvent, &mut Window, &mut App) + 'static,
    ) {
        self.scroll_wheel_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.should_handle_scroll(window) {
                    (listener)(event, window, cx);
                }
            }));
    }

    /// Bind the given callback to pinch gesture events during the bubble phase.
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_pinch(&mut self, listener: impl Fn(&PinchEvent, &mut Window, &mut App) + 'static) {
        self.pinch_listeners
            .push(Box::new(move |event, phase, hitbox, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    (listener)(event, window, cx);
                }
            }));
    }

    /// Bind the given callback to pinch gesture events during the capture phase.
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn capture_pinch(
        &mut self,
        listener: impl Fn(&PinchEvent, &mut Window, &mut App) + 'static,
    ) {
        self.pinch_listeners
            .push(Box::new(move |event, phase, _hitbox, window, cx| {
                if phase == DispatchPhase::Capture {
                    (listener)(event, window, cx);
                } else {
                    cx.propagate();
                }
            }));
    }

    /// Bind the given callback to an action dispatch during the capture phase.
    /// The imperative API equivalent to [`InteractiveElement::capture_action`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn capture_action<A: Action>(
        &mut self,
        listener: impl Fn(&A, &mut Window, &mut App) + 'static,
    ) {
        self.action_listeners.push((
            TypeId::of::<A>(),
            Box::new(move |action, phase, window, cx| {
                let action = action.downcast_ref().unwrap();
                if phase == DispatchPhase::Capture {
                    (listener)(action, window, cx)
                } else {
                    cx.propagate();
                }
            }),
        ));
    }

    /// Bind the given callback to an action dispatch during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_action`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    #[track_caller]
    #[inline(always)]
    pub fn on_action<A: Action>(&mut self, listener: impl Fn(&A, &mut Window, &mut App) + 'static) {
        self.action_listeners.push((
            TypeId::of::<A>(),
            Box::new(move |action, phase, window, cx| {
                let action = action.downcast_ref().unwrap();
                if phase == DispatchPhase::Bubble {
                    (listener)(action, window, cx)
                }
            }),
        ));
    }

    /// Bind the given callback to an action dispatch, based on a dynamic action parameter
    /// instead of a type parameter. Useful for component libraries that want to expose
    /// action bindings to their users.
    /// The imperative API equivalent to [`InteractiveElement::on_boxed_action`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_boxed_action(
        &mut self,
        action: &dyn Action,
        listener: impl Fn(&dyn Action, &mut Window, &mut App) + 'static,
    ) {
        let action = action.boxed_clone();
        self.action_listeners.push((
            (*action).type_id(),
            Box::new(move |_, phase, window, cx| {
                if phase == DispatchPhase::Bubble {
                    (listener)(&*action, window, cx)
                }
            }),
        ));
    }

    /// Bind the given callback to key down events during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_key_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_key_down(
        &mut self,
        listener: impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static,
    ) {
        self.key_down_listeners
            .push(Box::new(move |event, phase, window, cx| {
                if phase == DispatchPhase::Bubble {
                    (listener)(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to key down events during the capture phase.
    /// The imperative API equivalent to [`InteractiveElement::capture_key_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn capture_key_down(
        &mut self,
        listener: impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static,
    ) {
        self.key_down_listeners
            .push(Box::new(move |event, phase, window, cx| {
                if phase == DispatchPhase::Capture {
                    listener(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to key up events during the bubble phase.
    /// The imperative API equivalent to [`InteractiveElement::on_key_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_key_up(&mut self, listener: impl Fn(&KeyUpEvent, &mut Window, &mut App) + 'static) {
        self.key_up_listeners
            .push(Box::new(move |event, phase, window, cx| {
                if phase == DispatchPhase::Bubble {
                    listener(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to key up events during the capture phase.
    /// The imperative API equivalent to [`InteractiveElement::on_key_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn capture_key_up(
        &mut self,
        listener: impl Fn(&KeyUpEvent, &mut Window, &mut App) + 'static,
    ) {
        self.key_up_listeners
            .push(Box::new(move |event, phase, window, cx| {
                if phase == DispatchPhase::Capture {
                    listener(event, window, cx)
                }
            }));
    }

    /// Bind the given callback to modifiers changing events.
    /// The imperative API equivalent to [`InteractiveElement::on_modifiers_changed`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_modifiers_changed(
        &mut self,
        listener: impl Fn(&ModifiersChangedEvent, &mut Window, &mut App) + 'static,
    ) {
        self.modifiers_changed_listeners.push(Box::new(listener));
    }

    /// Bind the given callback to drop events of the given type, whether or not the drag started on this element.
    /// The imperative API equivalent to [`InteractiveElement::on_drop`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_drop<T: 'static>(&mut self, listener: impl Fn(&T, &mut Window, &mut App) + 'static) {
        self.drop_listeners.push((
            TypeId::of::<T>(),
            Box::new(move |dragged_value, window, cx| {
                listener(dragged_value.downcast_ref().unwrap(), window, cx);
            }),
        ));
    }

    /// Use the given predicate to determine whether or not a drop event should be dispatched to this element.
    /// The imperative API equivalent to [`InteractiveElement::can_drop`].
    pub fn can_drop(
        &mut self,
        predicate: impl Fn(&dyn Any, &mut Window, &mut App) -> bool + 'static,
    ) {
        self.can_drop_predicate = crate::fast::interactivity::rare(Box::new(predicate));
    }

    /// Bind the given callback to click events of this element.
    /// The imperative API equivalent to [`StatefulInteractiveElement::on_click`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    #[inline(always)]
    pub fn on_click(&mut self, listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static)
    where
        Self: Sized,
    {
        self.click_listeners.push(Rc::new(listener));
    }

    /// Bind the given callback to non-primary click events of this element.
    /// The imperative API equivalent to [`StatefulInteractiveElement::on_aux_click`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_aux_click(&mut self, listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static)
    where
        Self: Sized,
    {
        self.aux_click_listeners.push(Rc::new(listener));
    }

    /// On drag initiation, this callback will be used to create a new view to render the dragged value for a
    /// drag and drop operation. This API should also be used as the equivalent of 'on drag start' with
    /// the [`Self::on_drag_move`] API.
    /// The imperative API equivalent to [`StatefulInteractiveElement::on_drag`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_drag<T, W>(
        &mut self,
        value: T,
        constructor: impl Fn(&T, Point<Pixels>, &mut Window, &mut App) -> Entity<W> + 'static,
    ) where
        Self: Sized,
        T: 'static,
        W: 'static + Render,
    {
        debug_assert!(
            self.drag_listener.is_none(),
            "calling on_drag more than once on the same element is not supported"
        );
        self.drag_listener = crate::fast::interactivity::rare(DragListener {
            value: Arc::new(value),
            render: Box::new(move |value, offset, window, cx| {
                constructor(value.downcast_ref().unwrap(), offset, window, cx).into()
            }),
            external_payload: None,
        });
    }

    /// Registers a callback resolving a payload to offer the platform if a drag started by this
    /// element leaves the window. It is invoked at most once per drag gesture, when the pointer
    /// exits the viewport. Must be called after [`Self::on_drag`], with the same dragged value
    /// type `T`.
    pub fn external_drag_payload<T>(
        &mut self,
        resolver: impl Fn(&T, &mut Window, &mut App) -> Option<ExternalDragPayload> + 'static,
    ) where
        Self: Sized,
        T: 'static,
    {
        let Some(drag_listener) = self.drag_listener.as_mut() else {
            debug_assert!(false, "external_drag_payload must be called after on_drag");
            return;
        };
        debug_assert!(
            drag_listener.value.as_ref().type_id() == TypeId::of::<T>(),
            "external_drag_payload must use the same dragged value type as on_drag"
        );
        debug_assert!(
            drag_listener.external_payload.is_none(),
            "calling external_drag_payload more than once on the same element is not supported"
        );
        drag_listener.external_payload = Some(Box::new(move |value, window, cx| {
            resolver(value.downcast_ref::<T>()?, window, cx)
        }));
    }

    /// Bind the given callback on the hover start and end events of this element. Note that the boolean
    /// passed to the callback is true when the hover starts and false when it ends.
    /// Transitions caused by layout changes under a stationary mouse also invoke the callback.
    ///
    /// By default, keyboard input suppresses hover until the next mouse move, mouse down, or touch. Set
    /// [`HoverListenerMode::InputModalityIndependent`] with [`Self::hover_listener_mode`] to
    /// continue hit-testing hover after keyboard input.
    /// The imperative API equivalent to [`StatefulInteractiveElement::on_hover`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    pub fn on_hover(&mut self, listener: impl Fn(&bool, &mut Window, &mut App) + 'static)
    where
        Self: Sized,
    {
        debug_assert!(
            self.hover_listener.is_none(),
            "calling on_hover more than once on the same element is not supported"
        );
        self.hover_listener = crate::fast::interactivity::rare(Box::new(listener));
    }

    /// Sets how [`Self::on_hover`] responds to key presses while the mouse is stationary.
    /// This affects only the hover listener, not hover styles or tooltips. The imperative API
    /// equivalent to [`StatefulInteractiveElement::hover_listener_mode`].
    pub fn hover_listener_mode(&mut self, mode: HoverListenerMode)
    where
        Self: Sized,
    {
        self.hover_listener_mode = mode;
    }

    /// Constructs a tooltip when the element is hovered or long-pressed.
    /// The imperative API equivalent to [`StatefulInteractiveElement::tooltip`].
    pub fn tooltip(&mut self, build_tooltip: impl Fn(&mut Window, &mut App) -> AnyView + 'static)
    where
        Self: Sized,
    {
        debug_assert!(
            self.tooltip_builder.is_none(),
            "calling tooltip more than once on the same element is not supported"
        );
        self.tooltip_builder = crate::fast::interactivity::rare(TooltipBuilder {
            build: Rc::new(build_tooltip),
            hoverable: false,
        });
    }

    /// Constructs a tooltip when the element is hovered or long-pressed.
    /// The tooltip itself is also hoverable and won't disappear when the user moves the mouse into
    /// the tooltip. The imperative API equivalent to [`StatefulInteractiveElement::hoverable_tooltip`].
    pub fn hoverable_tooltip(
        &mut self,
        build_tooltip: impl Fn(&mut Window, &mut App) -> AnyView + 'static,
    ) where
        Self: Sized,
    {
        debug_assert!(
            self.tooltip_builder.is_none(),
            "calling tooltip more than once on the same element is not supported"
        );
        self.tooltip_builder = crate::fast::interactivity::rare(TooltipBuilder {
            build: Rc::new(build_tooltip),
            hoverable: true,
        });
    }

    /// Sets the delay before this element's tooltip is shown on hover.
    ///
    /// Touch long presses show the tooltip immediately once the gesture is recognized.
    /// The imperative API equivalent to [`StatefulInteractiveElement::tooltip_show_delay`].
    pub fn tooltip_show_delay(&mut self, delay: Duration) {
        self.tooltip_show_delay = Some(delay);
    }

    /// Block the mouse from all interactions with elements behind this element's hitbox. Typically
    /// `block_mouse_except_scroll` should be preferred.
    ///
    /// The imperative API equivalent to [`InteractiveElement::occlude`]
    pub fn occlude_mouse(&mut self) {
        self.hitbox_behavior = HitboxBehavior::BlockMouse;
    }

    /// Set the bounds of this element as a window control area for the platform window.
    /// The imperative API equivalent to [`InteractiveElement::window_control_area`]
    pub fn window_control_area(&mut self, area: WindowControlArea) {
        self.window_control = Some(area);
    }

    /// Block non-scroll mouse interactions with elements behind this element's hitbox.
    /// The imperative API equivalent to [`InteractiveElement::block_mouse_except_scroll`].
    ///
    /// See [`Hitbox::is_hovered`] for details.
    pub fn block_mouse_except_scroll(&mut self) {
        self.hitbox_behavior = HitboxBehavior::BlockMouseExceptScroll;
    }

    fn has_pinch_listeners(&self) -> bool {
        !self.pinch_listeners.is_empty()
    }
}

/// A trait for elements that want to use the standard GPUI event handlers that don't
/// require any state.
pub trait InteractiveElement: Sized {
    /// Retrieve the interactivity state associated with this element
    fn interactivity(&mut self) -> &mut Interactivity;

    /// Restrict this logical target to exact fragments relative to its bounds.
    /// One native focus, dispatch and press owner covers the entire set.
    fn hitbox_regions(mut self, regions: impl Into<Arc<[Bounds<Pixels>]>>) -> Self
    where
        Self: Sized,
    {
        self.interactivity().hitbox_regions = Some(regions.into());
        self
    }

    /// Assign this element to a group of elements that can be styled together
    fn group(mut self, group: impl Into<SharedString>) -> Self {
        self.interactivity().group = Some(group.into());
        self
    }

    /// Assign this element an ID, so that it can be used with interactivity
    fn id(mut self, id: impl Into<ElementId>) -> Stateful<Self> {
        self.interactivity().element_id = Some(id.into());

        Stateful { element: self }
    }

    /// Track the focus state of the given focus handle on this element.
    /// If the focus handle is focused by the application, this element will
    /// apply its focused styles.
    fn track_focus(mut self, focus_handle: &FocusHandle) -> Self {
        self.interactivity().focusable = true;
        self.interactivity().tracked_focus_handle = Some(focus_handle.clone());
        self
    }

    /// Set whether this element is a tab stop.
    ///
    /// When false, the element remains in tab-index order but cannot be reached via keyboard navigation.
    /// Useful for container elements: focus the container, then call `window.focus_next(cx)` to focus
    /// the first tab stop inside it while having the container element itself be unreachable via the keyboard.
    /// Should only be used with `tab_index`.
    fn tab_stop(mut self, tab_stop: bool) -> Self {
        self.interactivity().tab_stop = tab_stop;
        self
    }

    /// Set index of the tab stop order, and set this node as a tab stop.
    /// This will default the element to being a tab stop. See [`Self::tab_stop`] for more information.
    /// This should only be used in conjunction with `tab_group`
    /// in order to not interfere with the tab index of other elements.
    fn tab_index(mut self, index: isize) -> Self {
        self.interactivity().focusable = true;
        self.interactivity().tab_index = Some(index);
        self.interactivity().tab_stop = true;
        self
    }

    /// Designate this div as a "tab group". Tab groups have their own location in the tab-index order,
    /// but for children of the tab group, the tab index is reset to 0. This can be useful for swapping
    /// the order of tab stops within the group, without having to renumber all the tab stops in the whole
    /// application.
    fn tab_group(mut self) -> Self {
        self.interactivity().tab_group = true;
        if self.interactivity().tab_index.is_none() {
            self.interactivity().tab_index = Some(0);
        }
        self
    }

    /// Set the keymap context for this element. This will be used to determine
    /// which action to dispatch from the keymap.
    fn key_context<C, E>(mut self, key_context: C) -> Self
    where
        C: TryInto<KeyContext, Error = E>,
        E: std::fmt::Display,
    {
        if let Some(key_context) = key_context.try_into().log_err() {
            self.interactivity().key_context = Some(key_context);
        }
        self
    }

    /// Apply the given style to this element when the mouse hovers over it
    fn hover(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        debug_assert!(
            self.interactivity().hover_style.is_none(),
            "hover style already set"
        );
        self.interactivity().hover_style = Some(Box::new(f(StyleRefinement::default())));
        self
    }

    /// Apply the given style to this element when the mouse hovers over a group member
    fn group_hover(
        mut self,
        group_name: impl Into<SharedString>,
        f: impl FnOnce(StyleRefinement) -> StyleRefinement,
    ) -> Self {
        self.interactivity().group_hover_style = crate::fast::interactivity::rare(GroupStyle {
            group: group_name.into(),
            style: Box::new(f(StyleRefinement::default())),
        });
        self
    }

    /// Bind the given callback to the mouse down event for the given mouse button.
    /// The fluent API equivalent to [`Interactivity::on_mouse_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to the view state from this callback.
    #[inline(always)]
    fn on_mouse_down(
        mut self,
        button: MouseButton,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_mouse_down(button, listener);
        self
    }

    /// Set a key that can be used to look up this element's bounds
    /// in the [`crate::VisualTestContext::debug_bounds`] map.
    ///
    /// Selectors are only recorded in debug builds with the `test-support`
    /// feature. Elsewhere this is a no-op, so `test-support` can stay enabled
    /// in release builds without the per-frame cost.
    #[cfg(any(test, all(debug_assertions, feature = "test-support")))]
    fn debug_selector(mut self, f: impl FnOnce() -> String) -> Self {
        self.interactivity().debug_selector = Some(f());
        self
    }

    /// Set a key that can be used to look up this element's bounds
    /// in the [`crate::VisualTestContext::debug_bounds`] map.
    ///
    /// Selectors are only recorded in debug builds with the `test-support`
    /// feature. Elsewhere this is a no-op, so `test-support` can stay enabled
    /// in release builds without the per-frame cost.
    #[cfg(not(any(test, all(debug_assertions, feature = "test-support"))))]
    #[inline]
    fn debug_selector(self, _: impl FnOnce() -> String) -> Self {
        self
    }

    /// Bind the given callback to the mouse down event for any button, during the capture phase.
    /// The fluent API equivalent to [`Interactivity::capture_any_mouse_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn capture_any_mouse_down(
        mut self,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().capture_any_mouse_down(listener);
        self
    }

    /// Bind the given callback to the mouse down event for any button, during the capture phase.
    /// The fluent API equivalent to [`Interactivity::on_any_mouse_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_any_mouse_down(
        mut self,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_any_mouse_down(listener);
        self
    }

    /// Bind the given callback to the mouse up event for the given button, during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_mouse_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_mouse_up(
        mut self,
        button: MouseButton,
        listener: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_mouse_up(button, listener);
        self
    }

    /// Bind the given callback to the mouse up event for any button, during the capture phase.
    /// The fluent API equivalent to [`Interactivity::capture_any_mouse_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn capture_any_mouse_up(
        mut self,
        listener: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().capture_any_mouse_up(listener);
        self
    }

    /// Bind the given callback to the mouse pressure event, during the bubble phase
    /// the fluent API equivalent to [`Interactivity::on_mouse_pressure`]
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_mouse_pressure(
        mut self,
        listener: impl Fn(&MousePressureEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_mouse_pressure(listener);
        self
    }

    /// Bind the given callback to the mouse pressure event, during the capture phase
    /// the fluent API equivalent to [`Interactivity::on_mouse_pressure`]
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn capture_mouse_pressure(
        mut self,
        listener: impl Fn(&MousePressureEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().capture_mouse_pressure(listener);
        self
    }

    /// Bind the given callback to the mouse down event, on any button, during the capture phase,
    /// when the mouse is outside of the bounds of this element.
    /// The fluent API equivalent to [`Interactivity::on_mouse_down_out`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_mouse_down_out(
        mut self,
        listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_mouse_down_out(listener);
        self
    }

    /// Bind the given callback to the mouse up event, for the given button, during the capture phase,
    /// when the mouse is outside of the bounds of this element.
    /// The fluent API equivalent to [`Interactivity::on_mouse_up_out`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_mouse_up_out(
        mut self,
        button: MouseButton,
        listener: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_mouse_up_out(button, listener);
        self
    }

    /// Bind the given callback to the mouse move event, during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_mouse_move`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_mouse_move(
        mut self,
        listener: impl Fn(&MouseMoveEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_mouse_move(listener);
        self
    }

    /// Bind the given callback to the mouse exit event, during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_mouse_exit`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_mouse_exit(
        mut self,
        listener: impl Fn(&MouseExitEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_mouse_exit(listener);
        self
    }

    /// Bind the given callback to [`FileDropEvent::Exited`] when a platform file drag
    /// leaves this element's window while the element is hovered.
    ///
    /// This is a window-local exit event, not notification that the platform drag session ended.
    /// The fluent API equivalent to [`Interactivity::on_file_drop_exit`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_file_drop_exit(
        mut self,
        listener: impl Fn(&FileDropEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_file_drop_exit(listener);
        self
    }

    /// Bind the given callback to the mouse drag event of the given type. Note that this
    /// will be called for all move events, inside or outside of this element, as long as the
    /// drag was started with this element under the mouse. Useful for implementing draggable
    /// UIs that don't conform to a drag and drop style interaction, like resizing.
    /// The fluent API equivalent to [`Interactivity::on_drag_move`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_drag_move<T: 'static>(
        mut self,
        listener: impl Fn(&DragMoveEvent<T>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_drag_move(listener);
        self
    }

    /// Bind the given callback to scroll wheel events during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_scroll_wheel`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_scroll_wheel(
        mut self,
        listener: impl Fn(&ScrollWheelEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_scroll_wheel(listener);
        self
    }

    /// Bind the given callback to pinch gesture events during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_pinch`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_pinch(mut self, listener: impl Fn(&PinchEvent, &mut Window, &mut App) + 'static) -> Self {
        self.interactivity().on_pinch(listener);
        self
    }

    /// Bind the given callback to pinch gesture events during the capture phase.
    /// The fluent API equivalent to [`Interactivity::capture_pinch`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn capture_pinch(
        mut self,
        listener: impl Fn(&PinchEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().capture_pinch(listener);
        self
    }
    /// Capture the given action, before normal action dispatch can fire.
    /// The fluent API equivalent to [`Interactivity::capture_action`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn capture_action<A: Action>(
        mut self,
        listener: impl Fn(&A, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().capture_action(listener);
        self
    }

    /// Bind the given callback to an action dispatch during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_action`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    #[track_caller]
    #[inline(always)]
    fn on_action<A: Action>(
        mut self,
        listener: impl Fn(&A, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_action(listener);
        self
    }

    /// Bind the given callback to an action dispatch, based on a dynamic action parameter
    /// instead of a type parameter. Useful for component libraries that want to expose
    /// action bindings to their users.
    /// The fluent API equivalent to [`Interactivity::on_boxed_action`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_boxed_action(
        mut self,
        action: &dyn Action,
        listener: impl Fn(&dyn Action, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_boxed_action(action, listener);
        self
    }

    /// Bind the given callback to key down events during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_key_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_key_down(
        mut self,
        listener: impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_key_down(listener);
        self
    }

    /// Bind the given callback to key down events during the capture phase.
    /// The fluent API equivalent to [`Interactivity::capture_key_down`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn capture_key_down(
        mut self,
        listener: impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().capture_key_down(listener);
        self
    }

    /// Bind the given callback to key up events during the bubble phase.
    /// The fluent API equivalent to [`Interactivity::on_key_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_key_up(
        mut self,
        listener: impl Fn(&KeyUpEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_key_up(listener);
        self
    }

    /// Bind the given callback to key up events during the capture phase.
    /// The fluent API equivalent to [`Interactivity::capture_key_up`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn capture_key_up(
        mut self,
        listener: impl Fn(&KeyUpEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().capture_key_up(listener);
        self
    }

    /// Bind the given callback to modifiers changing events.
    /// The fluent API equivalent to [`Interactivity::on_modifiers_changed`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    #[inline(always)]
    fn on_modifiers_changed(
        mut self,
        listener: impl Fn(&ModifiersChangedEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_modifiers_changed(listener);
        self
    }

    /// Apply the given style when the given data type is dragged over this element
    fn drag_over<S: 'static>(
        mut self,
        f: impl 'static + Fn(StyleRefinement, &S, &mut Window, &mut App) -> StyleRefinement,
    ) -> Self {
        self.interactivity().drag_over_styles.push((
            TypeId::of::<S>(),
            Box::new(move |currently_dragged: &dyn Any, window, cx| {
                f(
                    StyleRefinement::default(),
                    currently_dragged.downcast_ref::<S>().unwrap(),
                    window,
                    cx,
                )
            }),
        ));
        self
    }

    /// Apply the given style when the given data type is dragged over this element's group
    fn group_drag_over<S: 'static>(
        mut self,
        group_name: impl Into<SharedString>,
        f: impl FnOnce(StyleRefinement) -> StyleRefinement,
    ) -> Self {
        self.interactivity().group_drag_over_styles.push((
            TypeId::of::<S>(),
            GroupStyle {
                group: group_name.into(),
                style: Box::new(f(StyleRefinement::default())),
            },
        ));
        self
    }

    /// Bind the given callback to drop events of the given type, whether or not the drag started on this element.
    /// The fluent API equivalent to [`Interactivity::on_drop`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_drop<T: 'static>(
        mut self,
        listener: impl Fn(&T, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.interactivity().on_drop(listener);
        self
    }

    /// Use the given predicate to determine whether or not a drop event should be dispatched to this element.
    /// The fluent API equivalent to [`Interactivity::can_drop`].
    fn can_drop(
        mut self,
        predicate: impl Fn(&dyn Any, &mut Window, &mut App) -> bool + 'static,
    ) -> Self {
        self.interactivity().can_drop(predicate);
        self
    }

    /// Block the mouse from all interactions with elements behind this element's hitbox. Typically
    /// `block_mouse_except_scroll` should be preferred.
    /// The fluent API equivalent to [`Interactivity::occlude_mouse`].
    fn occlude(mut self) -> Self {
        self.interactivity().occlude_mouse();
        self
    }

    /// Set the bounds of this element as a window control area for the platform window.
    /// The fluent API equivalent to [`Interactivity::window_control_area`].
    fn window_control_area(mut self, area: WindowControlArea) -> Self {
        self.interactivity().window_control_area(area);
        self
    }

    /// Block non-scroll mouse interactions with elements behind this element's hitbox.
    /// The fluent API equivalent to [`Interactivity::block_mouse_except_scroll`].
    ///
    /// See [`Hitbox::is_hovered`] for details.
    fn block_mouse_except_scroll(mut self) -> Self {
        self.interactivity().block_mouse_except_scroll();
        self
    }

    /// Set the given styles to be applied when this element, specifically, is focused.
    /// Requires that the element is focusable. Elements can be made focusable using [`InteractiveElement::track_focus`].
    fn focus(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self
    where
        Self: Sized,
    {
        self.interactivity().focus_style = Some(Box::new(f(StyleRefinement::default())));
        self
    }

    /// Set the given styles to be applied when this element is inside another element that is focused.
    /// Requires that the element is focusable. Elements can be made focusable using [`InteractiveElement::track_focus`].
    fn in_focus(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self
    where
        Self: Sized,
    {
        self.interactivity().in_focus_style = Some(Box::new(f(StyleRefinement::default())));
        self
    }

    /// Set the given styles to be applied when this element is focused via keyboard navigation.
    /// This is similar to CSS's `:focus-visible` pseudo-class - it only applies when the element
    /// is focused AND the user is navigating via keyboard (not mouse clicks).
    /// Requires that the element is focusable. Elements can be made focusable using [`InteractiveElement::track_focus`].
    fn focus_visible(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self
    where
        Self: Sized,
    {
        self.interactivity().focus_visible_style = Some(Box::new(f(StyleRefinement::default())));
        self
    }
}

/// A trait for elements that want to use the standard GPUI interactivity features
/// that require state.
pub trait StatefulInteractiveElement: InteractiveElement {
    /// Set the accessible role for this element.
    ///
    /// See the [accessibility guide](crate::_accessibility) for an overview.
    fn role(mut self, role: accesskit::Role) -> Self {
        debug_assert!(
            role != accesskit::Role::GenericContainer,
            "GenericContainer is filtered out of the a11y tree and has no effect"
        );
        self.interactivity().override_role = Some(role);
        self
    }

    /// Set the author-provided identifier exposed to accessibility clients.
    ///
    /// Unlike the GPUI element ID, this value is visible outside the process.
    /// Keep it stable and unique within its accessibility tree.
    /// AccessKit maps it to platform identifiers where supported, including
    /// UIA `AutomationId` on Windows, `AXIdentifier` on macOS, and AT-SPI
    /// `AccessibleId` on Linux stacks whose deployed adapter exposes it.
    fn accessibility_id(mut self, id: impl Into<SharedString>) -> Self {
        self.interactivity().aria.author_id = Some(id.into());
        self
    }

    /// Set the accessible label for this element.
    fn aria_label(mut self, label: impl Into<SharedString>) -> Self {
        self.interactivity().aria.label = Some(label.into());
        self
    }

    /// Set the accessible description for this element. Unlike the label (which
    /// names the element), the description provides supplementary information
    /// that assistive technology announces after the name, role, and value -
    /// for example a settings subtitle or a hint.
    fn aria_description(mut self, description: impl Into<SharedString>) -> Self {
        self.interactivity().aria.description = Some(description.into());
        self
    }

    /// Set the keyboard shortcut(s) that activate this element, announced by
    /// assistive technology (maps to AccessKit's `keyboard_shortcut`).
    ///
    /// Note that this does not create a keymap. It simply instructs assistive
    /// technology what the keymap is.
    fn aria_keyshortcuts(mut self, keyshortcuts: impl Into<SharedString>) -> Self {
        self.interactivity().aria.keyshortcuts = Some(keyshortcuts.into());
        self
    }

    /// Report this element as the focused node in the accessibility tree,
    /// overriding the element that holds real keyboard focus — but only while
    /// one of its ancestors actually holds focus.
    ///
    /// This implements the `aria-activedescendant` pattern for composite
    /// widgets that keep keyboard focus on a container (e.g. a menu or
    /// listbox) while a child is "selected": set this on the selected child so
    /// assistive technology announces and highlights it as focused.
    ///
    /// The element must also have a [`role`][Self::role] (and an id) so it
    /// produces an accessibility node. Unlike the web's container-side
    /// `aria-activedescendant`, this is set on the descendant; GPUI honors it
    /// only when a focused ancestor is present in the tree, so it is safe to
    /// set unconditionally on the selected child — if the container isn't
    /// focused, the claim is ignored.
    fn aria_active_descendant(mut self) -> Self {
        self.interactivity().report_active_descendant_focus = true;
        self
    }

    /// Contribute synthetic accessibility nodes — nodes that don't correspond
    /// to any element — as children of this element's a11y node. For example,
    /// text runs describing an editor's text content.
    ///
    /// The closure is called after this element is prepainted, and only if it
    /// contributed a node to the accessibility tree (i.e. it has an id and a
    /// [`role`][StatefulInteractiveElement::role]).
    ///
    /// See [`Element::a11y_synthetic_children`] for details.
    fn a11y_synthetic_children(
        mut self,
        f: impl FnOnce(&mut crate::A11ySubtreeBuilder) + 'static,
    ) -> Self {
        self.interactivity().a11y_synthetic_children =
            crate::fast::interactivity::rare(Box::new(f));
        self
    }

    /// Set the selected state for this element.
    fn aria_selected(mut self, selected: bool) -> Self {
        self.interactivity().aria.selected = Some(selected);
        self
    }

    /// Expose disabled interaction to assistive technology.
    fn aria_disabled(mut self, disabled: bool) -> Self {
        self.interactivity().aria.disabled = Some(disabled);
        self
    }

    /// Expose a readable value that users cannot edit.
    fn aria_readonly(mut self, readonly: bool) -> Self {
        self.interactivity().aria.readonly = Some(readonly);
        self
    }

    /// Set the expanded state for this element.
    fn aria_expanded(mut self, expanded: bool) -> Self {
        self.interactivity().aria.expanded = Some(expanded);
        self
    }

    /// Set the toggled state for this element.
    fn aria_toggled(mut self, toggled: accesskit::Toggled) -> Self {
        self.interactivity().aria.toggled = Some(toggled);
        self
    }

    /// Set the numeric value for this element.
    fn aria_numeric_value(mut self, value: f64) -> Self {
        self.interactivity().aria.numeric_value = Some(value);
        self
    }

    /// Set the step by which assistive technology should expect the numeric
    /// value of this element to change (e.g. when incrementing a spin button).
    fn aria_numeric_value_step(mut self, step: f64) -> Self {
        self.interactivity().aria.numeric_value_step = Some(step);
        self
    }

    /// Set the string value of this element, e.g. the text content of a simple
    /// text input.
    fn aria_value(mut self, value: impl Into<SharedString>) -> Self {
        self.interactivity().aria.value = Some(value.into());
        self
    }

    /// Set the placeholder text reported to assistive technology for this
    /// element, shown when a text input is empty.
    fn aria_placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.interactivity().aria.placeholder = Some(placeholder.into());
        self
    }

    /// Set the minimum numeric value for this element.
    fn aria_min_numeric_value(mut self, value: f64) -> Self {
        self.interactivity().aria.min_numeric_value = Some(value);
        self
    }

    /// Set the maximum numeric value for this element.
    fn aria_max_numeric_value(mut self, value: f64) -> Self {
        self.interactivity().aria.max_numeric_value = Some(value);
        self
    }

    /// Set the orientation of this element.
    fn aria_orientation(mut self, orientation: accesskit::Orientation) -> Self {
        self.interactivity().aria.orientation = Some(orientation);
        self
    }

    /// Set the heading level of this element.
    fn aria_level(mut self, level: usize) -> Self {
        self.interactivity().aria.level = Some(level);
        self
    }

    /// Set the position in set of this element.
    fn aria_position_in_set(mut self, position: usize) -> Self {
        self.interactivity().aria.position_in_set = Some(position);
        self
    }

    /// Set the size of set for this element.
    fn aria_size_of_set(mut self, size: usize) -> Self {
        self.interactivity().aria.size_of_set = Some(size);
        self
    }

    /// Set the row index for this element.
    fn aria_row_index(mut self, index: usize) -> Self {
        self.interactivity().aria.row_index = Some(index);
        self
    }

    /// Set the column index for this element.
    fn aria_column_index(mut self, index: usize) -> Self {
        self.interactivity().aria.column_index = Some(index);
        self
    }

    /// Set the row count for this element.
    fn aria_row_count(mut self, count: usize) -> Self {
        self.interactivity().aria.row_count = Some(count);
        self
    }

    /// Set the column count for this element.
    fn aria_column_count(mut self, count: usize) -> Self {
        self.interactivity().aria.column_count = Some(count);
        self
    }

    /// Register a handler for an accessibility action on this element.
    /// The handler is called when a screen reader requests the given action.
    ///
    /// See the [accessibility guide](crate::_accessibility) for an overview.
    #[inline(always)]
    fn on_a11y_action(
        mut self,
        action: accesskit::Action,
        listener: impl FnMut(Option<&accesskit::ActionData>, &mut crate::Window, &mut crate::App)
        + 'static,
    ) -> Self {
        self.interactivity()
            .a11y_action_listeners
            .push((action, Box::new(listener)));
        self
    }

    /// Set this element to focusable.
    fn focusable(mut self) -> Self {
        self.interactivity().focusable = true;
        self
    }

    /// Set the overflow x and y to scroll.
    fn overflow_scroll(mut self) -> Self {
        self.interactivity().base_style.overflow.x = Some(Overflow::Scroll);
        self.interactivity().base_style.overflow.y = Some(Overflow::Scroll);
        self
    }

    /// Set the overflow x to scroll.
    fn overflow_x_scroll(mut self) -> Self {
        self.interactivity().base_style.overflow.x = Some(Overflow::Scroll);
        self
    }

    /// Set the overflow y to scroll.
    fn overflow_y_scroll(mut self) -> Self {
        self.interactivity().base_style.overflow.y = Some(Overflow::Scroll);
        self
    }

    /// Restrict scrolling of this element to the axis of the input gesture.
    ///
    /// See [`Style::restrict_scroll_to_axis`](crate::Style::restrict_scroll_to_axis) for details.
    fn restrict_scroll_to_axis(mut self) -> Self {
        self.interactivity().base_style.restrict_scroll_to_axis = Some(true);
        self
    }

    /// Track the scroll state of this element with the given handle.
    fn track_scroll(mut self, scroll_handle: &ScrollHandle) -> Self {
        self.interactivity().tracked_scroll_handle = Some(scroll_handle.clone());
        self
    }

    /// Retain a reading position across layout changes. Requires `track_scroll`.
    fn retain_scroll(mut self, policy: ScrollRetention) -> Self {
        self.interactivity().scroll_retention = policy;
        self
    }

    /// Track the scroll state of this element with the given handle.
    fn anchor_scroll(mut self, scroll_anchor: Option<ScrollAnchor>) -> Self {
        self.interactivity().scroll_anchor = crate::fast::interactivity::rare_option(scroll_anchor);
        self
    }

    /// Set the given styles to be applied when this element is active.
    fn active(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self
    where
        Self: Sized,
    {
        self.interactivity().active_style = Some(Box::new(f(StyleRefinement::default())));
        self
    }

    /// Set the given styles to be applied when this element's group is active.
    fn group_active(
        mut self,
        group_name: impl Into<SharedString>,
        f: impl FnOnce(StyleRefinement) -> StyleRefinement,
    ) -> Self
    where
        Self: Sized,
    {
        self.interactivity().group_active_style = crate::fast::interactivity::rare(GroupStyle {
            group: group_name.into(),
            style: Box::new(f(StyleRefinement::default())),
        });
        self
    }

    /// Bind the given callback to click events of this element.
    /// The fluent API equivalent to [`Interactivity::on_click`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    #[inline(always)]
    fn on_click(mut self, listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self
    where
        Self: Sized,
    {
        self.interactivity().on_click(listener);
        self
    }

    /// Bind the given callback to non-primary click events of this element.
    /// The fluent API equivalent to [`Interactivity::on_aux_click`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_aux_click(
        mut self,
        listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self
    where
        Self: Sized,
    {
        self.interactivity().on_aux_click(listener);
        self
    }

    /// On drag initiation, this callback will be used to create a new view to render the dragged value for a
    /// drag and drop operation. This API should also be used as the equivalent of 'on drag start' with
    /// the [`InteractiveElement::on_drag_move`] API.
    /// The callback also has access to the offset of triggering click from the origin of parent element.
    /// The fluent API equivalent to [`Interactivity::on_drag`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_drag<T, W>(
        mut self,
        value: T,
        constructor: impl Fn(&T, Point<Pixels>, &mut Window, &mut App) -> Entity<W> + 'static,
    ) -> Self
    where
        Self: Sized,
        T: 'static,
        W: 'static + Render,
    {
        self.interactivity().on_drag(value, constructor);
        self
    }

    /// Registers a callback resolving a payload to offer the platform if a drag started by this
    /// element leaves the window. It is invoked at most once per drag gesture, when the pointer
    /// exits the viewport. Must be called after [`Self::on_drag`], with the same dragged value
    /// type `T`.
    /// The fluent API equivalent to [`Interactivity::external_drag_payload`].
    fn external_drag_payload<T>(
        mut self,
        resolver: impl Fn(&T, &mut Window, &mut App) -> Option<ExternalDragPayload> + 'static,
    ) -> Self
    where
        Self: Sized,
        T: 'static,
    {
        self.interactivity().external_drag_payload(resolver);
        self
    }

    /// Bind the given callback on the hover start and end events of this element. Note that the boolean
    /// passed to the callback is true when the hover starts and false when it ends.
    /// Transitions caused by layout changes under a stationary mouse also invoke the callback.
    ///
    /// By default, keyboard input suppresses hover until the next mouse move, mouse down, or touch. Set
    /// [`HoverListenerMode::InputModalityIndependent`] with [`Self::hover_listener_mode`] to
    /// continue hit-testing hover after keyboard input.
    /// The fluent API equivalent to [`Interactivity::on_hover`].
    ///
    /// See [`Context::listener`](crate::Context::listener) to get access to a view's state from this callback.
    fn on_hover(mut self, listener: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self
    where
        Self: Sized,
    {
        self.interactivity().on_hover(listener);
        self
    }

    /// Sets how [`Self::on_hover`] responds to key presses while the mouse is stationary.
    /// This affects only the hover listener, not hover styles or tooltips. The fluent API
    /// equivalent to [`Interactivity::hover_listener_mode`].
    fn hover_listener_mode(mut self, mode: HoverListenerMode) -> Self
    where
        Self: Sized,
    {
        self.interactivity().hover_listener_mode(mode);
        self
    }

    /// Constructs a tooltip when the element is hovered or long-pressed.
    /// The fluent API equivalent to [`Interactivity::tooltip`].
    fn tooltip(mut self, build_tooltip: impl Fn(&mut Window, &mut App) -> AnyView + 'static) -> Self
    where
        Self: Sized,
    {
        self.interactivity().tooltip(build_tooltip);
        self
    }

    /// Constructs a tooltip when the element is hovered or long-pressed.
    /// The tooltip itself is also hoverable and won't disappear when the user moves the mouse into
    /// the tooltip. The fluent API equivalent to [`Interactivity::hoverable_tooltip`].
    fn hoverable_tooltip(
        mut self,
        build_tooltip: impl Fn(&mut Window, &mut App) -> AnyView + 'static,
    ) -> Self
    where
        Self: Sized,
    {
        self.interactivity().hoverable_tooltip(build_tooltip);
        self
    }

    /// Sets the delay before this element's tooltip is shown on hover.
    ///
    /// Touch long presses show the tooltip immediately once the gesture is recognized.
    /// The fluent API equivalent to [`Interactivity::tooltip_show_delay`].
    fn tooltip_show_delay(mut self, delay: Duration) -> Self
    where
        Self: Sized,
    {
        self.interactivity().tooltip_show_delay(delay);
        self
    }
}

pub(crate) type MouseDownListener =
    Box<dyn Fn(&MouseDownEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;
pub(crate) type MouseUpListener =
    Box<dyn Fn(&MouseUpEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;
pub(crate) type MousePressureListener =
    Box<dyn Fn(&MousePressureEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;
pub(crate) type MouseMoveListener =
    Box<dyn Fn(&MouseMoveEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;
pub(crate) type MouseExitListener =
    Box<dyn Fn(&MouseExitEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;

pub(crate) type FileDropExitListener =
    Box<dyn Fn(&FileDropEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;

pub(crate) type ScrollWheelListener =
    Box<dyn Fn(&ScrollWheelEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;

pub(crate) type PinchListener =
    Box<dyn Fn(&PinchEvent, DispatchPhase, &Hitbox, &mut Window, &mut App) + 'static>;

pub(crate) type ClickListener = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// Controls how [`StatefulInteractiveElement::on_hover`] responds to key presses while the mouse
/// is stationary.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HoverListenerMode {
    /// Use input-modality-aware hit testing. Keyboard input suppresses hover until the mouse moves
    /// again, unless pointer capture or an active mouse-down interaction keeps the listener hovered.
    #[default]
    InputModalityAware,
    /// Use hit testing even when the last input was from the keyboard. This changes only
    /// keyboard-modality filtering; all other [`StatefulInteractiveElement::on_hover`] behavior
    /// remains unchanged.
    InputModalityIndependent,
}

impl HoverListenerMode {
    fn is_hovered(self, hitbox: &Hitbox, window: &Window) -> bool {
        match self {
            Self::InputModalityAware => hitbox.is_hovered(window),
            Self::InputModalityIndependent => hitbox.id.is_hovered_ignoring_last_input(window),
        }
    }
}

pub(crate) struct DragListener {
    value: Arc<dyn Any>,
    render: Box<dyn Fn(&dyn Any, Point<Pixels>, &mut Window, &mut App) -> AnyView + 'static>,
    external_payload: Option<ExternalDragPayloadResolver>,
}

type ExternalDragPayloadResolver =
    Box<dyn Fn(&dyn Any, &mut Window, &mut App) -> Option<ExternalDragPayload> + 'static>;

type DropListener = Box<dyn Fn(&dyn Any, &mut Window, &mut App) + 'static>;

type CanDropPredicate = Box<dyn Fn(&dyn Any, &mut Window, &mut App) -> bool + 'static>;

pub(crate) struct TooltipBuilder {
    build: Rc<dyn Fn(&mut Window, &mut App) -> AnyView + 'static>,
    hoverable: bool,
}

pub(crate) type KeyDownListener =
    Box<dyn Fn(&KeyDownEvent, DispatchPhase, &mut Window, &mut App) + 'static>;

pub(crate) type KeyUpListener =
    Box<dyn Fn(&KeyUpEvent, DispatchPhase, &mut Window, &mut App) + 'static>;

pub(crate) type ModifiersChangedListener =
    Box<dyn Fn(&ModifiersChangedEvent, &mut Window, &mut App) + 'static>;

pub(crate) type ActionListener =
    Box<dyn Fn(&dyn Any, DispatchPhase, &mut Window, &mut App) + 'static>;

/// Construct a new [`Div`] element
#[track_caller]
pub fn div() -> Div {
    Div {
        interactivity: Interactivity::new(),
        children: SmallVec::default(),
        prepaint_listener: None,
        image_cache: None,
        prepaint_order_fn: None,
    }
}

/// A [`Div`] element, the all-in-one element for building complex UIs in GPUI
pub struct Div {
    interactivity: Interactivity,
    children: SmallVec<[StackSafe<AnyElement>; 2]>,
    prepaint_listener: Option<Box<dyn Fn(Vec<Bounds<Pixels>>, &mut Window, &mut App) + 'static>>,
    image_cache: Option<Box<dyn ImageCacheProvider>>,
    prepaint_order_fn: Option<Box<dyn Fn(&mut Window, &mut App) -> SmallVec<[usize; 8]>>>,
}

impl Div {
    /// Add a listener to be called when the children of this `Div` are prepainted.
    /// This allows you to store the [`Bounds`] of the children for later use.
    pub fn on_children_prepainted(
        mut self,
        listener: impl Fn(Vec<Bounds<Pixels>>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.prepaint_listener = Some(Box::new(listener));
        self
    }

    /// Add an image cache at the location of this div in the element tree.
    pub fn image_cache(mut self, cache: impl ImageCacheProvider) -> Self {
        self.image_cache = Some(Box::new(cache));
        self
    }

    /// Specify a function that determines the order in which children are prepainted.
    ///
    /// The function is called at prepaint time and should return a vector of child indices
    /// in the desired prepaint order. Each index should appear exactly once.
    ///
    /// This is useful when the prepaint of one child affects state that another child reads.
    /// For example, in split editor views, the editor with an autoscroll request should
    /// be prepainted first so its scroll position update is visible to the other editor.
    pub fn with_dynamic_prepaint_order(
        mut self,
        order_fn: impl Fn(&mut Window, &mut App) -> SmallVec<[usize; 8]> + 'static,
    ) -> Self {
        self.prepaint_order_fn = Some(Box::new(order_fn));
        self
    }
}

/// A frame state for a `Div` element, which contains layout IDs for its children.
///
/// This struct is used internally by the `Div` element to manage the layout state of its children
/// during the UI update cycle. It holds a small vector of `LayoutId` values, each corresponding to
/// a child element of the `Div`. These IDs are used to query the layout engine for the computed
/// bounds of the children after the layout phase is complete.
pub struct DivFrameState {
    child_layout_ids: SmallVec<[LayoutId; 2]>,
    scroll_presentation: Option<ScrollPresentation>,
}

/// Interactivity state displayed an manipulated in the inspector.
#[derive(Clone)]
pub struct DivInspectorState {
    /// The inspected element's base style. This is used for both inspecting and modifying the
    /// state. In the future it will make sense to separate the read and write, possibly tracking
    /// the modifications.
    #[cfg(any(feature = "inspector", debug_assertions))]
    pub base_style: Box<StyleRefinement>,
    /// Inspects the bounds of the element.
    pub bounds: Bounds<Pixels>,
    /// Size of the children of the element, or `bounds.size` if it has no children.
    pub content_size: Size<Pixels>,
}

impl Styled for Div {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.interactivity.base_style
    }
}

impl InteractiveElement for Div {
    fn interactivity(&mut self) -> &mut Interactivity {
        &mut self.interactivity
    }
}

impl ParentElement for Div {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        #[cfg(feature = "stacker")]
        self.children
            .extend(elements.into_iter().map(StackSafe::new));
        #[cfg(not(feature = "stacker"))]
        self.children.extend(elements);
    }
}

impl Element for Div {
    type RequestLayoutState = DivFrameState;
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        self.interactivity.element_id.clone()
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        self.interactivity.source_location()
    }

    fn a11y_role(&self) -> Option<accesskit::Role> {
        // Nodes with `GenericContainer` should never be reported to accesskit.
        // Equivalent to an HTML div with no role.
        self.interactivity
            .override_role
            .filter(|role| *role != accesskit::Role::GenericContainer)
    }

    fn write_a11y_info(&self, node: &mut accesskit::Node) {
        self.interactivity.write_a11y_info(node);
    }

    fn a11y_synthetic_children(
        &mut self,
        _prepaint: &mut Self::PrepaintState,
        builder: &mut crate::A11ySubtreeBuilder,
    ) {
        if let Some(f) = self.interactivity.a11y_synthetic_children.take() {
            f(builder);
        }
    }

    #[cfg_attr(feature = "stacker", stacksafe::stacksafe)]
    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut child_layout_ids = SmallVec::new();
        let image_cache = self
            .image_cache
            .as_mut()
            .map(|provider| provider.provide(window, cx));

        let layout_id = window.with_image_cache(image_cache, |window| {
            self.interactivity.request_layout(
                global_id,
                inspector_id,
                window,
                cx,
                |style, window, cx| {
                    window.with_text_style(style.text_style().cloned(), |window| {
                        child_layout_ids = self
                            .children
                            .iter_mut()
                            .map(|child| child.request_layout(window, cx))
                            .collect::<SmallVec<_>>();
                        crate::fast::layout::request_layout(window, &style, &child_layout_ids)
                    })
                },
            )
        });

        (
            layout_id,
            DivFrameState {
                child_layout_ids,
                scroll_presentation: None,
            },
        )
    }

    #[cfg_attr(feature = "stacker", stacksafe::stacksafe)]
    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Hitbox> {
        let image_cache = self
            .image_cache
            .as_mut()
            .map(|provider| provider.provide(window, cx));

        let has_prepaint_listener = self.prepaint_listener.is_some();
        let mut children_bounds = Vec::with_capacity(if has_prepaint_listener {
            request_layout.child_layout_ids.len()
        } else {
            0
        });

        let mut child_min = point(Pixels::MAX, Pixels::MAX);
        let mut child_max = Point::default();
        if let Some(handle) = self.interactivity.scroll_anchor.as_ref() {
            *handle.last_origin.borrow_mut() = bounds.origin - window.element_offset();
        }
        if let Some(handle) = self.interactivity.tracked_scroll_handle.as_ref() {
            crate::fast::layers::input::track_handle(window, &handle.0);
            // Empty layouts must clear the previous children's geometry too.
            let mut state = handle.0.borrow_mut();
            state.child_bounds.clear();
        }
        let content_size = if request_layout.child_layout_ids.is_empty() {
            bounds.size
        } else {
            for child_layout_id in &request_layout.child_layout_ids {
                let child_bounds = window.layout_bounds(*child_layout_id);
                child_min = child_min.min(&child_bounds.origin);
                child_max = child_max.max(&child_bounds.bottom_right());
                if let Some(handle) = self.interactivity.tracked_scroll_handle.as_ref() {
                    handle.0.borrow_mut().child_bounds.push(child_bounds);
                }
                if has_prepaint_listener {
                    children_bounds.push(child_bounds);
                }
            }
            (child_max - child_min).into()
        };
        if self.interactivity.tracked_scroll_handle.is_some() {
            self.interactivity.scroll_child_ids = self
                .children
                .iter()
                .map(|child| child.0.fast_element_id())
                .collect();
        }

        let hitbox = self.interactivity.prepaint(
            global_id,
            inspector_id,
            bounds,
            content_size,
            window,
            cx,
            |style, scroll_offset, hitbox, window, cx| {
                // skip children
                if style.display == Display::None {
                    return hitbox;
                }

                window.with_image_cache(image_cache, |window| {
                    let fast_layer = crate::fast::layers::paint::begin_children(
                        window,
                        cx,
                        global_id,
                        bounds,
                        child_min,
                        content_size,
                        scroll_offset,
                        style,
                    );
                    crate::fast::layers::paint::prepaint_children(window, fast_layer, |window| {
                        if let Some(order_fn) = &self.prepaint_order_fn {
                            let order = order_fn(window, cx);
                            for idx in order {
                                if let Some(child) = self.children.get_mut(idx) {
                                    child.prepaint(window, cx);
                                }
                            }
                        } else {
                            for child in &mut self.children {
                                child.prepaint(window, cx);
                            }
                        }
                    });
                    crate::fast::layers::paint::end_children(window, cx, fast_layer);

                    if let Some(listener) = self.prepaint_listener.as_ref() {
                        crate::fast::layers::invalidate::note_uncarried(window);
                        listener(children_bounds, window, cx);
                    }
                });

                hitbox
            },
        );
        request_layout.scroll_presentation = self.interactivity.pending_scroll_presentation.take();
        hitbox
    }

    #[cfg_attr(feature = "stacker", stacksafe::stacksafe)]
    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        hitbox: &mut Option<Hitbox>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let image_cache = self
            .image_cache
            .as_mut()
            .map(|provider| provider.provide(window, cx));

        let mut did_paint = false;
        window.with_image_cache(image_cache, |window| {
            self.interactivity.paint(
                global_id,
                inspector_id,
                bounds,
                hitbox.as_ref(),
                window,
                cx,
                |style, window, cx| {
                    // skip children
                    if style.display == Display::None {
                        return;
                    }

                    did_paint = true;
                    crate::fast::layers::paint::paint_children(
                        window,
                        cx,
                        global_id,
                        |window, cx| {
                            for child in &mut self.children {
                                child.paint(window, cx);
                            }
                        },
                    );
                },
            )
        });
        if !did_paint {
            return;
        }
        if let Some(handle) = self.interactivity.tracked_scroll_handle.as_ref()
            && let Some(presentation) = request_layout.scroll_presentation.take()
        {
            let mut state = handle.0.borrow_mut();
            if state.reading_revision == presentation.observation.reading_revision {
                state.retention_attempt = None;
            }
            state.painted_layout = Some(presentation.layout);
            state.painted_observation = Some(presentation.observation);
            if let Some((id, status)) = presentation.request
                && state
                    .scroll_request
                    .as_ref()
                    .is_some_and(|request| request.id == id)
            {
                state.scroll_request = None;
                state.last_receipt = Some((id, status));
            }
        }
    }
}

impl IntoElement for Div {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

#[derive(Default)]
pub(crate) struct AriaProperties {
    pub(crate) author_id: Option<SharedString>,
    pub(crate) label: Option<SharedString>,
    pub(crate) description: Option<SharedString>,
    pub(crate) keyshortcuts: Option<SharedString>,
    pub(crate) selected: Option<bool>,
    pub(crate) disabled: Option<bool>,
    pub(crate) readonly: Option<bool>,
    pub(crate) expanded: Option<bool>,
    pub(crate) toggled: Option<accesskit::Toggled>,
    pub(crate) numeric_value: Option<f64>,
    pub(crate) min_numeric_value: Option<f64>,
    pub(crate) max_numeric_value: Option<f64>,
    pub(crate) numeric_value_step: Option<f64>,
    pub(crate) value: Option<SharedString>,
    pub(crate) placeholder: Option<SharedString>,
    pub(crate) orientation: Option<accesskit::Orientation>,
    pub(crate) level: Option<usize>,
    pub(crate) position_in_set: Option<usize>,
    pub(crate) size_of_set: Option<usize>,
    pub(crate) row_index: Option<usize>,
    pub(crate) column_index: Option<usize>,
    pub(crate) row_count: Option<usize>,
    pub(crate) column_count: Option<usize>,
}

/// The interactivity struct. Powers all of the general-purpose
/// interactivity in the `Div` element.
#[derive(Default)]
pub struct Interactivity {
    /// The element ID of the element. In id is required to support a stateful subset of the interactivity such as on_click.
    pub element_id: Option<ElementId>,
    /// Whether the element was clicked. This will only be present after layout.
    pub active: Option<bool>,
    /// Whether the element was hovered. This will only be present after paint if an hitbox
    /// was created for the interactive element.
    pub hovered: Option<bool>,
    pub(crate) tooltip_id: Option<TooltipId>,
    pub(crate) content_size: Size<Pixels>,
    pub(crate) key_context: Option<KeyContext>,
    pub(crate) focusable: bool,
    pub(crate) tracked_focus_handle: Option<FocusHandle>,
    pub(crate) tracked_scroll_handle: Option<ScrollHandle>,
    pub(crate) scroll_retention: ScrollRetention,
    pub(crate) scroll_child_ids: Vec<Option<ElementId>>,
    pub(crate) pending_scroll_presentation: Option<ScrollPresentation>,
    pub(crate) scroll_anchor: crate::fast::interactivity::Rare<ScrollAnchor>,
    pub(crate) scroll_offset: Option<Rc<RefCell<Point<Pixels>>>>,
    pub(crate) ongoing_scroll: Option<Rc<RefCell<OngoingScroll>>>,
    pub(crate) group: Option<SharedString>,
    /// The base style of the element, before any modifications are applied
    /// by focus, active, etc.
    pub base_style: Box<StyleRefinement>,
    pub(crate) focus_style: Option<Box<StyleRefinement>>,
    pub(crate) in_focus_style: Option<Box<StyleRefinement>>,
    pub(crate) focus_visible_style: Option<Box<StyleRefinement>>,
    pub(crate) hover_style: Option<Box<StyleRefinement>>,
    pub(crate) group_hover_style: crate::fast::interactivity::Rare<GroupStyle>,
    pub(crate) active_style: Option<Box<StyleRefinement>>,
    pub(crate) group_active_style: crate::fast::interactivity::Rare<GroupStyle>,
    pub(crate) drag_over_styles: crate::fast::interactivity::LazyVec<(
        TypeId,
        Box<dyn Fn(&dyn Any, &mut Window, &mut App) -> StyleRefinement>,
    )>,
    pub(crate) group_drag_over_styles: crate::fast::interactivity::LazyVec<(TypeId, GroupStyle)>,
    pub(crate) mouse_down_listeners: crate::fast::interactivity::LazyVec<MouseDownListener>,
    pub(crate) mouse_up_listeners: crate::fast::interactivity::LazyVec<MouseUpListener>,
    pub(crate) mouse_pressure_listeners: crate::fast::interactivity::LazyVec<MousePressureListener>,
    pub(crate) mouse_move_listeners: crate::fast::interactivity::LazyVec<MouseMoveListener>,
    pub(crate) mouse_exit_listeners: crate::fast::interactivity::LazyVec<MouseExitListener>,
    pub(crate) file_drop_exit_listeners: crate::fast::interactivity::LazyVec<FileDropExitListener>,
    pub(crate) scroll_wheel_listeners: crate::fast::interactivity::LazyVec<ScrollWheelListener>,
    pub(crate) pinch_listeners: crate::fast::interactivity::LazyVec<PinchListener>,
    pub(crate) key_down_listeners: crate::fast::interactivity::LazyVec<KeyDownListener>,
    pub(crate) key_up_listeners: crate::fast::interactivity::LazyVec<KeyUpListener>,
    pub(crate) modifiers_changed_listeners:
        crate::fast::interactivity::LazyVec<ModifiersChangedListener>,
    pub(crate) action_listeners: crate::fast::interactivity::LazyVec<(TypeId, ActionListener)>,
    pub(crate) drop_listeners: crate::fast::interactivity::LazyVec<(TypeId, DropListener)>,
    pub(crate) can_drop_predicate: crate::fast::interactivity::Rare<CanDropPredicate>,
    pub(crate) click_listeners: crate::fast::interactivity::LazyVec<ClickListener>,
    pub(crate) aux_click_listeners: crate::fast::interactivity::LazyVec<ClickListener>,
    pub(crate) drag_listener: crate::fast::interactivity::Rare<DragListener>,
    pub(crate) hover_listener:
        crate::fast::interactivity::Rare<Box<dyn Fn(&bool, &mut Window, &mut App)>>,
    pub(crate) hover_listener_mode: HoverListenerMode,
    pub(crate) tooltip_builder: crate::fast::interactivity::Rare<TooltipBuilder>,
    pub(crate) tooltip_show_delay: Option<Duration>,
    pub(crate) window_control: Option<WindowControlArea>,
    pub(crate) hitbox_behavior: HitboxBehavior,
    pub(crate) hitbox_regions: Option<Arc<[Bounds<Pixels>]>>,
    pub(crate) tab_index: Option<isize>,
    pub(crate) tab_group: bool,
    pub(crate) tab_stop: bool,

    pub(crate) a11y_action_listeners: crate::fast::interactivity::LazyVec<(
        accesskit::Action,
        crate::window::a11y::A11yActionListener,
    )>,
    pub(crate) a11y_synthetic_children:
        crate::fast::interactivity::Rare<Box<dyn FnOnce(&mut crate::A11ySubtreeBuilder)>>,
    pub(crate) report_active_descendant_focus: bool,
    pub(crate) override_role: Option<accesskit::Role>,
    pub(crate) aria: crate::fast::interactivity::Aria,

    #[cfg(any(feature = "inspector", debug_assertions))]
    pub(crate) source_location: Option<&'static core::panic::Location<'static>>,

    #[cfg(any(test, all(debug_assertions, feature = "test-support")))]
    pub(crate) debug_selector: Option<String>,
}

impl Interactivity {
    /// A weak handle to this original element's press state, after request_layout.
    /// Cancellation needs no window borrow and does not keep the element alive.
    pub fn click_handle(
        &self,
        global_id: Option<&GlobalElementId>,
        window: &mut Window,
    ) -> Option<ClickHandle> {
        window.with_optional_element_state::<InteractiveElementState, _>(global_id, |state, _| {
            let mut state = state.map(|state| state.unwrap_or_default());
            let handle = state.as_mut().map(InteractiveElementState::click_handle);
            (handle, state)
        })
    }

    /// Layout this element according to this interactivity state's configured styles
    pub fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
        f: impl FnOnce(Style, &mut Window, &mut App) -> LayoutId,
    ) -> LayoutId {
        #[cfg(any(feature = "inspector", debug_assertions))]
        window.with_inspector_state(
            _inspector_id,
            cx,
            |inspector_state: &mut Option<DivInspectorState>, _window| {
                if let Some(inspector_state) = inspector_state {
                    self.base_style = inspector_state.base_style.clone();
                } else {
                    *inspector_state = Some(DivInspectorState {
                        base_style: self.base_style.clone(),
                        bounds: Default::default(),
                        content_size: Default::default(),
                    })
                }
            },
        );

        window.with_optional_element_state::<InteractiveElementState, _>(
            global_id,
            |element_state, window| {
                let mut element_state =
                    element_state.map(|element_state| element_state.unwrap_or_default());

                if let Some(state) = element_state.as_ref() {
                    state.discard_stale_presses(window);
                }

                if let Some(element_state) = element_state.as_ref()
                    && cx.has_active_drag()
                {
                    if let Some(pending_mouse_down) = element_state.pending_mouse_down.as_ref() {
                        *pending_mouse_down.borrow_mut() = None;
                    }
                    if let Some(clicked_state) = element_state.clicked_state.as_ref() {
                        *clicked_state.borrow_mut() = ElementClickedState::default();
                    }
                }

                // Ensure we store a focus handle in our element state if we're focusable.
                // If there's an explicit focus handle we're tracking, use that. Otherwise
                // create a new handle and store it in the element state, which lives for as
                // as frames contain an element with this id.
                if self.focusable
                    && self.tracked_focus_handle.is_none()
                    && let Some(element_state) = element_state.as_mut()
                {
                    let mut handle = element_state
                        .focus_handle
                        .get_or_insert_with(|| cx.focus_handle())
                        .clone()
                        .tab_stop(self.tab_stop);

                    if let Some(index) = self.tab_index {
                        handle = handle.tab_index(index);
                    }

                    self.tracked_focus_handle = Some(handle);
                }

                if let Some(scroll_handle) = self.tracked_scroll_handle.as_ref() {
                    let scroll_handle_state = scroll_handle.0.borrow();
                    crate::fast::dependencies::note_state_read(cx, &scroll_handle_state.version);
                    self.scroll_offset = Some(scroll_handle_state.offset.clone());
                    self.ongoing_scroll = Some(scroll_handle_state.ongoing_scroll.clone());
                } else if (self.base_style.overflow.x == Some(Overflow::Scroll)
                    || self.base_style.overflow.y == Some(Overflow::Scroll))
                    && let Some(element_state) = element_state.as_mut()
                {
                    self.scroll_offset = Some(
                        element_state
                            .scroll_offset
                            .get_or_insert_with(Rc::default)
                            .clone(),
                    );
                    self.ongoing_scroll = Some(
                        element_state
                            .ongoing_scroll
                            .get_or_insert_with(|| Rc::new(RefCell::new(OngoingScroll::default())))
                            .clone(),
                    );
                }

                let style = self.compute_style_internal(None, element_state.as_mut(), window, cx);
                let layout_id = f(style, window, cx);
                (layout_id, element_state)
            },
        )
    }

    /// Commit the bounds of this element according to this interactivity state's configured styles.
    pub fn prepaint<R>(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        content_size: Size<Pixels>,
        window: &mut Window,
        cx: &mut App,
        f: impl FnOnce(&Style, Point<Pixels>, Option<Hitbox>, &mut Window, &mut App) -> R,
    ) -> R {
        self.content_size = content_size;

        #[cfg(any(feature = "inspector", debug_assertions))]
        window.with_inspector_state(
            _inspector_id,
            cx,
            |inspector_state: &mut Option<DivInspectorState>, _window| {
                if let Some(inspector_state) = inspector_state {
                    inspector_state.bounds = bounds;
                    inspector_state.content_size = content_size;
                }
            },
        );

        if let Some(focus_handle) = self.tracked_focus_handle.as_ref() {
            window.set_focus_handle(focus_handle, cx);

            if window.a11y.is_active() {
                if let Some(global_id) = global_id {
                    let node_id = global_id.accesskit_node_id();
                    window.a11y.set_focusable(node_id, focus_handle.id);
                    if focus_handle.is_focused(window) {
                        window.a11y.set_focus(node_id);
                    }
                } else if focus_handle.is_focused(window) {
                    // Focusable, but with no element id it can't have an
                    // accessibility node, so screen readers fall back to the
                    // whole window.
                    window
                        .a11y
                        .note_focus_without_node(focus_handle.id, "it has no element id");
                }
            }
        }

        if self.report_active_descendant_focus && window.a11y.is_active() {
            if let Some(global_id) = global_id {
                window
                    .a11y
                    .set_active_descendant(global_id.accesskit_node_id());
            }
        }
        window.with_optional_element_state::<InteractiveElementState, _>(
            global_id,
            |element_state, window| {
                let mut element_state =
                    element_state.map(|element_state| element_state.unwrap_or_default());
                let style = self.compute_style_internal(None, element_state.as_mut(), window, cx);

                if let Some(element_state) = element_state.as_mut() {
                    if let Some(clicked_state) = element_state.clicked_state.as_ref() {
                        let clicked_state = clicked_state.borrow();
                        self.active = Some(clicked_state.element);
                    }
                    if self.hover_style.is_some() || self.group_hover_style.is_some() {
                        element_state
                            .hover_state
                            .get_or_insert_with(Default::default);
                    }
                    if let Some(active_tooltip) = element_state.active_tooltip.as_ref() {
                        if self.tooltip_builder.is_some() {
                            self.tooltip_id = set_tooltip_on_window(active_tooltip, window);
                        } else {
                            // If there is no longer a tooltip builder, remove the active tooltip.
                            if let Some(long_press_tooltip_active) =
                                element_state.long_press_tooltip_active.as_ref()
                            {
                                long_press_tooltip_active.set(false);
                            }
                            element_state.active_tooltip.take();
                        }
                    }
                }

                window.with_prepaint_visibility(
                    style.display != Display::None && style.visibility != Visibility::Hidden,
                    |window| {
                        let opacity =
                            crate::fast::retained::push_element_opacity(window, style.opacity);
                        let result =
                            window.with_text_style(style.text_style().cloned(), |window| {
                                window.with_content_mask(
                                    style.overflow_mask(bounds, window.rem_size()),
                                    |window| {
                                        let hitbox = if self
                                            .should_insert_hitbox(&style, window, cx)
                                        {
                                            Some(match &self.hitbox_regions {
                                                Some(regions) => window.insert_hitbox_regions(
                                                    bounds,
                                                    self.hitbox_behavior,
                                                    regions.clone(),
                                                ),
                                                None => window
                                                    .insert_hitbox(bounds, self.hitbox_behavior),
                                            })
                                        } else {
                                            None
                                        };

                                        let scroll_offset =
                                            self.clamp_scroll_position(bounds, &style, window, cx);
                                        // Isolate this subtree's request from siblings.
                                        let scrolls = style.overflow.x == Overflow::Scroll
                                            || style.overflow.y == Overflow::Scroll;
                                        let owns_focus = style.display != Display::None
                                            && self
                                                .tracked_focus_handle
                                                .as_ref()
                                                .is_some_and(|h| h.is_focused(window));
                                        let scoped = scrolls || owns_focus;
                                        let outside_request = scoped
                                            .then(|| window.requested_autoscroll.take())
                                            .flatten();
                                        let outside_focus = window.autoscroll_focus_generation;
                                        if owns_focus && window.focus_reveal_pending() {
                                            window.autoscroll_focus_generation =
                                                Some(window.focus_generation);
                                        }
                                        let result = f(&style, scroll_offset, hitbox, window, cx);
                                        if scoped {
                                            let mut request = window.requested_autoscroll.take();
                                            if owns_focus
                                                && window.focus_reveal_pending()
                                                && self
                                                    .tracked_focus_handle
                                                    .as_ref()
                                                    .is_some_and(|handle| handle.is_focused(window))
                                            {
                                                window.focus_reveal_seen = true;
                                                // A child's explicit caret/line request is
                                                // more precise than the whole control.
                                                match request.as_mut() {
                                                    Some(request)
                                                        if !request.precise
                                                            && request.focus_generation
                                                                == Some(
                                                                    window.focus_generation,
                                                                ) =>
                                                    {
                                                        // A control can track the same handle at
                                                        // its editor and outer border. Preserve
                                                        // the entire control's derived bounds.
                                                        request.bounds =
                                                            request.bounds.union(&bounds);
                                                    }
                                                    None => {
                                                        request =
                                                            Some(crate::window::AutoscrollRequest {
                                                                bounds,
                                                                focus_generation: Some(
                                                                    window.focus_generation,
                                                                ),
                                                                precise: false,
                                                            })
                                                    }
                                                    _ => {}
                                                }
                                            }
                                            if scrolls {
                                                request = request.map(|mut request| {
                                                    request.bounds = self.reveal_bounds(
                                                        request.bounds,
                                                        bounds,
                                                        &style,
                                                        scroll_offset,
                                                        window,
                                                    );
                                                    request
                                                });
                                            }
                                            window.requested_autoscroll = window
                                                .prioritize_autoscroll(request, outside_request);
                                        }
                                        window.autoscroll_focus_generation = outside_focus;
                                        (result, element_state)
                                    },
                                )
                            });
                        crate::fast::retained::pop_element_opacity(window, opacity);
                        result
                    },
                )
            },
        )
    }

    fn should_insert_hitbox(&self, style: &Style, window: &Window, cx: &App) -> bool {
        self.hitbox_behavior != HitboxBehavior::Normal
            || self.window_control.is_some()
            || style.mouse_cursor.is_some()
            || self.group.is_some()
            || self.scroll_offset.is_some()
            || self.tracked_focus_handle.is_some()
            || self.hover_style.is_some()
            || self.group_hover_style.is_some()
            || self.hover_listener.is_some()
            || !self.mouse_up_listeners.is_empty()
            || !self.mouse_pressure_listeners.is_empty()
            || !self.mouse_down_listeners.is_empty()
            || !self.mouse_move_listeners.is_empty()
            || !self.mouse_exit_listeners.is_empty()
            || !self.file_drop_exit_listeners.is_empty()
            || !self.click_listeners.is_empty()
            || !self.aux_click_listeners.is_empty()
            || !self.scroll_wheel_listeners.is_empty()
            || self.has_pinch_listeners()
            || self.drag_listener.is_some()
            || !self.drop_listeners.is_empty()
            || !self.drag_over_styles.is_empty()
            || self.tooltip_builder.is_some()
            || window.is_inspector_picking(cx)
    }

    fn clamp_scroll_position(
        &mut self,
        bounds: Bounds<Pixels>,
        style: &Style,
        window: &mut Window,
        _cx: &mut App,
    ) -> Point<Pixels> {
        let Some(scroll_offset) = self.scroll_offset.as_ref() else {
            return Point::default();
        };
        self.pending_scroll_presentation = None;
        if !window.prepaint_visible {
            return *scroll_offset.borrow();
        }
        let scroll_max = self.max_scroll_offset(bounds, style, window);
        if let Some(handle) = self.tracked_scroll_handle.as_ref() {
            {
                let mut state = handle.0.borrow_mut();
                let layout = ScrollLayout {
                    max_y: scroll_max.y,
                    height: bounds.size.height,
                    children: self
                        .scroll_child_ids
                        .iter()
                        .cloned()
                        .zip(state.child_bounds.iter().map(|child| Bounds {
                            origin: child.origin - bounds.origin,
                            size: child.size,
                        }))
                        .collect(),
                };
                // Plain clamping is automatic layout work too. Stage its
                // origin so a discarded smaller plain box cannot look like
                // native input when the next candidate restores anchoring.
                state.retain_position(
                    self.scroll_retention,
                    &layout,
                    px(1. / window.scale_factor()),
                );
                self.pending_scroll_presentation = Some(ScrollPresentation {
                    layout,
                    observation: ScrollObservation::default(),
                    request: None,
                });
                state.overflow = style.overflow;
                state.bounds = bounds;
                state.max_offset = scroll_max;
            }
            // Explicit targets resolve after automatic retention.
            if let Some(presentation) = self.pending_scroll_presentation.as_mut() {
                presentation.request = handle.resolve_scroll_request(&self.scroll_child_ids);
            }
        }
        let mut scroll_offset = scroll_offset.borrow_mut();
        scroll_offset.x = scroll_offset.x.clamp(-scroll_max.x, px(0.));
        scroll_offset.y = scroll_offset.y.clamp(-scroll_max.y, px(0.));
        let offset = crate::fast::layers::paint::snap_scroll_offset(window, *scroll_offset);
        if let Some(presentation) = self.pending_scroll_presentation.as_mut()
            && let Some(handle) = self.tracked_scroll_handle.as_ref()
        {
            presentation.observation = ScrollObservation {
                reading_revision: handle.0.borrow().reading_revision,
                offset,
                max_offset: scroll_max,
                viewport: bounds.size,
                at_end: (offset.y + scroll_max.y).abs() <= px(1. / window.scale_factor()),
                visible_child_keys: presentation
                    .layout
                    .children
                    .iter()
                    .filter_map(|(id, child)| {
                        (child.bottom() + offset.y > px(0.)
                            && child.top() + offset.y < bounds.size.height)
                            .then(|| id.clone())
                            .flatten()
                    })
                    .collect(),
            };
        }
        *scroll_offset
    }

    fn max_scroll_offset(
        &self,
        bounds: Bounds<Pixels>,
        style: &Style,
        window: &Window,
    ) -> Point<Pixels> {
        fn round_to_two_decimals(pixels: Pixels) -> Pixels {
            const ROUNDING_FACTOR: f32 = 100.0;
            (pixels * ROUNDING_FACTOR).round() / ROUNDING_FACTOR
        }
        let rem_size = window.rem_size();
        // Taffy lays the box out with the padding snapped to the device pixel
        // grid (`to_taffy`); recomputed unsnapped, e.g. py_1 at a fractional
        // rem size, it exceeds `bounds` and leaves the box scrollable by the
        // sub-pixel difference.
        let padding = style
            .padding
            .to_pixels(bounds.size.into(), rem_size)
            .map(|edge| window.pixel_snap(*edge));
        let padding_size = size(padding.left + padding.right, padding.top + padding.bottom);
        // The floating point values produced by Taffy and ours often vary
        // slightly after ~5 decimal places. This can lead to cases where after
        // subtracting these, the container becomes scrollable for less than
        // 0.00000x pixels. As we generally don't benefit from a precision that
        // high for the maximum scroll, we round the scroll max to 2 decimal
        // places here.
        let padded_content_size = self.content_size + padding_size;
        let scroll_max = Point::from(padded_content_size - bounds.size)
            .map(round_to_two_decimals)
            .max(&Default::default());
        scroll_max
    }

    fn reveal_bounds(
        &self,
        mut request: Bounds<Pixels>,
        bounds: Bounds<Pixels>,
        style: &Style,
        offset: Point<Pixels>,
        window: &mut Window,
    ) -> Bounds<Pixels> {
        fn delta(start: Pixels, end: Pixels, min: Pixels, max: Pixels) -> Pixels {
            if end - start > max - min || start < min {
                min - start
            } else if end > max {
                max - end
            } else {
                px(0.)
            }
        }
        let Some(shared_offset) = self.scroll_offset.as_ref() else {
            return request;
        };
        let scroll_max = self.max_scroll_offset(bounds, style, window);
        let mut next = offset;
        if style.overflow.x == Overflow::Scroll {
            next.x = (offset.x
                + delta(
                    request.left(),
                    request.right(),
                    bounds.left(),
                    bounds.right(),
                ))
            .clamp(-scroll_max.x, px(0.));
        }
        if style.overflow.y == Overflow::Scroll {
            next.y = (offset.y
                + delta(
                    request.top(),
                    request.bottom(),
                    bounds.top(),
                    bounds.bottom(),
                ))
            .clamp(-scroll_max.y, px(0.));
        }
        let movement = next - offset;
        if movement != Point::default() {
            if let Some(handle) = self.tracked_scroll_handle.as_ref() {
                handle.set_offset(next);
            } else {
                *shared_offset.borrow_mut() = next;
            }
            window.focus_reveal_scrolled = true;
        }
        request.origin += movement;
        // Clip only by this container's own viewport, not an ancestor mask:
        // an offscreen inner viewport still has to be revealed by its parent.
        if style.overflow.x != Overflow::Visible {
            let right = request.right().min(bounds.right());
            request.origin.x = request.left().max(bounds.left()).min(bounds.right());
            request.size.width = (right - request.left()).max(px(0.));
        }
        if style.overflow.y != Overflow::Visible {
            let bottom = request.bottom().min(bounds.bottom());
            request.origin.y = request.top().max(bounds.top()).min(bounds.bottom());
            request.size.height = (bottom - request.top()).max(px(0.));
        }
        request
    }

    /// Paint this element according to this interactivity state's configured styles
    /// and bind the element's mouse and keyboard events.
    ///
    /// content_size is the size of the content of the element, which may be larger than the
    /// element's bounds if the element is scrollable.
    ///
    /// the final computed style will be passed to the provided function, along
    /// with the current scroll offset
    pub fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        hitbox: Option<&Hitbox>,
        window: &mut Window,
        cx: &mut App,
        f: impl FnOnce(&Style, &mut Window, &mut App),
    ) {
        self.hovered = hitbox.map(|hitbox| hitbox.is_hovered(window));
        let accessibility_clicks = if window.is_a11y_active()
            && !self
                .a11y_action_listeners
                .iter()
                .any(|(action, _)| *action == accesskit::Action::Click)
        {
            self.click_listeners.iter().cloned().collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        window.with_optional_element_state::<InteractiveElementState, _>(
            global_id,
            |element_state, window| {
                let mut element_state =
                    element_state.map(|element_state| element_state.unwrap_or_default());

                let style = self.compute_style_internal(hitbox, element_state.as_mut(), window, cx);

                #[cfg(any(test, all(debug_assertions, feature = "test-support")))]
                if let Some(debug_selector) = &self.debug_selector {
                    window
                        .next_frame
                        .record_debug_bounds(debug_selector.clone(), bounds);
                }

                self.paint_hover_group_handler(window, cx);

                if style.visibility == Visibility::Hidden {
                    return ((), element_state);
                }

                let mut tab_group = None;
                if self.tab_group {
                    tab_group = self.tab_index;
                }

                window.with_element_opacity(style.opacity, |window| {
                    style.paint(bounds, window, cx, |window: &mut Window, cx: &mut App| {
                        window.with_text_style(style.text_style().cloned(), |window| {
                            window.with_content_mask(
                                style.overflow_mask(bounds, window.rem_size()),
                                |window| {
                                    window.with_tab_group(tab_group, |window| {
                                        // Register the container's own focus handle *inside* its
                                        // tab group, so that focusing the container and then
                                        // calling `focus_next` descends into this group's first
                                        // item. Inserting it before `with_tab_group` would give the
                                        // container a shallower tab path than its children; with
                                        // sibling groups every container would then sort ahead of
                                        // every item, and `focus_next` from a container would jump
                                        // to the first item in the whole window instead of its own.
                                        if let Some(focus_handle) = &self.tracked_focus_handle {
                                            window.next_frame.tab_stops.insert(focus_handle);
                                        }
                                        if let Some(hitbox) = hitbox {
                                            #[cfg(debug_assertions)]
                                            self.paint_debug_info(
                                                global_id, hitbox, &style, window, cx,
                                            );

                                            if let Some(drag) = cx.active_drag.as_ref() {
                                                if let Some(mouse_cursor) = drag.cursor_style {
                                                    window.set_window_cursor_style(mouse_cursor);
                                                }
                                            } else {
                                                if let Some(mouse_cursor) = style.mouse_cursor {
                                                    window.set_cursor_style(mouse_cursor, hitbox);
                                                }
                                            }

                                            if let Some(group) = self.group.clone() {
                                                GroupHitboxes::push(group, hitbox.id, cx);
                                            }

                                            if let Some(area) = self.window_control {
                                                window.insert_window_control_hitbox(
                                                    area,
                                                    hitbox.clone(),
                                                );
                                            }

                                            self.paint_mouse_listeners(
                                                hitbox,
                                                element_state.as_mut(),
                                                window,
                                                cx,
                                            );
                                            self.paint_scroll_listener(hitbox, &style, window, cx);
                                        }

                                        self.paint_keyboard_listeners(window, cx);

                                        if window.a11y.is_active() {
                                            if let Some(global_id) = global_id {
                                                if !accessibility_clicks.is_empty() {
                                                    let node_id = global_id.accesskit_node_id();
                                                    let listeners = accessibility_clicks.clone();
                                                    let handle = element_state
                                                        .as_mut()
                                                        .map(InteractiveElementState::click_handle);
                                                    window.on_a11y_action(
                                                        node_id,
                                                        accesskit::Action::Click,
                                                        move |_, window, cx| {
                                                            if let Some(handle) = &handle {
                                                                handle.cancel();
                                                            }
                                                            let click = ClickEvent::Accessibility(
                                                                AccessibilityClickEvent { bounds },
                                                            );
                                                            let interruption =
                                                                window.input_interruption();
                                                            for listener in &listeners {
                                                                listener(&click, window, cx);
                                                                if window.input_interruption()
                                                                    != interruption
                                                                {
                                                                    cx.stop_propagation();
                                                                    break;
                                                                }
                                                            }
                                                        },
                                                    );
                                                }
                                                if !self.a11y_action_listeners.is_empty() {
                                                    let node_id = global_id.accesskit_node_id();
                                                    for (action, listener) in
                                                        self.a11y_action_listeners.drain(..)
                                                    {
                                                        window.on_a11y_action(
                                                            node_id, action, listener,
                                                        );
                                                    }
                                                }
                                            }
                                        }

                                        f(&style, window, cx);

                                        if let Some(_hitbox) = hitbox {
                                            #[cfg(any(feature = "inspector", debug_assertions))]
                                            window.insert_inspector_hitbox(
                                                _hitbox.id,
                                                _inspector_id,
                                                cx,
                                            );

                                            if let Some(group) = self.group.as_ref() {
                                                GroupHitboxes::pop(group, cx);
                                            }
                                        }
                                    })
                                },
                            );
                        });
                    });
                });

                ((), element_state)
            },
        );
    }

    #[cfg(debug_assertions)]
    fn paint_debug_info(
        &self,
        global_id: Option<&GlobalElementId>,
        hitbox: &Hitbox,
        style: &Style,
        window: &mut Window,
        cx: &mut App,
    ) {
        use crate::{BorderStyle, TextAlign};

        if let Some(global_id) = global_id
            && (style.debug || style.debug_below || cx.has_global::<crate::DebugBelow>())
            && hitbox.is_hovered(window)
        {
            const FONT_SIZE: crate::Pixels = crate::Pixels(10.);
            let element_id = format!("{global_id:?}");
            let str_len = element_id.len();

            let render_debug_text = |window: &mut Window| {
                if let Some(text) = window
                    .text_system()
                    .shape_text(
                        element_id.into(),
                        FONT_SIZE,
                        &[window.text_style().to_run(str_len)],
                        None,
                        None,
                    )
                    .ok()
                    .and_then(|mut text| text.pop())
                {
                    text.paint(hitbox.origin, FONT_SIZE, TextAlign::Left, None, window, cx)
                        .ok();

                    let text_bounds = crate::Bounds {
                        origin: hitbox.origin,
                        size: text.size(FONT_SIZE),
                    };
                    if let Some(source_location) = self.source_location
                        && text_bounds.contains(&window.mouse_position())
                        && window.modifiers().secondary()
                    {
                        let secondary_held = window.modifiers().secondary();
                        window.on_key_event({
                            move |e: &crate::ModifiersChangedEvent, _phase, window, _cx| {
                                if e.modifiers.secondary() != secondary_held
                                    && text_bounds.contains(&window.mouse_position())
                                {
                                    window.refresh();
                                }
                            }
                        });

                        let was_hovered = hitbox.is_hovered(window);
                        let current_view = window.current_view();
                        let subtrees = crate::fast::retained::enclosing_retained_subtrees(window);
                        window.on_mouse_event({
                            let hitbox = hitbox.clone();
                            move |_: &MouseMoveEvent, phase, window, cx| {
                                if phase == DispatchPhase::Capture {
                                    let hovered = hitbox.is_hovered(window);
                                    if hovered != was_hovered {
                                        crate::fast::retained::invalidate_retained_subtrees(
                                            window, &subtrees,
                                        );
                                        cx.notify(current_view)
                                    }
                                }
                            }
                        });

                        window.on_mouse_event({
                            let hitbox = hitbox.clone();
                            move |e: &crate::MouseDownEvent, phase, window, cx| {
                                if text_bounds.contains(&e.position)
                                    && phase.capture()
                                    && hitbox.is_hovered(window)
                                {
                                    cx.stop_propagation();
                                    let Ok(dir) = std::env::current_dir() else {
                                        return;
                                    };

                                    eprintln!(
                                        "This element was created at:\n{}:{}:{}",
                                        dir.join(source_location.file()).to_string_lossy(),
                                        source_location.line(),
                                        source_location.column()
                                    );
                                }
                            }
                        });
                        window.paint_quad(crate::outline(
                            crate::Bounds {
                                origin: hitbox.origin
                                    + crate::point(crate::px(0.), FONT_SIZE - px(2.)),
                                size: crate::Size {
                                    width: text_bounds.size.width,
                                    height: crate::px(1.),
                                },
                            },
                            crate::red(),
                            BorderStyle::default(),
                        ))
                    }
                }
            };

            window.with_text_style(
                Some(crate::TextStyleRefinement {
                    color: Some(crate::red()),
                    line_height: Some(FONT_SIZE.into()),
                    background_color: Some(crate::white()),
                    ..Default::default()
                }),
                render_debug_text,
            )
        }
    }

    fn paint_mouse_listeners(
        &mut self,
        hitbox: &Hitbox,
        element_state: Option<&mut InteractiveElementState>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let is_focused = self
            .tracked_focus_handle
            .as_ref()
            .map(|handle| handle.is_focused(window))
            .unwrap_or(false);

        // If this element can be focused, register a mouse down listener
        // that will automatically transfer focus when hitting the element.
        // This behavior can be suppressed by using `cx.prevent_default()`.
        if let Some(focus_handle) = self.tracked_focus_handle.clone() {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |_: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && hitbox.is_hovered(window)
                    && !window.default_prevented()
                {
                    window.focus(&focus_handle, cx);
                    // If there is a parent that is also focusable, prevent it
                    // from transferring focus because we already did so.
                    window.prevent_default();
                }
            });
        }

        for listener in self.mouse_down_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        for listener in self.mouse_up_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        for listener in self.mouse_pressure_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &MousePressureEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        for listener in self.mouse_move_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        for listener in self.mouse_exit_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &MouseExitEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        for listener in self.file_drop_exit_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &FileDropEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        for listener in self.scroll_wheel_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &ScrollWheelEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        for listener in self.pinch_listeners.drain(..) {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &PinchEvent, phase, window, cx| {
                listener(event, phase, &hitbox, window, cx);
            })
        }

        if self.hover_style.is_some()
            || self.base_style.mouse_cursor.is_some()
            || cx.active_drag.is_some() && !self.drag_over_styles.is_empty()
        {
            let hitbox = hitbox.clone();
            let hover_state = self.hover_style.as_ref().and_then(|_| {
                element_state
                    .as_ref()
                    .and_then(|state| state.hover_state.as_ref())
                    .cloned()
            });
            let current_view = window.current_view();
            let subtrees = crate::fast::retained::enclosing_retained_subtrees(window);

            window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                let hovered = hitbox.is_hovered(window);
                let was_hovered = hover_state
                    .as_ref()
                    .is_some_and(|state| state.borrow().element);
                if phase == DispatchPhase::Capture && hovered != was_hovered {
                    if let Some(hover_state) = &hover_state {
                        hover_state.borrow_mut().element = hovered;
                        crate::fast::retained::invalidate_retained_subtrees(window, &subtrees);
                        cx.notify(current_view);
                    }
                }
            });
        }

        if let Some(group_hover) = self.group_hover_style.as_ref() {
            if let Some(group_hitbox_id) = GroupHitboxes::get(&group_hover.group, cx) {
                let hover_state = element_state
                    .as_ref()
                    .and_then(|element| element.hover_state.as_ref())
                    .cloned();
                let current_view = window.current_view();
                let subtrees = crate::fast::retained::enclosing_retained_subtrees(window);

                window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                    let group_hovered = group_hitbox_id.is_hovered(window);
                    let was_group_hovered = hover_state
                        .as_ref()
                        .is_some_and(|state| state.borrow().group);
                    if phase == DispatchPhase::Capture && group_hovered != was_group_hovered {
                        if let Some(hover_state) = &hover_state {
                            hover_state.borrow_mut().group = group_hovered;
                            crate::fast::retained::invalidate_retained_subtrees(window, &subtrees);
                            cx.notify(current_view);
                        }
                    }
                });
            }
        }

        let drag_cursor_style = self.base_style.as_ref().mouse_cursor;

        let mut drag_listener = mem::take(&mut self.drag_listener);
        let drop_listeners = mem::take(&mut self.drop_listeners);
        let click_listeners = mem::take(&mut self.click_listeners);
        let aux_click_listeners = mem::take(&mut self.aux_click_listeners);
        let can_drop_predicate = mem::take(&mut self.can_drop_predicate);

        if !drop_listeners.is_empty() {
            let hitbox = hitbox.clone();
            window.on_mouse_event({
                move |_: &MouseUpEvent, phase, window, cx| {
                    if let Some(drag) = &cx.active_drag
                        && phase == DispatchPhase::Bubble
                        && hitbox.is_hovered(window)
                    {
                        let drag_state_type = drag.value.as_ref().type_id();
                        for (drop_state_type, listener) in &drop_listeners {
                            if *drop_state_type == drag_state_type {
                                let drag = cx
                                    .active_drag
                                    .take()
                                    .expect("checked for type drag state type above");

                                let mut can_drop = true;
                                if let Some(predicate) = &can_drop_predicate {
                                    can_drop = predicate(drag.value.as_ref(), window, cx);
                                }

                                if can_drop {
                                    listener(drag.value.as_ref(), window, cx);
                                    window.refresh();
                                    cx.stop_propagation();
                                }
                            }
                        }
                    }
                }
            });
        }

        if let Some(element_state) = element_state {
            if !click_listeners.is_empty()
                || !aux_click_listeners.is_empty()
                || drag_listener.is_some()
            {
                let generation = element_state
                    .click_generation
                    .get_or_insert_with(Default::default)
                    .clone();
                let pending_mouse_down = element_state
                    .pending_mouse_down
                    .get_or_insert_with(Default::default)
                    .clone();

                let pending_keyboard_down = element_state
                    .pending_keyboard_down
                    .get_or_insert_with(Default::default)
                    .clone();

                let clicked_state = element_state
                    .clicked_state
                    .get_or_insert_with(Default::default)
                    .clone();

                window.on_mouse_event({
                    let pending_mouse_down = pending_mouse_down.clone();
                    let hitbox = hitbox.clone();
                    let has_aux_click_listeners = !aux_click_listeners.is_empty();
                    let generation = generation.clone();
                    move |event: &MouseDownEvent, phase, window, _cx| {
                        if phase == DispatchPhase::Bubble
                            && (event.button == MouseButton::Left || has_aux_click_listeners)
                            && hitbox.is_hovered(window)
                        {
                            let serial = window.click_input.serial();
                            *pending_mouse_down.borrow_mut() = window
                                .click_input
                                .is_current(serial)
                                .then(|| MouseClickPress {
                                    down: event.clone(),
                                    serial,
                                    generation: generation.get(),
                                });
                            window.refresh();
                        }
                    }
                });

                window.on_mouse_event({
                    let pending_mouse_down = pending_mouse_down.clone();
                    let hitbox = hitbox.clone();
                    let generation = generation.clone();
                    move |event: &MouseMoveEvent, phase, window, cx| {
                        let mut pending_mouse_down = pending_mouse_down.borrow_mut();
                        if pending_mouse_down.as_ref().is_some_and(|press| {
                            event.pressed_button != Some(press.down.button)
                                || !window.click_input.is_pending(press.serial)
                                || press.generation != generation.get()
                        }) {
                            pending_mouse_down.take();
                            *clicked_state.borrow_mut() = ElementClickedState::default();
                            window.refresh();
                        }
                        if phase == DispatchPhase::Capture {
                            return;
                        }

                        if let Some(mouse_down) = pending_mouse_down.clone()
                            && !cx.has_active_drag()
                            && (event.position - mouse_down.position).magnitude() > DRAG_THRESHOLD
                            && let Some(listener) = drag_listener.take()
                            && mouse_down.button == MouseButton::Left
                        {
                            *clicked_state.borrow_mut() = ElementClickedState::default();
                            pending_mouse_down.take();
                            drop(pending_mouse_down);
                            let cursor_offset = event.position - hitbox.origin;
                            let drag = (listener.render)(
                                listener.value.as_ref(),
                                cursor_offset,
                                window,
                                cx,
                            );
                            let external_payload_source =
                                listener.external_payload.map(|external_payload| {
                                    let value = listener.value.clone();
                                    Box::new(move |window: &mut Window, cx: &mut App| {
                                        external_payload(value.as_ref(), window, cx)
                                    })
                                        as ExternalDragPayloadSource
                                });
                            cx.active_drag = Some(AnyDrag {
                                view: drag,
                                value: listener.value,
                                cursor_offset,
                                cursor_style: drag_cursor_style,
                                external_payload_source,
                            });
                            window.refresh();
                            cx.stop_propagation();
                        }
                    }
                });

                if is_focused {
                    window.on_key_event({
                        let pending = pending_keyboard_down.clone();
                        let generation = generation.clone();
                        move |event: &KeyDownEvent, phase, window, _| {
                            if phase.capture() {
                                pending.borrow_mut().take();
                            }
                            if phase.bubble() && !window.default_prevented() {
                                let serial = window.click_input.serial();
                                *pending.borrow_mut() = activation_key(&event.keystroke.key)
                                    .filter(|_| {
                                        !event.keystroke.modifiers.modified()
                                            && window.click_input.is_current(serial)
                                    })
                                    .map(|button| KeyboardClickPress {
                                        button,
                                        focus_generation: window.focus_generation,
                                        serial,
                                        generation: generation.get(),
                                    });
                            }
                        }
                    });
                    window.on_key_event({
                        let captured = Cell::new(None);
                        let generation = generation.clone();
                        let listeners = click_listeners.clone();
                        let hitbox = hitbox.clone();
                        move |event: &KeyUpEvent, phase, window, cx| {
                            if phase.capture() {
                                captured.set(pending_keyboard_down.borrow_mut().take());
                            } else if let Some(press) = captured.take() {
                                let serial = window.click_input.serial();
                                if window.default_prevented()
                                    || event.keystroke.modifiers.modified()
                                    || activation_key(&event.keystroke.key) != Some(press.button)
                                    || press.focus_generation != window.focus_generation
                                    || press.generation != generation.get()
                                    || serial != press.serial.wrapping_add(1)
                                    || !window.click_input.is_current(serial)
                                {
                                    return;
                                }
                                let click = ClickEvent::Keyboard(KeyboardClickEvent {
                                    button: press.button,
                                    bounds: hitbox.bounds,
                                });
                                for listener in &listeners {
                                    listener(&click, window, cx);
                                }
                            }
                        }
                    });
                }

                window.on_mouse_event({
                    let mut captured_mouse_down = None;
                    let hitbox = hitbox.clone();
                    move |event: &MouseUpEvent, phase, window, cx| match phase {
                        DispatchPhase::Capture => {
                            captured_mouse_down = None;
                            if let Some(press) = pending_mouse_down.borrow_mut().take() {
                                let serial = window.click_input.serial();
                                if hitbox.is_hovered(window)
                                    && press.down.button == event.button
                                    && serial == press.serial.wrapping_add(1)
                                    && window.click_input.is_current(serial)
                                {
                                    captured_mouse_down = Some(press);
                                }
                                window.refresh();
                            }
                        }
                        DispatchPhase::Bubble => {
                            if let Some(press) = captured_mouse_down.take() {
                                if press.generation != generation.get()
                                    || !window.click_input.is_current(window.click_input.serial())
                                {
                                    return;
                                }
                                let button = press.down.button;
                                let click = ClickEvent::Mouse(MouseClickEvent {
                                    down: press.down,
                                    up: event.clone(),
                                });
                                let listeners = if button == MouseButton::Left {
                                    &click_listeners
                                } else {
                                    &aux_click_listeners
                                };
                                let interruption = window.input_interruption();
                                for listener in listeners {
                                    listener(&click, window, cx);
                                    if window.input_interruption() != interruption {
                                        cx.stop_propagation();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                });
            }

            if let Some(hover_listener) = self.hover_listener.take() {
                let was_hovered = element_state
                    .hover_listener_state
                    .get_or_insert_with(Default::default)
                    .clone();
                let has_mouse_down = element_state
                    .pending_mouse_down
                    .get_or_insert_with(Default::default)
                    .clone();
                let hover_listener = Rc::new(hover_listener);
                let hover_listener_state = was_hovered.clone();
                let update_hover = move |is_hovered: bool, window: &mut Window, cx: &mut App| {
                    let mut was_hovered = hover_listener_state.borrow_mut();
                    if is_hovered != *was_hovered {
                        *was_hovered = is_hovered;
                        drop(was_hovered);
                        hover_listener(&is_hovered, window, cx);
                    }
                };
                let hover_listener_mode = self.hover_listener_mode;

                if has_mouse_down.borrow().is_none() {
                    let is_hovered =
                        !cx.has_active_drag() && hover_listener_mode.is_hovered(hitbox, window);
                    if is_hovered != *was_hovered.borrow() {
                        let update_hover = update_hover.clone();
                        window.defer(cx, move |window, cx| {
                            update_hover(is_hovered, window, cx);
                        });
                    }
                }

                window.on_mouse_event({
                    let update_hover = update_hover.clone();
                    let hitbox = hitbox.clone();
                    move |_: &MouseMoveEvent, phase, window, cx| {
                        if phase == DispatchPhase::Bubble {
                            let is_hovered = has_mouse_down.borrow().is_none()
                                && !cx.has_active_drag()
                                && hover_listener_mode.is_hovered(&hitbox, window);
                            update_hover(is_hovered, window, cx);
                        }
                    }
                });

                // The pointer can leave the window without a final MouseMove, so also
                // clear hover on MouseExited.
                window.on_mouse_event(move |_: &MouseExitEvent, phase, window, cx| {
                    if phase == DispatchPhase::Bubble {
                        update_hover(false, window, cx);
                    }
                });
            }

            if let Some(tooltip_builder) = self.tooltip_builder.take() {
                let active_tooltip = element_state
                    .active_tooltip
                    .get_or_insert_with(Default::default)
                    .clone();
                let pending_mouse_down = element_state
                    .pending_mouse_down
                    .get_or_insert_with(Default::default)
                    .clone();
                let long_press_tooltip_active = element_state
                    .long_press_tooltip_active
                    .get_or_insert_with(Default::default)
                    .clone();

                let tooltip_is_hoverable = tooltip_builder.hoverable;
                let build_tooltip = Rc::new(move |window: &mut Window, cx: &mut App| {
                    Some(((tooltip_builder.build)(window, cx), tooltip_is_hoverable))
                });
                // Prepaint checks geometry, including fragments and mask, without claiming occlusion.
                let check_is_hovered_during_prepaint = Rc::new({
                    let pending_mouse_down = pending_mouse_down.clone();
                    let source_hitbox = hitbox.clone();
                    move |window: &Window| {
                        !window.last_input_was_keyboard()
                            && pending_mouse_down.borrow().is_none()
                            && source_hitbox.contains(&window.mouse_position())
                    }
                });
                let check_is_hovered = Rc::new({
                    let hitbox = hitbox.clone();
                    move |window: &Window| {
                        pending_mouse_down.borrow().is_none() && hitbox.is_hovered(window)
                    }
                });
                register_tooltip_mouse_handlers(
                    &active_tooltip,
                    self.tooltip_id,
                    build_tooltip,
                    check_is_hovered,
                    check_is_hovered_during_prepaint,
                    long_press_tooltip_active,
                    self.tooltip_show_delay,
                    window,
                );
            }

            // We unconditionally bind both the mouse up and mouse down active state handlers
            // Because we might not get a chance to render a frame before the mouse up event arrives.
            let active_state = element_state
                .clicked_state
                .get_or_insert_with(Default::default)
                .clone();

            {
                let active_state = active_state.clone();
                window.on_mouse_event(move |_: &MouseUpEvent, phase, window, _cx| {
                    if phase == DispatchPhase::Capture && active_state.borrow().is_clicked() {
                        *active_state.borrow_mut() = ElementClickedState::default();
                        window.refresh();
                    }
                });
            }

            {
                let active_group_hitbox = self
                    .group_active_style
                    .as_ref()
                    .and_then(|group_active| GroupHitboxes::get(&group_active.group, cx));
                let hitbox = hitbox.clone();
                window.on_mouse_event(move |_: &MouseDownEvent, phase, window, _cx| {
                    if phase == DispatchPhase::Bubble && !window.default_prevented() {
                        let group_hovered = active_group_hitbox
                            .is_some_and(|group_hitbox_id| group_hitbox_id.is_hovered(window));
                        let element_hovered = hitbox.is_hovered(window);
                        if group_hovered || element_hovered {
                            *active_state.borrow_mut() = ElementClickedState {
                                group: group_hovered,
                                element: element_hovered,
                            };
                            window.refresh();
                        }
                    }
                });
            }
        }
    }

    fn paint_keyboard_listeners(&mut self, window: &mut Window, _cx: &mut App) {
        let key_down_listeners = mem::take(&mut self.key_down_listeners);
        let key_up_listeners = mem::take(&mut self.key_up_listeners);
        let modifiers_changed_listeners = mem::take(&mut self.modifiers_changed_listeners);
        let action_listeners = mem::take(&mut self.action_listeners);
        if let Some(context) = self.key_context.clone() {
            window.set_key_context(context);
        }

        for listener in key_down_listeners {
            window.on_key_event(move |event: &KeyDownEvent, phase, window, cx| {
                listener(event, phase, window, cx);
            })
        }

        for listener in key_up_listeners {
            window.on_key_event(move |event: &KeyUpEvent, phase, window, cx| {
                listener(event, phase, window, cx);
            })
        }

        for listener in modifiers_changed_listeners {
            window.on_modifiers_changed(move |event: &ModifiersChangedEvent, window, cx| {
                listener(event, window, cx);
            })
        }

        for (action_type, listener) in action_listeners {
            window.on_action(action_type, listener)
        }
    }

    fn paint_hover_group_handler(&self, window: &mut Window, cx: &mut App) {
        let group_hitbox = self
            .group_hover_style
            .as_ref()
            .and_then(|group_hover| GroupHitboxes::get(&group_hover.group, cx));

        if let Some(group_hitbox) = group_hitbox {
            let was_hovered = group_hitbox.is_hovered(window);
            let current_view = window.current_view();
            let subtrees = crate::fast::retained::enclosing_retained_subtrees(window);
            window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                let hovered = group_hitbox.is_hovered(window);
                if phase == DispatchPhase::Capture && hovered != was_hovered {
                    crate::fast::retained::invalidate_retained_subtrees(window, &subtrees);
                    cx.notify(current_view);
                }
            });
        }
    }

    fn paint_scroll_listener(
        &self,
        hitbox: &Hitbox,
        style: &Style,
        window: &mut Window,
        _cx: &mut App,
    ) {
        if let Some(scroll_offset) = self.scroll_offset.clone() {
            let ongoing_scroll = self.ongoing_scroll.clone();
            let scroll_handle = self
                .tracked_scroll_handle
                .as_ref()
                .map(|h| Rc::downgrade(&h.0));
            let overflow = style.overflow;
            let allow_concurrent_scroll = style.allow_concurrent_scroll;
            let restrict_scroll_to_axis = style.restrict_scroll_to_axis;
            let line_height = window.line_height();
            // How far it can move, as laid out for this frame, so an event
            // that would only push it past an edge is seen not to move it.
            let scroll_max = self.max_scroll_offset(hitbox.bounds, style, window);
            // The offset's cell stays the same from frame to frame.
            let owner = Rc::as_ptr(&scroll_offset) as *const () as usize;
            let hitbox = hitbox.clone();
            let current_view = window.current_view();
            let subtrees = crate::fast::retained::enclosing_retained_subtrees(window);
            let fast_container = crate::fast::layers::invalidate::painted_container(window, self);
            window.on_mouse_event(move |event: &ScrollWheelEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble && hitbox.should_handle_scroll(window) {
                    let mut scroll_offset = scroll_offset.borrow_mut();
                    let old_scroll_offset = *scroll_offset;
                    let mut delta = event.delta.pixel_delta(line_height);

                    if restrict_scroll_to_axis
                        && event.delta.precise()
                        && let Some(ongoing_scroll) = &ongoing_scroll
                    {
                        ongoing_scroll
                            .borrow_mut()
                            .filter(&mut delta, event.touch_phase);
                    }

                    // Whether it scrolls with the wheel's other axis.
                    let mut crosswise = false;
                    let mut delta_x = match overflow.x {
                        Overflow::Scroll if !delta.x.is_zero() => delta.x,
                        Overflow::Scroll
                            if !restrict_scroll_to_axis && overflow.y != Overflow::Scroll =>
                        {
                            crosswise = !delta.y.is_zero();
                            delta.y
                        }
                        _ => Pixels::ZERO,
                    };
                    let mut delta_y = match overflow.y {
                        Overflow::Scroll if !delta.y.is_zero() => delta.y,
                        Overflow::Scroll
                            if !restrict_scroll_to_axis && overflow.x != Overflow::Scroll =>
                        {
                            crosswise = !delta.x.is_zero();
                            delta.x
                        }
                        _ => Pixels::ZERO,
                    };
                    let turn = (!crosswise).then(|| window.scroll_latch.turn(owner));
                    if turn == Some(ScrollTurn::Elsewhere) {
                        return;
                    }
                    if !allow_concurrent_scroll && !delta_x.is_zero() && !delta_y.is_zero() {
                        if delta_x.abs() > delta_y.abs() {
                            delta_y = Pixels::ZERO;
                        } else {
                            delta_x = Pixels::ZERO;
                        }
                    }
                    scroll_offset.y = (scroll_offset.y + delta_y).clamp(-scroll_max.y, px(0.));
                    scroll_offset.x = (scroll_offset.x + delta_x).clamp(-scroll_max.x, px(0.));
                    let moved = *scroll_offset != old_scroll_offset;
                    let moved_along = match ScrollLatch::axis(delta) {
                        Axis::Vertical => scroll_offset.y != old_scroll_offset.y,
                        Axis::Horizontal => scroll_offset.x != old_scroll_offset.x,
                    };
                    // The gesture is this container's once it moves it along
                    // the gesture's axis. The containers around it, whose
                    // listeners run after this one, then leave the event
                    // alone (`ScrollLatch`); other listeners still see it.
                    if let Some(turn) = turn
                        && (moved_along || turn == ScrollTurn::Held)
                    {
                        window
                            .scroll_latch
                            .hold(owner, cx.background_executor().now());
                    }
                    if moved {
                        if let Some(handle) = scroll_handle.as_ref().and_then(Weak::upgrade) {
                            let mut state = handle.borrow_mut();
                            state.note_reading_intent();
                            state.explicit_scroll(scroll_offset.y);
                        }
                        crate::fast::retained::invalidate_retained_subtrees(window, &subtrees);
                        crate::fast::layers::invalidate::note_scrolled(window, &fast_container);
                        cx.notify(current_view);
                    }
                }
            });
        }
    }

    /// Compute the visual style for this element, based on the current bounds and the element's state.
    pub fn compute_style(
        &self,
        global_id: Option<&GlobalElementId>,
        hitbox: Option<&Hitbox>,
        window: &mut Window,
        cx: &mut App,
    ) -> Style {
        window.with_optional_element_state(global_id, |element_state, window| {
            let mut element_state =
                element_state.map(|element_state| element_state.unwrap_or_default());
            let style = self.compute_style_internal(hitbox, element_state.as_mut(), window, cx);
            (style, element_state)
        })
    }

    /// Called from internal methods that have already called with_element_state.
    fn compute_style_internal(
        &self,
        hitbox: Option<&Hitbox>,
        element_state: Option<&mut InteractiveElementState>,
        window: &mut Window,
        cx: &mut App,
    ) -> Style {
        let mut style = Style::default();
        style.refine(&self.base_style);

        if let Some(focus_handle) = self.tracked_focus_handle.as_ref() {
            if let Some(in_focus_style) = self.in_focus_style.as_ref()
                && focus_handle.within_focused(window, cx)
            {
                style.refine(in_focus_style);
            }

            if let Some(focus_style) = self.focus_style.as_ref()
                && focus_handle.is_focused(window)
            {
                style.refine(focus_style);
            }

            if let Some(focus_visible_style) = self.focus_visible_style.as_ref()
                && focus_handle.is_focused(window)
                && window.last_input_was_keyboard()
            {
                style.refine(focus_visible_style);
            }
        }

        if !cx.has_active_drag() {
            if let Some(group_hover) = self.group_hover_style.as_ref() {
                let is_group_hovered =
                    if let Some(group_hitbox_id) = GroupHitboxes::get(&group_hover.group, cx) {
                        !window.last_input_was_touch() && group_hitbox_id.is_hovered(window)
                    } else if let Some(element_state) = element_state.as_ref() {
                        !window.last_input_was_touch()
                            && element_state
                                .hover_state
                                .as_ref()
                                .map(|state| state.borrow().group)
                                .unwrap_or(false)
                    } else {
                        false
                    };

                if is_group_hovered {
                    style.refine(&group_hover.style);
                }
            }

            if let Some(hover_style) = self.hover_style.as_ref() {
                let is_hovered = if let Some(hitbox) = hitbox {
                    !window.last_input_was_touch() && hitbox.is_hovered(window)
                } else if let Some(element_state) = element_state.as_ref() {
                    !window.last_input_was_touch()
                        && element_state
                            .hover_state
                            .as_ref()
                            .map(|state| state.borrow().element)
                            .unwrap_or(false)
                } else {
                    false
                };

                if is_hovered {
                    style.refine(hover_style);
                }
            }
        }

        if let Some(hitbox) = hitbox {
            if let Some(drag) = cx.active_drag.take() {
                let mut can_drop = true;
                if let Some(can_drop_predicate) = &self.can_drop_predicate {
                    can_drop = can_drop_predicate(drag.value.as_ref(), window, cx);
                }

                if can_drop {
                    for (state_type, group_drag_style) in &self.group_drag_over_styles {
                        if let Some(group_hitbox_id) =
                            GroupHitboxes::get(&group_drag_style.group, cx)
                            && *state_type == drag.value.as_ref().type_id()
                            && group_hitbox_id.is_hovered(window)
                        {
                            style.refine(&group_drag_style.style);
                        }
                    }

                    for (state_type, build_drag_over_style) in &self.drag_over_styles {
                        if *state_type == drag.value.as_ref().type_id() && hitbox.is_hovered(window)
                        {
                            style.refine(&build_drag_over_style(drag.value.as_ref(), window, cx));
                        }
                    }
                }

                style.mouse_cursor = drag.cursor_style;
                cx.active_drag = Some(drag);
            }
        }

        if let Some(element_state) = element_state {
            let clicked_state = element_state
                .clicked_state
                .get_or_insert_with(Default::default)
                .borrow();
            if clicked_state.group
                && let Some(group) = self.group_active_style.as_ref()
            {
                style.refine(&group.style)
            }

            if let Some(active_style) = self.active_style.as_ref()
                && clicked_state.element
            {
                style.refine(active_style)
            }
        }

        style
    }

    pub(crate) fn write_a11y_info(&self, node: &mut accesskit::Node) {
        if let Some(id) = &self.aria.author_id {
            node.set_author_id(id.to_string());
        }
        if let Some(label) = &self.aria.label {
            node.set_label(label.to_string());
        }
        if let Some(description) = &self.aria.description {
            node.set_description(description.to_string());
        }
        if let Some(keyshortcuts) = &self.aria.keyshortcuts {
            node.set_keyboard_shortcut(keyshortcuts.to_string());
        }
        if let Some(selected) = self.aria.selected {
            node.set_selected(selected);
        }
        if let Some(disabled) = self.aria.disabled {
            if disabled {
                node.set_disabled();
            } else {
                node.clear_disabled();
            }
        }
        if let Some(readonly) = self.aria.readonly {
            if readonly {
                node.set_read_only();
            } else {
                node.clear_read_only();
            }
        }
        if let Some(expanded) = self.aria.expanded {
            node.set_expanded(expanded);
        }
        if let Some(toggled) = self.aria.toggled {
            node.set_toggled(toggled);
        }
        if let Some(value) = self.aria.numeric_value {
            node.set_numeric_value(value);
        }
        if let Some(value) = self.aria.min_numeric_value {
            node.set_min_numeric_value(value);
        }
        if let Some(value) = self.aria.max_numeric_value {
            node.set_max_numeric_value(value);
        }
        if let Some(step) = self.aria.numeric_value_step {
            node.set_numeric_value_step(step);
        }
        if let Some(value) = &self.aria.value {
            node.set_value(value.to_string());
        }
        if let Some(placeholder) = &self.aria.placeholder {
            node.set_placeholder(placeholder.to_string());
        }
        if let Some(orientation) = self.aria.orientation {
            node.set_orientation(orientation);
        }
        if let Some(level) = self.aria.level {
            node.set_level(level);
        }
        if let Some(position) = self.aria.position_in_set {
            node.set_position_in_set(position);
        }
        if let Some(size) = self.aria.size_of_set {
            node.set_size_of_set(size);
        }
        if let Some(index) = self.aria.row_index {
            node.set_row_index(index);
        }
        if let Some(index) = self.aria.column_index {
            node.set_column_index(index);
        }
        if let Some(count) = self.aria.row_count {
            node.set_row_count(count);
        }
        if let Some(count) = self.aria.column_count {
            node.set_column_count(count);
        }
        if !self.click_listeners.is_empty() {
            node.add_action(accesskit::Action::Click);
        }
        if self.tracked_focus_handle.is_some() || self.focusable {
            node.add_action(accesskit::Action::Focus);
        }
        for (action, _) in &self.a11y_action_listeners {
            node.add_action(*action);
        }
    }
}

/// The per-frame state of an interactive element. Used for tracking stateful interactions like clicks
/// and scroll offsets.
#[derive(Default)]
pub struct InteractiveElementState {
    pub(crate) focus_handle: Option<FocusHandle>,
    pub(crate) clicked_state: Option<Rc<RefCell<ElementClickedState>>>,
    pub(crate) hover_state: Option<Rc<RefCell<ElementHoverState>>>,
    pub(crate) hover_listener_state: Option<Rc<RefCell<bool>>>,
    pub(crate) pending_mouse_down: Option<Rc<RefCell<Option<MouseClickPress>>>>,
    /// Original key, focus generation, input serial and cancellation mark.
    /// A release activates only the same uninterrupted physical press.
    pub(crate) pending_keyboard_down: Option<Rc<RefCell<Option<KeyboardClickPress>>>>,
    click_generation: Option<Rc<Cell<u64>>>,
    pub(crate) scroll_offset: Option<Rc<RefCell<Point<Pixels>>>>,
    ongoing_scroll: Option<Rc<RefCell<OngoingScroll>>>,
    pub(crate) active_tooltip: Option<Rc<RefCell<Option<ActiveTooltip>>>>,
    long_press_tooltip_active: Option<Rc<Cell<bool>>>,
}

/// A weak locator for cancellation of the original native press state.
/// The state owner should notify its view after cancellation if visuals changed.
#[derive(Clone)]
pub struct ClickHandle {
    mouse: Weak<RefCell<Option<MouseClickPress>>>,
    keyboard: Weak<RefCell<Option<KeyboardClickPress>>>,
    clicked: Weak<RefCell<ElementClickedState>>,
    generation: Weak<Cell<u64>>,
}
impl ClickHandle {
    /// Withdraw pending mouse/keyboard and active styling synchronously.
    /// Returns false after the original native state has been released.
    pub fn cancel(&self) -> bool {
        let Some(generation) = self.generation.upgrade() else {
            return false;
        };
        generation.set(generation.get().wrapping_add(1));
        if let Some(mouse) = self.mouse.upgrade() {
            mouse.borrow_mut().take();
        }
        if let Some(keyboard) = self.keyboard.upgrade() {
            keyboard.borrow_mut().take();
        }
        if let Some(clicked) = self.clicked.upgrade() {
            *clicked.borrow_mut() = ElementClickedState::default();
        }
        true
    }
}
impl InteractiveElementState {
    fn discard_stale_presses(&self, window: &Window) {
        // A synchronous dirty draw may precede this input's capture phase.
        // The actual release listener must consume its press, not layout.
        if window.click_input.is_dispatching() {
            return;
        }
        if let Some(pending) = &self.pending_mouse_down {
            let mut pending = pending.borrow_mut();
            if pending
                .as_ref()
                .is_some_and(|press| !window.click_input.is_pending(press.serial))
            {
                pending.take();
                if let Some(clicked) = &self.clicked_state {
                    *clicked.borrow_mut() = ElementClickedState::default();
                }
            }
        }
        if let Some(pending) = &self.pending_keyboard_down {
            let mut pending = pending.borrow_mut();
            if pending.as_ref().is_some_and(|press| {
                !window.click_input.is_pending(press.serial)
                    || press.focus_generation != window.focus_generation
            }) {
                pending.take();
            }
        }
    }

    fn click_handle(&mut self) -> ClickHandle {
        ClickHandle {
            mouse: Rc::downgrade(self.pending_mouse_down.get_or_insert_with(Default::default)),
            keyboard: Rc::downgrade(
                self.pending_keyboard_down
                    .get_or_insert_with(Default::default),
            ),
            clicked: Rc::downgrade(self.clicked_state.get_or_insert_with(Default::default)),
            generation: Rc::downgrade(self.click_generation.get_or_insert_with(Default::default)),
        }
    }
}
#[derive(Clone)]
pub(crate) struct MouseClickPress {
    down: MouseDownEvent,
    serial: u64,
    generation: u64,
}
impl std::ops::Deref for MouseClickPress {
    type Target = MouseDownEvent;
    fn deref(&self) -> &Self::Target {
        &self.down
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct KeyboardClickPress {
    button: KeyboardButton,
    focus_generation: u64,
    serial: u64,
    generation: u64,
}
fn activation_key(key: &str) -> Option<KeyboardButton> {
    match key {
        "enter" => Some(KeyboardButton::Enter),
        "space" => Some(KeyboardButton::Space),
        _ => None,
    }
}

/// Whether or not the element or a group that contains it is clicked by the mouse.
#[derive(Copy, Clone, Default, Eq, PartialEq)]
pub struct ElementClickedState {
    /// True if this element's group has been clicked, false otherwise
    pub group: bool,

    /// True if this element has been clicked, false otherwise
    pub element: bool,
}

impl ElementClickedState {
    fn is_clicked(&self) -> bool {
        self.group || self.element
    }
}

/// Whether or not the element or a group that contains it is hovered.
#[derive(Copy, Clone, Default, Eq, PartialEq)]
pub struct ElementHoverState {
    /// True if this element's group is hovered, false otherwise
    pub group: bool,

    /// True if this element is hovered, false otherwise
    pub element: bool,
}

pub(crate) enum ActiveTooltip {
    /// Currently delaying before showing the tooltip.
    WaitingForShow { _task: Task<()> },
    /// Tooltip is visible, element was hovered or for hoverable tooltips, the tooltip was hovered.
    Visible {
        tooltip: AnyTooltip,
        is_hoverable: bool,
    },
    /// Tooltip is visible and hoverable, but the mouse is no longer hovering. Currently delaying
    /// before hiding it.
    WaitingForHide {
        tooltip: AnyTooltip,
        _task: Task<()>,
    },
}

pub(crate) fn clear_active_tooltip(
    active_tooltip: &Rc<RefCell<Option<ActiveTooltip>>>,
    window: &mut Window,
) {
    match active_tooltip.borrow_mut().take() {
        None => {}
        Some(ActiveTooltip::WaitingForShow { .. }) => {}
        Some(ActiveTooltip::Visible { .. }) => window.refresh(),
        Some(ActiveTooltip::WaitingForHide { .. }) => window.refresh(),
    }
}

pub(crate) fn clear_active_tooltip_if_not_hoverable(
    active_tooltip: &Rc<RefCell<Option<ActiveTooltip>>>,
    window: &mut Window,
) {
    let should_clear = match active_tooltip.borrow().as_ref() {
        None => false,
        Some(ActiveTooltip::WaitingForShow { .. }) => false,
        Some(ActiveTooltip::Visible { is_hoverable, .. }) => !is_hoverable,
        Some(ActiveTooltip::WaitingForHide { .. }) => false,
    };
    if should_clear {
        active_tooltip.borrow_mut().take();
        window.refresh();
    }
}

pub(crate) fn set_tooltip_on_window(
    active_tooltip: &Rc<RefCell<Option<ActiveTooltip>>>,
    window: &mut Window,
) -> Option<TooltipId> {
    let tooltip = match active_tooltip.borrow().as_ref() {
        None => return None,
        Some(ActiveTooltip::WaitingForShow { .. }) => return None,
        Some(ActiveTooltip::Visible { tooltip, .. }) => tooltip.clone(),
        Some(ActiveTooltip::WaitingForHide { tooltip, .. }) => tooltip.clone(),
    };
    Some(window.set_tooltip(tooltip))
}

pub(crate) fn register_tooltip_mouse_handlers(
    active_tooltip: &Rc<RefCell<Option<ActiveTooltip>>>,
    tooltip_id: Option<TooltipId>,
    build_tooltip: Rc<dyn Fn(&mut Window, &mut App) -> Option<(AnyView, bool)>>,
    check_is_hovered: Rc<dyn Fn(&Window) -> bool>,
    check_is_hovered_during_prepaint: Rc<dyn Fn(&Window) -> bool>,
    long_press_tooltip_active: Rc<Cell<bool>>,
    show_delay: Option<Duration>,
    window: &mut Window,
) {
    let current_view = window.current_view();
    let show_delay = show_delay.unwrap_or(DEFAULT_TOOLTIP_SHOW_DELAY);

    window.on_mouse_event({
        let active_tooltip = active_tooltip.clone();
        let build_tooltip = build_tooltip.clone();
        let check_is_hovered = check_is_hovered.clone();
        let check_is_hovered_during_prepaint = check_is_hovered_during_prepaint.clone();
        move |_: &MouseMoveEvent, phase, window, cx| {
            handle_tooltip_mouse_move(
                &active_tooltip,
                &build_tooltip,
                &check_is_hovered,
                &check_is_hovered_during_prepaint,
                tooltip_id,
                current_view,
                phase,
                show_delay,
                window,
                cx,
            )
        }
    });

    window.on_mouse_event({
        let active_tooltip = active_tooltip.clone();
        move |_: &MouseDownEvent, _phase, window: &mut Window, _cx| {
            if !tooltip_id.is_some_and(|tooltip_id| tooltip_id.is_hovered(window)) {
                clear_active_tooltip_if_not_hoverable(&active_tooltip, window);
            }
        }
    });

    window.on_mouse_event({
        let active_tooltip = active_tooltip.clone();
        let build_tooltip = build_tooltip.clone();
        let check_is_hovered_during_prepaint = check_is_hovered_during_prepaint.clone();
        move |event: &LongPressEvent, phase, window, cx| {
            if !phase.bubble() {
                return;
            }

            match event.phase {
                TouchPhase::Started if !window.default_prevented() && check_is_hovered(window) => {
                    if show_tooltip(
                        &active_tooltip,
                        &build_tooltip,
                        &check_is_hovered_during_prepaint,
                        Some(long_press_tooltip_active.clone()),
                        window,
                        cx,
                    ) {
                        long_press_tooltip_active.set(true);
                        window.prevent_default();
                        cx.stop_propagation();
                    }
                }
                TouchPhase::Ended | TouchPhase::Cancelled
                    if long_press_tooltip_active.replace(false) =>
                {
                    clear_active_tooltip(&active_tooltip, window);
                    cx.stop_propagation();
                }
                TouchPhase::Started
                | TouchPhase::Moved
                | TouchPhase::Ended
                | TouchPhase::Cancelled => {}
            }
        }
    });

    window.on_mouse_event({
        let active_tooltip = active_tooltip.clone();
        move |_: &ScrollWheelEvent, _phase, window: &mut Window, _cx| {
            if !tooltip_id.is_some_and(|tooltip_id| tooltip_id.is_hovered(window)) {
                clear_active_tooltip_if_not_hoverable(&active_tooltip, window);
            }
        }
    });
}

/// Handles displaying tooltips when an element is hovered.
///
/// The mouse hovering logic also relies on being called from window prepaint in order to handle the
/// case where the element the tooltip is on is not rendered - in that case its mouse listeners are
/// also not registered. During window prepaint, the hitbox information is not available, so
/// `check_is_hovered_during_prepaint` is used which bases the check off of the absolute bounds of
/// the element.
///
/// TODO: There's a minor bug due to the use of absolute bounds while checking during prepaint - it
/// does not know if the hitbox is occluded. In the case where a tooltip gets displayed and then
/// gets occluded after display, it will stick around until the mouse exits the hover bounds.
fn handle_tooltip_mouse_move(
    active_tooltip: &Rc<RefCell<Option<ActiveTooltip>>>,
    build_tooltip: &Rc<dyn Fn(&mut Window, &mut App) -> Option<(AnyView, bool)>>,
    check_is_hovered: &Rc<dyn Fn(&Window) -> bool>,
    check_is_hovered_during_prepaint: &Rc<dyn Fn(&Window) -> bool>,
    tooltip_id: Option<TooltipId>,
    current_view: EntityId,
    phase: DispatchPhase,
    show_delay: Duration,
    window: &mut Window,
    cx: &mut App,
) {
    // Separates logic for what mutation should occur from applying it, to avoid overlapping
    // RefCell borrows.
    enum Action {
        None,
        CancelShow,
        ScheduleShow,
        CheckVisible,
    }

    let action = match active_tooltip.borrow().as_ref() {
        None => {
            let is_hovered = check_is_hovered(window);
            if is_hovered && phase.bubble() {
                Action::ScheduleShow
            } else {
                Action::None
            }
        }
        Some(ActiveTooltip::WaitingForShow { .. }) => {
            let is_hovered = check_is_hovered(window);
            if is_hovered {
                Action::None
            } else {
                Action::CancelShow
            }
        }
        Some(ActiveTooltip::Visible { is_hoverable, .. }) => {
            if phase.capture()
                && !check_is_hovered(window)
                && (!*is_hoverable
                    || !tooltip_id.is_some_and(|tooltip_id| tooltip_id.is_hovered(window)))
            {
                Action::CheckVisible
            } else {
                Action::None
            }
        }
        Some(ActiveTooltip::WaitingForHide { .. }) => {
            if phase.capture()
                && (check_is_hovered(window)
                    || tooltip_id.is_some_and(|tooltip_id| tooltip_id.is_hovered(window)))
            {
                Action::CheckVisible
            } else {
                Action::None
            }
        }
    };

    match action {
        Action::None => {}
        Action::CancelShow => {
            // Cancel waiting to show tooltip when it is no longer hovered.
            active_tooltip.borrow_mut().take();
        }
        Action::ScheduleShow => {
            let delayed_show_task = window.spawn(cx, {
                let weak_active_tooltip = Rc::downgrade(active_tooltip);
                let build_tooltip = build_tooltip.clone();
                let check_is_hovered_during_prepaint = check_is_hovered_during_prepaint.clone();
                async move |cx| {
                    cx.background_executor().timer(show_delay).await;
                    let Some(active_tooltip) = weak_active_tooltip.upgrade() else {
                        return;
                    };
                    cx.update(|window, cx| {
                        show_tooltip(
                            &active_tooltip,
                            &build_tooltip,
                            &check_is_hovered_during_prepaint,
                            None,
                            window,
                            cx,
                        );
                    })
                    .ok();
                }
            });
            active_tooltip
                .borrow_mut()
                .replace(ActiveTooltip::WaitingForShow {
                    _task: delayed_show_task,
                });
        }
        Action::CheckVisible => cx.notify(current_view),
    }
}

fn show_tooltip(
    active_tooltip: &Rc<RefCell<Option<ActiveTooltip>>>,
    build_tooltip: &Rc<dyn Fn(&mut Window, &mut App) -> Option<(AnyView, bool)>>,
    check_is_hovered_during_prepaint: &Rc<dyn Fn(&Window) -> bool>,
    long_press_tooltip_active: Option<Rc<Cell<bool>>>,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let new_tooltip = build_tooltip(window, cx).map(|(view, tooltip_is_hoverable)| {
        let weak_active_tooltip = Rc::downgrade(active_tooltip);
        let check_is_hovered_during_prepaint = check_is_hovered_during_prepaint.clone();
        ActiveTooltip::Visible {
            tooltip: AnyTooltip {
                view,
                mouse_position: window.mouse_position(),
                check_visible_and_update: Rc::new(move |tooltip_bounds, window, cx| {
                    if long_press_tooltip_active
                        .as_ref()
                        .is_some_and(|active| active.get())
                    {
                        return true;
                    }
                    let Some(active_tooltip) = weak_active_tooltip.upgrade() else {
                        return false;
                    };
                    handle_tooltip_check_visible_and_update(
                        &active_tooltip,
                        tooltip_is_hoverable,
                        &check_is_hovered_during_prepaint,
                        tooltip_bounds,
                        window,
                        cx,
                    )
                }),
            },
            is_hoverable: tooltip_is_hoverable,
        }
    });
    let did_show = new_tooltip.is_some();
    *active_tooltip.borrow_mut() = new_tooltip;
    window.refresh();
    did_show
}

/// Returns a callback which will be called by window prepaint to update tooltip visibility. The
/// purpose of doing this logic here instead of the mouse move handler is that the mouse move
/// handler won't get called when the element is not painted (e.g. via use of `visible_on_hover`).
fn handle_tooltip_check_visible_and_update(
    active_tooltip: &Rc<RefCell<Option<ActiveTooltip>>>,
    tooltip_is_hoverable: bool,
    check_is_hovered: &Rc<dyn Fn(&Window) -> bool>,
    tooltip_bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    // Separates logic for what mutation should occur from applying it, to avoid overlapping RefCell
    // borrows.
    enum Action {
        None,
        Hide,
        ScheduleHide(AnyTooltip),
        CancelHide(AnyTooltip),
    }

    let is_hovered = check_is_hovered(window)
        || (tooltip_is_hoverable && tooltip_bounds.contains(&window.mouse_position()));
    let action = match active_tooltip.borrow().as_ref() {
        Some(ActiveTooltip::Visible { tooltip, .. }) => {
            if is_hovered {
                Action::None
            } else {
                if tooltip_is_hoverable {
                    Action::ScheduleHide(tooltip.clone())
                } else {
                    Action::Hide
                }
            }
        }
        Some(ActiveTooltip::WaitingForHide { tooltip, .. }) => {
            if is_hovered {
                Action::CancelHide(tooltip.clone())
            } else {
                Action::None
            }
        }
        None | Some(ActiveTooltip::WaitingForShow { .. }) => Action::None,
    };

    match action {
        Action::None => {}
        Action::Hide => clear_active_tooltip(active_tooltip, window),
        Action::ScheduleHide(tooltip) => {
            let delayed_hide_task = window.spawn(cx, {
                let weak_active_tooltip = Rc::downgrade(active_tooltip);
                async move |cx| {
                    cx.background_executor()
                        .timer(HOVERABLE_TOOLTIP_HIDE_DELAY)
                        .await;
                    let Some(active_tooltip) = weak_active_tooltip.upgrade() else {
                        return;
                    };
                    if active_tooltip.borrow_mut().take().is_some() {
                        cx.update(|window, _cx| window.refresh()).ok();
                    }
                }
            });
            active_tooltip
                .borrow_mut()
                .replace(ActiveTooltip::WaitingForHide {
                    tooltip,
                    _task: delayed_hide_task,
                });
        }
        Action::CancelHide(tooltip) => {
            // Cancel waiting to hide tooltip when it becomes hovered.
            active_tooltip.borrow_mut().replace(ActiveTooltip::Visible {
                tooltip,
                is_hoverable: true,
            });
        }
    }

    active_tooltip.borrow().is_some()
}

#[derive(Default)]
pub(crate) struct GroupHitboxes(HashMap<SharedString, SmallVec<[HitboxId; 1]>>);

impl Global for GroupHitboxes {}

impl GroupHitboxes {
    pub fn get(name: &SharedString, cx: &mut App) -> Option<HitboxId> {
        cx.default_global::<Self>()
            .0
            .get(name)
            .and_then(|bounds_stack| bounds_stack.last())
            .cloned()
    }

    pub fn push(name: SharedString, hitbox_id: HitboxId, cx: &mut App) {
        cx.default_global::<Self>()
            .0
            .entry(name)
            .or_default()
            .push(hitbox_id);
    }

    pub fn pop(name: &SharedString, cx: &mut App) {
        cx.default_global::<Self>().0.get_mut(name).unwrap().pop();
    }
}

/// A wrapper around an element that can store state, produced after assigning an ElementId.
pub struct Stateful<E> {
    pub(crate) element: E,
}

impl<E> Styled for Stateful<E>
where
    E: Styled,
{
    fn style(&mut self) -> &mut StyleRefinement {
        self.element.style()
    }
}

impl<E> StatefulInteractiveElement for Stateful<E>
where
    E: Element,
    Self: InteractiveElement,
{
}

impl<E> InteractiveElement for Stateful<E>
where
    E: InteractiveElement,
{
    fn interactivity(&mut self) -> &mut Interactivity {
        self.element.interactivity()
    }
}

impl<E> Element for Stateful<E>
where
    E: Element,
{
    type RequestLayoutState = E::RequestLayoutState;
    type PrepaintState = E::PrepaintState;

    fn id(&self) -> Option<ElementId> {
        self.element.id()
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        self.element.source_location()
    }

    fn a11y_role(&self) -> Option<accesskit::Role> {
        self.element.a11y_role()
    }

    fn write_a11y_info(&self, node: &mut accesskit::Node) {
        self.element.write_a11y_info(node);
    }

    fn a11y_synthetic_children(
        &mut self,
        prepaint: &mut Self::PrepaintState,
        builder: &mut crate::A11ySubtreeBuilder,
    ) {
        self.element.a11y_synthetic_children(prepaint, builder);
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        self.element.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> E::PrepaintState {
        self.element
            .prepaint(id, inspector_id, bounds, state, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.element.paint(
            id,
            inspector_id,
            bounds,
            request_layout,
            prepaint,
            window,
            cx,
        );
    }
}

impl<E> IntoElement for Stateful<E>
where
    E: Element,
{
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl<E> ParentElement for Stateful<E>
where
    E: ParentElement,
{
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.element.extend(elements)
    }
}

/// Represents an element that can be scrolled *to* in its parent element.
/// Contrary to [ScrollHandle::scroll_to_item], an anchored element does not have to be an immediate child of the parent.
#[derive(Clone)]
pub struct ScrollAnchor {
    handle: ScrollHandle,
    last_origin: Rc<RefCell<Point<Pixels>>>,
}

impl ScrollAnchor {
    /// Creates a [ScrollAnchor] associated with a given [ScrollHandle].
    pub fn for_handle(handle: ScrollHandle) -> Self {
        Self {
            handle,
            last_origin: Default::default(),
        }
    }
    /// Request scroll to this item on the next frame.
    pub fn scroll_to(&self, window: &mut Window, _cx: &mut App) {
        let this = self.clone();

        window.on_next_frame(move |_, _| {
            let viewport_bounds = this.handle.bounds();
            let self_bounds = *this.last_origin.borrow();
            this.handle.set_offset(viewport_bounds.origin - self_bounds);
        });
    }
}

#[derive(Default, Debug)]
pub(crate) struct ScrollHandleState {
    pub(crate) offset: Rc<RefCell<Point<Pixels>>>,
    ongoing_scroll: Rc<RefCell<OngoingScroll>>,
    bounds: Bounds<Pixels>,
    pub(crate) max_offset: Point<Pixels>,
    child_bounds: Vec<Bounds<Pixels>>,
    scroll_request: Option<ScrollRequest>,
    painted_layout: Option<ScrollLayout>,
    painted_observation: Option<ScrollObservation>,
    reading_revision: u64,
    last_receipt: Option<(ScrollRequestId, ScrollRequestStatus)>,
    retention_attempt: Option<Attempt>,
    overflow: Point<Overflow>,
    pub(crate) version: crate::fast::dependencies::StateVersion,
}

#[derive(Debug, Clone)]
struct ScrollRequest {
    id: ScrollRequestId,
    target: ScrollTarget,
}
#[derive(Debug, Clone)]
enum ScrollTarget {
    Bottom,
    Command(ScrollCommand),
    Item {
        index: usize,
        strategy: ScrollStrategy,
    },
}

#[derive(Default, Debug, Clone, Copy)]
enum ScrollStrategy {
    #[default]
    FirstVisible,
    Top,
}

/// A handle to the scrollable aspects of an element.
/// Used for accessing scroll state, like the current scroll offset,
/// and for mutating the scroll state, like scrolling to a specific child.
#[derive(Clone, Debug)]
pub struct ScrollHandle(pub(crate) Rc<RefCell<ScrollHandleState>>);

impl Default for ScrollHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl ScrollHandle {
    /// Construct a new scroll handle.
    pub fn new() -> Self {
        Self(Rc::default())
    }

    /// Invalidate retained layouts that depend on this scroll handle.
    ///
    /// Custom scroll adapters use this when changing a deferred request that
    /// their prepaint will consume. This changes neither the offset nor the
    /// target item, and does not schedule a platform frame; the caller still
    /// notifies its view or requests a draw as with other scroll mutations.
    pub fn invalidate(&self) {
        crate::fast::dependencies::StateVersion::bump(&self.0.borrow().version);
    }

    /// Get the current scroll offset.
    pub fn offset(&self) -> Point<Pixels> {
        crate::fast::layers::invalidate::note_offset_read(&self.0.borrow().version);
        *self.0.borrow().offset.borrow()
    }

    /// Get the maximum scroll offset.
    pub fn max_offset(&self) -> Point<Pixels> {
        crate::fast::layers::invalidate::note_offset_read(&self.0.borrow().version);
        self.0.borrow().max_offset
    }

    /// Get the top child that's scrolled into view.
    pub fn top_item(&self) -> usize {
        let state = self.0.borrow();
        crate::fast::layers::invalidate::note_offset_read(&state.version);
        let top = state.bounds.top() - state.offset.borrow().y;

        match state.child_bounds.binary_search_by(|bounds| {
            if top < bounds.top() {
                Ordering::Greater
            } else if top > bounds.bottom() {
                Ordering::Less
            } else {
                Ordering::Equal
            }
        }) {
            Ok(ix) => ix,
            Err(ix) => ix.min(state.child_bounds.len().saturating_sub(1)),
        }
    }

    /// Get the bottom child that's scrolled into view.
    pub fn bottom_item(&self) -> usize {
        let state = self.0.borrow();
        crate::fast::layers::invalidate::note_offset_read(&state.version);
        let bottom = state.bounds.bottom() - state.offset.borrow().y;

        match state.child_bounds.binary_search_by(|bounds| {
            if bottom < bounds.top() {
                Ordering::Greater
            } else if bottom > bounds.bottom() {
                Ordering::Less
            } else {
                Ordering::Equal
            }
        }) {
            Ok(ix) => ix,
            Err(ix) => ix.min(state.child_bounds.len().saturating_sub(1)),
        }
    }

    /// Return the bounds into which this child is painted
    pub fn bounds(&self) -> Bounds<Pixels> {
        crate::fast::layers::input::moved(&self.0, Some(self.0.borrow().bounds)).unwrap_or_default()
    }

    /// Get the bounds for a specific child.
    pub fn bounds_for_item(&self, ix: usize) -> Option<Bounds<Pixels>> {
        crate::fast::layers::invalidate::note_offset_read(&self.0.borrow().version);
        crate::fast::layers::input::moved(&self.0, self.0.borrow().child_bounds.get(ix).cloned())
    }

    /// Scroll the minimal distance to reveal a direct child after layout.
    pub fn scroll_to_item(&self, ix: usize) {
        self.queue_scroll(ScrollTarget::Item {
            index: ix,
            strategy: ScrollStrategy::FirstVisible,
        });
    }

    /// Align a direct child to the viewport top after layout.
    pub fn scroll_to_top_of_item(&self, ix: usize) {
        self.queue_scroll(ScrollTarget::Item {
            index: ix,
            strategy: ScrollStrategy::Top,
        });
    }

    /// Scroll to the bottom after layout. Requests remain pending until the
    /// container really paints; a discarded or hidden candidate cannot consume them.
    pub fn scroll_to_bottom(&self) {
        self.queue_scroll(ScrollTarget::Bottom);
    }

    /// Issue an explicit reading command against this original Div owner.
    /// Does not schedule a frame; the caller must notify its view.
    pub fn request_scroll(&self, command: ScrollCommand) -> ScrollRequestId {
        self.queue_scroll(ScrollTarget::Command(command))
    }

    fn queue_scroll(&self, target: ScrollTarget) -> ScrollRequestId {
        let mut state = self.0.borrow_mut();
        state.note_reading_intent();
        if matches!(target, ScrollTarget::Bottom) {
            crate::fast::layers::scroll_to_bottom::note_scroll_to_bottom(self, &state);
        } else {
            state.version.bump();
        }
        let id = ScrollRequestId(state.reading_revision);
        state.scroll_request = Some(ScrollRequest { id, target });
        id
    }

    fn resolve_scroll_request(
        &self,
        child_ids: &[Option<ElementId>],
    ) -> Option<(ScrollRequestId, ScrollRequestStatus)> {
        let mut state = self.0.borrow_mut();
        let request = state.scroll_request.clone()?;
        let (index, strategy) = match request.target {
            ScrollTarget::Command(ScrollCommand::Start) => {
                state.offset.borrow_mut().y = px(0.);
                (None, ScrollStrategy::Top)
            }
            ScrollTarget::Bottom | ScrollTarget::Command(ScrollCommand::End) => {
                state.offset.borrow_mut().y = -state.max_offset.y;
                (None, ScrollStrategy::Top)
            }
            ScrollTarget::Command(ScrollCommand::RevealChild(id)) => {
                let Some(index) = child_ids
                    .iter()
                    .position(|child| child.as_ref() == Some(&id))
                else {
                    return Some((request.id, ScrollRequestStatus::Rejected));
                };
                (Some(index), ScrollStrategy::FirstVisible)
            }
            ScrollTarget::Item { index, strategy } => (Some(index), strategy),
        };
        if let Some(index) = index {
            let Some(bounds) = state.child_bounds.get(index) else {
                return Some((request.id, ScrollRequestStatus::Rejected));
            };
            let mut offset = state.offset.borrow_mut();
            if state.overflow.y == Overflow::Scroll {
                match strategy {
                    ScrollStrategy::FirstVisible => {
                        if bounds.size.height > state.bounds.size.height
                            || bounds.top() + offset.y < state.bounds.top()
                        {
                            offset.y = state.bounds.top() - bounds.top();
                        } else if bounds.bottom() + offset.y > state.bounds.bottom() {
                            offset.y = state.bounds.bottom() - bounds.bottom();
                        }
                    }
                    ScrollStrategy::Top => offset.y = state.bounds.top() - bounds.top(),
                }
            }
            if state.overflow.x == Overflow::Scroll {
                if bounds.size.width > state.bounds.size.width
                    || bounds.left() + offset.x < state.bounds.left()
                {
                    offset.x = state.bounds.left() - bounds.left();
                } else if bounds.right() + offset.x > state.bounds.right() {
                    offset.x = state.bounds.right() - bounds.right();
                }
            }
        }
        let y = state.offset.borrow().y;
        state.explicit_scroll(y);
        Some((request.id, ScrollRequestStatus::Applied))
    }

    /// Current explicit native reading intent, independent of layout/cache revisions.
    pub fn reading_revision(&self) -> u64 {
        self.0.borrow().reading_revision
    }

    /// Last actually painted Div viewport; never candidate prepaint geometry.
    /// Custom list adapters do not publish Div observations.
    pub fn painted_observation(&self) -> Option<ScrollObservation> {
        self.0.borrow().painted_observation.clone()
    }

    /// Status of the current command or the most recently settled command.
    /// Older receipts are not retained: applications consume settlement before
    /// issuing their next command, rather than growing a native ledger.
    pub fn request_status(&self, id: ScrollRequestId) -> Option<ScrollRequestStatus> {
        let state = self.0.borrow();
        if state
            .scroll_request
            .as_ref()
            .is_some_and(|request| request.id == id)
        {
            Some(ScrollRequestStatus::Pending)
        } else {
            state
                .last_receipt
                .filter(|(settled, _)| *settled == id)
                .map(|(_, status)| status)
        }
    }

    /// Custom native adapters call this when issuing explicit deferred navigation.
    /// Resolving a deferred target and automatic layout must not call it again.
    pub fn note_reading_intent(&self) {
        let mut state = self.0.borrow_mut();
        state.note_reading_intent();
        state.version.bump();
    }

    /// Set the offset explicitly. The offset is the distance from the top left of the
    /// parent container to the top left of the first child.
    /// As you scroll further down the offset becomes more negative.
    pub fn set_offset(&self, mut position: Point<Pixels>) {
        let mut state = self.0.borrow_mut();
        state.note_reading_intent();
        crate::fast::layers::invalidate::offset_set(
            &state.version,
            *state.offset.borrow() != position,
        );
        *state.offset.borrow_mut() = position;
        state.explicit_scroll(position.y);
    }

    /// Write a native adapter's derived layout offset without issuing new
    /// reading intent or cancelling an accepted command.
    pub fn set_layout_offset(&self, position: Point<Pixels>) {
        let state = self.0.borrow();
        crate::fast::layers::invalidate::offset_set(
            &state.version,
            *state.offset.borrow() != position,
        );
        *state.offset.borrow_mut() = position;
    }

    /// Get the logical scroll top, based on a child index and a pixel offset.
    pub fn logical_scroll_top(&self) -> (usize, Pixels) {
        let ix = self.top_item();
        let state = self.0.borrow();

        if let Some(child_bounds) = state.child_bounds.get(ix) {
            (
                ix,
                child_bounds.top() + state.offset.borrow().y - state.bounds.top(),
            )
        } else {
            (ix, px(0.))
        }
    }

    /// Get the logical scroll bottom, based on a child index and a pixel offset.
    pub fn logical_scroll_bottom(&self) -> (usize, Pixels) {
        let ix = self.bottom_item();
        let state = self.0.borrow();

        if let Some(child_bounds) = state.child_bounds.get(ix) {
            (
                ix,
                child_bounds.bottom() + state.offset.borrow().y - state.bounds.bottom(),
            )
        } else {
            (ix, px(0.))
        }
    }

    /// Get the count of children for scrollable item.
    pub fn children_count(&self) -> usize {
        self.0.borrow().child_bounds.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AccessibleAction, AnyWindowHandle, AppContext as _, Context, GestureTuning, InputEvent,
        Keystroke, MouseMoveEvent, Role, TestAppContext, TouchEvent, TouchId, canvas,
        util::FluentBuilder as _,
    };
    use std::{cell::Cell, rc::Weak};

    struct GroupHoverTestView {
        render_count: Rc<Cell<usize>>,
        anonymous_paint_count: Rc<Cell<usize>>,
        stateful_width: Rc<Cell<Pixels>>,
    }

    impl Render for GroupHoverTestView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            self.render_count.set(self.render_count.get() + 1);
            let anonymous_paint_count = self.anonymous_paint_count.clone();
            let stateful_width = self.stateful_width.clone();
            div().size_full().child(
                div()
                    .ml(px(20.))
                    .mt(px(20.))
                    .size(px(50.))
                    .relative()
                    .group("hover-group")
                    .child(
                        div()
                            .absolute()
                            .size_full()
                            .invisible()
                            .group_hover("hover-group", |style| style.visible())
                            .child(canvas(
                                |_, _, _| {},
                                move |_, _, _, _| {
                                    anonymous_paint_count.set(anonymous_paint_count.get() + 1)
                                },
                            )),
                    )
                    .child(
                        div()
                            .id("stateful-group-hover-target")
                            .absolute()
                            .top_0()
                            .left_0()
                            .size(px(10.))
                            .group_hover("hover-group", |style| style.size(px(20.)))
                            .child(canvas(
                                move |bounds, _, _| stateful_width.set(bounds.size.width),
                                |_, _, _, _| {},
                            )),
                    ),
            )
        }
    }

    #[gpui::test]
    fn group_hover_styles_update_only_on_transitions(cx: &mut TestAppContext) {
        let render_count = Rc::new(Cell::new(0));
        let anonymous_paint_count = Rc::new(Cell::new(0));
        let stateful_width = Rc::new(Cell::new(px(0.)));
        let window = cx.add_window({
            let render_count = render_count.clone();
            let anonymous_paint_count = anonymous_paint_count.clone();
            let stateful_width = stateful_width.clone();
            move |_, _| GroupHoverTestView {
                render_count,
                anonymous_paint_count,
                stateful_width,
            }
        });
        let window = AnyWindowHandle::from(window);

        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        assert_eq!(anonymous_paint_count.get(), 0);
        assert_eq!(stateful_width.get(), px(10.));

        let move_mouse = |cx: &mut TestAppContext, position| {
            cx.update_window(window, |_, window, cx| {
                window.simulate_mouse_move(position, cx)
            })
            .unwrap();
        };

        let initial_render_count = render_count.get();
        move_mouse(cx, point(px(25.), px(25.)));
        assert_eq!(render_count.get(), initial_render_count + 1);
        assert_eq!(anonymous_paint_count.get(), 1);
        assert_eq!(stateful_width.get(), px(20.));

        move_mouse(cx, point(px(30.), px(30.)));
        assert_eq!(render_count.get(), initial_render_count + 1);
        assert_eq!(anonymous_paint_count.get(), 1);
        assert_eq!(stateful_width.get(), px(20.));

        move_mouse(cx, point(px(5.), px(5.)));
        assert_eq!(render_count.get(), initial_render_count + 2);
        assert_eq!(anonymous_paint_count.get(), 1);
        assert_eq!(stateful_width.get(), px(10.));

        move_mouse(cx, point(px(10.), px(10.)));
        assert_eq!(render_count.get(), initial_render_count + 2);
        assert_eq!(anonymous_paint_count.get(), 1);
        assert_eq!(stateful_width.get(), px(10.));
    }

    struct HoverListenerLayoutTestView {
        target_left: Pixels,
        hover_transitions: Rc<RefCell<Vec<bool>>>,
    }

    impl Render for HoverListenerLayoutTestView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let hover_transitions = self.hover_transitions.clone();
            div().relative().size_full().child(
                div()
                    .id("hover-target")
                    .absolute()
                    .left(self.target_left)
                    .top_0()
                    .size(px(20.))
                    .on_click(|_, _, _| {})
                    .on_hover(move |is_hovered, _, _| {
                        hover_transitions.borrow_mut().push(*is_hovered);
                    }),
            )
        }
    }

    #[gpui::test]
    fn default_hover_listener_updates_when_layout_changes_under_stationary_mouse(
        cx: &mut TestAppContext,
    ) {
        let hover_transitions = Rc::new(RefCell::new(Vec::new()));
        let window = cx.add_window({
            let hover_transitions = hover_transitions.clone();
            move |_, _| HoverListenerLayoutTestView {
                target_left: px(40.),
                hover_transitions,
            }
        });
        let any_window = AnyWindowHandle::from(window);

        cx.update_window(any_window, |_, window, cx| {
            window.draw(cx).clear(cx);
            window.simulate_mouse_move(point(px(10.), px(10.)), cx);
        })
        .unwrap();
        assert!(hover_transitions.borrow().is_empty());

        window
            .update(cx, |view, _, cx| {
                view.target_left = px(0.);
                cx.notify();
            })
            .unwrap();
        cx.update_window(any_window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true]);

        window
            .update(cx, |view, _, cx| {
                view.target_left = px(40.);
                cx.notify();
            })
            .unwrap();
        cx.update_window(any_window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true, false]);
    }

    #[gpui::test]
    fn default_hover_listener_ends_after_key_press(cx: &mut TestAppContext) {
        let hover_transitions = Rc::new(RefCell::new(Vec::new()));
        let window = cx.add_window({
            let hover_transitions = hover_transitions.clone();
            move |_, _| HoverListenerLayoutTestView {
                target_left: px(0.),
                hover_transitions,
            }
        });
        let any_window = AnyWindowHandle::from(window);

        cx.update_window(any_window, |_, window, cx| {
            window.draw(cx).clear(cx);
            window.simulate_mouse_move(point(px(10.), px(10.)), cx);
        })
        .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true]);

        key_down(cx, any_window, "a");
        cx.update_window(any_window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true, false]);
    }

    struct HoverListenerModeLayoutTestView {
        target_left: Pixels,
        hover_transitions: Rc<RefCell<Vec<bool>>>,
    }

    impl Render for HoverListenerModeLayoutTestView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let hover_transitions = self.hover_transitions.clone();
            div().relative().size_full().child(
                div()
                    .id("hover-target")
                    .absolute()
                    .left(self.target_left)
                    .top_0()
                    .size(px(20.))
                    .hover_listener_mode(HoverListenerMode::InputModalityIndependent)
                    .on_hover(move |is_hovered, _, _| {
                        hover_transitions.borrow_mut().push(*is_hovered);
                    }),
            )
        }
    }

    #[gpui::test]
    fn input_modality_independent_hover_listener_updates_after_key_press(cx: &mut TestAppContext) {
        let hover_transitions = Rc::new(RefCell::new(Vec::new()));
        let window = cx.add_window({
            let hover_transitions = hover_transitions.clone();
            move |_, _| HoverListenerModeLayoutTestView {
                target_left: px(40.),
                hover_transitions,
            }
        });
        let any_window = AnyWindowHandle::from(window);
        let pointer_position = point(px(10.), px(10.));

        cx.update_window(any_window, |_, window, cx| {
            window.draw(cx).clear(cx);
            window.simulate_mouse_move(pointer_position, cx);
        })
        .unwrap();
        assert!(hover_transitions.borrow().is_empty());

        key_down(cx, any_window, "a");
        window
            .update(cx, |view, _, cx| {
                view.target_left = px(0.);
                cx.notify();
            })
            .unwrap();
        cx.update_window(any_window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true]);

        key_down(cx, any_window, "b");
        cx.update_window(any_window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true]);

        cx.update_window(any_window, |_, window, cx| {
            window.simulate_mouse_move(point(px(30.), px(10.)), cx);
        })
        .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true, false]);

        cx.update_window(any_window, |_, window, cx| {
            window.simulate_mouse_move(pointer_position, cx);
            window.dispatch_event(
                MouseExitEvent {
                    position: pointer_position,
                    ..Default::default()
                }
                .to_platform_input(),
                cx,
            );
        })
        .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true, false, true, false]);
    }

    #[gpui::test]
    fn default_hover_listener_remains_hovered_during_stationary_mouse_press(
        cx: &mut TestAppContext,
    ) {
        let hover_transitions = Rc::new(RefCell::new(Vec::new()));
        let window = cx.add_window({
            let hover_transitions = hover_transitions.clone();
            move |_, _| HoverListenerLayoutTestView {
                target_left: px(0.),
                hover_transitions,
            }
        });
        let any_window = AnyWindowHandle::from(window);
        let mouse_position = point(px(10.), px(10.));

        cx.update_window(any_window, |_, window, cx| {
            window.draw(cx).clear(cx);
            window.simulate_mouse_move(mouse_position, cx);
        })
        .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true]);

        cx.update_window(any_window, |_, window, cx| {
            window.dispatch_event(
                MouseDownEvent {
                    position: mouse_position,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }
                .to_platform_input(),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true]);

        cx.update_window(any_window, |_, window, cx| {
            window.dispatch_event(
                MouseUpEvent {
                    position: mouse_position,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                }
                .to_platform_input(),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .unwrap();
        assert_eq!(*hover_transitions.borrow(), [true]);
    }

    struct TestTooltipView;

    impl Render for TestTooltipView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            div().w(px(20.)).h(px(20.)).child("tooltip")
        }
    }

    type CapturedActiveTooltip = Rc<RefCell<Option<Weak<RefCell<Option<ActiveTooltip>>>>>>;

    struct TooltipCaptureElement {
        child: AnyElement,
        captured_active_tooltip: CapturedActiveTooltip,
    }

    impl IntoElement for TooltipCaptureElement {
        type Element = Self;

        fn into_element(self) -> Self::Element {
            self
        }
    }

    impl Element for TooltipCaptureElement {
        type RequestLayoutState = ();
        type PrepaintState = ();

        fn id(&self) -> Option<ElementId> {
            None
        }

        fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
            None
        }

        fn request_layout(
            &mut self,
            _id: Option<&GlobalElementId>,
            _inspector_id: Option<&InspectorElementId>,
            window: &mut Window,
            cx: &mut App,
        ) -> (LayoutId, Self::RequestLayoutState) {
            (self.child.request_layout(window, cx), ())
        }

        fn prepaint(
            &mut self,
            _id: Option<&GlobalElementId>,
            _inspector_id: Option<&InspectorElementId>,
            _bounds: Bounds<Pixels>,
            _request_layout: &mut Self::RequestLayoutState,
            window: &mut Window,
            cx: &mut App,
        ) -> Self::PrepaintState {
            self.child.prepaint(window, cx);
        }

        fn paint(
            &mut self,
            _id: Option<&GlobalElementId>,
            _inspector_id: Option<&InspectorElementId>,
            _bounds: Bounds<Pixels>,
            _request_layout: &mut Self::RequestLayoutState,
            _prepaint: &mut Self::PrepaintState,
            window: &mut Window,
            cx: &mut App,
        ) {
            self.child.paint(window, cx);
            window.with_global_id("target".into(), |global_id, window| {
                window.with_element_state::<InteractiveElementState, _>(
                    global_id,
                    |state, _window| {
                        let state = state.unwrap();
                        *self.captured_active_tooltip.borrow_mut() =
                            state.active_tooltip.as_ref().map(Rc::downgrade);
                        ((), state)
                    },
                )
            });
        }
    }

    struct TooltipOwner {
        captured_active_tooltip: CapturedActiveTooltip,
        show_delay_override: Option<Duration>,
        fragmented: bool,
    }

    impl Render for TooltipOwner {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            TooltipCaptureElement {
                child: div()
                    .size_full()
                    .child(
                        div()
                            .id("target")
                            .w(px(50.))
                            .h(px(50.))
                            .when(self.fragmented, |this| {
                                this.hitbox_regions(Arc::<[Bounds<Pixels>]>::from([
                                    Bounds::new(point(px(0.), px(0.)), size(px(10.), px(10.))),
                                    Bounds::new(point(px(40.), px(40.)), size(px(10.), px(10.))),
                                ]))
                            })
                            .tooltip(|_, cx| cx.new(|_| TestTooltipView).into())
                            .when_some(self.show_delay_override, |this, delay| {
                                this.tooltip_show_delay(delay)
                            }),
                    )
                    .into_any_element(),
                captured_active_tooltip: self.captured_active_tooltip.clone(),
            }
        }
    }

    #[test]
    fn scroll_handle_aligns_wide_children_to_left_edge() {
        let handle = ScrollHandle::new();
        {
            let mut state = handle.0.borrow_mut();
            state.bounds = Bounds::new(point(px(0.), px(0.)), size(px(80.), px(20.)));
            state.child_bounds = vec![Bounds::new(point(px(25.), px(0.)), size(px(200.), px(20.)))];
            state.overflow.x = Overflow::Scroll;
        }

        handle.scroll_to_item(0);
        handle.resolve_scroll_request(&[]);

        assert_eq!(handle.offset().x, px(-25.));
    }

    #[test]
    fn scroll_handle_aligns_tall_children_to_top_edge() {
        let handle = ScrollHandle::new();
        {
            let mut state = handle.0.borrow_mut();
            state.bounds = Bounds::new(point(px(0.), px(0.)), size(px(20.), px(80.)));
            state.child_bounds = vec![Bounds::new(point(px(0.), px(25.)), size(px(20.), px(200.)))];
            state.overflow.y = Overflow::Scroll;
        }

        handle.scroll_to_item(0);
        handle.resolve_scroll_request(&[]);

        assert_eq!(handle.offset().y, px(-25.));
    }

    #[test]
    fn long_press_shows_tooltip_until_touch_ends() {
        let (mut test_app, any_window, captured_active_tooltip) = create_tooltip_owner_test(None);
        let active_tooltip = captured_active_tooltip
            .borrow()
            .clone()
            .unwrap()
            .upgrade()
            .unwrap();
        let touch_id = TouchId(1);
        let touch_position = point(px(49.), px(10.));

        test_app
            .update_window(any_window, |_, window, cx| {
                window.dispatch_event(
                    TouchEvent {
                        id: touch_id,
                        phase: TouchPhase::Started,
                        position: touch_position,
                        predicted_position: None,
                        force: None,
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();
        test_app
            .dispatcher
            .advance_clock(GestureTuning::default().long_press_duration + Duration::from_millis(1));
        test_app.run_until_parked();

        assert!(matches!(
            active_tooltip.borrow().as_ref(),
            Some(ActiveTooltip::Visible { .. })
        ));

        let moved_position = point(px(55.), px(10.));
        test_app
            .update_window(any_window, |_, window, cx| {
                window.dispatch_event(
                    TouchEvent {
                        id: touch_id,
                        phase: TouchPhase::Moved,
                        position: moved_position,
                        predicted_position: None,
                        force: None,
                    }
                    .to_platform_input(),
                    cx,
                );
                window.draw(cx).clear(cx);
            })
            .unwrap();
        assert!(matches!(
            active_tooltip.borrow().as_ref(),
            Some(ActiveTooltip::Visible { .. })
        ));

        test_app
            .update_window(any_window, |_, window, cx| {
                window.dispatch_event(
                    TouchEvent {
                        id: touch_id,
                        phase: TouchPhase::Ended,
                        position: moved_position,
                        predicted_position: None,
                        force: None,
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();

        assert!(active_tooltip.borrow().is_none());
    }

    fn setup_tooltip_owner_test(
        show_delay_override: Option<Duration>,
    ) -> (
        TestAppContext,
        crate::AnyWindowHandle,
        CapturedActiveTooltip,
    ) {
        let (mut test_app, any_window, captured_active_tooltip) =
            create_tooltip_owner_test(show_delay_override);

        test_app
            .update_window(any_window, |_, window, cx| {
                window.dispatch_event(
                    MouseMoveEvent {
                        position: point(px(10.), px(10.)),
                        modifiers: Default::default(),
                        pressed_button: None,
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();

        test_app
            .update_window(any_window, |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .unwrap();

        (test_app, any_window, captured_active_tooltip)
    }

    fn create_tooltip_owner_test(
        show_delay_override: Option<Duration>,
    ) -> (
        TestAppContext,
        crate::AnyWindowHandle,
        CapturedActiveTooltip,
    ) {
        create_tooltip_owner_test_with_fragments(show_delay_override, false)
    }

    fn create_tooltip_owner_test_with_fragments(
        show_delay_override: Option<Duration>,
        fragmented: bool,
    ) -> (
        TestAppContext,
        crate::AnyWindowHandle,
        CapturedActiveTooltip,
    ) {
        let mut test_app = TestAppContext::single();
        let captured_active_tooltip: CapturedActiveTooltip = Rc::new(RefCell::new(None));
        let window = test_app.add_window({
            let captured_active_tooltip = captured_active_tooltip.clone();
            move |_, _| TooltipOwner {
                captured_active_tooltip,
                show_delay_override,
                fragmented,
            }
        });
        let any_window = window.into();

        test_app
            .update_window(any_window, |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .unwrap();

        (test_app, any_window, captured_active_tooltip)
    }

    #[test]
    fn tooltip_waiting_for_show_is_released_when_its_owner_disappears() {
        let (mut test_app, any_window, captured_active_tooltip) = setup_tooltip_owner_test(None);

        let weak_active_tooltip = captured_active_tooltip.borrow().clone().unwrap();
        let active_tooltip = weak_active_tooltip.upgrade().unwrap();
        assert!(matches!(
            active_tooltip.borrow().as_ref(),
            Some(ActiveTooltip::WaitingForShow { .. })
        ));

        test_app
            .update_window(any_window, |_, window, _| {
                window.remove_window();
            })
            .unwrap();
        test_app.run_until_parked();
        drop(active_tooltip);

        assert!(weak_active_tooltip.upgrade().is_none());
    }

    #[test]
    fn tooltip_respects_custom_show_delay() {
        let extra_delay = Duration::from_secs(1);
        let show_delay_override = DEFAULT_TOOLTIP_SHOW_DELAY + extra_delay;
        let (mut test_app, _any_window, captured_active_tooltip) =
            setup_tooltip_owner_test(Some(show_delay_override));

        let weak_active_tooltip = captured_active_tooltip.borrow().clone().unwrap();
        let active_tooltip = weak_active_tooltip.upgrade().unwrap();

        test_app
            .dispatcher
            .advance_clock(DEFAULT_TOOLTIP_SHOW_DELAY);
        test_app.run_until_parked();

        assert!(matches!(
            active_tooltip.borrow().as_ref(),
            Some(ActiveTooltip::WaitingForShow { .. })
        ));

        test_app.dispatcher.advance_clock(extra_delay);
        test_app.run_until_parked();

        assert!(matches!(
            active_tooltip.borrow().as_ref(),
            Some(ActiveTooltip::Visible { .. })
        ));
    }

    #[test]
    fn tooltip_is_released_when_its_owner_disappears() {
        let (mut test_app, any_window, captured_active_tooltip) = setup_tooltip_owner_test(None);

        let weak_active_tooltip = captured_active_tooltip.borrow().clone().unwrap();
        let active_tooltip = weak_active_tooltip.upgrade().unwrap();

        test_app
            .dispatcher
            .advance_clock(DEFAULT_TOOLTIP_SHOW_DELAY);
        test_app.run_until_parked();

        assert!(matches!(
            active_tooltip.borrow().as_ref(),
            Some(ActiveTooltip::Visible { .. })
        ));

        test_app
            .update_window(any_window, |_, window, _| {
                window.remove_window();
            })
            .unwrap();
        test_app.run_until_parked();
        drop(active_tooltip);

        assert!(weak_active_tooltip.upgrade().is_none());
    }

    #[test]
    fn tooltip_hides_after_mouse_leaves_origin() {
        let (mut test_app, any_window, captured_active_tooltip) = setup_tooltip_owner_test(None);

        let weak_active_tooltip = captured_active_tooltip.borrow().clone().unwrap();
        let active_tooltip = weak_active_tooltip.upgrade().unwrap();

        test_app
            .dispatcher
            .advance_clock(DEFAULT_TOOLTIP_SHOW_DELAY);
        test_app.run_until_parked();

        assert!(matches!(
            active_tooltip.borrow().as_ref(),
            Some(ActiveTooltip::Visible { .. })
        ));

        test_app
            .update_window(any_window, |_, window, cx| {
                window.dispatch_event(
                    MouseMoveEvent {
                        position: point(px(75.), px(75.)),
                        modifiers: Default::default(),
                        pressed_button: None,
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();

        assert!(active_tooltip.borrow().is_none());
    }

    #[test]
    fn fragmented_tooltip_does_not_survive_blank_union_prepaint() {
        let (mut cx, window, captured) = create_tooltip_owner_test_with_fragments(None, true);
        let active = captured.borrow().as_ref().unwrap().upgrade().unwrap();
        cx.update_window(window, |_, window, cx| {
            window.dispatch_event(
                MouseMoveEvent {
                    position: point(px(5.), px(5.)),
                    modifiers: Default::default(),
                    pressed_button: None,
                }
                .to_platform_input(),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .unwrap();
        cx.dispatcher.advance_clock(DEFAULT_TOOLTIP_SHOW_DELAY);
        cx.run_until_parked();
        assert!(matches!(
            active.borrow().as_ref(),
            Some(ActiveTooltip::Visible { .. })
        ));
        cx.update_window(window, |_, window, cx| {
            window.dispatch_event(
                MouseMoveEvent {
                    position: point(px(25.), px(25.)),
                    modifiers: Default::default(),
                    pressed_button: None,
                }
                .to_platform_input(),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .unwrap();
        assert!(
            active.borrow().is_none(),
            "blank union cannot retain tooltip during native prepaint"
        );
    }

    struct MouseDownOutOwner {
        mouse_down_out_count: Rc<RefCell<usize>>,
    }

    impl Render for MouseDownOutOwner {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let mouse_down_out_count = self.mouse_down_out_count.clone();
            div()
                .size_full()
                .child(div().id("target").w(px(50.)).h(px(50.)).on_mouse_down_out(
                    move |_, _, _| {
                        *mouse_down_out_count.borrow_mut() += 1;
                    },
                ))
        }
    }

    #[test]
    fn mouse_down_out_is_suppressed_while_window_prompt_is_active() {
        let mut test_app = TestAppContext::single();
        let mouse_down_out_count = Rc::new(RefCell::new(0));
        let window = test_app.add_window({
            let mouse_down_out_count = mouse_down_out_count.clone();
            move |_, _| MouseDownOutOwner {
                mouse_down_out_count,
            }
        });
        let any_window: AnyWindowHandle = window.into();

        fn dispatch_mouse_down_outside_target(
            test_app: &mut TestAppContext,
            any_window: AnyWindowHandle,
        ) {
            test_app
                .update_window(any_window, |_, window, cx| {
                    window.dispatch_event(
                        MouseDownEvent {
                            position: point(px(75.), px(75.)),
                            button: MouseButton::Left,
                            modifiers: Default::default(),
                            click_count: 1,
                            first_mouse: false,
                        }
                        .to_platform_input(),
                        cx,
                    );
                })
                .unwrap();
        }

        test_app
            .update_window(any_window, |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .unwrap();

        dispatch_mouse_down_outside_target(&mut test_app, any_window);
        assert_eq!(
            *mouse_down_out_count.borrow(),
            1,
            "mouse down outside the element should fire mouse-down-out listeners"
        );

        test_app
            .update_window(any_window, |_, window, cx| {
                cx.set_prompt_builder(crate::fallback_prompt_renderer);
                let _receiver =
                    window.prompt(crate::PromptLevel::Warning, "message", None, &["Ok"], cx);
                assert!(window.has_active_prompt());
                window.draw(cx).clear(cx);
            })
            .unwrap();

        dispatch_mouse_down_outside_target(&mut test_app, any_window);
        assert_eq!(
            *mouse_down_out_count.borrow(),
            1,
            "mouse down over an active prompt should not fire mouse-down-out listeners"
        );
    }

    #[test]
    fn test_accessibility_id_builder_writes_author_id() {
        let mut element = div()
            .id("buffer-font-size")
            .accessibility_id("settings.buffer-font-size");
        let mut node = accesskit::Node::new(accesskit::Role::SpinButton);

        element.interactivity().write_a11y_info(&mut node);

        assert_eq!(node.author_id(), Some("settings.buffer-font-size"));
    }

    #[test]
    fn test_write_a11y_info_string_and_numeric_properties() {
        let mut interactivity = Interactivity::default();
        interactivity.aria.author_id = Some("settings.buffer-font-size".into());
        interactivity.aria.label = Some("Buffer Font Size".into());
        interactivity.aria.value = Some("15".into());
        interactivity.aria.placeholder = Some("Search".into());
        interactivity.aria.numeric_value = Some(15.0);
        interactivity.aria.min_numeric_value = Some(6.0);
        interactivity.aria.max_numeric_value = Some(72.0);
        interactivity.aria.numeric_value_step = Some(1.0);

        let mut node = accesskit::Node::new(accesskit::Role::SpinButton);
        interactivity.write_a11y_info(&mut node);

        assert_eq!(node.author_id(), Some("settings.buffer-font-size"));
        assert_eq!(node.label(), Some("Buffer Font Size"));
        assert_eq!(node.value(), Some("15"));
        assert_eq!(node.placeholder(), Some("Search"));
        assert_eq!(node.numeric_value(), Some(15.0));
        assert_eq!(node.min_numeric_value(), Some(6.0));
        assert_eq!(node.max_numeric_value(), Some(72.0));
        assert_eq!(node.numeric_value_step(), Some(1.0));
    }

    /// Two focusable, clickable elements ("a" and "b") used to exercise the
    /// Enter/Space -> synthesized click press/release pairing.
    crate::actions!(native_click_replay_test, [ReplayChord]);

    struct KeyboardActivationTest {
        focus_a: FocusHandle,
        focus_b: FocusHandle,
        clicks: Rc<RefCell<Vec<&'static str>>>,
        nested_ax: Rc<RefCell<Option<accesskit::ActionRequest>>>,
    }

    impl Render for KeyboardActivationTest {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let clicks_a = self.clicks.clone();
            let clicks_b = self.clicks.clone();
            let nested_ax = self.nested_ax.clone();
            div()
                .size_full()
                .on_action(|_: &ReplayChord, _, _| {})
                .child(
                    div()
                        .id("a")
                        .debug_selector(|| "a".into())
                        .role(Role::Button)
                        .aria_label("a")
                        .w(px(50.))
                        .h(px(50.))
                        .track_focus(&self.focus_a)
                        .on_click(move |_, _, _| clicks_a.borrow_mut().push("a")),
                )
                .child(
                    div()
                        .id("b")
                        .role(Role::Button)
                        .aria_label("b")
                        .w(px(50.))
                        .h(px(50.))
                        .track_focus(&self.focus_b)
                        .on_click(move |_, _, _| clicks_b.borrow_mut().push("b")),
                )
                .child(canvas(
                    |_, _, _| {},
                    move |_, _, window, _| {
                        let nested_ax = nested_ax.clone();
                        window.on_mouse_event(move |_: &MouseUpEvent, phase, window, cx| {
                            if phase.capture() {
                                let request = nested_ax.borrow_mut().take();
                                if let Some(request) = request {
                                    // The actual Window entrance is synchronous;
                                    // the platform action channel is asynchronous.
                                    window.handle_a11y_action(request, cx);
                                }
                            }
                        });
                    },
                ))
        }
    }

    fn setup_keyboard_activation_test() -> (
        TestAppContext,
        AnyWindowHandle,
        Rc<RefCell<Vec<&'static str>>>,
        FocusHandle,
        FocusHandle,
    ) {
        let mut cx = TestAppContext::single();
        let (focus_a, focus_b) = cx.update(|cx| (cx.focus_handle(), cx.focus_handle()));
        let clicks: Rc<RefCell<Vec<&'static str>>> = Rc::new(RefCell::new(Vec::new()));
        let window = cx.add_window({
            let focus_a = focus_a.clone();
            let focus_b = focus_b.clone();
            let clicks = clicks.clone();
            move |_, _| KeyboardActivationTest {
                focus_a,
                focus_b,
                clicks,
                nested_ax: Rc::default(),
            }
        });
        (cx, window.into(), clicks, focus_a, focus_b)
    }

    /// Move focus to `handle`, flush effects, then paint so the newly focused
    /// element registers its key handlers for the next dispatched event.
    fn focus_and_draw(cx: &mut TestAppContext, window: AnyWindowHandle, handle: &FocusHandle) {
        cx.update_window(window, |_, window, cx| window.focus(handle, cx))
            .unwrap();
        cx.run_until_parked();
        cx.update_window(window, |_, window, cx| {
            window.draw(cx).clear(cx);
        })
        .unwrap();
    }

    fn key_down(cx: &mut TestAppContext, window: AnyWindowHandle, key: &str) {
        let keystroke = Keystroke::parse(key).unwrap();
        cx.update_window(window, |_, window, cx| {
            window.dispatch_event(
                KeyDownEvent {
                    keystroke,
                    is_held: false,
                    prefer_character_input: false,
                }
                .to_platform_input(),
                cx,
            );
        })
        .unwrap();
    }

    fn key_up(cx: &mut TestAppContext, window: AnyWindowHandle, key: &str) {
        let keystroke = Keystroke::parse(key).unwrap();
        cx.update_window(window, |_, window, cx| {
            window.dispatch_event(KeyUpEvent { keystroke }.to_platform_input(), cx);
        })
        .unwrap();
    }

    fn a11y_click_request(
        cx: &mut TestAppContext,
        window: AnyWindowHandle,
        label: &str,
    ) -> accesskit::ActionRequest {
        cx.activate_accessibility(window);
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        let tree = cx.accessibility_update(window).unwrap();
        let (target_node, node) = tree
            .nodes
            .iter()
            .find(|(_, node)| node.label() == Some(label))
            .unwrap();
        assert!(node.supports_action(AccessibleAction::Click));
        accesskit::ActionRequest {
            action: AccessibleAction::Click,
            target_node: *target_node,
            target_tree: accesskit::TreeId::ROOT,
            data: None,
        }
    }

    fn click_a_event(cx: &mut TestAppContext, window: AnyWindowHandle, down: bool) {
        cx.update_window(window, |_, window, cx| {
            let position = window.rendered_frame.debug_bounds["a"].center();
            let event = if down {
                MouseDownEvent {
                    button: MouseButton::Left,
                    position,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }
                .to_platform_input()
            } else {
                MouseUpEvent {
                    button: MouseButton::Left,
                    position,
                    modifiers: Default::default(),
                    click_count: 1,
                }
                .to_platform_input()
            };
            window.dispatch_event(event, cx);
        })
        .unwrap();
    }

    #[test]
    fn a11y_channel_click_interrupts_another_targets_original_press() {
        let (mut cx, window, clicks, focus_a, _) = setup_keyboard_activation_test();
        focus_and_draw(&mut cx, window, &focus_a);
        let request = a11y_click_request(&mut cx, window, "b");
        click_a_event(&mut cx, window, true);
        cx.simulate_accessibility_action(window, request.clone());
        click_a_event(&mut cx, window, false);
        assert_eq!(*clicks.borrow(), vec!["b"]);
        key_down(&mut cx, window, "enter");
        cx.simulate_accessibility_action(window, request);
        key_up(&mut cx, window, "enter");
        assert_eq!(*clicks.borrow(), vec!["b", "b"]);
        click_a_event(&mut cx, window, true);
        click_a_event(&mut cx, window, false);
        assert_eq!(*clicks.borrow(), vec!["b", "b", "a"]);
    }

    #[test]
    fn nested_a11y_entry_invalidates_another_targets_captured_release() {
        let (mut cx, window, clicks, focus_a, _) = setup_keyboard_activation_test();
        focus_and_draw(&mut cx, window, &focus_a);
        let request = a11y_click_request(&mut cx, window, "b");
        cx.update_window(window, |root, _, cx| {
            root.clone()
                .downcast::<KeyboardActivationTest>()
                .unwrap()
                .update(cx, |view, _| {
                    *view.nested_ax.borrow_mut() = Some(request);
                });
        })
        .unwrap();
        click_a_event(&mut cx, window, true);
        cx.with_paused_automatic_drawing(|cx| {
            click_a_event(cx, window, false);
            assert_eq!(*clicks.borrow(), vec!["b"]);
        });
        click_a_event(&mut cx, window, true);
        click_a_event(&mut cx, window, false);
        assert_eq!(*clicks.borrow(), vec!["b", "a"]);
    }

    #[test]
    fn keyboard_replayed_chord_prefix_does_not_arm_native_press() {
        let (mut cx, window, clicks, focus_a, _) = setup_keyboard_activation_test();
        cx.update(|cx| cx.bind_keys([crate::KeyBinding::new("enter x", ReplayChord, None)]));
        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "enter");
        cx.update_window(window, |_, window, _| {
            assert!(window.pending_input_keystrokes().is_some())
        })
        .unwrap();
        key_up(&mut cx, window, "enter");
        // The second physical prefix replays the first inside an actual input
        // scope, then remains withheld by the same binding. Replay cannot arm it.
        key_down(&mut cx, window, "enter");
        key_up(&mut cx, window, "enter");
        assert!(clicks.borrow().is_empty());
        cx.dispatcher.advance_clock(Duration::from_secs(2));
        cx.run_until_parked();
        key_up(&mut cx, window, "enter");
        assert!(clicks.borrow().is_empty());
    }

    /// Pressing and releasing Enter on the same focused element fires a click.
    #[test]
    fn keyboard_activation_fires_click_on_same_element() {
        let (mut cx, window, clicks, focus_a, _focus_b) = setup_keyboard_activation_test();

        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "enter");
        key_up(&mut cx, window, "enter");

        assert_eq!(*clicks.borrow(), vec!["a"]);
    }

    /// A key-down whose key-up lands on a *different* element (because focus
    /// moved in between) must not leak a synthesized click onto the newly
    /// focused element. This is the core regression: previously the key-up
    /// handler fired unconditionally on whatever was focused at key-up time.
    #[test]
    fn keyboard_activation_does_not_leak_across_focus_change() {
        let (mut cx, window, clicks, focus_a, focus_b) = setup_keyboard_activation_test();

        // Enter pressed while "a" is focused...
        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "enter");

        // ...focus moves to "b" before the release (as a confirm action would)...
        focus_and_draw(&mut cx, window, &focus_b);
        key_up(&mut cx, window, "enter");

        // ...so neither element is clicked: "a" never saw the up, and "b"
        // never saw the down.
        assert!(clicks.borrow().is_empty(), "clicks: {:?}", clicks.borrow());
    }

    /// A keydown whose flag is left pending because focus moved away before
    /// the keyup must not fire a click when focus later *returns* to the same
    /// element (the menu trigger reopening case). The stamped focus generation
    /// no longer matches, so the stale pending state is ignored.
    #[test]
    fn keyboard_activation_does_not_leak_when_focus_returns() {
        let (mut cx, window, clicks, focus_a, focus_b) = setup_keyboard_activation_test();

        // Enter pressed on "a"...
        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "enter");

        // ...focus leaves "a" before its keyup (so the pending state is never
        // consumed), then comes back to "a"...
        focus_and_draw(&mut cx, window, &focus_b);
        focus_and_draw(&mut cx, window, &focus_a);
        key_up(&mut cx, window, "enter");

        // ...and the now-stale pending keydown must not fire a click.
        assert!(clicks.borrow().is_empty(), "clicks: {:?}", clicks.borrow());
    }

    /// A non-activation key *released* during the press must cancel the pending
    /// activation. For the sequence escape-down, space-down, escape-up,
    /// space-up the space forms a clean down/up pair, but the intervening
    /// escape-up means this isn't a plain space activation, so no click fires.
    #[test]
    fn keyboard_activation_cleared_by_intervening_key_release() {
        let (mut cx, window, clicks, focus_a, _focus_b) = setup_keyboard_activation_test();

        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "escape");
        key_down(&mut cx, window, "space");
        key_up(&mut cx, window, "escape");
        key_up(&mut cx, window, "space");

        assert!(clicks.borrow().is_empty(), "clicks: {:?}", clicks.borrow());
    }

    /// A clean activation requires the same actual key for down and up.
    #[test]
    fn keyboard_activation_requires_matching_space_or_enter() {
        let (mut cx, window, clicks, focus_a, _focus_b) = setup_keyboard_activation_test();

        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "space");
        key_up(&mut cx, window, "enter");
        assert!(clicks.borrow().is_empty());
        key_down(&mut cx, window, "space");
        key_up(&mut cx, window, "space");
        assert_eq!(*clicks.borrow(), vec!["a"]);
    }

    /// A non-activation key pressed between the activation down and up clears
    /// the pending flag, suppressing the click.
    #[test]
    fn keyboard_activation_cleared_by_intervening_keydown() {
        let (mut cx, window, clicks, focus_a, _focus_b) = setup_keyboard_activation_test();

        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "enter");
        key_down(&mut cx, window, "a");
        key_up(&mut cx, window, "enter");

        assert!(clicks.borrow().is_empty(), "clicks: {:?}", clicks.borrow());
    }

    /// A modified Enter (e.g. cmd-enter) is not treated as an activation key,
    /// so it neither sets the pending flag nor fires a click on release.
    #[test]
    fn keyboard_activation_ignores_modified_keys() {
        let (mut cx, window, clicks, focus_a, _focus_b) = setup_keyboard_activation_test();

        focus_and_draw(&mut cx, window, &focus_a);
        key_down(&mut cx, window, "cmd-enter");
        key_up(&mut cx, window, "cmd-enter");

        assert!(clicks.borrow().is_empty(), "clicks: {:?}", clicks.borrow());
    }

    /// Two sibling tab groups, each a focusable container that is *not* itself a
    /// tab stop and holds a single tab stop. Mirrors how the title bar and
    /// status bar expose their controls as ARIA toolbars.
    struct TabGroupFocus {
        group_a: FocusHandle,
        item_a: FocusHandle,
        group_b: FocusHandle,
        item_b: FocusHandle,
    }

    impl Render for TabGroupFocus {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            fn group(container: &FocusHandle, item: &FocusHandle) -> Div {
                div()
                    .track_focus(container)
                    .tab_group()
                    .child(div().track_focus(item))
            }
            div()
                .child(group(&self.group_a, &self.item_a))
                .child(group(&self.group_b, &self.item_b))
        }
    }

    /// Focusing a tab-group container and pressing Tab (`focus_next`) must move
    /// focus to the first tab stop *inside that container*, as documented on
    /// [`InteractiveElement::tab_stop`].
    #[test]
    fn focus_next_from_tab_group_container_enters_that_group() {
        let mut cx = TestAppContext::single();
        let (group_a, item_a, group_b, item_b) = cx.update(|cx| {
            (
                cx.focus_handle(),
                cx.focus_handle().tab_stop(true),
                cx.focus_handle(),
                cx.focus_handle().tab_stop(true),
            )
        });
        let window: AnyWindowHandle = cx
            .add_window({
                let (group_a, item_a, group_b, item_b) =
                    (group_a, item_a, group_b.clone(), item_b.clone());
                move |_, _| TabGroupFocus {
                    group_a,
                    item_a,
                    group_b,
                    item_b,
                }
            })
            .into();
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();

        // Focus the *second* group's container, then advance like Tab would.
        let focused = cx
            .update_window(window, |_, window, cx| {
                window.focus(&group_b, cx);
                window.focus_next(cx);
                window.focused(cx).map(|handle| handle.id)
            })
            .unwrap();

        assert_eq!(focused, Some(item_b.id));
    }

    #[gpui::test]
    fn test_fractional_padding_does_not_make_a_fitting_container_scrollable(
        cx: &mut TestAppContext,
    ) {
        struct PaddedContainer {
            scroll_handle: ScrollHandle,
        }

        impl Render for PaddedContainer {
            fn render(
                &mut self,
                _window: &mut Window,
                _cx: &mut Context<Self>,
            ) -> impl IntoElement {
                // 4.25px of padding snaps to 4px in layout, so a 42px child
                // fits the 50px box exactly.
                div().size_full().child(
                    div()
                        .id("container")
                        .h(px(50.))
                        .w(px(100.))
                        .py(px(4.25))
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll_handle)
                        .child(div().w_full().h(px(42.))),
                )
            }
        }

        let scroll_handle = ScrollHandle::new();
        let window: AnyWindowHandle = cx
            .add_window({
                let scroll_handle = scroll_handle.clone();
                move |_, _| PaddedContainer { scroll_handle }
            })
            .into();
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();

        assert_eq!(scroll_handle.max_offset().y, px(0.));
    }

    struct ContentSizedGrid;

    impl Render for ContentSizedGrid {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let widths = [px(100.), px(200.), px(50.)];
            div().size_full().child(
                div()
                    .w_full()
                    .grid()
                    .grid_cols_max_content(widths.len() as u16)
                    .children(widths.into_iter().enumerate().map(|(index, width)| {
                        div()
                            .debug_selector(move || format!("cell-{index}"))
                            .w(width)
                            .h(px(10.))
                    })),
            )
        }
    }

    #[gpui::test]
    fn grid_cols_max_content_sizes_columns_to_their_content(cx: &mut TestAppContext) {
        let window = cx.add_window(|_, _| ContentSizedGrid);
        cx.update_window(window.into(), |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();

        let mut bounds = |selector: &'static str| {
            cx.update_window(window.into(), |_, window, _| {
                window.rendered_frame.debug_bounds.get(selector).copied()
            })
            .unwrap()
            .unwrap_or_else(|| panic!("{selector} was not rendered"))
        };

        assert_eq!(bounds("cell-0").origin.x, px(0.));
        assert_eq!(bounds("cell-1").origin.x, px(100.));
        assert_eq!(bounds("cell-2").origin.x, px(300.));
    }

    /// A page 200px tall that scrolls, holding 50px of rows, a box 100px
    /// tall that scrolls `box_rows` rows of 20px, or as many columns 20px
    /// wide sideways, and 400px of rows. Counts the wheel events the page's
    /// own listener sees.
    struct NestedScroll {
        page: ScrollHandle,
        boxed: ScrollHandle,
        box_rows: usize,
        sideways: bool,
        page_wheel_events: Rc<Cell<usize>>,
    }

    impl Render for NestedScroll {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let page_wheel_events = self.page_wheel_events.clone();
            div().size_full().child(
                div()
                    .id("page")
                    .w(px(200.))
                    .h(px(200.))
                    .overflow_y_scroll()
                    .track_scroll(&self.page)
                    .on_scroll_wheel(move |_, _, _| {
                        page_wheel_events.set(page_wheel_events.get() + 1)
                    })
                    .child(div().w_full().h(px(50.)))
                    .child(if self.sideways {
                        div()
                            .id("box")
                            .flex()
                            .w_full()
                            .h(px(100.))
                            .flex_none()
                            .overflow_x_scroll()
                            .track_scroll(&self.boxed)
                            .children(
                                (0..self.box_rows).map(|_| div().w(px(20.)).h_full().flex_none()),
                            )
                    } else {
                        div()
                            .id("box")
                            .w_full()
                            .h(px(100.))
                            .flex_none()
                            .overflow_y_scroll()
                            .track_scroll(&self.boxed)
                            .children(
                                (0..self.box_rows).map(|_| div().w_full().h(px(20.)).flex_none()),
                            )
                    })
                    .child(div().w_full().h(px(400.)).flex_none()),
            )
        }
    }

    /// Where the pointer is over the box before the page scrolls, and over
    /// the page alone, 10px above the box.
    const OVER_BOX: Point<Pixels> = point(px(20.), px(100.));
    const OVER_PAGE: Point<Pixels> = point(px(20.), px(40.));

    struct NestedScrollWindow {
        window: AnyWindowHandle,
        page: ScrollHandle,
        boxed: ScrollHandle,
        page_wheel_events: Rc<Cell<usize>>,
    }

    impl NestedScrollWindow {
        fn open(cx: &mut TestAppContext, box_rows: usize) -> Self {
            Self::open_with(cx, box_rows, false)
        }

        fn open_with(cx: &mut TestAppContext, box_rows: usize, sideways: bool) -> Self {
            let page = ScrollHandle::new();
            let boxed = ScrollHandle::new();
            let page_wheel_events = Rc::new(Cell::new(0));
            let window: AnyWindowHandle = cx
                .add_window({
                    let page = page.clone();
                    let boxed = boxed.clone();
                    let page_wheel_events = page_wheel_events.clone();
                    move |_, _| NestedScroll {
                        page,
                        boxed,
                        box_rows,
                        sideways,
                        page_wheel_events,
                    }
                })
                .into();
            cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
                .unwrap();
            Self {
                window,
                page,
                boxed,
                page_wheel_events,
            }
        }

        /// Dispatches a wheel event that moves the content up by `dy`, and
        /// draws a frame.
        fn wheel(
            &self,
            cx: &mut TestAppContext,
            position: Point<Pixels>,
            dy: f32,
            touch_phase: TouchPhase,
        ) {
            self.wheel_xy(cx, position, 0., dy, touch_phase);
        }

        /// Dispatches a wheel event that moves the content left by `dx` and
        /// up by `dy`, and draws a frame.
        fn wheel_xy(
            &self,
            cx: &mut TestAppContext,
            position: Point<Pixels>,
            dx: f32,
            dy: f32,
            touch_phase: TouchPhase,
        ) {
            cx.update_window(self.window, |_, window, cx| {
                window.dispatch_event(
                    crate::PlatformInput::ScrollWheel(ScrollWheelEvent {
                        position,
                        delta: crate::ScrollDelta::Pixels(point(px(-dx), px(-dy))),
                        modifiers: Default::default(),
                        touch_phase,
                    }),
                    cx,
                );
                window.draw(cx).clear(cx);
            })
            .unwrap();
        }

        /// Dispatches a touch of `phase` at `position`, and draws a frame.
        fn touch(&self, cx: &mut TestAppContext, position: Point<Pixels>, phase: TouchPhase) {
            cx.update_window(self.window, |_, window, cx| {
                window.dispatch_event(
                    TouchEvent {
                        id: TouchId(1),
                        phase,
                        position,
                        predicted_position: None,
                        force: None,
                    }
                    .to_platform_input(),
                    cx,
                );
                window.draw(cx).clear(cx);
            })
            .unwrap();
        }

        /// How far the page and the box have scrolled.
        fn offsets(&self) -> (Pixels, Pixels) {
            (-self.page.offset().y, -self.boxed.offset().y)
        }
    }

    #[gpui::test]
    fn test_wheel_over_a_nested_box_scrolls_only_the_box(cx: &mut TestAppContext) {
        let nested = NestedScrollWindow::open(cx, 20);
        nested.wheel(cx, OVER_BOX, 30., TouchPhase::Started);
        assert_eq!(nested.offsets(), (px(0.), px(30.)));
        nested.wheel(cx, OVER_BOX, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(0.), px(60.)));
        // The page's own wheel listener still sees the events.
        assert_eq!(nested.page_wheel_events.get(), 2);
    }

    #[gpui::test]
    fn test_a_gesture_stays_with_a_nested_box_at_its_end(cx: &mut TestAppContext) {
        // The box's 20 rows scroll 300px.
        let nested = NestedScrollWindow::open(cx, 20);
        nested.wheel(cx, OVER_BOX, 280., TouchPhase::Started);
        nested.wheel(cx, OVER_BOX, 50., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(0.), px(300.)));
        nested.wheel(cx, OVER_BOX, 50., TouchPhase::Moved);
        nested.wheel(cx, OVER_BOX, 50., TouchPhase::Ended);
        assert_eq!(nested.offsets(), (px(0.), px(300.)));

        // The next gesture finds the box at its end and scrolls the page.
        nested.wheel(cx, OVER_BOX, 40., TouchPhase::Started);
        assert_eq!(nested.offsets(), (px(40.), px(300.)));
        // Scrolling back over the box is the page's too, for this gesture.
        nested.wheel(cx, OVER_BOX, -20., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(20.), px(300.)));
        // The next gesture back scrolls the box.
        nested.wheel(cx, OVER_BOX, -20., TouchPhase::Started);
        assert_eq!(nested.offsets(), (px(20.), px(280.)));
    }

    #[gpui::test]
    fn test_a_page_gesture_passes_over_a_nested_box(cx: &mut TestAppContext) {
        let nested = NestedScrollWindow::open(cx, 20);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Started);
        assert_eq!(nested.offsets(), (px(30.), px(0.)));
        // The box is now under the pointer, at y 20 to 120, and then at -10
        // to 90.
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(90.), px(0.)));
    }

    #[gpui::test]
    fn test_a_nested_box_that_fits_passes_the_wheel_out(cx: &mut TestAppContext) {
        let nested = NestedScrollWindow::open(cx, 3);
        nested.wheel(cx, OVER_BOX, 30., TouchPhase::Started);
        nested.wheel(cx, OVER_BOX, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(60.), px(0.)));
    }

    #[gpui::test]
    fn test_a_gesture_ends_when_the_pointer_moves(cx: &mut TestAppContext) {
        // A mouse wheel's ticks come as moves, without a start or an end.
        let nested = NestedScrollWindow::open(cx, 20);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        // Over the box now, which leaves the tick to the page.
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(60.), px(0.)));
        nested.wheel(cx, point(px(25.), px(40.)), 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(60.), px(30.)));
    }

    #[gpui::test]
    fn test_a_mouse_wheel_gesture_ends_after_a_pause(cx: &mut TestAppContext) {
        let nested = NestedScrollWindow::open(cx, 20);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        cx.executor()
            .advance_clock(crate::gestures::SCROLL_LATCH_IDLE / 2);
        // Over the box now, which leaves the tick to the page.
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(60.), px(0.)));

        cx.executor()
            .advance_clock(crate::gestures::SCROLL_LATCH_IDLE);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(60.), px(30.)));
    }

    #[gpui::test]
    fn test_a_finger_resting_on_the_trackpad_keeps_the_gesture(cx: &mut TestAppContext) {
        let nested = NestedScrollWindow::open(cx, 20);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Started);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        // The box is under the pointer now, and the finger rests a while.
        cx.executor()
            .advance_clock(crate::gestures::SCROLL_LATCH_IDLE * 2);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(90.), px(0.)));

        // Once the finger is lifted, a pause ends the gesture.
        nested.wheel(cx, OVER_PAGE, 0., TouchPhase::Ended);
        cx.executor()
            .advance_clock(crate::gestures::SCROLL_LATCH_IDLE);
        nested.wheel(cx, OVER_PAGE, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets(), (px(90.), px(30.)));
    }

    #[gpui::test]
    fn test_a_sideways_tremor_leaves_a_vertical_gesture_to_the_page(cx: &mut TestAppContext) {
        // The box's 20 columns scroll 200px sideways.
        let nested = NestedScrollWindow::open_with(cx, 20, true);
        nested.wheel_xy(cx, OVER_BOX, 2., 30., TouchPhase::Started);
        // Still over the box, at y 20 to 120.
        nested.wheel(cx, OVER_BOX, 30., TouchPhase::Moved);
        nested.wheel(cx, OVER_BOX, 30., TouchPhase::Moved);
        assert_eq!(nested.offsets().0, px(90.));
    }

    #[gpui::test]
    fn test_a_touch_pan_over_a_nested_box_scrolls_only_the_box(cx: &mut TestAppContext) {
        let nested = NestedScrollWindow::open(cx, 20);
        // A pan over the page, above the box.
        nested.touch(cx, OVER_PAGE, TouchPhase::Started);
        for y in [30., 20., 10., 0.] {
            nested.touch(cx, point(px(20.), px(y)), TouchPhase::Moved);
        }
        nested.touch(cx, point(px(20.), px(0.)), TouchPhase::Ended);
        let (page, boxed) = nested.offsets();
        assert!(page > px(0.), "the pan scrolled the page");
        assert_eq!(boxed, px(0.));

        // The next pan starts over the box and scrolls only the box.
        nested.touch(cx, OVER_BOX, TouchPhase::Started);
        for y in [80., 60., 40.] {
            nested.touch(cx, point(px(20.), px(y)), TouchPhase::Moved);
        }
        let (page_after, boxed) = nested.offsets();
        assert_eq!(page_after, page);
        assert!(boxed > px(0.), "the pan scrolled the box");
    }
}
