//! The chat's pieces (as the TSX gallery's `demos/chat/parts.tsx`):
//! loaders, the caret, the buttons under a reply, attachments, tool
//! cards, the error row and the avatar. Builders a list row makes once;
//! what changes in them (a tool's state, a button's tint) is bound.

use nsh_core::{element::AnyElement, prelude::*};

use super::{
    glyphs::{GlyphName, glyph},
    scripts::{FileRef, Source, Tool, ToolKind, ToolState},
};
use crate::ui::{Badge, Finish, Finished, IconName, MONO, Tone, colors, icon, press, radius};

/// A ring that spins natively, its arc in `tint` (a value, or bound).
pub(crate) fn spinner(size: f32, tint: impl IntoReactive<AdaptiveColor>) -> View {
    view()
        .size(px(size))
        .rounded(px(size / 2.0))
        .border_2()
        .border_color(colors::BORDER)
        .border_t_color(tint)
        .animation(KeyframeAnimation::new(Keyframes::Spin).duration(800.0))
}

/// The streaming caret: an inline block that pulses natively.
pub(crate) fn caret() -> View {
    view()
        .w(px(8.0))
        .h(px(16.0))
        .ml(px(2.0))
        .rounded(px(2.0))
        .bg(colors::ACCENT)
        .animation(KeyframeAnimation::new(Keyframes::Pulse).duration(900.0))
}

/// A small icon button under a reply (44 pt touch target), tinted while
/// `active`.
pub(crate) fn action_button(
    name: impl Into<Prop<GlyphName>>,
    label: &'static str,
    active: Prop<bool>,
    tone: Tone,
    on_press: impl Into<Listener<()>>,
) -> AnyElement {
    let name: Prop<GlyphName> = name.into();
    let on_press: Listener<()> = on_press.into();
    press()
        .scale(0.86)
        .label(label)
        .selected(active)
        .on_press(on_press)
        .child(
            view()
                .size(px(36.0))
                .rounded(px(18.0))
                .items_center()
                .justify_center()
                .m_1()
                .child(
                    view()
                        .absolute()
                        .size(px(32.0))
                        .rounded(px(16.0))
                        .bg(move || {
                            if active.get() {
                                tone.tint()
                            } else {
                                AdaptiveColor::TRANSPARENT
                            }
                        })
                        .transition_colors()
                        .duration(180.0),
                )
                .child(glyph().name(name).size(17.0).tint(move || {
                    if active.get() {
                        tone.color()
                    } else {
                        colors::MUTED
                    }
                })),
        )
        .into_element()
}

/// A row between days.
pub(crate) fn date_separator(label: impl IntoReactive<SharedString>) -> View {
    let rule = || view().flex_1().h(px(1.0)).bg(colors::LINE);
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .px_4()
        .py_3()
        .child(rule())
        .child(
            text(label)
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(colors::FAINT),
        )
        .child(rule())
}

/// A file as a chip: an icon, the name and the size; with `on_remove`, a
/// button that takes it away.
pub(crate) fn file_chip(file: &FileRef, on_remove: Option<Listener<()>>) -> View {
    let removable = on_remove.is_some();
    view()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .h(px(48.0))
        .pl(px(10.0))
        .pr(px(if removable { 4.0 } else { 14.0 }))
        .rounded(px(radius::CONTROL))
        .border_curve(BorderCurve::Continuous)
        .bg(colors::RAISED)
        .finish(Finish::Raised)
        .border_1()
        .border_color(colors::BORDER)
        .child(
            view()
                .size(px(30.0))
                .rounded(px(8.0))
                .bg(Tone::Danger.tint())
                .items_center()
                .justify_center()
                .child(
                    glyph()
                        .name(GlyphName::File)
                        .size(16.0)
                        .tint(colors::DANGER),
                ),
        )
        .child(
            view()
                .gap(px(1.0))
                .child(
                    text(file.name)
                        .number_of_lines(1)
                        .text_size(px(14.0))
                        .text_color(colors::TEXT)
                        .max_w(px(170.0)),
                )
                .child(
                    text(format!("PDF · {}", file.size))
                        .text_size(px(12.0))
                        .text_color(colors::MUTED)
                        .tabular_nums(),
                ),
        )
        .children(on_remove.map(|remove| {
            press()
                .scale(0.85)
                .label("Remove file")
                .on_press(remove)
                .child(
                    view()
                        .w(px(40.0))
                        .h(px(44.0))
                        .items_center()
                        .justify_center()
                        .child(
                            glyph()
                                .name(GlyphName::Close)
                                .size(14.0)
                                .tint(colors::MUTED),
                        ),
                )
        }))
}

