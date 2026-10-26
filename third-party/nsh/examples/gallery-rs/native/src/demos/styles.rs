//! Styles: corners (also continuous), borders, shadows and glows,
//! clipping, stacking and opacity, 3D transforms, numerals and right to
//! left layout, each on a card of specimens (as the TSX gallery's
//! `demos/Styles.tsx`).

use nsh_core::{
    animation::{Curve, EaseMode},
    element::{Animation, TransformKind},
    prelude::*,
};

use crate::ui::{
    Badge, Button, ButtonVariant, Card, DemoPage, Finish, Finished, IconName, MONO, Segment,
    caption, colors, hint, inset_shadow, press, radius, rgb_a, segmented, tints, toggle,
};

/// The stage every specimen stands on: the card's light, without its
/// drop shadow.
fn stage() -> View {
    view()
        .h(px(104.0))
        .items_center()
        .justify_center()
        .rounded(px(radius::CONTROL))
        .border_curve(BorderCurve::Continuous)
        .bg(colors::SURFACE)
        .border_1()
        .border_color(colors::LINE)
        .finish_fill(Finish::Card)
        .adaptive_shadow(
            [inset_shadow(1.0, 0.0, rgb(0xffffff))],
            [inset_shadow(1.0, 0.0, rgb_a(0xffffff, 0.05))],
        )
}

/// A specimen box: a raised surface the styles are tried on.
fn specimen_box() -> View {
    view()
        .w(px(112.0))
        .h(px(76.0))
        .items_center()
        .justify_center()
        .bg(colors::RAISED)
}

