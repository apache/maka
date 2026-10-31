//! `Popover`: content anchored to a trigger, in an overlay.

use nsh_core::{
    element::{NodeRef, Style},
    overlay::OverlayAnchor,
    prelude::*,
};

use crate::{
    popup::{OpenChangeReason, OpenState, PopupPresence, StateLooks, lifecycle},
    roving::{bar, bar_trigger, leave_bar},
};

/// The props of [`Popover`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct PopoverProps {
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the popover keeps its own state.
    pub open: Prop<Option<bool>>,
    /// Open at first, while `open` is not set.
    #[prop(default)]
    pub default_open: Prop<bool>,
    /// The side of the trigger it goes on (default `"bottom"`); the other
    /// side when only that one has room.
    #[prop(default)]
    pub placement: Prop<Placement>,
    /// How it lines up with the trigger along that side (default
    /// `"center"`).
    #[prop(default)]
    pub align: Prop<Align>,
    /// The gap between the trigger and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// The distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// Escape and the Android back button close it (default true); either
    /// way `onCancel` hears them.
    #[prop(default = true)]
    pub close_on_escape: Prop<bool>,
    /// A press outside it closes it (default true). On phones and tablets
    /// the press only closes it (a transparent backdrop takes it); on the
    /// desktops it goes on to what is under the pointer.
    #[prop(default = true)]
    pub close_on_press_outside: Prop<bool>,
    /// The classes of the popup: the box its content is in, placed by the
    /// core.
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// An element rendered elsewhere to place the popup against. When set,
    /// it takes precedence over the trigger's bounds. It belongs to the
    /// same root view and stays mounted while the popup is open. This only
    /// controls placement: focus returns to the actual opener.
    pub anchor: Prop<Option<NodeRef>>,
    /// Classes the popup has in its first frame, which its `transition`
    /// classes animate from (Tailwind's `starting:`, CSS's
    /// `@starting-style`): its entrance. A state's classes apply over
    /// `popupClass` and `popupStyle`, as a state's styles do.
    pub popup_starting_class: Prop<Option<SharedString>>,
    /// The inline style of the popup in its first frame, over
    /// `popupStyle`.
    #[prop(default)]
    pub popup_starting_style: Prop<Style>,
    /// Classes the popup has while it goes: it stays, taking no presses,
    /// until the transitions it has then ran (`onClose` after), so they
    /// run its exit.
    pub popup_ending_class: Prop<Option<SharedString>>,
    /// The inline style of the popup while it goes, over `popupStyle`.
    #[prop(default)]
    pub popup_ending_style: Prop<Style>,
    /// What opens it: pressing it toggles the popover, and the popover is
    /// placed against it.
    pub trigger: Prop<Option<Slot>>,
    /// The content, made on each opening.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// The events of a [`Popover`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum PopoverEvent {
    /// It opened or closed (by the trigger, a press outside, Escape or
    /// back), with why: set `open` to follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// It is shown.
    Open,
    /// It is gone (also when the app closed it), after its exit.
    Close,
    /// The user tried to close it (Escape or back, a press outside),
    /// whether or not `closeOnEscape` / `closeOnPressOutside` let it close.
    Cancel,
    /// The popup was placed: the side of the trigger it went on (the other
    /// side of `placement` when only that one had room), its frame in the
    /// root view and the room on that side.
    #[args(placement, bounds, available)]
    Position(Placement, Bounds<Points>, Size<Points>),
}

/// Content anchored to a trigger, shown on top of everything in its root
/// view (the surface, or the dialog it is in) whatever clips the trigger:
/// pressing the trigger toggles it, a press outside, Escape and the Android
/// back button close it. It goes on the `placement` side of the trigger, on
/// the other side when only that one has room, kept inside the safe area,
/// and follows the trigger as it scrolls. It looks like nothing: style the
/// popup with `popupClass` / `popupStyle` and the content as you like; its
/// entrance and exit are the app's `transition` classes between the
/// popup's look and its starting and ending looks (`popupStartingClass`,
/// `popupEndingClass`).
#[component]
pub fn Popover(props: PopoverProps, cx: Scope<PopoverEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let change = move |next: bool, reason: OpenChangeReason| {
        open.request(next, || cx.emit(PopoverEvent::OpenChange(next, reason)));
    };
    // A press outside or Escape: an attempt, which closes it when allowed
    // (none while it goes).
    let cancel = move |reason: OpenChangeReason, allowed: bool| {
        if !open.get_untracked() {
            return;
        }
        cx.emit(PopoverEvent::Cancel);
        if allowed {
            change(false, reason);
        }
    };
    let presence = PopupPresence::new(
        move || open.get(),
        StateLooks {
            class: Some(props.popup_class),
            style: Some(props.popup_style),
            starting_class: props.popup_starting_class,
            starting_style: props.popup_starting_style,
            ending_class: props.popup_ending_class,
            ending_style: props.popup_ending_style,
        },
    );
    lifecycle(
        move || presence.mounted(),
        move || cx.emit(PopoverEvent::Open),
        move || cx.emit(PopoverEvent::Close),
    );
    let anchor = element_ref();
    let desktop = is_desktop();
    // In a toolbar, the trigger is one of its items.
    let around = bar();
    view()
        .child(props.trigger.place(move |trigger| {
            let trigger = trigger
                .element_ref(&anchor)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(open.get()),
                    ..AccessibilityState::default()
                })
                .on_press(move || {
                    change(!open.get_untracked(), OpenChangeReason::TriggerPress);
                });
            bar_trigger(around.clone(), trigger, anchor)
        }))
        .child(when(
            move || presence.mounted(),
            move || {
                // The trigger may be a toolbar's item; the content is not.
                leave_bar();
                let mut views = Vec::new();
                if !desktop {
                    // Keep the outside press below the popup for its whole opening.
                    views.push(
                        overlay()
                            .inset_0()
                            .focusable(false)
                            .pointer_events(move || {
                                if open.get() && props.close_on_press_outside.get() {
                                    PointerEvents::Auto
                                } else {
                                    PointerEvents::None
                                }
                            })
                            .on_press(move || {
                                if props.close_on_press_outside.get_untracked() {
                                    cancel(OpenChangeReason::PressOutside, true);
                                }
                            })
                            .into_element(),
                    );
                }
                let popup = overlay()
                    .focus_return(true)
                    .anchor_target(move || {
                        if let Some(node) = props.anchor.get() {
                            OverlayAnchor::Node(node.0)
                        } else {
                            anchor
                                .node()
                                .map_or(OverlayAnchor::None, OverlayAnchor::Content)
                        }
                    })
                    .placement(props.placement)
                    .align(props.align)
                    .offset(props.offset)
                    .margin(props.margin)
                    .element_ref(&presence.popup())
                    .app_class(move || presence.class())
                    .state_inline_style(move || presence.style())
                    .on_position(move |p: &OverlayPosition| {
                        cx.emit(PopoverEvent::Position(p.placement, p.bounds, p.available))
                    })
                    .on_press_outside(move |_: &Point<Points>| {
                        // Touch screens: the backdrop took it.
                        if desktop {
                            let allowed = props.close_on_press_outside.get_untracked();
                            cancel(OpenChangeReason::PressOutside, allowed);
                        }
                    })
                    .on_cancel(move || {
                        cancel(
                            OpenChangeReason::Cancel,
                            props.close_on_escape.get_untracked(),
                        )
                    })
                    .child(props.children);
                views.push(popup.into_element());
                views
            },
        ))
}
