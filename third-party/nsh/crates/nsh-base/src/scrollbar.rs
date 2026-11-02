//! `Scrollbar`: a scroll bar of the app's own look over a scroll view or a
//! list it names, placed by the app like any other view (`gpui-base`'s
//! `scrollbar.rs`, `Scrollbar::new(&scroll_handle)`).
//!
//! The bar watches its target (`watch_scroll`): the platforms report every
//! scroll view's offset and the core lays out its content, so the thumb's
//! length and place follow the content, the viewport and the offset, also
//! while a list grows or the window resizes. Dragging the thumb, or
//! pressing the track, scrolls the target (`ScrollTo` commands). The
//! target's own indicator is the app's to turn off (`scrollbar={false}`).

use std::time::Duration;

use nsh_core::{
    NodeId,
    element::{
        AnyValue, BuiltInScrollbar, ElementRef, JsHost, JsIn, JsOwned, JsValue, ModuleCx, NodeRef,
        PropError, ScrollEvent, Style, TsTypes, from_json, set_builtin_scrollbars,
    },
    geometry::{Along, Axis},
    prelude::*,
    time::{Instant, now},
};

/// What a [`Scrollbar`] moves: a scroll view or a list (TS: its `ref`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum ScrollbarTarget {
    /// None yet: the bar shows nothing.
    #[default]
    None,
    /// The element a Rust view's ref is on, found when it is mounted.
    Ref(ElementRef),
    /// A node JS passes (a `ref`).
    Node(NodeRef),
}

impl ScrollbarTarget {
    /// Its node, while one is mounted.
    pub fn node(&self) -> Option<NodeId> {
        match self {
            Self::None => None,
            Self::Ref(r) => r.node(),
            Self::Node(n) => Some(n.0),
        }
    }
}

impl From<ElementRef> for ScrollbarTarget {
    fn from(r: ElementRef) -> Self {
        Self::Ref(r)
    }
}

impl From<&ElementRef> for ScrollbarTarget {
    fn from(r: &ElementRef) -> Self {
        Self::Ref(*r)
    }
}

impl From<NodeRef> for ScrollbarTarget {
    fn from(n: NodeRef) -> Self {
        Self::Node(n)
    }
}

impl JsValue for ScrollbarTarget {
    fn ts_type(types: &mut TsTypes) -> String {
        NodeRef::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Ok(Option::<NodeRef>::from_js(value)?.map_or(Self::None, Self::Node))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self.node() {
            Some(node) => NodeRef(node).to_js(host),
            None => Option::<NodeRef>::None.to_js(host),
        }
    }
}

/// When a [`Scrollbar`] shows (`gpui-base`'s `ScrollbarMode`). A drag of
/// its thumb keeps it shown in every mode; it never shows while the content
/// fits the viewport.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum ScrollbarMode {
    /// While the target scrolls, until `motion.idle` after it stops; the
    /// pointer on the bar while it shows keeps it.
    #[default]
    Scrolling,
    /// While the pointer is over the bar (where it shows), and as
    /// `scrolling`.
    Hover,
    /// Always.
    Always,
}

/// How a [`Scrollbar`] comes in (`gpui-base`'s `ScrollbarEntrance`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum ScrollbarEntrance {
    /// Fades in without moving.
    #[default]
    Fade,
    /// Slides in from the edge it is on (a vertical bar from the right, a
    /// horizontal one from the bottom) while it fades.
    SlideAndFade,
}

/// How a [`Scrollbar`] shows and hides (`gpui-base`'s `ScrollbarMotion`):
/// its fades run natively. The durations are milliseconds; `enter` and
/// `exit` default to zero, so the bar snaps in and out: the timing is the
/// app's. An `always` bar, or one while the user asks for less motion,
/// never animates. A reversed fade keeps its speed: it runs for the share
/// of its duration still to cover. The thumb's width on hover is the
/// thumb's own style, and so is its motion (`transition-all`).
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
#[non_exhaustive]
pub struct ScrollbarMotion {
    /// How long the bar stays after the last scroll, drag or hover
    /// (default `2000`).
    #[prop(default = 2000.0)]
    pub idle: f64,
    /// How long it takes to appear (default `0`): its opacity rises
    /// linearly, a slide eases out (cubic).
    #[prop(default)]
    pub enter: f64,
    /// How long it takes to fade away once `idle` is over (default `0`),
    /// easing in (cubic).
    #[prop(default)]
    pub exit: f64,
    /// How it comes in (default `"fade"`).
    #[prop(default)]
    pub entrance: ScrollbarEntrance,
    /// How it comes in when the pointer on its hidden thumb shows it (the
    /// `hover` mode; default `"fade"`).
    #[prop(default)]
    pub thumb_hover_entrance: ScrollbarEntrance,
}

