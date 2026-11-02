//! `ColorPicker` and its parts: a color picked on a saturation and
//! brightness area, on sliders of any channel of RGB, HSL, HSB or OKLCH,
//! typed in a field, chosen from swatches or picked on the screen with an
//! eyedropper, with no look of its own
//! (`gpui-base`'s `color_picker.rs`, the parts as React Aria's and ReUI's).
//! The root holds the color; the parts inside it read and change it, laid
//! out by the app.

mod model;

use nsh_core::{
    AccessibilityActionDef, AccessibilityValue, Color,
    element::{Style, input},
    geometry::{Along, Axis},
    prelude::*,
};

pub use self::model::{ColorChannel, ColorFormat, ColorSpace};
use self::model::{Model, Spec, parse, resolve, segments, spec};
use crate::keys::bind_while;

/// The most straight gradients a slider's track is drawn with
/// ([`model::segments`]).
const MAX_SEGMENTS: usize = 12;

/// The most colors reported that the app has not set back yet
/// ([`Picker::reported`]).
const MAX_REPORTED: usize = 32;

/// What the parts of a [`ColorPicker`] share through context: its color,
/// as each space's channels have it.
#[derive(Clone, Copy)]
struct Picker {
    model: Signal<Model>,
    disabled: Option<Prop<bool>>,
    format: Option<Prop<ColorFormat>>,
    cx: Option<Scope<ColorPickerEvent>>,
    /// The colors reported, oldest first, until the app sets them back as
    /// `value`. Events reach the app after the user's next changes may
    /// have, so the app sets back a color the picker has moved on from
    /// (a key typed after another): that is no color of the app's, and
    /// following it would drop the channels the user set since.
    reported: Stored<Vec<(u32, Option<u32>)>>,
}

impl Picker {
    /// The picker around the part; a part outside one picks a color of its
    /// own that nothing hears of (a warning says so).
    fn find(part: &str) -> Self {
        use_context::<Self>().unwrap_or_else(|| {
            log::warn!("`{part}` is outside a `ColorPicker`: its color goes nowhere");
            Self {
                model: signal(Model::default()),
                disabled: None,
                format: None,
                cx: None,
                reported: stored(Vec::new()),
            }
        })
    }

    /// The color (tracked).
    fn get(self) -> Model {
        self.model.get()
    }

    /// The color, now.
    fn now(self) -> Model {
        self.model.get_untracked()
    }

    /// Whether the picker is disabled (tracked).
    fn disabled(self) -> bool {
        self.disabled.is_some_and(|d| d.get())
    }

    /// The user changed the color to `next`: the picker shows it and
    /// reports it. Nothing when nothing changed.
    fn set(self, next: Model) {
        if next == self.now() {
            return;
        }
        self.model.set(next);
        self.emit(false);
    }

    /// The user's change ended (a drag released, a key, a swatch, a field
    /// committed).
    fn end(self) {
        self.emit(true);
    }

    fn emit(self, end: bool) {
        let Some(cx) = self.cx else {
            return;
        };
        let model = self.now();
        let format = self.format.map(|f| f.get_untracked()).unwrap_or_default();
        let formatted = SharedString::from(model.format(format));
        // The app sets back either: the color, or its text read again,
        // which the text's rounding may move off the color.
        let read = Color::parse(&formatted).map(|c| c.0);
        self.reported.with(|reported| {
            if reported.len() == MAX_REPORTED {
                reported.remove(0);
            }
            reported.push((Color::from(model.hsla()).0, read));
        });
        cx.emit(if end {
            ColorPickerEvent::ChangeEnd(model.hsla(), formatted)
        } else {
            ColorPickerEvent::Change(model.hsla(), formatted)
        });
    }
}

/// The props of [`ColorPicker`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ColorPickerProps {
    /// The color (controlled). The app owns it and sets the one
    /// `onChange` reports; whenever it sets a color the picker did not
    /// report, the parts show it. Without it the picker keeps its own,
    /// from `defaultValue`.
    pub value: Prop<Option<Hsla>>,
    /// The color at first, while `value` is not set (default opaque
    /// black).
    #[prop(default = black())]
    pub default_value: Prop<Hsla>,
    /// How the `formatted` of `onChange` and `onChangeEnd` writes the
    /// color (default `"hex"`).
    #[prop(default)]
    pub format: Prop<ColorFormat>,
    /// No changes from any part; `disabled:` styles apply to the picker
    /// and its parts.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The parts ([`ColorArea`], [`ColorSlider`], [`ColorField`],
    /// [`ColorSwatch`], [`ColorEyeDropper`]) and whatever the app lays out
    /// between them.
    pub children: Prop<Children>,
}