fn label(content: impl Into<SharedString>, color: AdaptiveColor) -> Text {
    text(content.into())
        .text_size(px(13.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(color)
}

/// One cell of a two-column grid: the specimen on a stage, a label, the
/// style it shows (`code`, monospaced) and a plain note.
fn tile(
    label: impl IntoReactive<SharedString>,
    code: Option<Reactive<SharedString>>,
    note: Option<Reactive<SharedString>>,
    on_press: Option<Listener<()>>,
    specimen: impl IntoElement,
) -> View {
    view()
        .basis(relative(0.4))
        .flex_grow(1.0)
        .gap_2()
        .child(
            stage()
                .when_some(on_press, |v, listener| v.on_press(listener))
                .child(specimen),
        )
        .child(
            view()
                .gap(px(3.0))
                .px(px(2.0))
                .child(
                    text(label)
                        .text_size(px(13.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(colors::TEXT),
                )
                .children(code.map(|code| {
                    text(code)
                        .number_of_lines(1)
                        .text_size(px(12.0))
                        .text_color(colors::MUTED)
                        .font_family(MONO)
                }))
                .children(note.map(|note| {
                    text(note)
                        .number_of_lines(1)
                        .text_size(px(12.0))
                        .text_color(colors::FAINT)
                        .tabular_nums()
                })),
        )
}

/// A tile's line that never changes.
fn some(s: &'static str) -> Option<Reactive<SharedString>> {
    Some(s.into_reactive())
}

/// Tiles two to a row.
fn grid() -> View {
    view()
        .flex_row()
        .flex_wrap()
        .gap_x(px(12.0))
        .gap_y(px(16.0))
}

/// A caption whose label and note are spans of their own (TS `<Caption
/// label={<Text …/>} note={<Text …/>} />`).
fn caption_spans(label: Text, note: &'static str) -> View {
    view()
        .flex_row()
        .items_baseline()
        .gap_2()
        .child(
            text("")
                .flex_1()
                .text_size(px(14.0))
                .text_color(colors::MUTED)
                .child(label),
        )
        .child(
            text("")
                .text_size(px(13.0))
                .text_color(colors::FAINT)
                .tabular_nums()
                .child(text(note).font_family(MONO)),
        )
}

/// A face of the flip card: its fill, its gradient's two stops and its
/// rim, a badge, its angle and two lines.
fn face(
    [fill, from, to, rim]: [AdaptiveColor; 4],
    badge: Badge,
    degrees: &'static str,
    title: &'static str,
    detail: &'static str,
) -> View {
    view()
        .absolute()
        .inset(px(0.0))
        .rounded(px(radius::CARD))
        .border_curve(BorderCurve::Continuous)
        .border_1()
        .p_4()
        .justify_between()
        .backface_hidden()
        .bg(fill)
        .bg_linear_to_b()
        .gradient_from(from)
        .gradient_to(to)
        .adaptive_shadow(
            [
                inset_shadow(1.0, 0.0, rgb(0xffffff)),
                BoxShadow {
                    offset_x: px(0.0),
                    offset_y: px(8.0),
                    blur: px(20.0),
                    spread: px(0.0),
                    color: rgb_a(0x14140a, 0.10).to_packed(),
                    inset: false,
                },
            ],
            [
                inset_shadow(1.0, 0.0, rgb_a(0xffffff, 0.07)),
                BoxShadow {
                    offset_x: px(0.0),
                    offset_y: px(10.0),
                    blur: px(24.0),
                    spread: px(0.0),
                    color: rgb_a(0x000000, 0.4).to_packed(),
                    inset: false,
                },
            ],
        )
        .border_color(rim)
        .child(
            view().flex_row().justify_between().child(badge).child(
                text(degrees)
                    .text_size(px(13.0))
                    .text_color(colors::MUTED)
                    .tabular_nums(),
            ),
        )
        .child(
            view()
                .gap(px(2.0))
                .child(
                    text(title)
                        .text_size(px(20.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::TEXT),
                )
                .child(text(detail).text_size(px(13.0)).text_color(colors::MUTED)),
        )
}

/// Two faces back to back: each hides while turned away.
#[component]
fn FlipCard() -> impl IntoElement {
    let angle = animated_value(0.0);
    // Turned to its back (nothing displays it: the angle shows it).
    let flipped = stored(false);
    let flip = move |_: &()| {
        let to = flipped.with(|flipped| {
            *flipped = !*flipped;
            if *flipped { 180.0 } else { 0.0 }
        });
        angle.spring(
            to,
            Spring {
                stiffness: 140.0,
                damping: 16.0,
                mass: 1.0,
                velocity: None,
            },
        );
    };
    let tone = |light: u32, dark: u32| AdaptiveColor::new(rgb(light), rgb(dark));
    view().flex_1().child(
        press()
            .scale(0.98)
            .label("Flip the card")
            .on_press(flip)
            .child(
                view()
                    .h(px(132.0))
                    // The faces' bound rotations are seen from 800pt away.
                    .perspective(px(800.0))
                    .child(
                        face(
                            [
                                tone(0xeef2fc, 0x1a2134),
                                tone(0xf5f8fe, 0x212a42),
                                tone(0xe6ecfa, 0x171d2d),
                                tone(0xcdd8f3, 0x2b3a5c),
                            ],
                            Badge::new("front").tone(crate::ui::Tone::Info),
                            "0°",
                            hint("Tap to flip", "Click to flip"),
                            "A spring turns it on the UI thread",
                        )
                        .bind_transform(TransformKind::RotateY, &angle),
                    )
                    .child(
                        face(
                            [
                                tone(0xf1f7e2, 0x202814),
                                tone(0xf7fbec, 0x283219),
                                tone(0xe9f2d2, 0x1b2211),
                                tone(0xd3e3a8, 0x3b4a22),
                            ],
                            Badge::new("back").tone(crate::ui::Tone::Accent),
                            "180°",
                            "backfaceVisibility",
                            "hidden: each face hides while turned away",
                        )
                        .bind_transform(
                            TransformKind::RotateY,
                            &angle.interpolate(&[0.0, 180.0], &[180.0, 360.0]),
                        ),
                    ),
            ),
    )
}

/// The opacity levels of the layers card.
const LEVELS: [(&str, f32); 3] = [("0.2", 0.2), ("0.45", 0.45), ("1", 1.0)];

/// Circular and continuous corners side by side, at the same radius.
fn corners() -> Card {
    let shape = |name: &'static str, shape: View| {
        view()
            .items_center()
            .gap(px(10.0))
            .child(view().h(px(64.0)).justify_center().child(shape))
            .child(text(name).text_size(px(12.0)).text_color(colors::MUTED))
    };
    Card::new()
        .icon(IconName::Styles)
        .title("Corners")
        .subtitle("borderRadius · borderCurve · per corner")
        .child(
            view()
                .flex_row()
                .justify_between()
                .child(shape(
                    "Circular",
                    view().size(px(60.0)).rounded(px(20.0)).bg(colors::INFO),
                ))
                .child(shape(
                    "Continuous",
                    view()
                        .size(px(60.0))
                        .rounded(px(20.0))
                        .border_curve(BorderCurve::Continuous)
                        .bg(colors::INFO),
                ))
                .child(shape(
                    "One corner",
                    view()
                        .size(px(60.0))
                        .rounded(px(20.0))
                        .border_curve(BorderCurve::Continuous)
                        .border(px(2.5))
                        .border_color(colors::ACCENT)
                        .rounded_tl(px(4.0)),
                ))
                .child(shape(
                    "Pill",
                    view()
                        .w(px(60.0))
                        .h(px(28.0))
                        .rounded(px(14.0))
                        .border_curve(BorderCurve::Continuous)
                        .bg(colors::UP),
                )),
        )
        .child(caption(
            "Continuous corners ease into the edges",
            Some("Radius 20 pt"),
        ))
        .child(
            grid()
                .child(tile(
                    "Top corners",
                    some("borderTop*Radius"),
                    some("28 pt"),
                    None,
                    specimen_box()
                        .rounded_t(px(28.0))
                        .border(px(1.5))
                        .border_color(colors::ACCENT)
                        .child(label("28 pt", colors::ACCENT)),
                ))
                .child(tile(
                    "Mixed radii",
                    None,
                    some("44 · 6 · 28 · 0 pt, clockwise"),
                    None,
                    specimen_box()
                        .bg(tints::INFO)
                        .rounded_tl(px(44.0))
                        .rounded_tr(px(6.0))
                        .rounded_br(px(28.0))
                        .border_2()
                        .border_color(colors::INFO)
                        .child(label("Mixed", colors::INFO)),
                )),
        )
}

fn borders() -> Card {
    Card::new()
        .icon(IconName::Components)
        .title("Borders")
        .subtitle("per side · dashed · dotted")
        .child(
            grid()
                .child(tile(
                    "Per-side borders",
                    None,
                    some("6 · 2 · 4 · 1 pt, clockwise"),
                    None,
                    specimen_box()
                        .border_t(px(6.0))
                        .border_t_color(colors::DANGER)
                        .border_r(px(2.0))
                        .border_r_color(colors::UP)
                        .border_b(px(4.0))
                        .border_b_color(colors::INFO)
                        .border_l(px(1.0))
                        .border_l_color(colors::WARN),
                ))
                .child(tile(
                    "Dashed / dotted",
                    some("borderStyle"),
                    None,
                    None,
                    view()
                        .gap_2()
                        .child(
                            view()
                                .w(px(112.0))
                                .h(px(28.0))
                                .rounded(px(8.0))
                                .border(px(1.5))
                                .border_color(colors::INFO)
                                .border_dashed(),
                        )
                        .child(
                            view()
                                .w(px(112.0))
                                .h(px(28.0))
                                .rounded(px(8.0))
                                .border(px(3.0))
                                .border_color(colors::WARN)
                                .border_dotted(),
                        ),
                )),
        )
}

/// Shadows that read on a dark page: colored glows rather than black.
fn shadows() -> Card {
    Card::new()
        .icon(IconName::Spark)
        .title("Shadows and glow")
        .subtitle("shadowColor · elevation · text shadow")
        .child(
            grid()
                .child(tile(
                    "Glow",
                    some("shadowColor"),
                    some("A colored shadow"),
                    None,
                    specimen_box()
                        .rounded(px(16.0))
                        .border_curve(BorderCurve::Continuous)
                        .bg(colors::ACCENT_FILL)
                        .shadow_color(colors::ACCENT_FILL)
                        .shadow_opacity(0.55)
                        .shadow_radius(px(18.0))
                        .shadow_offset(point(px(0.0), px(6.0)))
                        .child(label("Glow", colors::ON_ACCENT)),
                ))
                .child(tile(
                    "Offset shadow",
                    some("shadowOffset"),
                    some("4, 8 pt · radius 10"),
                    None,
                    specimen_box()
                        .bg(AdaptiveColor::new(rgb(0xe7edfb), rgb(0x1d2740)))
                        .rounded_tl(px(30.0))
                        .rounded_br(px(30.0))
                        .border_1()
                        .border_color(colors::INFO)
                        .shadow_color(colors::INFO)
                        .shadow_opacity(0.45)
                        .shadow_radius(px(10.0))
                        .shadow_offset(point(px(4.0), px(8.0)))
                        .child(label("Offset", colors::INFO)),
                ))
                .child(tile(
                    "Image corners",
                    None,
                    some("Two radii and a shadow"),
                    None,
                    image("https://picsum.photos/seed/nsh/300/220")
                        .w(px(112.0))
                        .h(px(76.0))
                        .rounded_tl(px(28.0))
                        .rounded_br(px(28.0))
                        .bg(colors::RAISED)
                        .shadow_color(rgb(0x000000))
                        .shadow_opacity(move || if dark() { 0.6_f32 } else { 0.22 })
                        .shadow_radius(px(12.0))
                        .shadow_offset(point(px(0.0), px(8.0))),
                ))
                // A transparent view's shadow follows its content: the
                // text.
                .child(tile(
                    "Text shadow",
                    None,
                    some("Shadow of the content"),
                    None,
                    specimen_box()
                        .bg(transparent_black())
                        .shadow_color(colors::DANGER)
                        .shadow_opacity(0.9)
                        .shadow_radius(px(8.0))
                        .shadow_offset(point(px(0.0), px(0.0)))
                        .child(
                            text("Shadow")
                                .text_size(px(24.0))
                                .font_weight(FontWeight::EXTRA_BOLD)
                                .text_color(colors::TEXT)
                                .letter_spacing(px(-0.5)),
                        ),
                ))
                .child(tile(
                    "Text corners",
                    None,
                    some("Radii on a Text"),
                    None,
                    text("Text corners")
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors::UP)
                        .bg(tints::UP)
                        .rounded_tl(px(14.0))
                        .rounded_br(px(14.0))
                        .px(px(14.0))
                        .py_2(),
                ))
                .child(tile(
                    "Elevation",
                    some("elevation: 10"),
                    some("Android"),
                    None,
                    specimen_box()
                        .elevation(10.0)
                        .rounded(px(16.0))
                        .bg(colors::RAISED)
                        .shadow_opacity(0.5)
                        .shadow_radius(px(10.0))
                        .shadow_offset(point(px(0.0), px(6.0)))
                        .child(label("Elevation", colors::TEXT)),
                )),
        )
}

/// Clipping, stacking order and opacity, each one tap away.
fn layers() -> Card {
    // The warning box clips what overflows it; the square of the
    // stacking tile on top; the opacity level's index and the opacity
    // box's opacity, animated natively.
    let clip = signal(true);
    let front = signal(0_usize);
    let level = signal(1_u32);
    let opacity = animated_value(0.45);
    let switch = move |_: &()| clip.update(|c| *c = !*c);
    let next = move |_: &()| front.update(|f| *f = (*f + 1) % 3);
    let squares = [colors::DANGER, colors::INFO, colors::UP]
        .into_iter()
        .enumerate()
        .map(|(i, color)| {
            let on_top = computed(move || front.get() == i);
            view()
                .absolute()
                .left(px(4.0 + i as f32 * 28.0))
                .top(px(2.0 + i as f32 * 14.0))
                .w(px(64.0))
                .h(px(52.0))
                .rounded(px(12.0))
                .border_curve(BorderCurve::Continuous)
                .bg(color)
                .border(move || px(if on_top.get() { 2.0 } else { 0.0 }))
                .border_color(colors::TEXT)
                .z_index(0)
                .style_when(on_top, |s| s.z_index(10))
                .shadow_color(rgb(0x000000))
                .shadow_opacity(move || if dark() { 0.5_f32 } else { 0.18 })
                .shadow_radius(px(6.0))
                .shadow_offset(point(px(0.0), px(3.0)))
        });
    Card::new()
        .icon(IconName::Lists)
        .title("Clipping and layers")
        .subtitle("overflow · zIndex · opacity")
        .right(
            toggle()
                .value(clip)
                .label("Clip")
                .on_change(move |&on: &bool| {
                    clip.set(on);
                }),
        )
        .child(
            grid()
                .child(tile(
                    move || if clip.get() { "Clipped" } else { "Visible" },
                    Some(
                        (move || {
                            if clip.get() {
                                "overflow: hidden"
                            } else {
                                "overflow: visible"
                            }
                        })
                        .into_reactive(),
                    ),
                    some(hint("Tap to switch", "Click to switch")),
                    Some(switch.into()),
                    specimen_box()
                        .bg(tints::WARN)
                        .rounded(px(22.0))
                        .border(px(1.5))
                        .border_color(colors::WARN)
                        .style_when(clip, |s| s.overflow_hidden())
                        .child(
                            view()
                                .absolute()
                                .left(px(-26.0))
                                .top(px(-26.0))
                                .size(px(72.0))
                                .rounded(px(36.0))
                                .bg(colors::DANGER),
                        )
                        .child(label(hint("Tap", "Click"), colors::WARN)),
                ))
                .child(tile(
                    "Stacking order",
                    some("zIndex"),
                    Some(
                        (move || format!("Front: {} of 3 · tap", front.get() + 1)).into_reactive(),
                    ),
                    Some(next.into()),
                    // Its squares have no text: tests find it by id.
                    view()
                        .w(px(130.0))
                        .h(px(84.0))
                        .test_id("stacking")
                        .children(squares),
                )),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .child(
                    view()
                        .size(px(64.0))
                        .rounded(px(14.0))
                        .border_curve(BorderCurve::Continuous)
                        .bg(colors::INFO)
                        .bind_opacity(&opacity)
                        .items_center()
                        .justify_center()
                        .child(
                            text(move || LEVELS[level.get() as usize].0)
                                .text_size(px(13.0))
                                .font_weight(FontWeight::BOLD)
                                .text_color(AdaptiveColor::new(rgb(0xffffff), rgb(0x0c1020)))
                                .tabular_nums(),
                        ),
                )
                .child(
                    view()
                        .flex_1()
                        .gap_2()
                        .child(caption("Opacity", Some("Animated natively")))
                        .child(
                            segmented()
                                .options(LEVELS.map(|(l, _)| Segment::new(l)))
                                .selected(level)
                                .on_change(move |&to: &u32| {
                                    level.set(to);
                                    opacity.timing(
                                        LEVELS[to as usize].1,
                                        260.0,
                                        Easing::Curve(Curve::Cubic, EaseMode::Out),
                                    );
                                }),
                        ),
                ),
        )
}

/// 3D transforms: a flip card, a sway, a tilt, a skew, an origin.
fn transforms() -> Card {
    // A slow native sway, so the perspective reads as depth (kept with
    // the page: dropping the last handle releases it).
    let sway = animated_value(-30.0);
    let sin = Easing::Curve(Curve::Sin, EaseMode::InOut);
    let sway_loop = Animation::sequence([
        Animation::timing(&sway, 30.0, Timing::new(2200.0, sin)),
        Animation::timing(&sway, -30.0, Timing::new(2200.0, sin)),
    ])
    .looped(None);
    sway_loop.start();
    stored(sway_loop);
    Card::new()
        .icon(IconName::Physics)
        .title("3D transforms")
        .subtitle("perspective · rotateX/Y · skew · origin")
        .child(flip_card())
        .child(
            grid()
                .child(tile(
                    "Perspective",
                    some("rotateY"),
                    some("Swaying, driven natively"),
                    None,
                    // CSS's `perspective`: the depth of its children.
                    view().perspective(px(400.0)).child(
                        specimen_box()
                            .rounded(px(14.0))
                            .bg(tints::INFO)
                            .border_1()
                            .border_color(colors::INFO)
                            .bind_transform(TransformKind::RotateY, &sway)
                            .child(label("Y axis", colors::INFO)),
                    ),
                ))
                .child(tile(
                    "Tilt",
                    some("rotateX: 40deg"),
                    None,
                    None,
                    view().perspective(px(400.0)).child(
                        specimen_box()
                            .rounded(px(14.0))
                            .bg(tints::ACCENT)
                            .border_1()
                            .border_color(colors::ACCENT)
                            .rotate_x(deg(40.0))
                            .child(label("X axis", colors::ACCENT)),
                    ),
                ))
                .child(tile(
                    "Skew",
                    some("skewX: -12deg"),
                    some("iOS"),
                    None,
                    specimen_box()
                        .rounded(px(10.0))
                        .bg(tints::WARN)
                        .border_1()
                        .border_color(colors::WARN)
                        .skew_x(deg(-12.0))
                        .child(label("Skew", colors::WARN)),
                ))
                .child(tile(
                    "Origin",
                    some("transformOrigin"),
                    some("Top left · rotated 30°"),
                    None,
                    view()
                        .w(px(112.0))
                        .h(px(84.0))
                        .child(
                            view()
                                .absolute()
                                .left(px(30.0))
                                .top(px(14.0))
                                .size(px(54.0))
                                .rounded(px(6.0))
                                .border_1()
                                .border_color(colors::FAINT)
                                .border_dashed(),
                        )
                        .child(
                            view()
                                .absolute()
                                .left(px(30.0))
                                .top(px(14.0))
                                .size(px(54.0))
                                .rounded(px(6.0))
                                .bg(colors::DANGER.opacity(0.55))
                                .origin_top_left()
                                .rotate(deg(30.0)),
                        )
                        .child(
                            view()
                                .absolute()
                                .left(px(26.0))
                                .top(px(10.0))
                                .size(px(8.0))
                                .rounded(px(4.0))
                                .bg(colors::TEXT),
                        ),
                )),
        )
}

fn numerals() -> Card {
    let figure = |n: &'static str| {
        text(n)
            .text_size(px(22.0))
            .text_color(colors::TEXT)
            .font_weight(FontWeight::MEDIUM)
    };
    let rule = || view().h(px(1.0)).bg(colors::LINE);
    Card::new()
        .icon(IconName::Text)
        .title("Numerals")
        .subtitle("fontVariant")
        .child(
            view()
                .flex_row()
                .gap_3()
                .child(
                    view()
                        .flex_1()
                        .gap_1()
                        .child(
                            text("Proportional")
                                .text_size(px(12.0))
                                .text_color(colors::MUTED),
                        )
                        .child(figure("1,111.11"))
                        .child(figure("8,888.88")),
                )
                .child(view().w(px(1.0)).bg(colors::LINE))
                .child(
                    view()
                        .flex_1()
                        .gap_1()
                        .child(
                            text("tabular-nums")
                                .text_size(px(12.0))
                                .text_color(colors::ACCENT)
                                .font_family(MONO),
                        )
                        .child(figure("1,111.11").tabular_nums())
                        .child(figure("8,888.88").tabular_nums()),
                ),
        )
        .child(rule())
        .child(caption_spans(
            text("Small Caps")
                .text_size(px(18.0))
                .text_color(colors::TEXT)
                .small_caps(),
            "small-caps",
        ))
        .child(caption_spans(
            text("Oldstyle 1234567890")
                .text_size(px(18.0))
                .text_color(colors::TEXT)
                .oldstyle_nums(),
            "oldstyle-nums",
        ))
}

/// Rows, `marginStart` and text under a right-to-left layout.
fn right_to_left() -> Card {
    let boxes = [colors::DANGER, colors::INFO, colors::UP]
        .into_iter()
        .enumerate()
        .map(|(i, color)| {
            view()
                .size(px(44.0))
                .rounded(px(10.0))
                .rounded_ss(px(22.0))
                .items_center()
                .justify_center()
                .bg(color)
                .when(i == 0, |v| v.ms(px(16.0)))
                .child(
                    text((i + 1).to_string())
                        .text_color(AdaptiveColor::new(rgb(0xffffff), rgb(0x0c0d0f)))
                        .font_weight(FontWeight::BOLD)
                        .text_size(px(15.0)),
                )
        });
    let chip = |n: Reactive<SharedString>, fill: AdaptiveColor, fg: AdaptiveColor| {
        view()
            .size(px(40.0))
            .rounded(px(10.0))
            .border_curve(BorderCurve::Continuous)
            .items_center()
            .justify_center()
            .bg(fill)
            .child(text(n).text_size(px(13.0)).text_color(fg).tabular_nums())
    };
    let mono_note = |label: &'static str, note: &'static str| caption_spans(text(label), note);
    // The card's content in a direction of its own: the app's follows the
    // user's language.
    let rtl = signal(false);
    let flip = move |_: &()| rtl.set(!rtl.get());
    let content = view()
        .gap(px(12.0))
        .direction(move || {
            if rtl.get() {
                LayoutDirection::Rtl
            } else {
                LayoutDirection::Ltr
            }
        })
        .child(view().flex_row().gap_2().children(boxes))
            .child(
                text(
                    "Text aligns to the start side; the first box has marginStart 16 and a round top-start corner.",
                )
                .text_size(px(15.0))
                .line_height(px(21.0))
                .text_color(colors::TEXT),
            )
            .child(mono_note("Horizontal scroll view", "Scroll"))
            .child(
                scroll()
                    .horizontal()
                    .scrollbar(false)
                    .h(px(40.0))
                    .child(
                        view()
                            .flex_row()
                            .gap(px(6.0))
                            .children((1..=12).map(|n| chip(n.to_string().into_reactive(), tints::INFO, colors::INFO))),
                    ),
            )
            .child(mono_note("Horizontal list", "List"))
            .child(
                virtual_list(30, move |at| {
                    // A cell shows the row its position says (cells are
                    // recycled).
                    let label = move || SharedString::from((at.index() + 1).to_string());
                    chip(label.into_reactive(), tints::ACCENT, colors::ACCENT).me(px(6.0))
                })
                .horizontal()
                .estimated_item_size(px(46.0))
                .scrollbar(false)
                .h(px(40.0)),
            )
            .child(view().h(px(1.0)).bg(colors::LINE))
            .child(
                text("textAlign left (the start side right to left)")
                    .text_size(px(13.0))
                    .text_left()
                    .text_color(colors::MUTED),
            )
            .child(
                text("مرحبا بالعالم — writingDirection rtl")
                    .text_size(px(13.0))
                    .writing_direction(WritingDirection::Rtl)
                    .text_color(colors::MUTED),
            );
    Card::new()
        .icon(IconName::Nav)
        .title("Right to left")
        .subtitle(move || {
            if rtl.get() {
                "direction: rtl"
            } else {
                "direction: ltr"
            }
        })
        .right(Button::new("Flip", flip).variant(ButtonVariant::Secondary))
        .child(content)
}

/// The demo's page.
#[component]
pub(crate) fn Styles() -> impl IntoElement {
    DemoPage::new().cards([
        corners,
        borders,
        shadows,
        layers,
        transforms,
        numerals,
        right_to_left,
    ])
}