impl Default for ScrollbarMotion {
    fn default() -> Self {
        Self {
            idle: 2000.0,
            enter: 0.0,
            exit: 0.0,
            entrance: ScrollbarEntrance::Fade,
            thumb_hover_entrance: ScrollbarEntrance::Fade,
        }
    }
}

/// The props of [`Scrollbar`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ScrollbarProps {
    /// The scroll view or list it follows and moves (TS: its `ref`; a
    /// Rust view's [`ElementRef`]). Read in every commit, so a ref set
    /// later in the same render is found once its element is mounted.
    #[prop(default)]
    pub scroll: Prop<ScrollbarTarget>,
    /// The axis of the target (default `"vertical"`): the bar's track
    /// runs along it. Read when the bar is made.
    #[prop(default = Axis::Vertical)]
    pub axis: Prop<Axis>,
    /// When it shows (default `"scrolling"`).
    #[prop(default)]
    pub mode: Prop<ScrollbarMode>,
    /// How it shows and hides: how long it stays, its fades.
    #[prop(default)]
    pub motion: Prop<ScrollbarMotion>,
    /// The shortest the thumb gets on a long content (default `48`), so it
    /// stays easy to grab.
    #[prop(default = px(48.0))]
    pub min_thumb_length: Prop<Points>,
    /// The Tailwind classes of the thumb, inside the track's padding and
    /// sized along the axis by the bar (`w-full rounded-full
    /// bg-foreground/30`); `hover:` under the pointer, `active:` while it
    /// is dragged.
    pub thumb_class: Prop<Option<SharedString>>,
    /// The style of the thumb, over `thumbClass`.
    #[prop(default)]
    pub thumb_style: Prop<Style>,
    /// What screen readers say of the bar.
    pub accessibility_label: Prop<Option<SharedString>>,
}

/// A thumb's drag, from the grant to the release.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Drag {
    /// The target's offset along the axis when it started.
    from: f32,
}

/// The bar's fade toward shown (`1`) or hidden (`0`), as `gpui-base`'s
/// `VisibilityAnimation`: the bar samples it to start a reversed fade
/// where the native one is.
#[derive(Debug, Clone, Copy)]
struct Fade {
    opacity: f32,
    position: f32,
    target: f32,
    entrance: ScrollbarEntrance,
    start: Instant,
    /// Milliseconds.
    duration: f32,
}

impl Fade {
    fn settled(target: f32) -> Self {
        Self {
            opacity: target,
            position: target,
            target,
            entrance: ScrollbarEntrance::Fade,
            start: now(),
            duration: 0.0,
        }
    }

    /// The opacity and the slide's progress now.
    fn sample(&self) -> (f32, f32) {
        let elapsed = now().saturating_duration_since(self.start).as_secs_f32() * 1000.0;
        let t = if self.duration > 0.0 {
            (elapsed / self.duration).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let entering = self.target > self.opacity || self.target > self.position;
        let ease_in = t * t * t;
        let (fade, slide) = if entering {
            (t, 1.0 - (1.0 - t).powi(3))
        } else {
            (ease_in, ease_in)
        };
        (
            self.opacity + (self.target - self.opacity) * fade,
            self.position + (self.target - self.position) * slide,
        )
    }
}

/// What the bar's parts and listeners share.
#[derive(Clone, Copy)]
struct Ctl {
    scroll: Prop<ScrollbarTarget>,
    axis: Axis,
    mode: Prop<ScrollbarMode>,
    motion: Prop<ScrollbarMotion>,
    min_thumb: Prop<Points>,
    /// What the target reported last.
    metrics: Signal<Option<ScrollEvent>>,
    /// The rail's length along the axis: the track's content box.
    rail: Signal<f32>,
    /// Where the rail starts in the track.
    rail_origin: Stored<Point<Points>>,
    /// The target scrolled, or the pointer came or went, a moment ago
    /// (until `motion.idle` after).
    active: Signal<bool>,
    /// The pointer is over the track.
    over_track: Signal<bool>,
    /// The pointer is over the thumb.
    over_thumb: Signal<bool>,
    drag: Signal<Option<Drag>>,
    /// When the bar hides, unless activity comes first: one timer runs at a
    /// time and waits again while activity has moved this on (scrolling
    /// reports every frame).
    deadline: Stored<Option<Instant>>,
    /// The bar's opacity, bound natively.
    opacity: AnimatedValue,
    /// The slide's progress (`1`: in place), bound natively.
    position: AnimatedValue,
    fade: Stored<Fade>,
}

impl Ctl {
    fn node(self) -> Option<NodeId> {
        self.scroll.get_untracked().node()
    }

