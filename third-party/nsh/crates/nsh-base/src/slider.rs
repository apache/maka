//! `Slider`: a value, or a range of two, picked along a track, with no
//! look of its own (`gpui-base`'s `slider.rs`).

use nsh_core::{
    AccessibilityActionDef, AccessibilityValue,
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, Style, TsTypes},
    geometry::{Along, Axis},
    prelude::*,
};

use crate::{
    keys::bind_while,
    numeric::{self, Range},
};

/// A slider's value (TS `number | [number, number]`, `SliderValue`): one
/// number, or a range of two with one thumb each (`gpui-base`'s
/// `SliderValue`). A range's start is never past its end.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SliderValue {
    /// One value, one thumb.
    Single(f64),
    /// From a start to an end, a thumb at each.
    Range(f64, f64),
}

impl Default for SliderValue {
    /// One value, 0.
    fn default() -> Self {
        Self::Single(0.0)
    }
}

impl From<f64> for SliderValue {
    fn from(value: f64) -> Self {
        Self::Single(value)
    }
}

impl From<(f64, f64)> for SliderValue {
    fn from((start, end): (f64, f64)) -> Self {
        Self::Range(start, end)
    }
}

impl From<std::ops::Range<f64>> for SliderValue {
    fn from(range: std::ops::Range<f64>) -> Self {
        Self::Range(range.start, range.end)
    }
}

impl SliderValue {
    /// Whether it is a range of two values.
    pub fn is_range(&self) -> bool {
        matches!(self, Self::Range(..))
    }

    /// A range's start; a single value's value.
    pub fn start(&self) -> f64 {
        match *self {
            Self::Single(v) | Self::Range(v, _) => v,
        }
    }

    /// A range's end; a single value's value.
    pub fn end(&self) -> f64 {
        match *self {
            Self::Single(v) | Self::Range(_, v) => v,
        }
    }

    /// The value of `thumb`.
    fn of(&self, thumb: Thumb) -> f64 {
        match thumb {
            Thumb::Start => self.start(),
            Thumb::End => self.end(),
        }
    }

    /// The value as a slider shows it: in `range`, a range's ends in order.
    fn held(self, range: &Range) -> Self {
        match self {
            Self::Single(v) => Self::Single(range.clamp(v)),
            Self::Range(a, b) => {
                let (a, b) = (range.clamp(a), range.clamp(b));
                Self::Range(a.min(b), a.max(b))
            }
        }
    }

    /// The value with `thumb` at `v`: a range's thumbs never cross (the
    /// start stays at or before the end, the end at or after the start,
    /// as `gpui-base`'s `set_start` / `set_end`).
    fn with(self, thumb: Thumb, v: f64) -> Self {
        match (self, thumb) {
            (Self::Single(_), _) => Self::Single(v),
            (Self::Range(_, end), Thumb::Start) => Self::Range(v.min(end), end),
            (Self::Range(start, _), Thumb::End) => Self::Range(start, v.max(start)),
        }
    }
}