/// The events of a [`ColorPicker`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ColorPickerEvent {
    /// The user changed the color (a drag on the area or a slider, a key,
    /// a field, a swatch), as many times as it changes during a drag: the
    /// color, and the color written as `format` says.
    #[args(value, formatted)]
    Change(Hsla, SharedString),
    /// The user's change ended (the pointer lifted, a key, a field left or
    /// submitted, a swatch pressed): the color it ended at, once.
    #[args(value, formatted)]
    ChangeEnd(Hsla, SharedString),
}

/// A color picker: the color its parts inside show and change (a
/// [`ColorArea`] of saturation and brightness, [`ColorSlider`]s of any
/// channel of RGB, HSL, HSB or OKLCH and of the alpha, [`ColorField`]s
/// that take the color or a channel as text, [`ColorSwatch`]es of preset
/// colors), laid out by the app. It keeps the color in each space as the
/// user set it, so a gray keeps its hue and a color past sRGB its OKLCH
/// channels. It has no look and no popup of its own: put it in a
/// `Popover` to open it from a trigger, and switch the parts' `colorSpace`
/// with the app's `Tabs` for RGB, HSL, HSB and OKLCH modes.
#[component]
pub fn ColorPicker(props: ColorPickerProps, cx: Scope<ColorPickerEvent>) -> impl IntoElement {
    let first = props
        .value
        .get_untracked()
        .unwrap_or_else(|| props.default_value.get_untracked());
    let model = signal(Model::from_hsla(first));
    let reported = stored(Vec::<(u32, Option<u32>)>::new());
    effect(move || {
        let Some(value) = props.value.get() else {
            return;
        };
        let packed = Color::from(value).0;
        // A color reported: the app following the user, maybe behind.
        let echo = reported.with(|reported| {
            let at = reported
                .iter()
                .position(|&(color, read)| packed == color || Some(packed) == read)?;
            reported.drain(..=at);
            Some(())
        });
        if echo.is_some() {
            return;
        }
        reported.with(Vec::clear);
        let now = model.get_untracked();
        if packed != Color::from(now.hsla()).0 {
            model.set(now.follow(value));
        }
    });
    provide_context(Picker {
        model,
        disabled: Some(props.disabled),
        format: Some(props.format),
        cx: Some(cx),
        reported,
    });
    view().disabled(props.disabled).child(props.children)
}

/// A thumb's keys and what they do: steps of one, Shift's of ten, pages,
/// the ends.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Nudge {
    /// Along the slider's axis, or the area's x, by this many steps.
    X(f64),
    /// The area's y (up is more brightness), by this many steps.
    Y(f64),
    /// To the start of the range.
    Min,
    /// To the end of the range.
    Max,
}

/// WAI-ARIA's slider keys (Right and Up raise, also on a vertical
/// slider), Shift for steps of ten; arrows and pages repeat while held.
const SLIDER_KEYS: &[(&str, bool, Nudge)] = &[
    ("right", true, Nudge::X(1.0)),
    ("up", true, Nudge::X(1.0)),
    ("left", true, Nudge::X(-1.0)),
    ("down", true, Nudge::X(-1.0)),
    ("shift+right", true, Nudge::X(10.0)),
    ("shift+up", true, Nudge::X(10.0)),
    ("shift+left", true, Nudge::X(-10.0)),
    ("shift+down", true, Nudge::X(-10.0)),
    ("pageup", true, Nudge::X(10.0)),
    ("pagedown", true, Nudge::X(-10.0)),
    ("home", false, Nudge::Min),
    ("end", false, Nudge::Max),
];

/// The area's keys: Left and Right the saturation, Up and Down the
/// brightness, Shift for steps of ten.
const AREA_KEYS: &[(&str, bool, Nudge)] = &[
    ("right", true, Nudge::X(1.0)),
    ("left", true, Nudge::X(-1.0)),
    ("up", true, Nudge::Y(1.0)),
    ("down", true, Nudge::Y(-1.0)),
    ("shift+right", true, Nudge::X(10.0)),
    ("shift+left", true, Nudge::X(-10.0)),
    ("shift+up", true, Nudge::Y(10.0)),
    ("shift+down", true, Nudge::Y(-10.0)),
    ("pageup", true, Nudge::Y(10.0)),
    ("pagedown", true, Nudge::Y(-10.0)),
];

fn action(name: &str) -> AccessibilityActionDef {
    AccessibilityActionDef {
        name: name.into(),
        label: None,
    }
}