    /// The viewport, the content and the offset along the axis (tracked).
    fn along(self) -> Option<(f32, f32, f32)> {
        let m = self.metrics.get()?;
        Some((
            m.size.along(self.axis).0,
            m.content_size.along(self.axis).0,
            m.offset.along(self.axis).0,
        ))
    }

    /// How far the target scrolls along the axis (tracked).
    fn range(self) -> f32 {
        self.along()
            .map_or(0.0, |(view, content, _)| (content - view).max(0.0))
    }

    /// The content overflows the viewport (tracked), by more than a point:
    /// a text view laying out its text as it grows may report it a pixel
    /// taller than itself (GTK's), which is not content to scroll to.
    fn scrolls(self) -> bool {
        self.range() > 1.0
    }

    /// The thumb's length (tracked).
    fn thumb(self) -> f32 {
        let rail = self.rail.get();
        let Some((view, content, _)) = self.along() else {
            return rail;
        };
        let min = self.min_thumb.get().0.min(rail);
        (rail * view / content.max(1.0)).clamp(min, rail)
    }

    /// Where the thumb starts along the rail (tracked): the offset, held
    /// to the content, so overscrolls leave it at an end.
    fn position(self) -> f32 {
        let range = self.range();
        let Some((_, _, offset)) = self.along() else {
            return 0.0;
        };
        if range <= 0.0 {
            return 0.0;
        }
        (self.rail.get() - self.thumb()).max(0.0) * (offset / range).clamp(0.0, 1.0)
    }

    /// The target's offset that puts the thumb at `position` on the rail.
    fn offset_at(self, position: f32) -> f32 {
        untracked(|| {
            let travel = (self.rail.get() - self.thumb()).max(0.0);
            if travel <= 0.0 {
                return 0.0;
            }
            (position / travel).clamp(0.0, 1.0) * self.range()
        })
    }

    /// Scrolls the target to `offset` along the axis.
    fn scroll_to(self, offset: f32) {
        let Some(node) = self.node() else { return };
        let Some(now) = self.metrics.get_untracked() else {
            return;
        };
        let mut to = now.offset;
        match self.axis {
            Axis::Horizontal => to.x = px(offset),
            Axis::Vertical => to.y = px(offset),
        }
        NodeRef(node).scroll_to(to, false);
        // The thumb moves in the same batch as the command, not when the
        // platform reports the scroll (a frame or two later, which lags
        // behind the pointer).
        self.metrics.set(Some(ScrollEvent { offset: to, ..now }));
    }

    /// Something kept the bar shown: it hides `motion.idle` after the last.
    fn touch(self) {
        if !self.active.get_untracked() {
            self.active.set(true);
        }
        let idle = self.motion.get_untracked().idle.max(0.0);
        let delay = Duration::from_secs_f64(idle / 1000.0);
        if self.deadline.replace(Some(now() + delay)).is_none() {
            self.hide_after(delay);
        }
    }

    /// Hides the bar at the deadline, waiting again while it moved on.
    fn hide_after(self, delay: Duration) {
        set_timeout(delay, move || {
            let Some(deadline) = self.deadline.get() else {
                return;
            };
            let left = deadline.saturating_duration_since(now());
            if left.is_zero() {
                self.deadline.replace(None);
                self.active.set(false);
            } else {
                self.hide_after(left);
            }
        });
    }