impl JsValue for SliderValue {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("SliderValue", |_| {
            "/** A slider's value: one number, or a range of two (`[start, end]`), a thumb each. */\n\
             export type SliderValue = number | [number, number];\n"
                .to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(n) = value.as_number() {
            return Ok(Self::Single(n));
        }
        let wanted = "a number or `[start, end]`";
        if value.array_len()?.is_none() {
            return Err(value.expected(wanted));
        }
        match Vec::<f64>::from_js(value)?[..] {
            [start, end] => Ok(Self::Range(start, end)),
            _ => Err(value.expected(wanted)),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match *self {
            Self::Single(v) => v.to_js(host),
            Self::Range(start, end) => vec![start, end].to_js(host),
        }
    }
}

/// How values spread along a slider's track (`gpui-base`'s
/// `SliderScale`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum SliderScale {
    /// Evenly: halfway along is halfway from `min` to `max`.
    #[default]
    Linear,
    /// By orders of magnitude, for a range over several (a volume, a
    /// frequency, a zoom): from 1 to 1000, a third of the way is 10 and
    /// two thirds 100. It needs `min` above 0; with a lower `min` the
    /// scale is linear.
    Logarithmic,
}

impl From<SliderScale> for numeric::Scale {
    fn from(scale: SliderScale) -> Self {
        match scale {
            SliderScale::Linear => Self::Linear,
            SliderScale::Logarithmic => Self::Logarithmic,
        }
    }
}

/// The props of [`Slider`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SliderProps {
    /// The value (controlled): a number, or `[start, end]` for a range
    /// with two thumbs. The app owns it and sets the one `onChange`
    /// reports; without it the slider keeps its own, from
    /// `defaultValue`. Shown held to `min` and `max`, a range's ends in
    /// order.
    pub value: Prop<Option<SliderValue>>,
    /// The value at first, while `value` is not set (default `0`).
    #[prop(default)]
    pub default_value: Prop<SliderValue>,
    /// The smallest value (default `0`).
    #[prop(default)]
    pub min: Prop<f64>,
    /// The largest value (default `100`); one below `min` is `min`.
    #[prop(default = 100.0)]
    pub max: Prop<f64>,
    /// The step the user's values snap to, counted from `min` (default
    /// `1`); `max` is always reachable, the last step shorter when the
    /// range is not a whole number of steps. `0`: any value.
    #[prop(default = 1.0)]
    pub step: Prop<f64>,
    /// How values spread along the track (default `"linear"`).
    #[prop(default)]
    pub scale: Prop<SliderScale>,
    /// The direction of the track (default `"horizontal"`, `min` at the
    /// left); a vertical slider has `min` at the bottom. Read when the
    /// slider is made.
    #[prop(default = Axis::Horizontal)]
    pub axis: Prop<Axis>,
    /// No pointer, keyboard or screen reader changes; `disabled:` styles
    /// apply to the slider and its parts, and screen readers say its
    /// thumbs are dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say for the thumb (on a range, the end's).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers say for a range's start thumb (default
    /// `accessibilityLabel`).
    pub start_accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the track: the area that takes presses and
    /// drags, around the indicator (taller than it for a finger:
    /// `h-6 justify-center`). `active:` while a press on it drags, and it
    /// is a `group` for its parts' `group-hover:` / `group-active:`.
    pub track_class: Prop<Option<SharedString>>,
    /// The style of the track, over `trackClass`.
    #[prop(default)]
    pub track_style: Prop<Style>,
    /// The Tailwind classes of the indicator, inside the track: the rail
    /// whose length the values map onto (`h-1.5 rounded-full bg-muted`);
    /// the range and the thumbs are placed on it.
    pub indicator_class: Prop<Option<SharedString>>,
    /// The style of the indicator, over `indicatorClass`.
    #[prop(default)]
    pub indicator_style: Prop<Style>,
    /// The Tailwind classes of the range, inside the indicator: the
    /// stretch from `min` to the thumb (on a range, between the thumbs),
    /// placed by the slider (`rounded-full bg-primary`).
    pub range_class: Prop<Option<SharedString>>,
    /// The style of the range, over `rangeClass`.
    #[prop(default)]
    pub range_style: Prop<Style>,
    /// The Tailwind classes of each thumb, centered on its value on the
    /// indicator (`size-4 rounded-full bg-background`); `hover:` under the
    /// pointer, `active:` while it is dragged, `focus:` with the keyboard
    /// focus, `disabled:` with the slider.
    pub thumb_class: Prop<Option<SharedString>>,
    /// The style of each thumb, over `thumbClass`.
    #[prop(default)]
    pub thumb_style: Prop<Style>,
    /// The content after the track: a label, the value as text.
    pub children: Prop<Children>,
}

/// The events of a [`Slider`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SliderEvent {
    /// The user changed the value (a press on the track, a drag, a key, a
    /// screen reader's increment): the value it asks for, snapped to the
    /// step, as many times as it changes during a drag.
    #[args(value)]
    Change(SliderValue),
    /// The user's change ended (the pointer lifted, a key or a screen
    /// reader's step done): the value it ended at, once (`gpui-base`'s
    /// `SliderEvent::Release`).
    #[args(value)]
    ChangeEnd(SliderValue),
}

/// One of a slider's thumbs: a range's start, or the end (a single
/// value's only thumb).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Thumb {
    Start,
    End,
}

/// What a key or a screen reader's action does to the focused thumb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Nudge {
    Up,
    Down,
    PageUp,
    PageDown,
    Min,
    Max,
}

/// WAI-ARIA's slider keys (Right and Up raise, also on a vertical slider);
/// arrows and pages repeat while held.
const KEYS: &[(&str, bool, Nudge)] = &[
    ("right", true, Nudge::Up),
    ("up", true, Nudge::Up),
    ("left", true, Nudge::Down),
    ("down", true, Nudge::Down),
    ("pageup", true, Nudge::PageUp),
    ("pagedown", true, Nudge::PageDown),
    ("home", false, Nudge::Min),
    ("end", false, Nudge::Max),
];

