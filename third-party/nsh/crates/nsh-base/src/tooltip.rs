//! `Tooltip`: the hint an element's `tooltip` shows, as GPUI's
//! `.tooltip(..)`: a hint overlay of the core (`nsh_core::element::Overlay::hint`)
//! with the app's look, placement, delay and events.

use std::time::Duration;

use nsh_core::{element::Style, prelude::*};

use crate::popup::{OpenChangeReason, OpenState, PopupPresence, StateLooks, lifecycle};

/// The props of [`Tooltip`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TooltipProps {
    /// Shown (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the tooltip keeps its own state.
    pub open: Prop<Option<bool>>,
    /// Shown at first, while `open` is not set.
    #[prop(default)]
    pub default_open: Prop<bool>,
    /// The side of the trigger it goes on (default `"top"`); the other side
    /// when only that one has room.
    #[prop(default = Placement::Top)]
    pub placement: Prop<Placement>,
    /// How it lines up with the trigger along that side (default
    /// `"center"`).
    #[prop(default)]
    pub align: Prop<Align>,
    /// The gap between the trigger and the tooltip (default 4).
    #[prop(default = Points(4.0))]
    pub offset: Prop<Points>,
    /// The distance it keeps from the edges of the safe area (default 4).
    #[prop(default = Points(4.0))]
    pub margin: Prop<Points>,
    /// Milliseconds the pointer rests on the trigger before it shows
    /// (default 500).
    #[prop(default = 500.0)]
    pub delay: Prop<f64>,
    /// No tooltip: it neither shows nor asks to.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Classes it has in its first frame, which its `transition` classes
    /// animate from (Tailwind's `starting:`, CSS's `@starting-style`): its
    /// entrance. A state's classes apply over its `class` and `style`, as a
    /// state's styles do.
    pub starting_class: Prop<Option<SharedString>>,
    /// Its inline style in its first frame, over its classes (its `style`
    /// wins where both set a property).
    #[prop(default)]
    pub starting_style: Prop<Style>,
    /// Classes it has while it goes: it stays until the transitions it has
    /// then ran (`onClose` after), so they run its exit.
    pub ending_class: Prop<Option<SharedString>>,
    /// Its inline style while it goes, over its classes (its `style` wins
    /// where both set a property).
    #[prop(default)]
    pub ending_style: Prop<Style>,
    /// What it shows: the bubble is the tooltip itself, styled with its
    /// `class` / `style`.
    pub children: Prop<Children>,
}

/// The events of a [`Tooltip`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TooltipEvent {
    /// The pointer rested on the trigger, or left or pressed it (`reason`
    /// `"hover"`): set `open` to follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// It is shown.
    Open,
    /// It is gone (also when the app hid it), after its exit.
    Close,
}

/// A hint about an element, given as the element's `tooltip`
/// (`<View tooltip={<Tooltip>…</Tooltip>}>`, Rust
/// `.tooltip(tooltip().child(..))`), as GPUI's `.tooltip(..)`: shown on top
/// of everything next to the element on the desktops while the pointer
/// rests on it (after `delay`), until the pointer leaves or presses it;
/// touch screens show it only when the app opens it (`open`). It never
/// takes the pointer or presses, so the element works as it does without
/// it. It looks like nothing: it is the bubble, styled with its `class` /
/// `style`, and its children are what it says; its entrance and exit are
/// the app's `transition` classes between its look and its starting and
/// ending looks (`startingClass`, `endingClass`).
#[component]
pub fn Tooltip(props: TooltipProps, cx: Scope<TooltipEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let change = move |next: bool| {
        if next && props.disabled.get_untracked() {
            return;
        }
        open.request(next, || {
            cx.emit(TooltipEvent::OpenChange(next, OpenChangeReason::Hover));
        });
    };
    let shown = move || open.get() && !props.disabled.get();
    // Its own `class` and `style` are the core's to give its root.
    let presence = PopupPresence::new(
        shown,
        StateLooks {
            class: None,
            style: None,
            starting_class: props.starting_class,
            starting_style: props.starting_style,
            ending_class: props.ending_class,
            ending_style: props.ending_style,
        },
    );
    lifecycle(
        move || presence.mounted(),
        move || cx.emit(TooltipEvent::Open),
        move || cx.emit(TooltipEvent::Close),
    );
    // The core follows the pointer on the trigger and asks; the tooltip's
    // state decides.
    overlay()
        .hint(move || Duration::from_secs_f64(props.delay.get().max(0.0) / 1000.0))
        .hint_open(move || Some(presence.mounted()))
        .placement(props.placement)
        .align(props.align)
        .offset(props.offset)
        .margin(props.margin)
        .pointer_events(PointerEvents::None)
        .element_ref(&presence.popup())
        .app_class(move || presence.class())
        .state_inline_style(move || presence.style())
        .on_hint_show(move || change(true))
        .on_hint_hide(move || change(false))
        .child(props.children)
}

/// As an element's `tooltip`, it is the hint overlay itself.
impl IntoTooltip for TooltipElement {
    fn apply_tooltip(self, node: &mut nsh_core::element::ElNode) {
        nsh_core::element::__hint_tooltip(node, self.into_element());
    }
}