    /// The bar shows (tracked), as `gpui-base` decides: always, while
    /// dragged, while the pointer is on it in the `hover` mode (or in the
    /// `scrolling` mode once it shows), or until `idle` after the last
    /// activity.
    fn shown(self) -> bool {
        if !self.scrolls() {
            return false;
        }
        // The pointer reaches a hidden bar only where hover shows it
        // (`pointer_events` below).
        self.mode.get() == ScrollbarMode::Always
            || self.drag.get().is_some()
            || self.over_track.get()
            || self.active.get()
    }

    /// Fades the bar toward `visible`, from where its fade is.
    fn fade_to(self, visible: bool, first: bool) {
        let target = if visible { 1.0 } else { 0.0 };
        let motion = self.motion.get_untracked();
        let mode = self.mode.get_untracked();
        let entrance = if mode == ScrollbarMode::Hover && self.over_thumb.get_untracked() {
            motion.thumb_hover_entrance
        } else {
            motion.entrance
        };
        let full = if first || mode == ScrollbarMode::Always || reduce_motion() {
            0.0
        } else if visible {
            motion.enter
        } else {
            motion.exit
        } as f32;
        let fade = self.fade.get();
        if full <= 0.0 {
            self.opacity.set(target);
            self.position.set(target);
            self.fade.replace(Fade::settled(target));
            return;
        }
        if fade.target == target && fade.entrance == entrance {
            return;
        }
        let (opacity, position) = fade.sample();
        let from = if visible && entrance == ScrollbarEntrance::Fade {
            1.0
        } else {
            position
        };
        if from != position {
            self.position.set(from);
        }
        let distance = (target - opacity).abs().max((target - from).abs());
        let duration = full * distance;
        let (fade_easing, slide_easing) = if visible {
            (Easing::Linear, Easing::Curve(Curve::Cubic, EaseMode::Out))
        } else {
            let ease_in = Easing::Curve(Curve::Cubic, EaseMode::In);
            (ease_in, ease_in)
        };
        drop(self.opacity.timing(target, duration, fade_easing));
        drop(self.position.timing(target, duration, slide_easing));
        self.fade.replace(Fade {
            opacity,
            position: from,
            target,
            entrance,
            start: now(),
            duration,
        });
    }

    /// The pointer came onto the track or left it.
    fn hover_track(self, over: bool) {
        self.over_track.set(over);
        self.touch();
    }

    /// A press on the track at `at` (in the track): the thumb's middle
    /// jumps there, and a drag goes on from there.
    fn press_track(self, at: Point<Points>) {
        let along = at.along(self.axis).0 - self.rail_origin.get().along(self.axis).0;
        let thumb = untracked(|| self.thumb());
        let offset = self.offset_at(along - thumb / 2.0);
        self.drag.set(Some(Drag { from: offset }));
        self.scroll_to(offset);
    }

    /// A press on the thumb: a drag moves it by the pointer's offset.
    fn press_thumb(self) {
        let from = untracked(|| self.along()).map_or(0.0, |(_, _, o)| o);
        self.drag.set(Some(Drag {
            from: from.clamp(0.0, untracked(|| self.range())),
        }));
    }

    /// The drag moved `delta` points along the axis.
    fn drag_by(self, delta: f32) {
        let Some(drag) = self.drag.get_untracked() else {
            return;
        };
        let (travel, range) =
            untracked(|| ((self.rail.get() - self.thumb()).max(0.0), self.range()));
        if travel <= 0.0 {
            return;
        }
        let offset = (drag.from + delta * range / travel).clamp(0.0, range);
        self.scroll_to(offset);
    }

