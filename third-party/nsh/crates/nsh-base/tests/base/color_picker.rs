//! `ColorPicker`: its parts change one color, which the app owns; a swatch
//! picks its color, a field reads any CSS form when it is submitted, a
//! slider's drag reports each color then the end once, and a channel's
//! field keeps the number typed, an eyedropper picks a color on the screen
//! where the platform has one; a disabled picker takes none of it. In a
//! right-to-left layout a horizontal slider and the area run from the
//! right: their thumbs sit from it, a drag to the left raises them and
//! Left and Right trade places, as they do in `Slider`.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{
    ColorChannel, ColorFormat, ColorPickerEvent, ColorSpace, color_area, color_eye_dropper,
    color_field, color_picker, color_slider, color_swatch,
};
use nsh_core::{MountItem, NodeId, Size, element::Root, geometry::point, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, Screen};

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

/// The harness on a headless macOS surface (Tab stops at the thumbs: the
/// area's, the hue's, the alpha's), in a right-to-left layout with `rtl`.
fn start_in(rtl: bool) -> Headless {
    let props = HarnessProps {
        format: ColorFormat::Hex,
        disabled: false,
    };
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    config.environment.rtl = rtl;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ends").unwrap();
    app
}

/// The colors `onChangeEnd` reported, in order.
fn ends(screen: &Screen) -> Vec<String> {
    screen
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("Ends"))
        .map(|t| {
            t.split(", ")
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A picker of `#3b82f6` with one part that takes the keyboard focus: the
/// area (`area`) or HSB's hue on a track 200 long, its thumb
/// `focus:opacity-50`, after a preview swatch (no `color`), which has
/// nothing to press and so is no Tab stop; the ends `onChangeEnd` reported.
#[derive(Clone, PartialEq, Props)]
struct KeysProps {
    area: bool,
}

#[component]
fn Keys(props: KeysProps) -> impl IntoElement {
    let area = props.area;
    let color = signal(Hsla::from(rgb(0x3b82f6)));
    let ends = signal(Vec::<String>::new());
    let picker = color_picker()
        .value(move || Some(color.get()))
        .on_change(move |e: &ColorPickerEvent| {
            if let ColorPickerEvent::Change(value, _) = e {
                color.set(*value);
            }
        })
        .on_change_end(move |e: &ColorPickerEvent| {
            if let ColorPickerEvent::ChangeEnd(_, formatted) = e {
                ends.update(|log| log.push(formatted.to_string()));
            }
        })
        .child(
            color_swatch()
                .accessibility_label("Current color")
                .size(px(20.0)),
        );
    let picker = if area {
        picker.child(
            color_area()
                .accessibility_label("Part")
                .w(px(200.0))
                .h(px(100.0))
                .thumb_class("focus:opacity-50")
                .thumb_style(|s| s.size(px(10.0))),
        )
    } else {
        picker.child(
            color_slider()
                .color_space(ColorSpace::Hsb)
                .channel(ColorChannel::Hue)
                .accessibility_label("Part")
                .w(px(200.0))
                .h(px(20.0))
                .justify_center()
                .track_style(|s| s.h(px(10.0)))
                .thumb_class("focus:opacity-50")
                .thumb_style(|s| s.size(px(10.0))),
        )
    };
    view()
        .child(picker)
        .child(text(move || format!("Ends {}", ends.get().join(", "))))
}

/// The ends `keys` report on the area's thumb (`area`) or the hue's, which
/// Tab gives the keyboard focus first (past the preview swatch), in a left-to-right or right-to-left
/// layout (on a headless macOS surface, where Tab stops at them).
fn ends_after_keys(area: bool, rtl: bool, keys: &[&str]) -> Vec<String> {
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Keys>(move || KeysProps { area }))
    };
    config.environment.os = Os::MacOs;
    config.environment.rtl = rtl;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ends").unwrap();
    let thumb = app
        .screen()
        .press_target("label:Part")
        .unwrap()
        .expect("a thumb");
    let opacity = Arc::new(Mutex::new(1.0_f32));
    let into = opacity.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item
                && *id == thumb
            {
                *into.lock().unwrap() = style.opacity;
            }
        }
    });
    app.press_key("tab").unwrap();
    app.wait_until(
        "Tab gives the thumb the keyboard focus (`focus:`)",
        Duration::from_secs(5),
        move |_| *opacity.lock().unwrap() < 1.0,
    )
    .unwrap();
    for key in keys {
        app.press_key(key).unwrap();
    }
    let n = keys.len();
    app.wait_until("an end per key", Duration::from_secs(5), move |s| {
        ends(s).len() == n
    })
    .unwrap();
    ends(app.screen())
}

