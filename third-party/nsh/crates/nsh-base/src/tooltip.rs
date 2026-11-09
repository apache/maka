//! `Tooltip`: the hint an element's `tooltip` shows, as GPUI's
//! `.tooltip(..)`: a hint overlay of the core (`nsh_core::element::Overlay::hint`)
//! with the app's look, placement, delay and events. The core shows it for
//! the keyboard focus on its trigger too, in every idiom, and hides it on
//! Escape (WAI-ARIA's tooltip pattern). In a terminal it is a line, not a
//! bubble: what it says shows at once on the status line
//! ([`crate::status_line`]) while the focus or the pointer is on its
//! trigger.

use std::time::Duration;

use nsh_core::{
    element::{Overlay, Style, StyleRefinement},
    prelude::*,
};

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
    /// (default 500); the keyboard focus shows it at once. `Infinity`:
    /// never by itself (neither the pointer nor the focus), only when the
    /// app opens it.
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
    /// `"hover"`), the keyboard focus came to it or left it (`"focus"`),
    /// or Escape was pressed while it was shown (`"cancel"`): set `open`
    /// to follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// It is shown.
    Open,
    /// It is gone (also when the app hid it), after its exit.
    Close,
}

/// The longest a timer waits: 2^31 - 1 milliseconds (about 24.8 days),
/// as the web's `setTimeout`.
const LONGEST: Duration = Duration::from_millis(i32::MAX as u64);

/// `ms` milliseconds as the pointer's delay: zero for a negative or NaN
/// one, none (it never ends) for `Infinity` or one longer than
/// [`LONGEST`].
fn delay(ms: f64) -> Option<Duration> {
    if ms.is_nan() || ms <= 0.0 {
        Some(Duration::ZERO)
    } else if ms > f64::from(i32::MAX) {
        None
    } else {
        Some(Duration::from_secs_f64(ms / 1000.0))
    }
}

/// A hint about an element, given as the element's `tooltip`
/// (`<View tooltip={<Tooltip>…</Tooltip>}>`, Rust
/// `.tooltip(tooltip().child(..))`), as GPUI's `.tooltip(..)`: shown on top
/// of everything next to the element on the desktops while the pointer
/// rests on it (after `delay`), until the pointer leaves or presses it, and
/// in every idiom at once while the keyboard focus is on it, until the
/// focus leaves; Escape hides it. Touch screens show it otherwise only when
/// the app opens it (`open`). It never
/// takes the pointer or presses, so the element works as it does without
/// it. It looks like nothing: it is the bubble, styled with its `class` /
/// `style`, and its children are what it says; its entrance and exit are
/// the app's `transition` classes between its look and its starting and
/// ending looks (`startingClass`, `endingClass`). In a terminal it shows
/// at once (no delay but an endless one) and in one frame on the bottom
/// row of the viewport, the line a toast's message takes while one shows,
/// with the terminal's colors rather than its look: the keyboard focus and
/// the pointer on the trigger show it alike.
#[component]
pub fn Tooltip(props: TooltipProps, cx: Scope<TooltipEvent>) -> impl IntoElement {
    let terminal = crate::terminal::is_terminal();
    let open = OpenState::new(props.open, props.default_open);
    // A delay that never ends: the pointer never asks.
    let endless = move || delay(props.delay.get_untracked()).is_none();
    let change = move |next: bool, reason: HintReason| {
        let reason = match reason {
            HintReason::Focus => OpenChangeReason::Focus,
            HintReason::Escape => OpenChangeReason::Cancel,
            _ => OpenChangeReason::Hover,
        };
        if next && (props.disabled.get_untracked() || endless()) {
            return;
        }
        open.request(next, || {
            cx.emit(TooltipEvent::OpenChange(next, reason));
        });
    };
    let shown = move || open.get() && !props.disabled.get();
    if terminal {
        return terminal_tooltip(props, cx, change, shown);
    }
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
    // state decides. An endless delay waits the longest a timer can, and
    // its end asks nothing.
    overlay()
        .hint(move || delay(props.delay.get()).unwrap_or(LONGEST))
        .hint_open(move || Some(presence.mounted()))
        .placement(props.placement)
        .align(props.align)
        .offset(props.offset)
        .margin(props.margin)
        .pointer_events(PointerEvents::None)
        .element_ref(&presence.popup())
        .app_class(move || presence.class())
        .state_inline_style(move || presence.style())
        .on_hint_show(move |reason: &HintReason| change(true, *reason))
        .on_hint_hide(move |reason: &HintReason| change(false, *reason))
        .child(props.children)
}

/// A terminal's tooltip: the core's hint follows the focus and the pointer
/// on the trigger and asks, at once. The hint overlay shows only while the
/// tooltip has the status line, and takes no Cell by the trigger (no size,
/// whatever the app's look gives the bubble): it only holds the line, an
/// overlay of the root view, with what the tooltip says.
fn terminal_tooltip(
    props: TooltipProps,
    cx: Scope<TooltipEvent>,
    change: impl Fn(bool, HintReason) + Copy + 'static,
    shown: impl Fn() -> bool + Copy + 'static,
) -> Overlay {
    lifecycle(
        shown,
        move || cx.emit(TooltipEvent::Open),
        move || cx.emit(TooltipEvent::Close),
    );
    let on_line = crate::status_line::claim(crate::status_line::Claim::Hint, shown);
    overlay()
        .hint(move || match delay(props.delay.get()) {
            Some(_) => Duration::ZERO,
            None => LONGEST,
        })
        .hint_open(move || Some(on_line.get()))
        .pointer_events(PointerEvents::None)
        .focusable(false)
        .state_inline_style(|| {
            Style::from(
                StyleRefinement::default()
                    .size_0()
                    .p_0()
                    .m_0()
                    .border(Points(0.0)),
            )
        })
        .on_hint_show(move |reason: &HintReason| change(true, *reason))
        .on_hint_hide(move |reason: &HintReason| change(false, *reason))
        .child(crate::status_line::line(on_line, props.children))
}

/// As an element's `tooltip`, it is the hint overlay itself.
impl IntoTooltip for TooltipElement {
    fn apply_tooltip(self, node: &mut nsh_core::element::ElNode) {
        nsh_core::element::__hint_tooltip(node, self.into_element());
    }
}