    fn release(self) {
        if self.drag.get_untracked().is_some() {
            self.drag.set(None);
            self.touch();
        }
    }
}

/// A scroll bar of the app's own look for a scroll view or a list it
/// names (`scroll`), placed by the app like any other view: over the
/// target's edge, beside a fixed header, along two panes. It owns its
/// behavior, as `gpui-base`'s does (the thumb's length and place follow the
/// target's content, viewport and offset; dragging the thumb or pressing
/// the track scrolls the target; when it shows, by `mode`, and how it fades,
/// by `motion`) and leaves its look to the app: no colors, sizes or radii
/// of its own. The app's `class` and `style` style the bar, its track:
/// placed by the app (`absolute inset-y-0 right-0 w-4 p-1`), the area that
/// takes presses (a press scrolls the target to that point and a drag goes
/// on from there), a `group` for the thumb's `group-hover:`; its opacity is
/// the bar's (hidden, it takes no presses). `thumbClass` / `thumbStyle`
/// style the thumb, inside the track's padding and sized along the axis by
/// the bar. Turn the target's own indicator off with `scrollbar={false}`.
#[component]
pub fn Scrollbar(props: ScrollbarProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let ctl = Ctl {
        scroll: props.scroll,
        axis: props.axis.get_untracked(),
        mode: props.mode,
        motion: props.motion,
        min_thumb: props.min_thumb_length,
        metrics: signal(None),
        rail: signal(0.0),
        rail_origin: stored(Point::default()),
        active: signal(false),
        over_track: signal(false),
        over_thumb: signal(false),
        drag: signal(None),
        deadline: stored(None),
        opacity: animated_value(0.0),
        position: animated_value(0.0),
        fade: stored(Fade::settled(0.0)),
    };
    let target = move || ctl.node();
    watch_scroll(target, move |e: &ScrollEvent| {
        let before = ctl.metrics.get_untracked();
        let mut e = *e;
        // While a drag scrolls the target, the thumb stays where the drag
        // put it: the platform's reports of the commands before trail it.
        if let Some(b) = before.filter(|_| ctl.drag.get_untracked().is_some()) {
            match ctl.axis {
                Axis::Horizontal => e.offset.x = b.offset.x,
                Axis::Vertical => e.offset.y = b.offset.y,
            }
        }
        ctl.metrics.set(Some(e));
        // A move (not the first report, nor a resize) shows the bar.
        if before.is_some_and(|b| b.offset != e.offset) {
            ctl.touch();
        }
    });
    let shown = computed(move || ctl.shown());
    let first = std::cell::Cell::new(true);
    effect(move || {
        let visible = shown.get();
        ctl.fade_to(visible, first.replace(false));
    });
    // A hidden bar follows the pointer where it can show on hover (a
    // mouse in the `hover` mode), as `gpui-base`'s does; elsewhere it lets
    // the pointer through to what is under it.
    let hover_reveals = move || ctl.mode.get() == ScrollbarMode::Hover && is_desktop();
    // A hidden bar takes no touches anywhere in it: under the track's
    // `none`, a view inside with `pointerEvents` of its own would take
    // them again (CSS's inheritance), so the rail and the thumb's holder
    // are `none` too while it is hidden.
    let takes = move || shown.get() || hover_reveals();
    let inner = move || {
        if takes() {
            PointerEvents::BoxNone
        } else {
            PointerEvents::None
        }
    };
    let axis = ctl.axis;
    // The track's thickness across the axis: how far a sliding entrance
    // starts off its edge.
    let thickness = animated_value(0.0);
    let thumb = view()
        .flex_1()
        .on_mouse_enter(move |_: &MouseEvent| ctl.over_thumb.set(true))
        .on_mouse_leave(move |_: &MouseEvent| ctl.over_thumb.set(false))
        .claim_touches(TouchClaim::on_start().ask(|request: &ClaimRequest| request.claim()))
        // A scroll view around it does not take the drag over.
        .keep_touches(true)
        .on_responder_grant(move |_: &ResponderEvent| ctl.press_thumb())
        .on_responder_move(move |e: &ResponderEvent| ctl.drag_by(e.gesture.delta.along(axis).0))
        .on_responder_release(move |_: &ResponderEvent| ctl.release())
        .on_responder_terminate(move |_: &ResponderEvent| ctl.release())
        .app_class(props.thumb_class)
        .inline_style(props.thumb_style);
    // The thumb's place and length, on a view of the bar's own around it:
    // the app's transitions on the thumb (a `transition-all` for a thumb
    // that widens) would make it trail the content.
    let holder = view()
        .flex_shrink_0()
        .map(|v| match axis {
            Axis::Vertical => v
                .flex_col()
                .h(move || Length::from(px(ctl.thumb())))
                .translate_y(move || DefiniteLength::from(px(ctl.position()))),
            Axis::Horizontal => v
                .flex_row()
                .w(move || Length::from(px(ctl.thumb())))
                .translate_x(move || DefiniteLength::from(px(ctl.position()))),
        })
        .pointer_events(inner)
        .child(thumb);
    // Off its edge by the track's thickness until the slide brings it in
    // (an exit slides it out): the track clips it.
    let slide = ctl
        .position
        .interpolate(&[0.0, 1.0], &[1.0, 0.0])
        .mul(&thickness);
    // The thumb's room: the track's content box, measured.
    let rail = view()
        .flex_1()
        .map(|v| match axis {
            Axis::Vertical => v.flex_col().bind_translate_x(&slide),
            Axis::Horizontal => v.flex_row().bind_translate_y(&slide),
        })
        .pointer_events(inner)
        .on_layout(move |frame: &Bounds<Points>| {
            ctl.rail_origin.replace(frame.origin);
            ctl.rail.set(frame.size.along(axis).0);
        })
        .child(holder);
    view()
        .group()
        // The slide in and out stays inside the track, as `gpui-base`'s
        // bar does inside its scroll area.
        .overflow_hidden()
        .map(|v| match axis {
            Axis::Vertical => v.flex_col(),
            Axis::Horizontal => v.flex_row(),
        })
        .optional_label(move || props.accessibility_label.get())
        .on_layout(move |frame: &Bounds<Points>| {
            let across = match axis {
                Axis::Vertical => frame.size.width,
                Axis::Horizontal => frame.size.height,
            };
            thickness.set(across.0);
        })
        .on_mouse_enter(move |_: &MouseEvent| ctl.hover_track(true))
        .on_mouse_leave(move |_: &MouseEvent| ctl.hover_track(false))
        .claim_touches(TouchClaim::on_start().ask(|request: &ClaimRequest| request.claim()))
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| ctl.press_track(e.location))
        .on_responder_move(move |e: &ResponderEvent| ctl.drag_by(e.gesture.delta.along(axis).0))
        .on_responder_release(move |_: &ResponderEvent| ctl.release())
        .on_responder_terminate(move |_: &ResponderEvent| ctl.release())
        .bind_opacity(&ctl.opacity)
        .pointer_events(move || {
            if takes() {
                PointerEvents::Auto
            } else {
                PointerEvents::None
            }
        })
        .child(rail)
}

