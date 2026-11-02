//! `ColorPicker`: its parts change one color, which the app owns; a swatch
//! picks its color, a field reads any CSS form when it is submitted, a
//! slider's drag reports each color then the end once, and a channel's
//! field keeps the number typed, an eyedropper picks a color on the screen
//! where the platform has one; a disabled picker takes none of it.

use nsh_base::{
    ColorChannel, ColorFormat, ColorPickerEvent, ColorSpace, color_area, color_eye_dropper,
    color_field, color_picker, color_slider, color_swatch,
};
use nsh_core::{Size, element::Root, geometry::point, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    format: ColorFormat,
    disabled: bool,
}

/// A picker of `#3b82f6` with an area, HSB's hue and the alpha on tracks
/// 200 long, the color's field, OKLCH's lightness as a number and a red
/// swatch; the color the app keeps and the ends `onChangeEnd` reported.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let color = signal(Hsla::from(rgb(0x3b82f6)));
    let changes = signal(0usize);
    let ends = signal(Vec::<String>::new());
    view()
        .child(
            color_picker()
                .value(move || Some(color.get()))
                .format(props.format)
                .disabled(props.disabled)
                .on_change(move |e: &ColorPickerEvent| {
                    if let ColorPickerEvent::Change(value, _) = e {
                        color.set(*value);
                        changes.update(|n| *n += 1);
                    }
                })
                .on_change_end(move |e: &ColorPickerEvent| {
                    if let ColorPickerEvent::ChangeEnd(_, formatted) = e {
                        ends.update(|log| log.push(formatted.to_string()));
                    }
                })
                .child(
                    color_area()
                        .accessibility_label("Area")
                        .w(px(200.0))
                        .h(px(100.0))
                        .thumb_style(|s| s.size(px(10.0))),
                )
                .child(
                    color_slider()
                        .color_space(ColorSpace::Hsb)
                        .channel(ColorChannel::Hue)
                        .accessibility_label("Hue")
                        .w(px(200.0))
                        .h(px(20.0))
                        .justify_center()
                        .track_style(|s| s.h(px(10.0)))
                        .thumb_style(|s| s.size(px(10.0))),
                )
                .child(
                    color_slider()
                        .channel(ColorChannel::Alpha)
                        .accessibility_label("Alpha")
                        .w(px(200.0))
                        .h(px(20.0))
                        .justify_center()
                        .track_style(|s| s.h(px(10.0)))
                        .thumb_style(|s| s.size(px(10.0))),
                )
                .child(
                    color_field()
                        .accessibility_label("Color")
                        .w(px(200.0))
                        .h(px(30.0)),
                )
                .child(
                    color_field()
                        .color_space(ColorSpace::Oklch)
                        .channel(ColorChannel::Lightness)
                        .accessibility_label("Lightness")
                        .w(px(200.0))
                        .h(px(30.0)),
                )
                .child(
                    color_swatch()
                        .color(Some(rgb(0xff0000).into()))
                        .accessibility_label("Red")
                        .size(px(20.0)),
                )
                .child(
                    color_eye_dropper()
                        .accessibility_label("Pick from screen")
                        .size(px(20.0)),
                ),
        )
        .child(text(move || format!("Ends {}", ends.get().join(", "))))
        .child(text(move || {
            if changes.get() > 0 {
                "Changed"
            } else {
                "Unchanged"
            }
        }))
}

fn start(format: ColorFormat, disabled: bool) -> Headless {
    let props = HarnessProps { format, disabled };
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ends").unwrap();
    app
}

#[test]
fn a_swatch_and_a_typed_color_change_the_color_the_app_keeps() {
    let mut app = start(ColorFormat::Hex, false);
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 3);
    app.press("label:Red").unwrap();
    app.wait_for("text:Ends #ff0000").unwrap();
    assert!(app.shows("Changed"));
    // Any CSS form, read when the field is submitted.
    app.clear("label:Color").unwrap();
    app.type_text("label:Color", "rgb(0 128 255)").unwrap();
    app.submit("label:Color").unwrap();
    app.wait_for("text:Ends #ff0000, #0080ff").unwrap();
}