/// A pointer's drag, from the grant to the release.
#[derive(Debug, Clone, Copy)]
struct Drag {
    /// The thumb it moves.
    thumb: Thumb,
    /// Where it started along the indicator, in points from the `min`
    /// end: the pointer on the track, or the thumb's value (a thumb is
    /// moved by the pointer's offset, so it does not jump under it).
    from: f64,
    /// The value as the drag has it (the app may not have set it yet).
    value: SliderValue,
    /// It set a value: the release reports its end.
    moved: bool,
    /// It started on a range's two thumbs at one value: its first move
    /// picks the one that can go the pointer's way, which it then keeps.
    undecided: bool,
}

/// What the slider's parts and listeners share.
#[derive(Clone, Copy)]
struct Ctl {
    controlled: Prop<Option<SliderValue>>,
    own: Signal<SliderValue>,
    min: Prop<f64>,
    max: Prop<f64>,
    step: Prop<f64>,
    scale: Prop<SliderScale>,
    disabled: Prop<bool>,
    axis: Axis,
    /// The indicator's frame in the track.
    rail: Stored<Bounds<Points>>,
    drag: Stored<Option<Drag>>,
    cx: Scope<SliderEvent>,
}

impl Ctl {
    /// The range of values (tracked).
    fn range(self) -> Range {
        Range::new(
            self.min.get(),
            self.max.get(),
            self.step.get(),
            self.scale.get().into(),
        )
    }

    /// The value shown (tracked).
    fn shown(self) -> SliderValue {
        let raw = self.controlled.get().unwrap_or_else(|| self.own.get());
        raw.held(&self.range())
    }

    /// The value shown, now.
    fn current(self) -> SliderValue {
        untracked(|| self.shown())
    }

    /// Where `thumb` sits along the indicator, from 0 to 1 (tracked).
    fn fraction(self, thumb: Thumb) -> f64 {
        self.range().fraction(self.shown().of(thumb))
    }

    /// The user asks for `next`: the slider keeps it when the app does not
    /// control the value, and reports it.
    fn request(self, next: SliderValue) {
        if self.controlled.get_untracked().is_none() {
            self.own.set(next);
        }
        self.cx.emit(SliderEvent::Change(next));
    }

    /// A key or a screen reader's step on `thumb`: a whole change, so it
    /// reports its end too. Nothing when it changes nothing.
    fn nudge(self, thumb: Thumb, nudge: Nudge) {
        if self.disabled.get_untracked() {
            return;
        }
        let range = untracked(|| self.range());
        let now = self.current();
        let v = now.of(thumb);
        let to = match nudge {
            Nudge::Up => range.step_by(v, 1.0),
            Nudge::Down => range.step_by(v, -1.0),
            Nudge::PageUp => range.page(v, 1.0),
            Nudge::PageDown => range.page(v, -1.0),
            Nudge::Min => range.min(),
            Nudge::Max => range.max(),
        };
        let next = now.with(thumb, to);
        if next != now {
            self.request(next);
            self.cx.emit(SliderEvent::ChangeEnd(next));
        }
    }

    /// The indicator's length along the axis.
    fn length(self) -> f64 {
        f64::from(self.rail.get().size.along(self.axis).0)
    }

    /// Points from the indicator's `min` end of `at`, a point in the
    /// track (bottom up on a vertical slider).
    fn along(self, at: Point<Points>) -> f64 {
        let rail = self.rail.get();
        f64::from(match self.axis {
            Axis::Horizontal => (at.x - rail.origin.x).0,
            Axis::Vertical => (rail.origin.y + rail.size.height - at.y).0,
        })
    }

    /// How far a drag went toward `max`.
    fn offset(self, e: &ResponderEvent) -> f64 {
        f64::from(match self.axis {
            Axis::Horizontal => e.gesture.delta.x.0,
            Axis::Vertical => -e.gesture.delta.y.0,
        })
    }

    /// The value at `points` from the `min` end, snapped; none before the
    /// indicator is laid out.
    fn value_at(self, points: f64) -> Option<f64> {
        let length = self.length();
        if length <= 0.0 {
            return None;
        }
        let range = untracked(|| self.range());
        Some(range.snap(range.value_at(points / length)))
    }