/// The look of the built-in bars of one axis ([`ScrollbarTheme`]): what
/// `class`, `style`, `thumbClass` and `thumbStyle` are to a [`Scrollbar`],
/// placed in the view's viewport (`absolute inset-y-0 right-0 w-4 p-1`
/// for a vertical bar).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct ScrollbarLook {
    /// The Tailwind classes of the bar, its track.
    pub class: Option<SharedString>,
    /// The style of the bar, over `class`.
    #[prop(default)]
    pub style: Style,
    /// The Tailwind classes of the thumb.
    pub thumb_class: Option<SharedString>,
    /// The style of the thumb, over `thumbClass`.
    #[prop(default)]
    pub thumb_style: Style,
    /// What screen readers say of the bar.
    pub accessibility_label: Option<SharedString>,
}

/// The built-in scroll bars of scroll views and lists: a [`Scrollbar`] the
/// core puts over each view's viewport in place of the platform's
/// indicator, for every view once the app sets it ([`set_scrollbar_theme`],
/// TS `Scrollbar.setTheme`), or for one view as its `scrollbar` prop. The
/// look is the app's, per axis: a view whose axis has no look keeps the
/// platform's indicator.
#[derive(Debug, Clone, PartialEq, JsObject)]
#[non_exhaustive]
pub struct ScrollbarTheme {
    /// When the bars show (default `"scrolling"`).
    #[prop(default)]
    pub mode: ScrollbarMode,
    /// How they show and hide.
    #[prop(default)]
    pub motion: ScrollbarMotion,
    /// The shortest a thumb gets (default `48`).
    #[prop(default = px(48.0))]
    pub min_thumb_length: Points,
    /// The look of the bars of vertical views.
    pub vertical: Option<ScrollbarLook>,
    /// The look of the bars of horizontal views.
    pub horizontal: Option<ScrollbarLook>,
}

