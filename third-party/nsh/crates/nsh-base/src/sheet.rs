//! `Sheet`: a panel at an edge of the screen, over a backdrop, in
//! overlays.

use nsh_core::ui::{Style, prelude::*};

use crate::popup::{OpenChangeReason, OpenState, SheetMotion, lifecycle};

/// The props of [`Sheet`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SheetProps {
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the sheet keeps its own state.
    pub open: Prop<Option<bool>>,
    /// Open at first, while `open` is not set.
    #[prop(default)]
    pub default_open: Prop<bool>,
    /// The edge it is on (default `"bottom"`): as wide as the screen at the
    /// top and bottom, as tall at the left and right.
    #[prop(default)]
    pub side: Prop<Placement>,
    /// Escape and the Android back button close it (default true); either
    /// way `onCancel` hears them.
    #[prop(default = true)]
    pub close_on_escape: Prop<bool>,
    /// A press on the backdrop closes it (default true).
    #[prop(default = true)]
    pub close_on_backdrop_press: Prop<bool>,
    /// A bottom sheet follows a downward swipe and closes on release past
    /// 30% of its height or 800 points per second (default false).
    /// On iOS, a scroll inside it hands the same drag over at its top.
    #[prop(default)]
    pub close_on_swipe: Prop<bool>,
    /// The classes of the panel.
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the panel, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// The classes of the backdrop behind the panel, which covers the
    /// screen and takes its presses.
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// The content, made on each opening.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// The events of a [`Sheet`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SheetEvent {
    /// It closed (a press on the backdrop, Escape, back or a swipe), with why: set
    /// `open` to follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// It came in: it is all there.
    Open,
    /// It went: it is all gone (also when the app closed it).
    Close,
    /// The user tried to close it (Escape or back, a press on the
    /// backdrop, or an enabled swipe), whether or not `closeOnEscape` / `closeOnBackdropPress`
    /// let it close.
    Cancel,
}

/// A panel at an edge of the screen (`side`) over a backdrop that covers
/// the rest and takes its presses, on top of everything in its root view;
/// the same on every device. It slides in from its edge as its backdrop
/// fades in, and back out as it closes (at once when the user asked for
/// less motion): the backdrop's opacity and the panel's translation are
/// the sheet's, so color the backdrop with its background. A press on the backdrop, Escape and the
/// Android back button close it. It looks like nothing: style the panel
/// with `popupClass` / `popupStyle` and the backdrop with `backdropClass`
/// / `backdropStyle` (a translucent color).
#[component]
pub fn Sheet(props: SheetProps, cx: Scope<SheetEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let change = move |next: bool, reason: OpenChangeReason| {
        if open.request(next) {
            cx.emit(SheetEvent::OpenChange(next, reason));
        }
    };
    let motion = SheetMotion::new(move || open.get(), move || props.side.get());
    let height = animated_value(1.0);
    let panel_height = stored(Points(1.0));
    let swipe_enabled = animated_value(0.0);
    // The same native value drives the panel and scrim: finger motion
    // never waits for a Rust component turn or a JS callback.
    let progress = motion
        .drag_y
        .div(&height)
        .interpolate(&[0.0, 1.0], &[0.0, 1.0]);
    let dragged_y = progress
        .mul(&height)
        .sub(&motion.drag_y)
        .mul(&swipe_enabled)
        .add(&motion.y);
    // During exit both fade and drag return to zero. Subtracting keeps
    // the backdrop fading forward from the finger's release position.
    let dragged_fade = motion
        .fade
        .sub(&progress.mul(&swipe_enabled))
        .interpolate(&[0.0, 1.0], &[0.0, 1.0]);
    let swipe = move || props.close_on_swipe.get() && props.side.get() == Placement::Bottom;
    let was_swipe = stored(false);
    effect(move || {
        let enabled = swipe();
        swipe_enabled.set(if enabled { 1.0 } else { 0.0 });
        if was_swipe.replace(enabled) && !enabled && open.get_untracked() {
            motion.come_in();
        }
    });
    lifecycle(
        move || motion.there(),
        move || cx.emit(SheetEvent::Open),
        move || cx.emit(SheetEvent::Close),
    );
    when(motion.shown, move || {
        let backdrop = overlay()
            .inset_0()
            .bind_opacity(&dragged_fade)
            .focusable(false)
            .app_class(props.backdrop_class)
            .inline_style(props.backdrop_style)
            .on_press(move || {
                cx.emit(SheetEvent::Cancel);
                if props.close_on_backdrop_press.get_untracked() {
                    change(false, OpenChangeReason::BackdropPress);
                }
            });
        let mut panel = overlay()
            .style_with(move |s| match props.side.get() {
                Placement::Bottom => s.left_0().right_0().bottom_0(),
                Placement::Top => s.left_0().right_0().top_0(),
                Placement::Left => s.top_0().bottom_0().left_0(),
                Placement::Right => s.top_0().bottom_0().right_0(),
            })
            .app_class(props.popup_class)
            .inline_style(props.popup_style)
            .bind_translate_x(&motion.x)
            .on_layout(move |frame: &Bounds<Points>| {
                panel_height.replace(frame.size.height.max(Points(1.0)));
                height.set(frame.size.height.0.max(1.0));
                motion.laid_out(frame.size);
            })
            .on_cancel(move || {
                cx.emit(SheetEvent::Cancel);
                if props.close_on_escape.get_untracked() {
                    change(false, OpenChangeReason::Cancel);
                }
            })
            .child(props.children);
        panel = panel
            .pan_values(None, Some(&motion.drag_y))
            .pan_enabled(move || swipe() && open.get() && motion.settled.get())
            .pan_scroll_handoff(swipe)
            .on_pan_end(move |e: &PanEvent| {
                if !open.get_untracked() {
                    return;
                }
                let distance = e.value_y.unwrap_or(0.0).max(0.0);
                let dismiss = !e.cancelled
                    && distance > 0.0
                    && (distance >= panel_height.get().0 * 0.3 || e.velocity_y >= 800.0);
                if props.close_on_swipe.get_untracked()
                    && props.side.get_untracked() == Placement::Bottom
                    && dismiss
                {
                    cx.emit(SheetEvent::Cancel);
                    change(false, OpenChangeReason::Swipe);
                }
                // Controlled open may decline the request. It comes back
                // until the owner's next value actually starts closing it.
                if open.get_untracked() {
                    motion.come_in();
                }
            });
        // These bindings change in place when the permission changes;
        // children and scroll positions keep their state.
        panel = panel.bind_translate_y(&dragged_y);
        vec![backdrop.into_element(), panel.into_element()]
    })
}