/// An attached image, rounded.
pub(crate) fn photo(src: &'static str, width: f32, height: f32) -> View {
    view()
        .w(px(width))
        .h(px(height))
        .rounded(px(radius::INSET))
        .border_curve(BorderCurve::Continuous)
        .overflow_hidden()
        .bg(colors::RAISED)
        .border_1()
        .border_color(colors::BORDER)
        .child(image(src).w(px(width)).h(px(height)))
}

/// What a tool's header shows: its glyph, its title and the detail.
fn tool_head(kind: &ToolKind) -> (GlyphName, &'static str, String) {
    match kind {
        ToolKind::Search { query, .. } => (GlyphName::Globe, "Web search", query.to_string()),
        ToolKind::Weather { city, .. } => (GlyphName::Sun, "Weather", city.to_string()),
        ToolKind::Code { lang, .. } => (
            GlyphName::Terminal,
            "Run code",
            format!("{lang}, sandboxed"),
        ),
    }
}

/// A tool call: a header with its state, then its result once done. Its
/// state changes alone; the result is made when it comes.
pub(crate) fn tool_card(tool: ReadSignal<Tool>) -> View {
    let head = computed(move || tool.with(|t| tool_head(&t.kind)));
    let state = computed(move || tool.with(|t| t.state));
    let busy = computed(move || matches!(state.get(), ToolState::Running | ToolState::Pending));
    let body = computed(move || tool.with(|t| (t.kind.clone(), t.state == ToolState::Done)));
    view()
        .bg(colors::SURFACE)
        .finish(Finish::Card)
        .rounded(px(radius::INSET))
        .border_curve(BorderCurve::Continuous)
        .border_1()
        .border_color(move || {
            if state.get() == ToolState::Running {
                AdaptiveColor::new(colors::INFO.opacity(0.4).light, rgb(0x33405a))
            } else {
                colors::BORDER
            }
        })
        .transition_colors()
        .duration(250.0)
        .overflow_hidden()
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .p_3()
                .child(
                    view()
                        .size(px(32.0))
                        .rounded(px(9.0))
                        .items_center()
                        .justify_center()
                        .bg(colors::RAISED)
                        .finish(Finish::Raised)
                        .border_1()
                        .border_color(colors::BORDER)
                        .child(
                            glyph()
                                .name(move || head.with(|h| h.0))
                                .size(16.0)
                                .tint(colors::TEXT),
                        ),
                )
                .child(
                    view()
                        .flex_1()
                        .gap(px(1.0))
                        .child(
                            text(move || head.with(|h| h.1))
                                .text_size(px(14.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT),
                        )
                        .child(
                            text(move || head.with(|h| h.2.clone()))
                                .number_of_lines(1)
                                .text_size(px(13.0))
                                .text_color(colors::MUTED),
                        ),
                )
                .child(
                    when(busy, move || {
                        view()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .child(spinner(14.0, move || {
                                if state.get() == ToolState::Pending {
                                    colors::FAINT
                                } else {
                                    colors::INFO
                                }
                            }))
                            .child(
                                text(move || state.get().label())
                                    .text_size(px(13.0))
                                    .text_color(colors::MUTED),
                            )
                    })
                    .otherwise(move || {
                        Badge::new(move || state.get().label()).tone(move || state.get().tone())
                    }),
                ),
        )
        .child(dynamic(move || {
            body.with(|(kind, done)| tool_body(kind, *done))
        }))
}