impl Default for ScrollbarTheme {
    fn default() -> Self {
        Self {
            mode: ScrollbarMode::default(),
            motion: ScrollbarMotion::default(),
            min_thumb_length: px(48.0),
            vertical: None,
            horizontal: None,
        }
    }
}

impl ScrollbarTheme {
    /// The look of the bars of `horizontal` views, if it has one.
    fn look(&self, horizontal: bool) -> Option<&ScrollbarLook> {
        if horizontal {
            self.horizontal.as_ref()
        } else {
            self.vertical.as_ref()
        }
    }
}

/// `theme` as the core keeps it for the built-in bars.
fn kept(theme: Option<ScrollbarTheme>) -> Option<AnyValue> {
    theme.map(AnyValue::new)
}

/// Draws the bar of every scroll view and list whose `scrollbar` is `true`
/// with a [`Scrollbar`] of `theme` in place of the platform's indicator
/// (TS `Scrollbar.setTheme`); `None` gives the views the platform's back.
/// A later theme restyles the bars. A view whose `scrollbar` is a theme of
/// its own keeps it.
pub fn set_scrollbar_theme(theme: Option<ScrollbarTheme>) {
    set_builtin_scrollbars(built_in, kept(theme));
}

#[module]
impl Scrollbar {
    /// Draws the bar of every scroll view and list whose `scrollbar` is
    /// `true` with a `Scrollbar` of `theme` in place of the platform's
    /// indicator; `null` gives the views the platform's back. A later
    /// theme restyles the bars; a view whose `scrollbar` is a theme of its
    /// own keeps it.
    pub fn set_theme(theme: Option<ScrollbarTheme>, cx: &mut ModuleCx) {
        cx.set_builtin_scrollbars(built_in, kept(theme));
    }
}

/// Makes the built-in bar the core asks for, of the view's theme or the
/// app's (`Registry::scrollbars_from`, [`set_scrollbar_theme`]): `None`
/// when that theme has no look for the view's axis.
pub(crate) fn built_in(of: &BuiltInScrollbar) -> Option<AnyElement> {
    let theme = match &of.theme {
        Some(json) => match from_json::<ScrollbarTheme>(json) {
            Ok(theme) => theme,
            Err(e) => {
                log::warn!(target: "js", "`scrollbar`: {}", e.0);
                return None;
            }
        },
        None => of.app_theme.clone()?.take::<ScrollbarTheme>()?,
    };
    theme.look(of.horizontal)?;
    Some(
        view_scrollbar()
            .target(ScrollbarTarget::Node(NodeRef(of.target)))
            .horizontal(of.horizontal)
            .theme(theme)
            .into_element(),
    )
}

/// The props of [`ViewScrollbar`].
#[derive(Debug, Clone, PartialEq, Props)]
struct ViewScrollbarProps {
    /// The view it is the bar of.
    #[prop(default)]
    target: ScrollbarTarget,
    /// Whether that view scrolls sideways.
    #[prop(default)]
    horizontal: bool,
    /// What it is drawn with.
    #[prop(default)]
    theme: ScrollbarTheme,
}

/// A view's built-in bar: as large as the view's viewport (the core lays
/// it out there), the pointer going through to the view but where the
/// bar takes it.
#[component]
fn ViewScrollbar(props: ViewScrollbarProps) -> impl IntoElement {
    let theme = props.theme;
    let look = theme.look(props.horizontal).cloned().unwrap_or_default();
    let bar = Scrollbar::element(ScrollbarProps {
        scroll: Prop::from(props.target),
        axis: Prop::from(if props.horizontal {
            Axis::Horizontal
        } else {
            Axis::Vertical
        }),
        mode: Prop::from(theme.mode),
        motion: Prop::from(theme.motion),
        min_thumb_length: Prop::from(theme.min_thumb_length),
        thumb_class: Prop::from(look.thumb_class),
        thumb_style: Prop::from(look.thumb_style),
        accessibility_label: Prop::from(look.accessibility_label),
    })
    .app_class(look.class)
    .inline_style(look.style);
    view().pointer_events(PointerEvents::BoxNone).child(bar)
}