/// The end a drag by `by` from the thumb `selector` names reports, in a
/// left-to-right or right-to-left layout.
fn end_after_drag(rtl: bool, selector: &str, by: f32) -> String {
    let mut app = start_in(rtl);
    app.drag(selector, point(px(by), px(0.0))).unwrap();
    app.wait_until("the drag's end", Duration::from_secs(5), |s| {
        ends(s).len() == 1
    })
    .unwrap();
    ends(app.screen()).remove(0)
}

#[test]
fn right_to_left_left_and_right_trade_places_on_the_area() {
    // Left raises the saturation as Right does left to right; Up keeps
    // the brightness.
    assert_eq!(
        ends_after_keys(true, true, &["left", "shift+left", "right", "up"]),
        ends_after_keys(true, false, &["right", "shift+right", "left", "up"]),
    );
    assert_ne!(
        ends_after_keys(true, true, &["left"]),
        ends_after_keys(true, true, &["right"]),
    );
}

#[test]
fn right_to_left_left_and_right_trade_places_on_a_horizontal_slider() {
    // Left raises the hue, Right lowers it; Down and Home keep theirs.
    assert_eq!(
        ends_after_keys(
            false,
            true,
            &["left", "shift+left", "right", "down", "home"]
        ),
        ends_after_keys(
            false,
            false,
            &["right", "shift+right", "left", "down", "home"]
        ),
    );
    assert_ne!(
        ends_after_keys(false, true, &["left"]),
        ends_after_keys(false, true, &["right"]),
    );
}

#[test]
fn right_to_left_a_drag_to_the_left_raises_a_slider_and_the_saturation() {
    // Past the alpha's end, to the left: fully transparent left to right,
    // the right end (opaque) right to left.
    assert_eq!(end_after_drag(true, "label:Alpha", 300.0), "#3b82f600");
    assert_eq!(
        end_after_drag(true, "label:Hue", -300.0),
        end_after_drag(false, "label:Hue", 300.0),
    );
    assert_eq!(
        end_after_drag(true, "label:Area", 300.0),
        end_after_drag(false, "label:Area", -300.0),
    );
}

#[test]
fn right_to_left_the_thumbs_sit_from_the_right() {
    let mut app = start_in(false);
    let lefts = Arc::new(Mutex::new(Vec::<(NodeId, f32)>::new()));
    let thumbs: Vec<NodeId> = ["label:Area", "label:Hue"]
        .into_iter()
        .map(|selector| {
            app.screen()
                .press_target(selector)
                .unwrap()
                .expect("a thumb")
        })
        .collect();
    let into = lefts.clone();
    let watched = thumbs.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::Frame { id, frame } = item
                && watched.contains(id)
            {
                into.lock().unwrap().push((*id, frame.origin.x.0));
            }
        }
    });
    let left_of = |thumb: NodeId| {
        lefts
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(id, _)| *id == thumb)
            .map(|(_, x)| *x)
    };
    // #3b82f6: 76% saturation, a hue of 217.2° (60% of 360), along 200.
    app.set_environment("rtl", |env| env.rtl = true).unwrap();
    app.settle();
    let area = left_of(thumbs[0]).expect("the area's thumb moved");
    let hue = left_of(thumbs[1]).expect("the hue's thumb moved");
    assert!((area - 48.0).abs() < 1.0, "{area}");
    assert!((hue - 79.3).abs() < 1.0, "{hue}");
    app.set_environment("ltr", |env| env.rtl = false).unwrap();
    app.settle();
    let area = left_of(thumbs[0]).unwrap();
    let hue = left_of(thumbs[1]).unwrap();
    assert!((area - 152.0).abs() < 1.0, "{area}");
    assert!((hue - 120.7).abs() < 1.0, "{hue}");
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