/// A grid of squares of `color` over its box, every other one: what shows
/// through a translucent color.
fn checkerboard(color: Prop<Option<Hsla>>, size: Prop<Points>) -> impl IntoElement {
    when(
        move || color.get().is_some(),
        move || {
            let area = signal(Size::<Points>::default());
            canvas(move || {
                let mut painter = Painter::new();
                let Some(color) = color.get() else {
                    return painter;
                };
                let Size { width, height } = area.get();
                let cell = size.get().0.max(1.0);
                painter = painter.fill_style(color);
                let (columns, rows) = (
                    (width.0 / cell).ceil() as u32,
                    (height.0 / cell).ceil() as u32,
                );
                for row in 0..rows {
                    for column in (row % 2..columns).step_by(2) {
                        painter = painter.fill_rect(
                            px(column as f32 * cell),
                            px(row as f32 * cell),
                            px(cell),
                            px(cell),
                        );
                    }
                }
                painter
            })
            .absolute()
            .inset_0()
            .pointer_events(PointerEvents::None)
            .on_layout(move |frame: &Bounds<Points>| area.set(frame.size))
        },
    )
}

/// The props of [`ColorArea`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ColorAreaProps {
    /// No pointer, keyboard or screen reader changes; `disabled:` styles
    /// apply to the area and its parts.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say for the thumb.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the panel, filling the area: the colors of
    /// the hue in saturation (left to right) and brightness (bottom to
    /// top), clipped to its corners (`rounded-lg`).
    pub panel_class: Prop<Option<SharedString>>,
    /// The style of the panel, over `panelClass`.
    #[prop(default)]
    pub panel_style: Prop<Style>,
    /// The Tailwind classes of the thumb, centered on the color
    /// (`size-4 rounded-full border-2 border-white`); `active:` while it is
    /// dragged, `focus:` with the keyboard focus.
    pub thumb_class: Prop<Option<SharedString>>,
    /// The style of the thumb, over `thumbClass`.
    #[prop(default)]
    pub thumb_style: Prop<Style>,
    /// The thumb's background is the color.
    #[prop(default)]
    pub fill_thumb: Prop<bool>,
}