    /// A press on the track: the nearer thumb (a single value's only one)
    /// jumps to the value under the pointer, and a drag goes on from there.
    fn press_track(self, e: &ResponderEvent) {
        let now = self.current();
        let at = self.along(e.location);
        let thumb = match now {
            SliderValue::Range(..) => {
                // Before the middle of the two thumbs: the start's
                // (`gpui-base`'s `is_nearer_start`).
                let (s, t) = untracked(|| (self.fraction(Thumb::Start), self.fraction(Thumb::End)));
                if at < (s + t) / 2.0 * self.length() {
                    Thumb::Start
                } else {
                    Thumb::End
                }
            }
            SliderValue::Single(_) => Thumb::End,
        };
        self.drag.replace(Some(Drag {
            thumb,
            from: at,
            value: now,
            moved: false,
            undecided: false,
        }));
        self.drag_to(0.0);
    }

    /// A press on `thumb`: a drag moves it by the pointer's offset.
    fn press_thumb(self, thumb: Thumb) {
        let now = self.current();
        let from = untracked(|| self.fraction(thumb)) * self.length();
        let undecided = matches!(now, SliderValue::Range(start, end) if start == end);
        self.drag.replace(Some(Drag {
            thumb,
            from,
            value: now,
            moved: false,
            undecided,
        }));
    }

    /// The drag moved `offset` points toward `max` since it started.
    fn drag_to(self, offset: f64) {
        let Some(mut drag) = self.drag.get() else {
            return;
        };
        let Some(v) = self.value_at(drag.from + offset) else {
            return;
        };
        // Pressed on two thumbs at one value: the one that can go where the
        // pointer goes, so they never stick together. Once picked, a drag
        // keeps its thumb, which stops at the other (`gpui-base`'s
        // `set_start` / `set_end`).
        if drag.undecided
            && let SliderValue::Range(start, _) = drag.value
            && v != start
        {
            drag.thumb = if v < start { Thumb::Start } else { Thumb::End };
            drag.undecided = false;
        }
        drag.moved = true;
        let next = drag.value.with(drag.thumb, v);
        let changed = next != drag.value;
        drag.value = next;
        self.drag.replace(Some(drag));
        if changed {
            self.request(next);
        }
    }

    /// The pointer lifted (or the system took the drag): the change ends.
    fn release(self) {
        if let Some(drag) = self.drag.replace(None)
            && drag.moved
        {
            self.cx.emit(SliderEvent::ChangeEnd(drag.value));
        }
    }

    /// What screen readers get of `thumb`: its value as text, between
    /// the values it can take (a range's start up to the end, the end
    /// from the start).
    fn accessibility_value(self, thumb: Thumb) -> AccessibilityValue {
        let range = self.range();
        let value = self.shown();
        let (low, high) = match (value, thumb) {
            (SliderValue::Range(_, end), Thumb::Start) => (range.min(), end),
            (SliderValue::Range(start, _), Thumb::End) => (start, range.max()),
            (SliderValue::Single(_), _) => (range.min(), range.max()),
        };
        let now = value.of(thumb);
        AccessibilityValue {
            min: Some(low as f32),
            max: Some(high as f32),
            now: Some(now as f32),
            text: Some(range.format(now).into()),
        }
    }
}

