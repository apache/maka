//! A component: `<Gauge value={…} max={…} label="…" onChange={…}>…</Gauge>`.

use nsh_base::theme;
use nsh_core::prelude::*;

/// The props of [`Gauge`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct GaugeProps {
    /// The amount spent (required).
    pub value: Prop<f64>,
    /// The budget (100 when left out).
    #[prop(default = 100.0)]
    pub max: Prop<f64>,
    /// What a press adds (10 when left out).
    #[prop(default = 10.0)]
    pub step: Prop<f64>,
    /// The title above the bar, when given.
    pub label: Prop<Option<SharedString>>,
    /// Shown under the bar: the app's own JSX.
    pub children: Prop<Children>,
}

/// The events of a [`Gauge`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum GaugeEvent {
    /// The gauge was pressed: the value it asks for.
    Change(f64),
}

/// How much of a budget is spent; a press adds `step` (back to 0 past
/// `max`) and reports the new value. The app controls `value`: it sets it
/// from `onChange`.
#[component]
pub fn Gauge(props: GaugeProps, cx: Scope<GaugeEvent>) -> impl IntoElement {
    let fraction = move || {
        let max = props.max.get();
        if max > 0.0 {
            (props.value.get() / max).clamp(0.0, 1.0) as f32
        } else {
            0.0
        }
    };
    view()
        .gap_2()
        .p_4()
        .rounded(move || theme().radius)
        .bg(move || theme().muted)
        .border_1()
        .border_color(move || theme().border)
        .active(|s| s.opacity(0.7))
        .on_press(move || {
            let (value, max, step) = (
                props.value.get_untracked(),
                props.max.get_untracked(),
                props.step.get_untracked(),
            );
            let next = if value + step > max {
                0.0
            } else {
                value + step
            };
            cx.emit(GaugeEvent::Change(next));
        })
        .child(
            view()
                .flex_row()
                .justify_between()
                .child(
                    text(move || props.label.get().unwrap_or_else(|| "Budget".into()))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || theme().foreground),
                )
                .child(
                    text(move || format!("{:.0}%", fraction() * 100.0))
                        .tabular_nums()
                        .text_color(move || theme().muted_foreground),
                ),
        )
        .child(
            view()
                .h(px(10.0))
                .rounded(px(5.0))
                .bg(move || theme().border)
                .child(
                    view()
                        .h(px(10.0))
                        .rounded(px(5.0))
                        .w(move || relative(fraction()))
                        .bg(move || {
                            if fraction() >= 1.0 {
                                theme().destructive
                            } else {
                                theme().primary
                            }
                        }),
                ),
        )
        .child(props.children)
}