/// The colors of a hue: HSB's saturation from left to right, its
/// brightness from bottom to top, in a [`ColorPicker`]. A press or a drag
/// anywhere on it picks the color under the pointer (on touch screens too,
/// kept from a scroll view around it); its thumb takes the keyboard focus,
/// where the arrows change the saturation and the brightness (Shift by
/// ten), and screen readers hear it as an adjustable control whose value is
/// the color. The app sizes it with `class` and styles its panel and thumb.
#[component]
pub fn ColorArea(props: ColorAreaProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let picker = Picker::find("ColorArea");
    let disabled = move || props.disabled.get() || picker.disabled();
    let size = stored(Size::<Points>::default());
    let drag = stored(None::<(f64, f64)>);
    let focused = signal(false);
    let place = move |x: f64, y: f64| {
        let Size { width, height } = size.get();
        if width.0 <= 0.0 || height.0 <= 0.0 {
            return;
        }
        let s = (x / f64::from(width.0)).clamp(0.0, 1.0) * 100.0;
        let b = (1.0 - y / f64::from(height.0)).clamp(0.0, 1.0) * 100.0;
        let now = picker.now();
        let h = now.channel(ColorSpace::Hsb, ColorChannel::Hue);
        picker.set(now.with_triple(ColorSpace::Hsb, [h, s.round(), b.round()]));
    };
    let nudge = move |nudge: Nudge| {
        if untracked(disabled) {
            return;
        }
        let now = picker.now();
        let channel = |c| now.channel(ColorSpace::Hsb, c);
        let (s, b) = (
            channel(ColorChannel::Saturation),
            channel(ColorChannel::Brightness),
        );
        let (s, b) = match nudge {
            Nudge::X(by) => ((s + by).round(), b),
            Nudge::Y(by) => (s, (b + by).round()),
            Nudge::Min => (s, 0.0),
            Nudge::Max => (s, 100.0),
        };
        let h = channel(ColorChannel::Hue);
        picker.set(now.with_triple(
            ColorSpace::Hsb,
            [h, s.clamp(0.0, 100.0), b.clamp(0.0, 100.0)],
        ));
        picker.end();
    };
    bind_while(move || focused.get(), AREA_KEYS, nudge);
    let release = move || {
        if drag.replace(None).is_some() {
            picker.end();
        }
    };
    let panel = view()
        .absolute()
        .inset_0()
        .overflow_hidden()
        .pointer_events(PointerEvents::None)
        .project_disabled(props.disabled)
        .style_with(move |s| s.bg(AdaptiveColor::from(picker.get().hue_color())))
        .app_class(props.panel_class)
        .inline_style(props.panel_style)
        .child(
            view()
                .absolute()
                .inset_0()
                .bg_linear_to_r()
                .gradient_from(AdaptiveColor::from(white()))
                .gradient_to(AdaptiveColor::from(white().alpha(0.0))),
        )
        .child(
            view()
                .absolute()
                .inset_0()
                .bg_linear_to_b()
                .gradient_from(AdaptiveColor::from(black().alpha(0.0)))
                .gradient_to(AdaptiveColor::from(black())),
        );
    let thumb = view()
        .absolute()
        .translate_x(relative(-0.5))
        .translate_y(relative(-0.5))
        .style_with(move |s| {
            let m = picker.get();
            let s_ = m.channel(ColorSpace::Hsb, ColorChannel::Saturation) / 100.0;
            let b = m.channel(ColorSpace::Hsb, ColorChannel::Brightness) / 100.0;
            let s = s.left(relative(s_ as f32)).top(relative((1.0 - b) as f32));
            if props.fill_thumb.get() {
                s.bg(AdaptiveColor::from(m.opaque()))
            } else {
                s
            }
        })
        .pointer_events(PointerEvents::None)
        .disabled(disabled)
        .accessible(true)
        .role(AccessibilityRole::Adjustable)
        .optional_label(props.accessibility_label)
        .accessibility_value(move || {
            let m = picker.get();
            Some(AccessibilityValue {
                min: Some(0.0),
                max: Some(100.0),
                now: Some(m.channel(ColorSpace::Hsb, ColorChannel::Brightness) as f32),
                text: Some(m.format(ColorFormat::Hex).into()),
            })
        })
        .accessibility_actions(vec![action("increment"), action("decrement")])
        .on_accessibility_action(move |name: &str| match name {
            "increment" => nudge(Nudge::Y(1.0)),
            "decrement" => nudge(Nudge::Y(-1.0)),
            _ => {}
        })
        // A press makes it a stop of the keyboard focus on the platforms
        // that move it between pressables; the drag is the area's.
        .on_press(|| {})
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false))
        .app_class(props.thumb_class)
        .inline_style(props.thumb_style);
    view()
        .disabled(disabled)
        .on_layout(move |frame: &Bounds<Points>| {
            size.replace(frame.size);
        })
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if !untracked(disabled) {
                request.claim();
            }
        }))
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| {
            let at = (f64::from(e.location.x.0), f64::from(e.location.y.0));
            drag.replace(Some(at));
            place(at.0, at.1);
        })
        .on_responder_move(move |e: &ResponderEvent| {
            if let Some((x, y)) = drag.get() {
                let d = e.gesture.delta;
                place(x + f64::from(d.x.0), y + f64::from(d.y.0));
            }
        })
        .on_responder_release(move |_: &ResponderEvent| release())
        .on_responder_terminate(move |_: &ResponderEvent| release())
        .child(panel)
        .child(thumb)
}

/// The props of [`ColorSlider`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ColorSliderProps {
    /// The space of the channel (default `"hsb"`).
    #[prop(default)]
    pub color_space: Prop<ColorSpace>,
    /// The channel it changes (default `"hue"`): one of `colorSpace`'s, or
    /// `"alpha"`. A channel the space does not have is its first.
    #[prop(default)]
    pub channel: Prop<ColorChannel>,
    /// The direction of the track (default `"horizontal"`, the channel's
    /// smallest value at the left); a vertical one has it at the bottom.
    /// Read when the slider is made.
    #[prop(default = Axis::Horizontal)]
    pub axis: Prop<Axis>,
    /// No pointer, keyboard or screen reader changes; `disabled:` styles
    /// apply to the slider and its parts.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say for the thumb.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the track, inside the slider: the colors of
    /// the channel along it, clipped to its corners (`h-3 rounded-full`);
    /// the thumb is placed on it.
    pub track_class: Prop<Option<SharedString>>,
    /// The style of the track, over `trackClass`.
    #[prop(default)]
    pub track_style: Prop<Style>,
    /// The Tailwind classes of the thumb, centered on the value on the
    /// track (`size-5 rounded-full border-2 border-white`); `active:` while
    /// it is dragged, `focus:` with the keyboard focus.
    pub thumb_class: Prop<Option<SharedString>>,
    /// The style of the thumb, over `thumbClass`.
    #[prop(default)]
    pub thumb_style: Prop<Style>,
    /// The thumb's background is the color (with its alpha on an alpha
    /// slider).
    #[prop(default)]
    pub fill_thumb: Prop<bool>,
    /// The color of a checkerboard under the track's colors, which shows
    /// through an alpha slider's: every other square of it, over the
    /// track's background (default none).
    pub checkerboard_color: Prop<Option<Hsla>>,
    /// The side of the checkerboard's squares (default 4).
    #[prop(default = Points(4.0))]
    pub checkerboard_size: Prop<Points>,
}

