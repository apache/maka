//! A Rust app's typed styles and texts end to end: effects reach the
//! platform as the same view styles classes make, a group's press restyles
//! what is inside it natively, and a text's spans are one paragraph whose
//! links take presses.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, AttributedText, EventKind, EventPayload, MountBatch, MountItem, Size,
    ViewStyle,
    element::{
        Root,
        palette::{SKY, VIOLET, ZINC},
    },
    prelude::*,
    tailwind::state,
};
use nsh_engine::{App, Engine, EngineConfig, Environment};

use crate::ChannelSink;

#[component]
fn Card() -> impl IntoElement {
    let taps = signal(0);
    view()
        .flex_1()
        .child(
            view()
                .group()
                .p_4()
                .rounded_tl(px(20.0))
                .border_t(px(4.0))
                .border_dashed()
                .bg_linear_to_br()
                .gradient_from(SKY.shade(400))
                .gradient_to(VIOLET.shade(600))
                .shadow_lg()
                .shadow_color(SKY.shade(500).opacity(0.5))
                .ring(px(2.0))
                .ring_color(SKY.shade(500))
                .perspective(px(400.0))
                .rotate_y(deg(20.0))
                .animate_pulse()
                .child(
                    text("In the group")
                        .text_color(ZINC.shade(500))
                        .group_active(|s| s.text_color(VIOLET.shade(600))),
                ),
        )
        .child(
            text(move || format!("Tapped {} times: ", taps.get()))
                .child(
                    text("tap")
                        .underline()
                        .line_through()
                        .on_press(move |_: &()| taps.update(|t| *t += 1)),
                )
                .child(" or ")
                .child(text("not").font_weight(FontWeight::BOLD)),
        )
}

fn start() -> (Engine, Receiver<MountBatch>) {
    start_root(Root::new::<Card>(|| ()))
}

fn start_root(root: Root) -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(root),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// What the batches within a moment send: view styles, text blocks and
/// the views whose states the platform must report.
#[derive(Default)]
struct Seen {
    styles: Vec<(u32, ViewStyle)>,
    texts: Vec<(u32, std::sync::Arc<AttributedText>)>,
    tracked: Vec<u32>,
}

fn seen(rx: &Receiver<MountBatch>) -> Seen {
    let mut seen = Seen::default();
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
        for item in &batch.items {
            match item {
                MountItem::ViewStyle { id, style } => seen.styles.push((*id, (**style).clone())),
                MountItem::Text { id, text, .. } => seen.texts.push((*id, text.clone())),
                MountItem::TrackStates { id, states } if states & state::PRESSED != 0 => {
                    seen.tracked.push(*id)
                }
                _ => {}
            }
        }
    }
    seen
}

#[test]
fn a_rust_apps_typed_styles_and_spans_reach_the_platform() {
    let (engine, rx) = start();
    let first = seen(&rx);
    let (group, card) = first
        .styles
        .iter()
        .find(|(_, s)| {
            s.effects
                .as_ref()
                .is_some_and(|e| !e.background_images.is_empty())
        })
        .expect("the card's gradient");
    let effects = card.effects.as_ref().unwrap();
    // The shadow's two layers and the ring.
    assert_eq!(effects.box_shadows.len(), 3);
    assert_eq!(card.borders.widths.top.0, 4.0);
    assert_eq!(card.borders.style, nsh_core::BorderStyle::Dashed);
    assert_eq!(card.corner_radius.top_left, Some(nsh_core::Points(20.0)));
    // Its perspective is its children's (CSS's `perspective`).
    assert_eq!(card.transform.ops().len(), 1, "rotateY");
    assert_eq!(
        card.animation.map(|a| a.keyframes),
        Some(nsh_core::Keyframes::Pulse)
    );
    assert!(first.tracked.contains(group), "a group reports its presses");

    let sentence = first
        .texts
        .iter()
        .find(|(_, t)| t.text.starts_with("Tapped"))
        .map(|(_, t)| t.clone())
        .expect("the sentence");
    assert_eq!(sentence.text, "Tapped 0 times: tap or not");
    let link = &sentence.links[0];
    let tap = sentence
        .spans
        .iter()
        .find(|s| s.start == link.start)
        .unwrap();
    assert!(tap.style.decoration.underline && tap.style.decoration.line_through);

    // The group pressed: the text inside it turns violet, with no render.
    engine.control().set_states(*group, state::PRESSED);
    let pressed = seen(&rx);
    let inside = pressed
        .texts
        .iter()
        .find(|(_, t)| t.text == "In the group")
        .expect("restyled");
    assert_eq!(inside.1.spans[0].style.color, VIOLET.shade(600).into());

    // The link takes the press, not the sentence.
    engine
        .control()
        .dispatch_event(link.node, EventKind::Press, EventPayload::None);
    let tapped = seen(&rx);
    assert!(
        tapped
            .texts
            .iter()
            .any(|(_, t)| t.text == "Tapped 1 times: tap or not")
    );
}