/// A tool's result: a search's sources and a forecast once done, a run's
/// code (and its output once done).
fn tool_body(kind: &ToolKind, done: bool) -> Option<View> {
    let rule = || view().border_t_1().border_t_color(colors::LINE);
    match kind {
        ToolKind::Search { sources, .. } => done.then(|| {
            rule().py_1().children(
                sources
                    .iter()
                    .enumerate()
                    .map(|(i, source)| source_row(source, i)),
            )
        }),
        ToolKind::Weather {
            temp,
            condition,
            high,
            low,
            hours,
            ..
        } => done.then(|| {
            rule()
                .p_3()
                .gap_3()
                .child(
                    view()
                        .flex_row()
                        .items_end()
                        .gap_3()
                        .child(
                            text(format!("{temp}°"))
                                .text_size(px(40.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT)
                                .tabular_nums()
                                .letter_spacing(px(-1.0)),
                        )
                        .child(
                            view()
                                .flex_1()
                                .pb(px(7.0))
                                .gap(px(2.0))
                                .child(
                                    text(*condition)
                                        .text_size(px(15.0))
                                        .text_color(colors::TEXT),
                                )
                                .child(
                                    text(format!("H {high}°  L {low}°"))
                                        .text_size(px(13.0))
                                        .text_color(colors::MUTED)
                                        .tabular_nums(),
                                ),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .items_end()
                        .gap(px(6.0))
                        .h(px(44.0))
                        .children(hours.iter().enumerate().map(|(i, t)| {
                            view()
                                .flex_1()
                                .items_center()
                                .gap_1()
                                .child(
                                    view()
                                        .w_full()
                                        .h(px(6.0 + (t - low) as f32 * 3.0))
                                        .rounded(px(3.0))
                                        .bg(if i == 0 { colors::WARN } else { colors::RAISED }),
                                )
                                .child(
                                    text(format!("{}h", (17 + i) % 24))
                                        .text_size(px(11.0))
                                        .text_color(colors::FAINT)
                                        .tabular_nums(),
                                )
                        })),
                )
        }),
        ToolKind::Code {
            code, output, ms, ..
        } => Some(
            rule()
                .child(
                    view().p_3().bg(colors::INSET).child(
                        text(*code)
                            .selectable(true)
                            .font_family(MONO)
                            .text_size(px(12.0))
                            .line_height(px(18.0))
                            .text_color(AdaptiveColor::new(colors::CODE.light, rgb(0xc9cdd3))),
                    ),
                )
                .when(done, |v| {
                    v.child(
                        view()
                            .flex_row()
                            .items_center()
                            .gap(px(10.0))
                            .px_3()
                            .h(px(44.0))
                            .border_t_1()
                            .border_t_color(colors::LINE)
                            .child(text("Output").text_size(px(13.0)).text_color(colors::MUTED))
                            .child(
                                text(*output)
                                    .selectable(true)
                                    .flex_1()
                                    .font_family(MONO)
                                    .text_size(px(14.0))
                                    .text_color(colors::UP),
                            )
                            .child(
                                text(format!("exit 0 · {ms} ms"))
                                    .text_size(px(12.0))
                                    .text_color(colors::FAINT)
                                    .tabular_nums(),
                            ),
                    )
                }),
        ),
    }
}

fn source_row(source: &Source, index: usize) -> View {
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .h(px(48.0))
        .px_3()
        .child(
            view()
                .size(px(24.0))
                .rounded(px(6.0))
                .bg(source.tone.tint())
                .items_center()
                .justify_center()
                .child(
                    text(source.site[..1].to_uppercase())
                        .text_size(px(12.0))
                        .font_weight(FontWeight::BOLD)
                        .text_color(source.tone.color()),
                ),
        )
        .child(
            view()
                .flex_1()
                .gap(px(1.0))
                .child(
                    text(source.title)
                        .number_of_lines(1)
                        .text_size(px(14.0))
                        .text_color(colors::TEXT),
                )
                .child(
                    text(source.site)
                        .text_size(px(12.0))
                        .text_color(colors::FAINT),
                ),
        )
        .child(
            text((index + 1).to_string())
                .text_size(px(12.0))
                .text_color(colors::FAINT)
                .tabular_nums(),
        )
}

/// The reply's error: what went wrong and a Retry button.
pub(crate) fn error_row(
    message: impl IntoReactive<SharedString>,
    on_retry: impl Into<Listener<()>>,
) -> View {
    let on_retry: Listener<()> = on_retry.into();
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .p_3()
        .rounded(px(radius::INSET))
        .border_curve(BorderCurve::Continuous)
        .bg(Tone::Danger.tint())
        .border_1()
        .border_color(colors::DANGER.opacity(0.32))
        .child(
            glyph()
                .name(GlyphName::Alert)
                .size(18.0)
                .tint(colors::DANGER),
        )
        .child(
            text(message)
                .flex_1()
                .text_size(px(14.0))
                .line_height(px(19.0))
                .text_color(colors::TEXT),
        )
        .child(
            press().label("Retry").on_press(on_retry).child(
                view()
                    .h(px(36.0))
                    .px(px(14.0))
                    .rounded(px(18.0))
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .bg(colors::LIGHT)
                    .finish(Finish::Light)
                    .child(
                        glyph()
                            .name(GlyphName::Regenerate)
                            .size(14.0)
                            .tint(colors::ON_LIGHT),
                    )
                    .child(
                        text("Retry")
                            .text_size(px(13.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors::ON_LIGHT),
                    ),
            ),
        )
}

/// The assistant's avatar: a small tile with the spark.
pub(crate) fn avatar() -> View {
    view()
        .size(px(26.0))
        .rounded(px(8.0))
        .items_center()
        .justify_center()
        .bg(colors::RAISED)
        .finish(Finish::Raised)
        .border_1()
        .border_color(colors::BORDER)
        .child(icon().name(IconName::Spark).size(14.0).tint(colors::ACCENT))
}