/// What a slider's parts and listeners share.
#[derive(Clone, Copy)]
struct SliderCtl {
    picker: Picker,
    space: Prop<ColorSpace>,
    channel: Prop<ColorChannel>,
    axis: Axis,
    disabled: Prop<bool>,
    /// The track's frame in the slider.
    rail: Signal<Bounds<Points>>,
    /// Where a drag started along the track, in points from its start.
    drag: Stored<Option<f64>>,
}

impl SliderCtl {
    /// The space and channel (tracked).
    fn pair(self) -> (ColorSpace, ColorChannel) {
        resolve(self.space.get(), self.channel.get())
    }

    fn spec(self) -> Spec {
        let (space, channel) = self.pair();
        spec(space, channel)
    }

    /// The channel's value (tracked).
    fn value(self) -> f64 {
        let (space, channel) = self.pair();
        self.picker.get().channel(space, channel)
    }

    /// Where the thumb sits, from 0 to 1 (tracked).
    fn fraction(self) -> f64 {
        self.spec().fraction(self.value())
    }

    fn disabled(self) -> bool {
        self.disabled.get() || self.picker.disabled()
    }

    fn set(self, v: f64) {
        let (space, channel) = untracked(|| self.pair());
        let v = untracked(|| self.spec()).snap(v);
        self.picker
            .set(self.picker.now().with_channel(space, channel, v));
    }

    fn length(self) -> f64 {
        let rail = self.rail.get_untracked();
        f64::from(rail.size.along(self.axis).0)
    }

    /// Points along the track from its start of `at`, a point in the
    /// slider (bottom up on a vertical one).
    fn along(self, at: Point<Points>) -> f64 {
        let rail = self.rail.get_untracked();
        f64::from(match self.axis {
            Axis::Horizontal => (at.x - rail.origin.x).0,
            Axis::Vertical => (rail.origin.y + rail.size.height - at.y).0,
        })
    }

    fn offset(self, e: &ResponderEvent) -> f64 {
        f64::from(match self.axis {
            Axis::Horizontal => e.gesture.delta.x.0,
            Axis::Vertical => -e.gesture.delta.y.0,
        })
    }

    fn set_at(self, points: f64) {
        let length = self.length();
        if length > 0.0 {
            self.set(untracked(|| self.spec()).at(points / length));
        }
    }

    /// A press on the track: the value under the pointer, and a drag from
    /// there.
    fn press_track(self, e: &ResponderEvent) {
        let at = self.along(e.location);
        self.drag.replace(Some(at));
        self.set_at(at);
    }

    /// A press on the thumb: a drag moves it by the pointer's offset.
    fn press_thumb(self) {
        let from = untracked(|| self.fraction()) * self.length();
        self.drag.replace(Some(from));
    }

    fn drag_to(self, offset: f64) {
        if let Some(from) = self.drag.get() {
            self.set_at(from + offset);
        }
    }

    fn release(self) {
        if self.drag.replace(None).is_some() {
            self.picker.end();
        }
    }

    fn nudge(self, nudge: Nudge) {
        if untracked(|| self.disabled()) {
            return;
        }
        let spec = untracked(|| self.spec());
        let now = untracked(|| self.value());
        let to = match nudge {
            Nudge::X(by) | Nudge::Y(by) => now + by * spec.step,
            Nudge::Min => spec.min,
            Nudge::Max => spec.max,
        };
        self.set(to);
        self.picker.end();
    }
}