/// `nsh/base`'s `Button` styled per state by a Rust app, as a TSX app's
/// `active:` / `selected:` classes style it. (Its `selected` prop's setter
/// comes before `Styled::selected`, the state's style.)
#[component]
fn Buttons() -> impl IntoElement {
    let button = |selected: bool| {
        let button = nsh_base::button()
            .selected(selected)
            .p_2()
            .bg(rgb(0x0000ff))
            .active(|s| s.bg(rgb(0xff0000)))
            .child(text(if selected { "On" } else { "Off" }));
        Styled::selected(button, |s| s.bg(rgb(0x00ff00)))
    };
    view().flex_1().child(button(false)).child(button(true))
}

#[test]
fn a_rust_apps_button_takes_its_state_styles() {
    let (engine, rx) = start_root(Root::new::<Buttons>(|| ()));
    let first = seen(&rx);
    let background = |seen: &Seen, id: u32| {
        seen.styles
            .iter()
            .rev()
            .find(|(i, _)| *i == id)
            .map(|(_, s)| s.background_color)
    };
    let (blue, green, red) = (
        nsh_core::Color(0x0000ffff),
        nsh_core::Color(0x00ff00ff),
        nsh_core::Color(0xff0000ff),
    );
    // Both buttons report their presses; the selected one is green.
    assert_eq!(first.tracked.len(), 2);
    let plain = *first
        .tracked
        .iter()
        .find(|&&id| background(&first, id) == Some(blue))
        .expect("the plain button");
    assert!(
        first
            .tracked
            .iter()
            .any(|&id| background(&first, id) == Some(green)),
        "selected:"
    );
    // Pressed: red, natively.
    engine.control().set_states(plain, state::PRESSED);
    assert_eq!(background(&seen(&rx), plain), Some(red));
    engine.control().set_states(plain, 0);
    assert_eq!(background(&seen(&rx), plain), Some(blue));
}

/// `nsh/base`'s `Button` heard by a Rust app through its event's listener
/// method, as `onPress` in TSX (styled while pressed, so its view's id
/// shows in the states the platform reports).
#[component]
fn PressedButton() -> impl IntoElement {
    let presses = signal(0);
    view()
        .flex_1()
        .child(
            nsh_base::button()
                .active(|s| s.opacity(0.5))
                .on_press(move || presses.update(|n| *n += 1))
                .child(text("Press")),
        )
        .child(text(move || format!("pressed {}", presses.get())))
}

#[test]
fn a_rust_apps_button_hears_its_press() {
    let (engine, rx) = start_root(Root::new::<PressedButton>(|| ()));
    let first = seen(&rx);
    assert_eq!(first.tracked.len(), 1, "the button");
    engine
        .control()
        .dispatch_event(first.tracked[0], EventKind::Press, EventPayload::None);
    assert!(seen(&rx).texts.iter().any(|(_, t)| t.text == "pressed 1"));
}

/// `nsh/base`'s `Switch` styled by a Rust app (as its page shows it): its
/// track's typed style takes a `checked` variant that follows the switch,
/// as a TSX app's `checked:` classes in `trackClass` do.
#[component]
fn Switches() -> impl IntoElement {
    let switch = |checked: bool| {
        let on = signal(checked);
        nsh_base::switch()
            .checked(on)
            .on_change(move |next: &bool| on.set(*next))
            .flex_row()
            .items_center()
            .gap_3()
            .track_style(|s| {
                s.w(px(44.0))
                    .p(px(2.0))
                    .rounded_full()
                    .bg(rgb(0x0000ff))
                    .transition_colors()
                    .checked(|s| s.bg(rgb(0x00ff00)))
            })
            .thumb_style(|s| {
                s.size(px(20.0))
                    .rounded_full()
                    .bg(white())
                    .shadow_sm()
                    .transition_transform()
                    .checked(|s| s.translate_x(px(20.0)))
            })
            .child(text("Wi-Fi"))
    };
    view().flex_1().child(switch(false)).child(switch(true))
}

#[test]
fn a_rust_apps_switch_styles_its_parts_by_its_value() {
    let (_engine, rx) = start_root(Root::new::<Switches>(|| ()));
    let first = seen(&rx);
    let backgrounds: Vec<u32> = first
        .styles
        .iter()
        .map(|(_, s)| s.background_color.0)
        .collect();
    for color in [0x0000_ffff, 0x00ff_00ff] {
        assert_eq!(
            backgrounds.iter().filter(|&&c| c == color).count(),
            1,
            "{color:08x} in {backgrounds:08x?}"
        );
    }
}

