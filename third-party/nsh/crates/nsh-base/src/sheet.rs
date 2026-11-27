//! `Sheet`: a panel at an edge of the screen, over a backdrop, in
//! overlays.

/// A height a bottom sheet rests at (`detents`; TS `SheetDetent`): the
/// core's, which dialogs presented as iOS sheets take too.
pub use nsh_core::SheetDetent;
use nsh_core::{AccessibilityActionDef, AccessibilityValue, element::Style, prelude::*};

use crate::{
    popup::{
        OpenChangeReason, OpenState, SheetMotion, bottom_panel_max_height, keyboard_lift, lifecycle,
    },
    roving::leave_bar,
};

/// The height of `detent` in a room `room` tall (the screen below the
/// status bar) on a screen `screen` tall.
fn detent_height(detent: SheetDetent, room: Points, screen: Points) -> Points {
    let room = room.0.max(0.0);
    let height = match detent {
        SheetDetent::Medium => Points(screen.0 * 0.5),
        SheetDetent::Large => Points(room),
        SheetDetent::Height(height) => height,
        SheetDetent::Fraction(fraction) => Points(room * fraction.0.clamp(0.0, 1.0)),
    };
    Points(height.0.clamp(0.0, room))
}

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
    /// The heights a bottom sheet rests at (none by default: as tall as
    /// its content). The panel is as tall as the largest and stands lower
    /// for a smaller one; a drag moves it between them, following the
    /// finger, and a release springs it to the nearest, or on in the
    /// direction of a flick; past the smallest it closes when
    /// `closeOnSwipe` allows. On iOS, a scroll inside it hands the
    /// downward drag over at its top. While the software keyboard is up,
    /// it rests at the largest, and back at its detent once the keyboard
    /// goes (the grabber goes on from that detent). Given to an open sheet
    /// that had none, or all taken away, or a `side` changing between the
    /// bottom and another edge, they take effect at once and the sheet
    /// makes its content again.
    #[prop(default)]
    pub detents: Prop<Vec<SheetDetent>>,
    /// The detent it rests at (controlled): the app owns the value and
    /// changes it in `onDetentChange`. Without it the sheet keeps its own
    /// (from `defaultDetent`); one that is not among `detents` is the
    /// smallest.
    pub detent: Prop<Option<SheetDetent>>,
    /// The detent it rests at first, while `detent` is not set (default
    /// the smallest).
    pub default_detent: Prop<Option<SheetDetent>>,
    /// Shows a grabber at the top of the panel, before the content: a
    /// handle screen readers adjust to change the detent and a press
    /// moves to the next larger one (after the largest, the smallest).
    /// It looks like nothing: style it with `grabberClass` /
    /// `grabberStyle`.
    #[prop(default)]
    pub grabber: Prop<bool>,
    /// The classes of the grabber.
    pub grabber_class: Prop<Option<SharedString>>,
    /// The inline style of the grabber, over its classes.
    #[prop(default)]
    pub grabber_style: Prop<Style>,
    /// Decoration inside the grabber, separate from its touch and accessibility frame.
    pub grabber_content: Prop<Option<Slot>>,
    /// What screen readers call the grabber.
    pub grabber_accessibility_label: Prop<Option<SharedString>>,
    /// What shows at the bottom of the panel, after the content (an input
    /// bar, the sheet's actions). With `detents` it stays at the bottom of
    /// the part of the panel that shows, at every detent and while a drag
    /// moves the panel between them (make the smallest detent tall enough
    /// to show it); below the smallest it goes with the panel.
    pub footer: Prop<Option<Slot>>,
    /// The classes of the footer.
    pub footer_class: Prop<Option<SharedString>>,
    /// The inline style of the footer, over its classes.
    #[prop(default)]
    pub footer_style: Prop<Style>,
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
    /// What screen readers call the sheet, a dialog: its title.
    pub accessibility_label: Prop<Option<SharedString>>,
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
    /// The user moved it to another of its `detents` (a drag, the
    /// grabber): set `detent` to follow it.
    #[args(detent)]
    DetentChange(SheetDetent),
}