/// A slider of one channel of a [`ColorPicker`]'s color in RGB, HSL, HSB
/// or OKLCH, or of its alpha: its track shows the colors the channel goes
/// through, the others held (HSL's and HSB's hue at full saturation, a
/// rainbow). A press on the track picks the value under the pointer and a
/// drag goes on from there (on touch screens too); its thumb takes the
/// keyboard focus, with WAI-ARIA's slider keys (Shift for steps of ten),
/// and screen readers hear it as an adjustable control. The app sizes it
/// with `class` (`h-6 justify-center px-2.5`: half a thumb free at each
/// end keeps the thumb inside it, where it takes presses) and styles its
/// track and thumb; an alpha slider's `checkerboardColor` draws what shows
/// through.
#[component]
pub fn ColorSlider(props: ColorSliderProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let ctl = SliderCtl {
        picker: Picker::find("ColorSlider"),
        space: props.color_space,
        channel: props.channel,
        axis: props.axis.get_untracked(),
        disabled: props.disabled,
        rail: signal(Bounds::default()),
        drag: stored(None),
    };
    effect(move || {
        let (space, channel) = (props.color_space.get(), props.channel.get());
        if resolve(space, channel) != (space, channel) {
            log::warn!("`ColorSlider`: {space:?} has no {channel:?} channel");
        }
    });
    let focused = signal(false);
    bind_while(move || focused.get(), SLIDER_KEYS, move |n| ctl.nudge(n));
    let axis = ctl.axis;
    // The track's colors from its start to its end, computed once per
    // change of the color; a segment restyles only when its two stops
    // change (dragging a channel leaves its own track as it was).
    let stops = computed(move || {
        let (space, channel) = ctl.pair();
        let n = segments(space, channel);
        let m = ctl.picker.get();
        (0..=n)
            .map(|k| Color::from(m.track(space, channel, k as f64 / n as f64)).0)
            .collect::<Vec<u32>>()
    });
    let segment = move |k: usize| {
        let ends = computed(move || {
            stops.with(|stops| {
                let n = stops.len() - 1;
                (k < n).then(|| match axis {
                    Axis::Horizontal => (stops[k], stops[k + 1]),
                    Axis::Vertical => (stops[n - k - 1], stops[n - k]),
                })
            })
        });
        view().flex_1().style_with(move |s| {
            let Some((from, to)) = ends.get() else {
                return s.hidden();
            };
            let s = match axis {
                Axis::Horizontal => s.bg_linear_to_r(),
                Axis::Vertical => s.bg_linear_to_t(),
            };
            s.gradient_from(AdaptiveColor::from(Hsla::from(Color(from))))
                .gradient_to(AdaptiveColor::from(Hsla::from(Color(to))))
        })
    };
    let colors = view()
        .absolute()
        .inset_0()
        .map(|v| match axis {
            Axis::Horizontal => v.flex_row(),
            Axis::Vertical => v.flex_col(),
        })
        .children((0..MAX_SEGMENTS).map(segment));
    let track = view()
        .overflow_hidden()
        .pointer_events(PointerEvents::None)
        .project_disabled(props.disabled)
        .on_layout(move |frame: &Bounds<Points>| ctl.rail.set(*frame))
        .app_class(props.track_class)
        .inline_style(props.track_style)
        .child(checkerboard(
            props.checkerboard_color,
            props.checkerboard_size,
        ))
        .child(colors);
    let thumb = view()
        .absolute()
        .translate_x(relative(-0.5))
        .translate_y(relative(-0.5))
        .style_with(move |s| {
            let rail = ctl.rail.get();
            let f = ctl.fraction() as f32;
            let s = match axis {
                Axis::Horizontal => s
                    .left(px(rail.origin.x.0 + f * rail.size.width.0))
                    .top(px(rail.origin.y.0 + rail.size.height.0 / 2.0)),
                Axis::Vertical => s
                    .top(px(rail.origin.y.0 + (1.0 - f) * rail.size.height.0))
                    .left(px(rail.origin.x.0 + rail.size.width.0 / 2.0)),
            };
            if !props.fill_thumb.get() {
                return s;
            }
            let m = ctl.picker.get();
            let fill = if ctl.pair().1 == ColorChannel::Alpha {
                m.hsla()
            } else {
                m.opaque()
            };
            s.bg(AdaptiveColor::from(fill))
        })
        .disabled(move || ctl.disabled())
        .accessible(true)
        .role(AccessibilityRole::Adjustable)
        .optional_label(props.accessibility_label)
        .accessibility_value(move || {
            let spec = ctl.spec();
            let now = ctl.value();
            Some(AccessibilityValue {
                min: Some(spec.min as f32),
                max: Some(spec.max as f32),
                now: Some(now as f32),
                text: Some(spec.format(now).into()),
            })
        })
        .accessibility_actions(vec![action("increment"), action("decrement")])
        .on_accessibility_action(move |name: &str| match name {
            "increment" => ctl.nudge(Nudge::X(1.0)),
            "decrement" => ctl.nudge(Nudge::X(-1.0)),
            _ => {}
        })
        .on_press(|| {})
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false))
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if !untracked(|| ctl.disabled()) {
                request.claim();
            }
        }))
        .keep_touches(true)
        .on_responder_grant(move |_: &ResponderEvent| ctl.press_thumb())
        .on_responder_move(move |e: &ResponderEvent| ctl.drag_to(ctl.offset(e)))
        .on_responder_release(move |_: &ResponderEvent| ctl.release())
        .on_responder_terminate(move |_: &ResponderEvent| ctl.release())
        .app_class(props.thumb_class)
        .inline_style(props.thumb_style);
    view()
        .disabled(move || ctl.disabled())
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if !untracked(|| ctl.disabled()) {
                request.claim();
            }
        }))
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| ctl.press_track(e))
        .on_responder_move(move |e: &ResponderEvent| ctl.drag_to(ctl.offset(e)))
        .on_responder_release(move |_: &ResponderEvent| ctl.release())
        .on_responder_terminate(move |_: &ResponderEvent| ctl.release())
        .child(track)
        .child(thumb)
}

