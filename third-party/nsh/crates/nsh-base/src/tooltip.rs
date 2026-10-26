//! `Tooltip`: the hint an element's `tooltip` shows, as GPUI's
//! `.tooltip(..)`: a hint overlay of the core (`nsh_core::element::Overlay::hint`)
//! with the app's look, placement, delay and events.

use std::time::Duration;

use nsh_core::prelude::*;

use crate::popup::{OpenChangeReason, OpenState, lifecycle};

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
    /// It is gone (also when the app hid it).
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
/// `style`, and its children are what it says.
#[component]
pub fn Tooltip(props: TooltipProps, cx: Scope<TooltipEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let change = move |next: bool| {
        if next && props.disabled.get_untracked() {
            return;
        }
        if open.request(next) {
            cx.emit(TooltipEvent::OpenChange(next, OpenChangeReason::Hover));
        }
    };
    let shown = move || open.get() && !props.disabled.get();
    lifecycle(
        shown,
        move || cx.emit(TooltipEvent::Open),
        move || cx.emit(TooltipEvent::Close),
    );
    // The core follows the pointer on the trigger and asks; the tooltip's
    // state decides.
    overlay()
        .hint(move || Duration::from_secs_f64(props.delay.get().max(0.0) / 1000.0))
        .hint_open(move || Some(shown()))
        .placement(props.placement)
        .align(props.align)
        .offset(props.offset)
        .margin(props.margin)
        .pointer_events(PointerEvents::None)
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