/// How long a sheet's spring between detents takes to respond, in
/// milliseconds, and its damping ratio: settled with no visible bounce.
const DETENT_SPRING_MS: f32 = 320.0;
const DETENT_DAMPING: f32 = 0.9;
/// A release this fast (points per second) is a flick: it goes on to the
/// next detent in its direction.
const FLICK: f32 = 500.0;
/// A release this fast downward past the smallest detent closes the sheet
/// (as `closeOnSwipe` does without detents), and so does one this far
/// below it (a share of the smallest detent's height).
const CLOSE_VELOCITY: f32 = 800.0;
const CLOSE_SHARE: f32 = 0.3;

/// Where a release at `at` (how far the panel stands below its top) at
/// `velocity` (downward, points per second) goes: the index of one of
/// `offsets` (each detent's distance below the top, smallest first: the
/// largest detent first; at least one), or `None` to close (when
/// `can_close`), the panel `height` tall.
fn settle(offsets: &[f32], height: f32, at: f32, velocity: f32, can_close: bool) -> Option<usize> {
    let last = offsets.len().checked_sub(1)?;
    let lowest = offsets[last];
    if can_close && at > lowest {
        let below = at - lowest;
        if below >= (height - lowest) * CLOSE_SHARE || velocity >= CLOSE_VELOCITY {
            return None;
        }
    }
    if velocity >= FLICK {
        return Some(offsets.iter().position(|&o| o > at).unwrap_or(last));
    }
    if velocity <= -FLICK {
        return Some(offsets.iter().rposition(|&o| o < at).unwrap_or(0));
    }
    offsets
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1 - at).abs().total_cmp(&(b.1 - at).abs()))
        .map(|(i, _)| i)
}