/// The props of [`ColorField`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ColorFieldProps {
    /// The channel it takes as a number: one of `colorSpace`'s, or
    /// `"alpha"` (a percent). Without it the field takes the whole color
    /// as text.
    pub channel: Prop<Option<ColorChannel>>,
    /// The space of `channel` (default `"hsb"`).
    #[prop(default)]
    pub color_space: Prop<ColorSpace>,
    /// How the field writes the whole color (default `"hex"`). It reads
    /// any: hex with or without `#`, `rgb()`, `hsl()`, `hsb()`, `oklch()`,
    /// a CSS name.
    #[prop(default)]
    pub format: Prop<ColorFormat>,
    /// No typing; `disabled:` styles apply.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Shown while the field is empty (the app's words).
    pub placeholder: Prop<Option<SharedString>>,
    /// What screen readers say for the field, when no visible label names
    /// it.
    pub accessibility_label: Prop<Option<SharedString>>,
}

/// A text field of a [`ColorPicker`]'s color: the whole color, written as
/// `format` says, or one channel's number. A channel changes as the user
/// types a number (held to its range); the whole color when the field is
/// left or submitted, if the text reads as one. Leaving it writes the
/// value again in its form. The field is the app's `class` and `style`.
#[component]
pub fn ColorField(props: ColorFieldProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let picker = Picker::find("ColorField");
    // What the user is typing, until the field is left.
    let draft = signal(None::<String>);
    let take = move || {
        let text = draft.get_untracked();
        draft.set(None);
        text
    };
    let pair = move || {
        props
            .channel
            .get()
            .map(|c| resolve(props.color_space.get(), c))
    };
    let written = move || {
        let m = picker.get();
        match pair() {
            Some((space, channel)) => spec(space, channel).format(m.channel(space, channel)),
            None => m.format(props.format.get()),
        }
    };
    let commit = move || {
        let Some(text) = take() else {
            return;
        };
        if untracked(pair).is_none()
            && let Some(color) = parse(&text)
        {
            picker.set(color.apply(&picker.now()));
        }
        picker.end();
    };
    input()
        .value(move || draft.get().unwrap_or_else(written))
        .placeholder(move || {
            props
                .placeholder
                .get()
                .map(|p| p.to_string())
                .unwrap_or_default()
        })
        .keyboard_type(move || match pair() {
            Some(_) => KeyboardType::Decimal,
            None => KeyboardType::Default,
        })
        .auto_correct(false)
        .auto_capitalize(AutoCapitalize::None)
        .readonly(move || props.disabled.get() || picker.disabled())
        .disabled(move || props.disabled.get() || picker.disabled())
        .optional_label(props.accessibility_label)
        .on_change(move |text: &str| {
            draft.set(Some(text.to_owned()));
            if let Some((space, channel)) = untracked(pair)
                && let Ok(v) = text.trim().parse::<f64>()
            {
                picker.set(picker.now().with_channel(space, channel, v));
            }
        })
        .on_blur(commit)
        .on_submit(move |_: &str| commit())
}

/// The props of [`ColorSwatch`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ColorSwatchProps {
    /// The color it shows; pressing it picks it in the [`ColorPicker`]
    /// around it. Without it, the picker's color, which a press does not
    /// change (a preview).
    pub color: Prop<Option<Hsla>>,
    /// No presses; `disabled:` styles apply.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The style while it is the picker's color, as `selected:` classes.
    #[prop(default)]
    pub selected_style: Prop<Style>,
    /// What screen readers say (default the color in hex).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The color of a checkerboard under the swatch's color, which shows
    /// through a translucent one (default none).
    pub checkerboard_color: Prop<Option<Hsla>>,
    /// The side of the checkerboard's squares (default 4).
    #[prop(default = Points(4.0))]
    pub checkerboard_size: Prop<Points>,
    /// Content over the color: a check on the selected swatch
    /// (`group-selected:`).
    pub children: Prop<Children>,
}