/// A control that picks a value, or a range of two, along a track: a
/// volume, a brightness, a price range. It owns its behavior (presses on
/// the track and drags of its thumbs, on touch screens too; the keyboard
/// on each thumb, WAI-ARIA's slider keys; the step and the scale; each
/// thumb's role, label and value for screen readers and their increment and
/// decrement) and leaves its look to the app: no colors, sizes, radii or
/// motion of its own. Its parts are a track, the indicator inside it, the
/// range and the thumbs on the indicator, then its children; the app's
/// `class` and `style` style the slider, `<part>Class` / `<part>Style` the
/// parts, whose `disabled:` follow the slider and whose thumbs show
/// `hover:`, `active:` and `focus:`.
#[component]
pub fn Slider(props: SliderProps, cx: Scope<SliderEvent>) -> impl IntoElement {
    let ctl = Ctl {
        controlled: props.value,
        own: signal(props.default_value.get_untracked()),
        min: props.min,
        max: props.max,
        step: props.step,
        scale: props.scale,
        disabled: props.disabled,
        axis: props.axis.get_untracked(),
        rail: stored(Bounds::default()),
        drag: stored(None),
        cx,
    };
    let disabled = props.disabled;
    let focused = signal(None::<Thumb>);
    bind_while(
        move || focused.get().is_some(),
        KEYS,
        move |nudge| {
            if let Some(thumb) = focused.get_untracked() {
                ctl.nudge(thumb, nudge);
            }
        },
    );
    let thumb = move |which: Thumb| {
        let label = move || match which {
            Thumb::Start => props
                .start_accessibility_label
                .get()
                .or_else(|| props.accessibility_label.get()),
            Thumb::End => props.accessibility_label.get(),
        };
        let action = |name: &str| AccessibilityActionDef {
            name: name.into(),
            label: None,
        };
        view()
            .absolute()
            .map(|v| match ctl.axis {
                Axis::Horizontal => v.top(relative(0.5)),
                Axis::Vertical => v.left(relative(0.5)),
            })
            .translate_x(relative(-0.5))
            .translate_y(relative(-0.5))
            .style_with(move |s| {
                let f = ctl.fraction(which) as f32;
                match ctl.axis {
                    Axis::Horizontal => s.left(relative(f)),
                    Axis::Vertical => s.top(relative(1.0 - f)),
                }
            })
            .disabled(disabled)
            .accessible(true)
            .role(AccessibilityRole::Adjustable)
            .optional_label(label)
            .accessibility_value(move || Some(ctl.accessibility_value(which)))
            .accessibility_actions(vec![action("increment"), action("decrement")])
            .on_accessibility_action(move |name: &str| match name {
                "increment" => ctl.nudge(which, Nudge::Up),
                "decrement" => ctl.nudge(which, Nudge::Down),
                _ => {}
            })
            // A press makes it a stop of the keyboard focus (Tab) on the
            // platforms that move it between pressables; the drag is the
            // responder's.
            .on_press(|| {})
            .on_focus(move || focused.set(Some(which)))
            .on_blur(move || {
                if focused.get_untracked() == Some(which) {
                    focused.set(None);
                }
            })
            .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
                if !disabled.get_untracked() {
                    request.claim();
                }
            }))
            // A scroll view around it does not take the drag over.
            .keep_touches(true)
            .on_responder_grant(move |_: &ResponderEvent| ctl.press_thumb(which))
            .on_responder_move(move |e: &ResponderEvent| ctl.drag_to(ctl.offset(e)))
            .on_responder_release(move |_: &ResponderEvent| ctl.release())
            .on_responder_terminate(move |_: &ResponderEvent| ctl.release())
            .app_class(props.thumb_class)
            .inline_style(props.thumb_style)
    };
    let range = view()
        .absolute()
        .pointer_events(PointerEvents::None)
        .project_disabled(disabled)
        .map(|v| match ctl.axis {
            Axis::Horizontal => v.top(px(0.0)).bottom(px(0.0)),
            Axis::Vertical => v.left(px(0.0)).right(px(0.0)),
        })
        .style_with(move |s| {
            let start = match ctl.shown() {
                SliderValue::Range(..) => ctl.fraction(Thumb::Start) as f32,
                SliderValue::Single(_) => 0.0,
            };
            let end = ctl.fraction(Thumb::End) as f32;
            match ctl.axis {
                Axis::Horizontal => s.left(relative(start)).right(relative(1.0 - end)),
                Axis::Vertical => s.bottom(relative(start)).top(relative(1.0 - end)),
            }
        })
        .app_class(props.range_class)
        .inline_style(props.range_style);
    let indicator = view()
        // Presses go through it to the track (or to a thumb).
        .pointer_events(PointerEvents::BoxNone)
        .project_disabled(disabled)
        .on_layout(move |frame: &Bounds<Points>| {
            ctl.rail.replace(*frame);
        })
        .app_class(props.indicator_class)
        .inline_style(props.indicator_style)
        .child(range)
        .child(when(
            move || ctl.shown().is_range(),
            move || thumb(Thumb::Start),
        ))
        .child(thumb(Thumb::End));
    let track = view()
        .group()
        .project_disabled(disabled)
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if !disabled.get_untracked() {
                request.claim();
            }
        }))
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| ctl.press_track(e))
        .on_responder_move(move |e: &ResponderEvent| ctl.drag_to(ctl.offset(e)))
        .on_responder_release(move |_: &ResponderEvent| ctl.release())
        .on_responder_terminate(move |_: &ResponderEvent| ctl.release())
        .app_class(props.track_class)
        .inline_style(props.track_style)
        .child(indicator);
    view().disabled(disabled).child(track).child(props.children)
}