/// `nsh/base`'s `Checkbox` styled by a Rust app (as its page shows it): its
/// indicator's typed style takes `checked` and `indeterminate` variants
/// that follow the checkbox, as a TSX app's classes in `indicatorClass` do,
/// and its mark is the app's element in the indicator.
#[component]
fn Checkboxes() -> impl IntoElement {
    let checkbox = |checked: bool, indeterminate: bool| {
        let on = signal(checked);
        nsh_base::checkbox()
            .checked(on)
            .indeterminate(indeterminate)
            .on_change(move |next: &bool| on.set(*next))
            .flex_row()
            .items_center()
            .gap_2()
            .indicator_style(|s| {
                s.size(px(20.0))
                    .items_center()
                    .justify_center()
                    .rounded(px(4.0))
                    .border_2()
                    .border_color(rgb(0xa1a1aa))
                    .bg(rgb(0x0000ff))
                    .transition_colors()
                    .checked(|s| s.bg(rgb(0x00ff00)))
                    .indeterminate(|s| s.bg(rgb(0xff0000)))
            })
            .indicator(text(move || if on.get() { "✓" } else { "-" }).text_color(white()))
            .child(text("Notify me"))
    };
    view()
        .flex_1()
        .child(checkbox(false, false))
        .child(checkbox(true, false))
        .child(checkbox(true, true))
}

#[test]
fn a_rust_apps_checkbox_styles_its_indicator_by_its_value() {
    let (_engine, rx) = start_root(Root::new::<Checkboxes>(|| ()));
    let first = seen(&rx);
    let backgrounds: Vec<u32> = first
        .styles
        .iter()
        .map(|(_, s)| s.background_color.0)
        .collect();
    for color in [0x0000_ffff, 0x00ff_00ff, 0xff00_00ff] {
        assert_eq!(
            backgrounds.iter().filter(|&&c| c == color).count(),
            1,
            "{color:08x} in {backgrounds:08x?}"
        );
    }
    let marks = |mark: &str| first.texts.iter().filter(|(_, t)| t.text == mark).count();
    assert_eq!((marks("-"), marks("✓")), (1, 2));
}

/// `nsh/base`'s `Radio` in a `RadioGroup` from a Rust app (as its page
/// shows it): the app's value checks one radio, and the dot inside each
/// follows it.
#[component]
fn Radios() -> impl IntoElement {
    let plan = signal("basic");
    let option = move |value: &'static str, label: &'static str| {
        let checked = move || plan.get() == value;
        nsh_base::radio()
            .checked(checked)
            .on_change(move |_: &bool| plan.set(value))
            .flex_row()
            .items_center()
            .gap_2()
            .child(
                view()
                    .size(px(20.0))
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .border_2()
                    .border_color(rgb(0xa1a1aa))
                    .child(
                        view()
                            .size(px(10.0))
                            .rounded_full()
                            .bg(rgb(0x2563eb))
                            .opacity(move || if checked() { 1.0_f32 } else { 0.0 }),
                    ),
            )
            .child(text(label))
    };
    nsh_base::radio_group()
        .gap_3()
        .child(option("basic", "Basic"))
        .child(option("pro", "Pro"))
}

#[test]
fn a_rust_apps_radios_show_the_apps_value() {
    let (_engine, rx) = start_root(Root::new::<Radios>(|| ()));
    let first = seen(&rx);
    let dots: Vec<f32> = first
        .styles
        .iter()
        .filter(|(_, s)| s.background_color.0 == 0x2563_ebff)
        .map(|(_, s)| s.opacity)
        .collect();
    assert_eq!(dots, [1.0, 0.0]);
}

/// `nsh/base`'s `Tab` in `Tabs` from a Rust app (as its page shows it):
/// the app's value selects one tab, whose `selected_style` applies.
#[component]
fn Sections() -> impl IntoElement {
    let current = signal("overview");
    let section = move |value: &'static str, label: &'static str| {
        let selected = move || current.get() == value;
        nsh_base::tab()
            .selected(selected)
            .on_press(move |_: &()| current.set(value))
            .rounded(move || nsh_base::theme().radius)
            .px_3()
            .py_2()
            .selected_style(|s| s.bg(rgb(0x2563eb)))
            .child(text(label).text_sm().text_color(move || {
                if selected() {
                    nsh_base::theme().foreground
                } else {
                    nsh_base::theme().muted_foreground
                }
            }))
    };
    view()
        .gap_4()
        .child(
            nsh_base::tabs()
                .flex_row()
                .self_start()
                .gap_1()
                .p_1()
                .rounded(move || nsh_base::theme().radius)
                .bg(move || nsh_base::theme().muted)
                .child(section("overview", "Overview"))
                .child(section("activity", "Activity")),
        )
        .child(
            text(move || {
                if current.get() == "overview" {
                    "Visitors, sign-ups and conversion this week."
                } else {
                    "Deploys, invoices and new members, newest first."
                }
            })
            .text_color(move || nsh_base::theme().foreground),
        )
}

#[test]
fn a_rust_apps_tabs_show_the_apps_value() {
    let (_engine, rx) = start_root(Root::new::<Sections>(|| ()));
    let first = seen(&rx);
    let selected = first
        .styles
        .iter()
        .filter(|(_, s)| s.background_color.0 == 0x2563_ebff)
        .count();
    assert_eq!(selected, 1);
}