/// The events of a [`ColorSwatch`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ColorSwatchEvent {
    /// The swatch was pressed (a tap, a click, Space or Return): its
    /// color, which a [`ColorPicker`] around it has picked.
    #[args(color)]
    Press(Hsla),
}

/// A color shown as a fill, over a checkerboard when it is translucent:
/// a preset of a palette, which a press picks in the [`ColorPicker`]
/// around it (`selected:` while it is the picker's color), or without a
/// `color` the picker's own, a preview. It works alone too, as a palette's
/// chip that reports `onPress`. Its size, shape and border are the app's
/// `class` and `style`; its corners clip the fill.
#[component]
pub fn ColorSwatch(props: ColorSwatchProps, cx: Scope<ColorSwatchEvent>) -> impl IntoElement {
    let picker = use_context::<Picker>();
    let shown = move || {
        props
            .color
            .get()
            .or_else(|| picker.map(|p| p.get().hsla()))
            .unwrap_or_else(black)
    };
    let selected = move || match (props.color.get(), picker) {
        (Some(color), Some(picker)) => Color::from(color).0 == Color::from(picker.get().hsla()).0,
        _ => false,
    };
    view()
        .overflow_hidden()
        .disabled(props.disabled)
        .accessible(true)
        .role(AccessibilityRole::Button)
        .optional_label(move || {
            props
                .accessibility_label
                .get()
                .or_else(|| Some(Model::from_hsla(shown()).format(ColorFormat::Hex).into()))
        })
        .accessibility_state(move || AccessibilityState {
            selected: selected(),
            ..AccessibilityState::default()
        })
        .selected_style(props.selected_style)
        .on_press(move |_: &()| {
            let Some(color) = props.color.get_untracked() else {
                return;
            };
            if let Some(picker) = picker
                && !untracked(|| picker.disabled())
            {
                picker.set(picker.now().follow(color));
                picker.end();
            }
            cx.emit(ColorSwatchEvent::Press(color));
        })
        .child(checkerboard(
            props.checkerboard_color,
            props.checkerboard_size,
        ))
        .child(
            view()
                .absolute()
                .inset_0()
                .pointer_events(PointerEvents::None)
                .bg(move || AdaptiveColor::from(shown())),
        )
        .child(props.children)
}

/// The props of [`ColorEyeDropper`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ColorEyeDropperProps {
    /// No presses; `disabled:` styles apply. It is disabled too where the
    /// platform picks no colors on the screen.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Its content: the app's icon or label.
    pub children: Prop<Children>,
}

/// The events of a [`ColorEyeDropper`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ColorEyeDropperEvent {
    /// The user picked a color on the screen: the color, which a
    /// [`ColorPicker`] around it has picked. Nothing when the user
    /// cancelled.
    #[args(color)]
    Pick(Hsla),
}

/// A button that picks a color anywhere on the screen: a press shows the
/// system's eyedropper (AppKit's color sampler on macOS, the browser's
/// `EyeDropper`), and the color picked becomes the [`ColorPicker`]'s around
/// it (`onChange`, then `onChangeEnd`). Where the platform has no
/// eyedropper it is disabled: `disabled:hidden` hides it there. Its look
/// and content are the app's.
#[component]
pub fn ColorEyeDropper(
    props: ColorEyeDropperProps,
    cx: Scope<ColorEyeDropperEvent>,
) -> impl IntoElement {
    let picker = use_context::<Picker>();
    let picking = signal(false);
    let disabled = move || {
        props.disabled.get() || !can_pick_screen_color() || picker.is_some_and(|p| p.disabled())
    };
    view()
        .disabled(disabled)
        .accessible(true)
        .role(AccessibilityRole::Button)
        .optional_label(props.accessibility_label)
        .on_press(move |_: &()| {
            if untracked(disabled) || picking.get_untracked() {
                return;
            }
            picking.set(true);
            spawn(async move {
                let color = pick_screen_color().await;
                picking.set(false);
                let Some(color) = color else {
                    return;
                };
                if let Some(picker) = picker
                    && !untracked(|| picker.disabled())
                {
                    picker.set(picker.now().follow(color));
                    picker.end();
                }
                cx.emit(ColorEyeDropperEvent::Pick(color));
            });
        })
        .child(props.children)
}