#[test]
fn a_slider_drag_reports_the_color_then_its_end_once() {
    let mut app = start(ColorFormat::Hex, false);
    // Past the alpha's start: fully transparent.
    app.drag("label:Alpha", point(px(-300.0), px(0.0))).unwrap();
    app.wait_for("text:Ends #3b82f600").unwrap();
}

#[test]
fn a_channel_typed_is_kept_in_its_space() {
    let mut app = start(ColorFormat::Oklch, false);
    app.clear("label:Lightness").unwrap();
    app.type_text("label:Lightness", "70").unwrap();
    app.submit("label:Lightness").unwrap();
    app.wait_for("text:Ends oklch(70% 0.188 259.8)").unwrap();
}

#[test]
fn a_disabled_picker_takes_no_changes() {
    let mut app = start(ColorFormat::Hex, true);
    // Its parts say so to screen readers, as the picker's own state.
    for part in ["label:Area", "label:Hue", "label:Alpha", "label:Color"] {
        let state = app.screen().accessibility_state(part).unwrap();
        assert!(state.disabled, "{part}");
    }
    app.press("label:Red").unwrap();
    app.drag("label:Alpha", point(px(-300.0), px(0.0))).unwrap();
    app.settle();
    assert!(app.shows("Unchanged"));
}

#[test]
fn an_eyedropper_picks_a_color_on_the_screen_where_the_platform_has_one() {
    let mut app = start(ColorFormat::Hex, false);
    // No eyedropper on this platform: disabled.
    assert!(!app.screen().enabled("label:Pick from screen").unwrap());
    app.on_screen_color(Some(rgb(0x22c55e).into())).unwrap();
    assert!(app.screen().enabled("label:Pick from screen").unwrap());
    app.press("label:Pick from screen").unwrap();
    app.wait_for("text:Ends #22c55e").unwrap();
    // Cancelled: nothing changes.
    app.on_screen_color(None).unwrap();
    app.press("label:Pick from screen").unwrap();
    app.settle();
    assert!(app.shows("Ends #22c55e"));
    assert!(!app.shows("#22c55e, "));
}

/// A picker whose app sets the colors back late, as their text: they
/// wait until `catch-up` is pressed, as events reach a JS app after the
/// user's next keys may have.
#[component]
fn Late() -> impl IntoElement {
    let color = signal(Hsla::from(rgb(0x3b82f6)));
    let queued = stored(Vec::<String>::new());
    let ends = signal(Vec::<String>::new());
    view()
        .child(
            color_picker()
                .value(move || Some(color.get()))
                .format(ColorFormat::Oklch)
                .on_change(move |e: &ColorPickerEvent| {
                    if let ColorPickerEvent::Change(_, formatted) = e {
                        queued.with(|queued| queued.push(formatted.to_string()));
                    }
                })
                .on_change_end(move |e: &ColorPickerEvent| {
                    if let ColorPickerEvent::ChangeEnd(_, formatted) = e {
                        ends.update(|log| log.push(formatted.to_string()));
                    }
                })
                .child(
                    color_field()
                        .color_space(ColorSpace::Oklch)
                        .channel(ColorChannel::Lightness)
                        .accessibility_label("Lightness")
                        .w(px(200.0))
                        .h(px(30.0)),
                ),
        )
        .child(view().test_id("catch-up").size(px(20.0)).on_press(move || {
            for formatted in queued.replace(Vec::new()) {
                color.set(formatted.parse().unwrap());
            }
        }))
        .child(text(move || format!("Ends {}", ends.get().join(", "))))
}

#[test]
fn colors_the_app_sets_back_late_keep_the_channels_set_since() {
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::of::<Late>())
    };
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ends").unwrap();
    app.clear("label:Lightness").unwrap();
    app.type_text("label:Lightness", "7").unwrap();
    app.type_text("label:Lightness", "0").unwrap();
    // 7% then 70%, set back after both.
    app.press("id:catch-up").unwrap();
    app.submit("label:Lightness").unwrap();
    app.wait_for("text:Ends oklch(70% 0.188 259.8)").unwrap();
}