fn action(name: &str) -> AccessibilityActionDef {
    AccessibilityActionDef {
        name: name.into(),
        label: None,
    }
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
///
/// A bottom sheet given `detents` rests at one of those heights, as tall as
/// the largest and lower for a smaller one: a drag moves it between them
/// and a release springs it to one (`onDetentChange`), with an optional
/// grabber screen readers adjust.
///
/// It is a modal dialog, as [`crate::dialog`] is, on every platform: screen
/// readers hear a dialog named by `accessibilityLabel` and keep to it, the
/// keyboard focus leaves what is under it and Tab goes round its stops
/// (where the keyboard moves between views), and the focus goes back where
/// it was as it goes.
#[component]
pub fn Sheet(props: SheetProps, cx: Scope<SheetEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let change = move |next: bool, reason: OpenChangeReason| {
        open.request(next, || cx.emit(SheetEvent::OpenChange(next, reason)));
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
    // Detents make their own translation and fade, only while the sheet
    // shows with some (`Detents::graph`): a sheet without them makes no
    // more of the graph than the nodes above.
    let detents = Detents::new(&props, cx, motion);
    let swipe = move || props.close_on_swipe.get() && props.side.get() == Placement::Bottom;
    let draggable = move || swipe() || detents.draggable();
    let was_swipe = stored(false);
    effect(move || {
        let enabled = swipe();
        swipe_enabled.set(if enabled { 1.0 } else { 0.0 });
        if was_swipe.replace(enabled) && !enabled && open.get_untracked() {
            motion.come_in();
        }
    });
    detents.follow(open);
    lifecycle(
        move || motion.there(),
        move || cx.emit(SheetEvent::Open),
        move || cx.emit(SheetEvent::Close),
    );
    when(motion.shown, move || {
        // Placed in a toolbar, its content is still no part of it.
        leave_bar();
        // The backdrop and the panel, bound to the translation and fade of
        // a sheet with detents or without: whether it has some changes
        // which, and makes them again.
        let layers = move |translate: AnimatedNode,
                           fade: AnimatedNode,
                           footer_stop: Option<AnimatedValue>| {
            let backdrop = overlay()
                .inset_0()
                .bind_opacity(&fade)
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
                // What reaches the bottom of the screen ends above the
                // keyboard. A bottom sheet the keyboard lifts stays below the
                // status bar; otherwise its height is the app's (a web sheet's
                // presented surface may be taller than the window), or its
                // largest detent's.
                .style_with(move |s| {
                    // The same on every platform: the modal root the sheet
                    // owns keeps the window's whole height (Android's too,
                    // since #3154), and the panel stands on the keyboard.
                    let lift = keyboard_lift();
                    let above = Length::from(lift);
                    let s = match props.side.get() {
                        Placement::Bottom if lift > Points::ZERO => s
                            .left_0()
                            .right_0()
                            .bottom(above)
                            .max_h(bottom_panel_max_height()),
                        Placement::Bottom => s.left_0().right_0().bottom(above),
                        Placement::Top => s.left_0().right_0().top_0(),
                        Placement::Left => s.top_0().bottom(above).left_0(),
                        Placement::Right => s.top_0().bottom(above).right_0(),
                    };
                    match detents.largest() {
                        Some(largest) => s.h(largest),
                        None => s,
                    }
                })
                .app_class(props.popup_class)
                // The app's height gives way to the room above the keyboard
                // while it lifts the panel (`maxHeight: "92%"` would put its
                // top under the status bar), and comes back with it down.
                .inline_style(move || {
                    let style = props.popup_style.get();
                    let lift = keyboard_lift();
                    if props.side.get() != Placement::Bottom || lift <= Points::ZERO {
                        return style;
                    }
                    let screen = window().height;
                    style.max_height_at_most(screen - safe_area().top - lift, screen)
                })
                // Standing on the keyboard already, what the app pads by
                // `env(keyboard-inset-height)` in it reads 0: one sheet
                // works on every platform, and is never lifted twice.
                .clears_keyboard(move || props.side.get() != Placement::Top)
                .bind_translate_x(&motion.x)
                .on_layout(move |frame: &Bounds<Points>| {
                    panel_height.replace(frame.size.height.max(Points(1.0)));
                    height.set(frame.size.height.0.max(1.0));
                    detents.laid_out(frame.size.height);
                    motion.laid_out(frame.size);
                })
                .child(when(move || props.grabber.get(), move || detents.grabber()))
                .child(props.children)
                .child(when(
                    move || props.footer.with(Option::is_some),
                    move || {
                        // At the bottom of the panel however tall the
                        // content is; the app's style may place it
                        // otherwise.
                        let footer = view()
                            .mt(auto())
                            .flex_shrink_0()
                            .app_class(props.footer_class)
                            .inline_style(props.footer_style)
                            .child(props.footer.place(|c| c));
                        match footer_stop {
                            Some(stop) => footer.bind_translate_y(&detents.footer_lift(stop)),
                            None => footer,
                        }
                    },
                ));
            panel = panel
                .pan_values(None, Some(&motion.drag_y))
                .pan_enabled(move || draggable() && open.get() && motion.settled.get())
                .pan_scroll_handoff(draggable)
                // At the start, as a stack's back swipe (#430): the keyboard
                // would cover the panel the finger is moving.
                .on_pan_start(move |_: &PanEvent| {
                    detents.grab();
                    dismiss_keyboard();
                })
                .on_pan_end(move |e: &PanEvent| {
                    if !open.get_untracked() {
                        detents.let_go();
                        return;
                    }
                    if detents.active_untracked() {
                        if detents.release(e, props.close_on_swipe.get_untracked()) {
                            cx.emit(SheetEvent::Cancel);
                            change(false, OpenChangeReason::Swipe);
                            detents.back_unless_closed(open);
                        }
                        return;
                    }
                    detents.let_go();
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
            panel = panel.bind_translate_y(&translate);
            vec![backdrop.into_element(), panel.into_element()]
        };
        let layers = when(
            move || detents.active(),
            move || {
                let (translate, fade, footer_stop) = detents.graph(height, swipe_enabled, swipe);
                layers(translate, fade, Some(footer_stop))
            },
        )
        .otherwise(move || layers(dragged_y, dragged_fade, None));
        // A dialog's modal root around both, with no motion or closing of
        // its own: the sheet's are `SheetMotion`'s and its props'. It keeps
        // screen readers and the keyboard focus to the sheet as a dialog
        // does; on the web it is also a separately sized surface, which
        // the player's host can present over the viewport, including
        // outside an iframe. On Android it reaches under the status bar,
        // as the root view's overlays did: the backdrop covers the whole
        // screen and a top or side panel starts at its top edge, padded by
        // the safe area the app reads.
        vec![
            crate::dialog()
                .optional_label(props.accessibility_label)
                .status_bar_translucent(true)
                .animation(nsh_core::ModalAnimation::None)
                .close_on_escape(false)
                .close_on_swipe(false)
                .on_cancel(move || {
                    cx.emit(SheetEvent::Cancel);
                    if props.close_on_escape.get_untracked() {
                        change(false, OpenChangeReason::Cancel);
                    }
                })
                .child(layers)
                .into_element(),
        ]
    })
}

/// A bottom sheet's detents: their heights and which one it rests at,
/// the translation and fade the panel and the backdrop take with them,
/// and where a drag ends.
#[derive(Clone, Copy)]
struct Detents {
    list: Prop<Vec<SheetDetent>>,
    detent: Prop<Option<SheetDetent>>,
    grabber_class: Prop<Option<SharedString>>,
    grabber_style: Prop<Style>,
    grabber_content: Prop<Option<Slot>>,
    grabber_label: Prop<Option<SharedString>>,
    cx: Scope<SheetEvent>,
    motion: SheetMotion,
    /// Its own detent, while `detent` is not set.
    own: Signal<Option<SheetDetent>>,
    /// Each detent's height, in the order of `detents` (none: no detents,
    /// or not at the bottom).
    heights: Memo<Vec<Points>>,
    /// The panel's height as last laid out.
    laid: Signal<Points>,
    /// The index of the detent it rests at.
    current: Memo<Option<usize>>,
    /// The index of the detent it stands at: the largest while the
    /// software keyboard is up (as UIKit's sheets do, so what is typed in
    /// shows), else `current`.
    resting: Memo<Option<usize>>,
    /// Where it was sent last (`None` once a finger took it).
    aimed: Stored<Option<f32>>,
    /// A finger moves it.
    dragging: Stored<bool>,
    owner: Owner,
}

impl Detents {
    fn new(props: &SheetProps, cx: Scope<SheetEvent>, motion: SheetMotion) -> Self {
        let (side, list, detent) = (props.side, props.detents, props.detent);
        let heights = computed(move || {
            if side.get() != Placement::Bottom {
                return Vec::new();
            }
            let screen = window().height;
            let room = screen - safe_area().top;
            list.get()
                .iter()
                .map(|&d| detent_height(d, room, screen))
                .collect()
        });
        let own = signal(props.default_detent.get_untracked());
        let current = computed(move || {
            let heights = heights.get();
            if heights.is_empty() {
                return None;
            }
            let value = detent.get().or_else(|| own.get());
            value
                .and_then(|value| list.with(|d| d.iter().position(|&d| d == value)))
                .filter(|&i| i < heights.len())
                .or_else(|| {
                    heights
                        .iter()
                        .enumerate()
                        .min_by(|a, b| a.1.0.total_cmp(&b.1.0))
                        .map(|(i, _)| i)
                })
        });
        let resting = computed(move || {
            if keyboard_lift() > Points::ZERO {
                heights.with(|h| {
                    h.iter()
                        .enumerate()
                        .max_by(|a, b| a.1.0.total_cmp(&b.1.0))
                        .map(|(i, _)| i)
                })
            } else {
                current.get()
            }
        });
        Self {
            list,
            detent,
            grabber_class: props.grabber_class,
            grabber_style: props.grabber_style,
            grabber_content: props.grabber_content,
            grabber_label: props.grabber_accessibility_label,
            cx,
            motion,
            own,
            heights,
            laid: signal(Points::ZERO),
            current,
            resting,
            aimed: stored(None),
            dragging: stored(false),
            owner: Owner::current(),
        }
    }

    /// The sheet has detents (tracked).
    fn active(self) -> bool {
        self.heights.with(|h| !h.is_empty())
    }

    fn active_untracked(self) -> bool {
        untracked(|| self.active())
    }

    /// A drag moves between detents (tracked).
    fn draggable(self) -> bool {
        self.heights.with(|h| h.len() >= 2)
    }

    /// The panel's height: its largest detent's (tracked).
    fn largest(self) -> Option<Points> {
        self.heights
            .with(|h| h.iter().copied().max_by(|a, b| a.0.total_cmp(&b.0)))
    }

    /// Each detent's distance below the panel's top, in the order of
    /// `detents`.
    fn offsets(self, laid: Points, heights: &[Points]) -> Vec<f32> {
        heights.iter().map(|h| (laid.0 - h.0).max(0.0)).collect()
    }

    /// Where the panel rests now, below its top.
    fn target_untracked(self) -> Option<f32> {
        untracked(|| {
            let i = self.resting.get()?;
            let heights = self.heights.get();
            Some((self.laid.get().0 - heights.get(i)?.0).max(0.0))
        })
    }

    /// Where the panel's translation stops a drag (the smallest detent's
    /// place, or the bottom of the panel where a drag may close it,
    /// `can_close`), where the backdrop starts to fade (the smallest
    /// detent's place) and over how far, and how far the footer follows
    /// the panel down: to the smallest detent's place, or all the way
    /// while the keyboard is up, so the footer stays above it as the
    /// panel rises (a drag, which may close it, takes the keyboard down
    /// first).
    fn shape(self, can_close: bool) -> (f32, f32, f32, f32) {
        let (heights, laid) = (self.heights.get(), self.laid.get());
        let height = laid.0.max(1.0);
        let lowest = self.offsets(laid, &heights).into_iter().fold(0.0, f32::max);
        let limit = if can_close { height } else { lowest.max(0.01) };
        let footer = if keyboard_lift() > Points::ZERO {
            height
        } else {
            lowest
        };
        (limit, lowest, (height - lowest).max(1.0), footer)
    }

    /// The panel's translation and the backdrop's opacity with detents,
    /// made with the layers that show them (and gone with them), so a
    /// sheet without detents makes none of these nodes. `drag_y` is where
    /// the panel stands below its top, kept between the largest detent and
    /// the smallest (or the bottom of the panel, where it may close); the
    /// entrance and exit move the panel between there and out of sight,
    /// and the backdrop fades below the smallest detent only. With them,
    /// the value the footer stops following the panel at (`footer_lift`).
    fn graph(
        self,
        height: AnimatedValue,
        swipe_enabled: AnimatedValue,
        swipe: impl Fn() -> bool + 'static,
    ) -> (AnimatedNode, AnimatedNode, AnimatedValue) {
        let close = untracked(&swipe);
        let shape = untracked(|| self.shape(close));
        let limit = animated_value(shape.0);
        let fade_from = animated_value(shape.1);
        let fade_span = animated_value(shape.2);
        let footer_stop = animated_value(shape.3);
        let set = stored(shape);
        effect(move || {
            if !self.active() {
                // Going with the layers.
                return;
            }
            let shape = self.shape(swipe());
            if set.replace(shape) != shape {
                limit.set(shape.0);
                fade_from.set(shape.1);
                fade_span.set(shape.2);
                footer_stop.set(shape.3);
            }
        });
        let motion = self.motion;
        let held_y = motion
            .drag_y
            .div(&limit)
            .interpolate(&[0.0, 1.0], &[0.0, 1.0])
            .mul(&limit);
        let translate = height
            .mul(&motion.fade.interpolate(&[0.0, 1.0], &[1.0, 0.0]))
            .add(&held_y.mul(&motion.fade));
        let fade = motion
            .fade
            .sub(
                &motion
                    .drag_y
                    .sub(&fade_from)
                    .div(&fade_span)
                    .interpolate(&[0.0, 1.0], &[0.0, 1.0])
                    .mul(&swipe_enabled),
            )
            .interpolate(&[0.0, 1.0], &[0.0, 1.0]);
        (translate, fade, footer_stop)
    }

    /// How far the footer moves up from the bottom of the panel to the
    /// bottom of what shows of it: the panel's distance below its top, up
    /// to `stop` (the smallest detent's place: below it the footer goes
    /// with the panel), as far as it came in.
    fn footer_lift(self, stop: AnimatedValue) -> AnimatedNode {
        let motion = self.motion;
        motion
            .drag_y
            .div(&stop)
            .interpolate(&[0.0, 1.0], &[0.0, 1.0])
            .mul(&stop)
            .mul(&motion.fade)
            .mul(-1.0)
    }

    /// Keeps the motion to the detents and the panel's height: where it
    /// rests and whether it holds that place as it goes; sends the panel
    /// to a detent the app or a layout changed, and back to where a sheet
    /// without detents rests once they went.
    fn follow(self, open: OpenState) {
        effect(move || {
            let _ = self.resting.get();
            let active = self.active();
            let _ = self.laid.get();
            let settled = self.motion.settled.get();
            untracked(|| {
                self.motion.hold_drag(active);
                let target = self.target_untracked();
                self.motion.rest_at(target.unwrap_or(0.0));
                if !settled || !open.get_untracked() {
                    return;
                }
                if target.is_some() {
                    self.place();
                } else if self.aimed.replace(None).is_some_and(|y| y != 0.0) {
                    // The detents went while it rested lower: back to
                    // where a sheet without them rests.
                    self.motion.come_in();
                }
            });
        });
    }

    /// The panel was laid out `height` tall: where it comes in to.
    fn laid_out(self, height: Points) {
        if self.laid.get_untracked() != height {
            self.laid.set(height);
        }
        let target = self.target_untracked();
        self.motion.rest_at(target.unwrap_or(0.0));
    }

    /// Sends the panel to the detent it rests at, unless a finger has it
    /// or it is on its way there.
    fn place(self) {
        if self.dragging.get() {
            return;
        }
        if let Some(y) = self.target_untracked()
            && self.aimed.get() != Some(y)
        {
            self.go_to(y, None);
        }
    }

    fn go_to(self, y: f32, velocity: Option<f32>) {
        self.aimed.replace(Some(y));
        if reduce_motion() {
            self.motion.drag_y.set(y);
            return;
        }
        let mut spring = Spring::new(DETENT_SPRING_MS).damping_ratio(DETENT_DAMPING);
        spring.velocity = velocity;
        self.motion.drag_y.spring(y, spring);
    }

    /// A close the user asked for: a controlled sheet the app keeps open
    /// goes back to its detent once the app answered, and stays where the
    /// finger left it until then (going back first would lift a sheet
    /// that then closes).
    fn back_unless_closed(self, open: OpenState) {
        self.owner.run(|| {
            after_answer(move || {
                if open.get_untracked() {
                    self.place();
                }
            })
        });
    }

    /// A finger took the panel.
    fn grab(self) {
        self.dragging.replace(true);
        self.aimed.replace(None);
    }

    fn let_go(self) {
        self.dragging.replace(false);
    }

    /// The finger let go of the panel at `e`: it goes to a detent, or
    /// `true` when it closes (`can_close`).
    fn release(self, e: &PanEvent, can_close: bool) -> bool {
        self.let_go();
        let (heights, current, laid) =
            untracked(|| (self.heights.get(), self.current.get(), self.laid.get()));
        let Some(current) = current else { return false };
        let offsets = self.offsets(laid, &heights);
        let rest = offsets[current];
        let at = e.value_y.unwrap_or(rest);
        // A drag a scroll view kept moved nothing: no flick of its own.
        if e.cancelled || (at - rest).abs() < 0.5 {
            self.aimed.replace(None);
            self.place();
            return false;
        }
        let mut order: Vec<usize> = (0..offsets.len()).collect();
        order.sort_by(|&a, &b| offsets[a].total_cmp(&offsets[b]));
        let sorted: Vec<f32> = order.iter().map(|&i| offsets[i]).collect();
        match settle(&sorted, laid.0.max(1.0), at, e.velocity_y, can_close) {
            None => true,
            Some(k) => {
                let next = order[k];
                self.go_to(offsets[next], Some(e.velocity_y));
                if next != current {
                    self.request(next);
                }
                false
            }
        }
    }

    /// The user moved it to detent `index`.
    fn request(self, index: usize) {
        let Some(next) = self.list.with_untracked(|d| d.get(index).copied()) else {
            return;
        };
        self.cx.emit(SheetEvent::DetentChange(next));
        if self.detent.get_untracked().is_none() {
            self.own.set(Some(next));
        } else {
            // The app may keep its value: the panel goes back to it.
            self.owner.run(|| after_answer(move || self.place()));
        }
    }

    /// The detents from the smallest up, and the place of the current one
    /// among them.
    fn ladder(self) -> (Vec<usize>, Option<usize>) {
        untracked(|| {
            let heights = self.heights.get();
            let mut order: Vec<usize> = (0..heights.len()).collect();
            order.sort_by(|&a, &b| heights[a].0.total_cmp(&heights[b].0));
            let at = self
                .current
                .get()
                .and_then(|c| order.iter().position(|&i| i == c));
            (order, at)
        })
    }

    /// The grabber moves it `by` detents up (larger) or down, within them.
    fn step(self, by: isize) {
        let (order, Some(at)) = self.ladder() else {
            return;
        };
        let to = (at as isize + by).clamp(0, order.len() as isize - 1) as usize;
        if to != at {
            self.request(order[to]);
            self.place();
        }
    }

    /// A press on the grabber: the next larger detent, after the largest
    /// the smallest.
    fn cycle(self) {
        let (order, Some(at)) = self.ladder() else {
            return;
        };
        if order.len() < 2 {
            return;
        }
        self.request(order[(at + 1) % order.len()]);
        self.place();
    }

    /// The grabber: the app's look, a handle screen readers adjust.
    fn grabber(self) -> impl IntoElement {
        view()
            .app_class(self.grabber_class)
            .inline_style(self.grabber_style)
            .accessible(true)
            .role(AccessibilityRole::Adjustable)
            .optional_label(self.grabber_label)
            .accessibility_value(move || {
                let count = self.heights.with(Vec::len);
                if count < 2 {
                    return None;
                }
                let (_, at) = self.ladder();
                let _ = self.current.get();
                Some(AccessibilityValue {
                    min: Some(0.0),
                    max: Some((count - 1) as f32),
                    now: at.map(|at| at as f32),
                    text: None,
                })
            })
            .accessibility_actions(vec![action("increment"), action("decrement")])
            .on_accessibility_action(move |name: &str| match name {
                "increment" => self.step(1),
                "decrement" => self.step(-1),
                _ => {}
            })
            .on_press(move || self.cycle())
            .child(self.grabber_content.place(|content| content))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Large at 0, medium 422 below it, on an 844-point panel.
    const OFFSETS: [f32; 2] = [0.0, 422.0];

    #[test]
    fn a_slow_release_goes_to_the_nearest_detent() {
        assert_eq!(settle(&OFFSETS, 844.0, 150.0, 0.0, false), Some(0));
        assert_eq!(settle(&OFFSETS, 844.0, 300.0, 100.0, false), Some(1));
        assert_eq!(settle(&OFFSETS, 844.0, 300.0, -400.0, false), Some(1));
    }

    #[test]
    fn a_flick_goes_on_to_the_next_detent_its_way() {
        assert_eq!(settle(&OFFSETS, 844.0, 380.0, -600.0, false), Some(0));
        assert_eq!(settle(&OFFSETS, 844.0, 40.0, 600.0, false), Some(1));
        // Past the last one its way, it stays at the last.
        assert_eq!(settle(&OFFSETS, 844.0, 500.0, 600.0, false), Some(1));
        assert_eq!(settle(&OFFSETS, 844.0, -20.0, -600.0, false), Some(0));
    }

    #[test]
    fn past_the_smallest_it_closes_when_allowed() {
        // 30% of the smallest detent's 422 points, or 800 points a second.
        assert_eq!(settle(&OFFSETS, 844.0, 560.0, 0.0, true), None);
        assert_eq!(settle(&OFFSETS, 844.0, 440.0, 900.0, true), None);
        assert_eq!(settle(&OFFSETS, 844.0, 440.0, 0.0, true), Some(1));
        assert_eq!(settle(&OFFSETS, 844.0, 560.0, 0.0, false), Some(1));
        // A fast drag from the largest goes to the next detent first.
        assert_eq!(settle(&OFFSETS, 844.0, 200.0, 1500.0, true), Some(1));
    }

    #[test]
    fn detents_resolve_within_the_room_below_the_status_bar() {
        let (room, screen) = (Points(797.0), Points(844.0));
        assert_eq!(
            detent_height(SheetDetent::Medium, room, screen),
            Points(422.0)
        );
        assert_eq!(detent_height(SheetDetent::Large, room, screen), room);
        assert_eq!(
            detent_height(SheetDetent::Height(Points(900.0)), room, screen),
            room
        );
        assert_eq!(
            detent_height(SheetDetent::Fraction(Percentage(0.5)), room, screen),
            Points(398.5)
        );
    }
}
