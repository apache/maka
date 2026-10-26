//! The gallery's controls with motion of their own: [`Toggle`] and
//! [`Segmented`].

use nsh_core::{
    Bounds, Points,
    element::{JsObject, PropEnum},
    prelude::*,
};

use super::theme::{Finish, Finished, colors, inset_shadow, motion, rgb_a};

/// The props of [`Toggle`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct ToggleProps {
    /// On.
    #[prop(default)]
    pub(crate) value: Prop<bool>,
    /// Its accessibility label.
    pub(crate) label: Prop<Option<SharedString>>,
}

/// What a [`Toggle`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum ToggleEvent {
    /// It was flipped (the new value; the owner sets `value`).
    Change(bool),
}

/// Where the knob is for `on`: 0 off, 1 on.
fn knob(on: bool) -> f32 {
    if on { 1.0 } else { 0.0 }
}

/// An on / off switch: the knob springs across, the track changes color
/// natively.
#[component]
pub(crate) fn Toggle(props: ToggleProps, cx: Scope<ToggleEvent>) -> impl IntoElement {
    let on = animated_value(knob(props.value.get_untracked()));
    // A new value from the owner springs the knob there.
    let shown = stored(props.value.get_untracked());
    effect(move || {
        let value = props.value.get();
        if shown.replace(value) != value {
            on.spring(knob(value), motion::SETTLE);
        }
    });
    let (knob_light, _) = Finish::Knob.shadows();
    view()
        .w(px(50.0))
        .h(px(30.0))
        .rounded(px(15.0))
        .p(px(3.0))
        .border_1()
        .border_color(colors::BORDER)
        .finish_shadow(Finish::Track)
        .role(AccessibilityRole::Switch)
        .label(move || props.label.get().unwrap_or_default())
        .accessibility_state(move || AccessibilityState {
            checked: Some(if props.value.get() {
                nsh_core::Checked::True
            } else {
                nsh_core::Checked::False
            }),
            ..AccessibilityState::default()
        })
        .hit_slop(EdgeInsets::all(px(8.0)))
        .on_press(move || {
            let next = !props.value.get_untracked();
            on.spring(knob(next), motion::SETTLE);
            cx.emit(ToggleEvent::Change(next));
        })
        // Inside the border: its radius less the border's width; its colors
        // follow the appearance natively.
        .child(
            view()
                .absolute()
                .inset_0()
                .rounded(px(14.0))
                .pointer_events(PointerEvents::None)
                .bind_background(
                    &on.interpolate_colors(&[0.0, 1.0], &[colors::TRACK, colors::ACCENT_FILL]),
                ),
        )
        .child(
            view()
                .size(px(22.0))
                .rounded(px(11.0))
                .bg(move || {
                    if props.value.get() {
                        colors::ON_ACCENT
                    } else {
                        colors::KNOB
                    }
                })
                // A drop of glass: a specular top over the knob's color.
                .bg_linear_to_b()
                .gradient_from(rgb_a(0xffffff, 0.3))
                .gradient_to(rgb_a(0xffffff, 0.0))
                .gradient_to_position(percentage(0.6))
                .adaptive_shadow(
                    knob_light.iter().copied(),
                    [
                        inset_shadow(1.0, 0.0, rgb_a(0xffffff, 0.2)),
                        BoxShadow {
                            offset_x: px(0.0),
                            offset_y: px(1.0),
                            blur: px(3.0),
                            spread: px(0.0),
                            color: rgb_a(0x000000, 0.4).to_packed(),
                            inset: false,
                        },
                    ],
                )
                .bind_translate_x(&on.interpolate(&[0.0, 1.0], &[0.0, 20.0])),
        )
}

/// A segment of [`Segmented`].
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct Segment {
    /// Its label.
    pub(crate) label: SharedString,
    /// A quiet number after the label.
    pub(crate) count: Option<u32>,
}

impl Segment {
    /// A segment labelled `label`.
    pub(crate) fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            count: None,
        }
    }

    /// With `count` after the label.
    pub(crate) fn count(mut self, count: u32) -> Self {
        self.count = Some(count);
        self
    }
}

/// How tall a [`Segmented`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum SegmentedSize {
    /// 40 pt.
    #[default]
    Regular,
    /// 32 pt.
    Small,
}

/// The props of [`Segmented`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct SegmentedProps {
    /// The segments.
    pub(crate) options: Prop<Vec<Segment>>,
    /// The selected one's index.
    #[prop(default)]
    pub(crate) selected: Prop<u32>,
    /// Its height.
    #[prop(default)]
    pub(crate) size: SegmentedSize,
}

/// What a [`Segmented`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum SegmentedEvent {
    /// A segment was pressed (its index; the owner sets `selected`).
    Change(u32),
}

/// Equal segments with an indicator that springs to the selected one.
#[component]
pub(crate) fn Segmented(props: SegmentedProps, cx: Scope<SegmentedEvent>) -> impl IntoElement {
    // Its width as laid out (0 before the first layout).
    let width = signal(0.0_f32);
    let count = computed(move || props.options.with(Vec::len).max(1));
    let segment = computed(move || (width.get() - 6.0) / count.get() as f32);
    // The indicator's offset: the first place jumps, later moves spring.
    let x = animated_value(0.0);
    let placed = stored(false);
    effect(move || {
        let index = (props.selected.get() as usize).min(count.get() - 1);
        let to = index as f32 * segment.get();
        if width.get() <= 0.0 {
            return;
        }
        if placed.replace(true) {
            x.spring(to, motion::SETTLE);
        } else {
            x.set(to);
        }
    });
    let small = props.size == SegmentedSize::Small;
    let height = if small { 32.0 } else { 40.0 };
    let (track_light, track_dark) = Finish::Track.shadows();
    let segments = dynamic(move || {
        props
            .options
            .get()
            .into_iter()
            .enumerate()
            .map(|(i, option)| {
                let i = i as u32;
                let selected = computed(move || props.selected.get() == i);
                view()
                    .flex_1()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(5.0))
                    .role(AccessibilityRole::Tab)
                    .accessibility_state(move || AccessibilityState {
                        selected: selected.get(),
                        ..AccessibilityState::default()
                    })
                    .on_press(move || cx.emit(SegmentedEvent::Change(i)))
                    .child(
                        text(option.label)
                            .number_of_lines(1)
                            .text_size(px(if small { 13.0 } else { 14.0 }))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(move || {
                                if selected.get() {
                                    colors::TEXT
                                } else {
                                    colors::MUTED
                                }
                            }),
                    )
                    .children(option.count.map(|count| {
                        text(count.to_string())
                            .text_size(px(12.0))
                            .text_color(colors::FAINT)
                            .tabular_nums()
                    }))
            })
            .collect::<Vec<_>>()
    });
    view()
        .h(px(height))
        .flex_row()
        .p(px(3.0))
        .rounded(px(height / 2.0))
        .bg(colors::INSET)
        .adaptive_shadow(track_light.iter().copied(), track_dark.iter().copied())
        .border_1()
        .border_color(colors::BORDER)
        .role(AccessibilityRole::Tablist)
        .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
        .child(
            view()
                .absolute()
                .top(px(3.0))
                .left(px(3.0))
                .bottom(px(3.0))
                .w(move || px(segment.get().max(0.0)))
                .rounded(px((height - 6.0) / 2.0))
                .finish(Finish::Pill)
                .border_1()
                .pointer_events(PointerEvents::None)
                .bind_translate_x(&x),
        )
        .child(segments)
}
