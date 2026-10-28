//! `NumberInput`: typing keeps a number or the text on the way to one and
//! reports the number it reads as, refusing anything else (other
//! keyboards' digits read as ASCII); the buttons, Up / Down and Page Up /
//! Page Down step it with the step's decimals and stop at `min` / `max`,
//! the buttons leaving the focus in the field and disabled where a step
//! does nothing; leaving the field or Enter holds a typed value to the
//! range; the app owns a controlled value (what it refuses goes when the
//! field is left, what it sets shows), and an uncontrolled input keeps its
//! own; a disabled or read-only input takes none of it.

use nsh_base::number_input;
use nsh_core::{Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The value at first.
    value: Option<f64>,
    min: Option<f64>,
    max: Option<f64>,
    step: f64,
    /// The app keeps its value whatever the user asks.
    refusing: bool,
    /// The input owns the value, from `defaultValue`.
    uncontrolled: bool,
    disabled: bool,
    readonly: bool,
    controls_right: bool,
    /// A prefix `about` and a suffix `kg` around the field.
    affixes: bool,
}

/// The app owns `value` and sets the one `onChange` reports.
fn controlled(value: Option<f64>) -> HarnessProps {
    HarnessProps {
        value,
        min: None,
        max: None,
        step: 1.0,
        refusing: false,
        uncontrolled: false,
        disabled: false,
        readonly: false,
        controls_right: false,
        affixes: false,
    }
}

/// `5`, `none`.
fn show(value: Option<f64>) -> String {
    value.map_or_else(|| "none".to_owned(), |v| format!("{v}"))
}

/// A number input labelled `Quantity` with the buttons `Less` and `More`,
/// then a `Done` button (a stop for Tab to leave the field to), `Reset`
/// (the app sets 42) and `Clear` (the app sets none); the app's value, the
/// values `onChange` reported and the focus, blur and submit events.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(props.value);
    let changes = signal(Vec::<String>::new());
    let events = signal(Vec::<String>::new());
    let follows = !props.refusing && !props.uncontrolled;
    let log = move |e: String| events.update(|all| all.push(e));
    let el = number_input()
        .min(props.min)
        .max(props.max)
        .step(props.step)
        .disabled(props.disabled)
        .readonly(props.readonly)
        .controls_right(props.controls_right)
        .accessibility_label("Quantity")
        .placeholder("Amount")
        .decrement_button(text("Less"))
        .increment_button(text("More"))
        .input_style(|s| s.w(px(100.0)).h(px(30.0)))
        .decrement_button_style(|s| s.size(px(30.0)))
        .increment_button_style(|s| s.size(px(30.0)))
        .on_change(move |v: &Option<f64>| {
            changes.update(|c| c.push(show(*v)));
            if follows {
                value.set(*v);
            }
        })
        .on_focus(move || log("focus".into()))
        .on_blur(move || log("blur".into()))
        .on_submit(move |v: &Option<f64>| log(format!("submit {}", show(*v))));
    let el = if props.affixes {
        el.prefix(text("about")).suffix(text("kg"))
    } else {
        el
    };
    let el = if props.uncontrolled {
        el.default_value(props.value)
    } else {
        el.value(move || value.get())
    };
    view()
        .child(el)
        .child(view().size(px(30.0)).on_press(|| {}).child(text("Done")))
        .child(
            view()
                .size(px(30.0))
                .on_press(move || value.set(Some(42.0)))
                .child(text("Reset")),
        )
        .child(
            view()
                .size(px(30.0))
                .on_press(move || value.set(None))
                .child(text("Clear")),
        )
        .child(text(move || format!("Value {}", show(value.get()))))
        .child(text(move || {
            format!("Changes {}", changes.get().join(", "))
        }))
        .child(text(move || format!("Events {}", events.get().join(", "))))
}

/// The harness of `props` on a headless macOS surface (Tab stops at the
/// buttons there).
fn start(props: HarnessProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Events").unwrap();
    app
}

/// What the field shows.
fn field(app: &Headless) -> String {
    app.screen()
        .input_text("label:Quantity")
        .unwrap()
        .expect("the field")
        .to_owned()
}

/// The field takes the keyboard focus, as a click in it does.
fn focus(app: &mut Headless) {
    app.type_text("label:Quantity", "").unwrap();
}

#[test]
fn typing_reports_the_number_and_keeps_the_text_on_the_way_to_one() {
    let mut app = start(controlled(None));
    assert_eq!(app.screen().count("role:spinbutton").unwrap(), 1);
    assert_eq!(field(&app), "");
    app.type_text("label:Quantity", "-").unwrap();
    // `-` reads as no number yet: nothing to report.
    assert_eq!(field(&app), "-");
    app.type_text("label:Quantity", "1.").unwrap();
    app.wait_for("text:Value -1").unwrap();
    assert_eq!(field(&app), "-1.");
    app.type_text("label:Quantity", "5").unwrap();
    app.wait_for("text:Value -1.5").unwrap();
    assert_eq!(field(&app), "-1.5");
    assert!(app.shows("Changes -1, -1.5"));
    // Emptied: none.
    app.clear("label:Quantity").unwrap();
    app.wait_for("text:Value none").unwrap();
    assert!(app.shows("Changes -1, -1.5, none"));
}

#[test]
fn letters_a_second_point_and_a_sign_not_first_are_refused() {
    let mut app = start(controlled(None));
    app.type_text("label:Quantity", "1").unwrap();
    for refused in ["a", "e", " "] {
        app.type_text("label:Quantity", refused).unwrap();
        assert_eq!(field(&app), "1", "{refused:?}");
    }
    app.type_text("label:Quantity", ".").unwrap();
    app.type_text("label:Quantity", ".").unwrap();
    assert_eq!(field(&app), "1.");
    app.type_text("label:Quantity", "5").unwrap();
    app.type_text("label:Quantity", "-").unwrap();
    app.type_text("label:Quantity", "+").unwrap();
    assert_eq!(field(&app), "1.5");
    app.wait_for("text:Changes 1, 1.5").unwrap();
}

#[test]
fn other_keyboards_digits_signs_and_decimal_comma_read_as_ascii() {
    let mut app = start(controlled(None));
    app.type_text("label:Quantity", "－１２").unwrap();
    app.wait_for("text:Value -12").unwrap();
    assert_eq!(field(&app), "-12");
    app.type_text("label:Quantity", "。５").unwrap();
    app.wait_for("text:Value -12.5").unwrap();
    assert_eq!(field(&app), "-12.5");
    // A decimal comma, as a German keyboard's decimal key types it.
    app.clear("label:Quantity").unwrap();
    app.type_text("label:Quantity", "3,25").unwrap();
    app.wait_for("text:Value 3.25").unwrap();
    assert_eq!(field(&app), "3.25");
}

#[test]
fn keys_step_while_the_field_edits() {
    let mut app = start(controlled(Some(5.0)));
    assert_eq!(field(&app), "5");
    // Not focused: the keys are not the input's.
    app.press_key("up").unwrap();
    app.idle(std::time::Duration::from_millis(50)).unwrap();
    assert!(app.shows("Value 5"));
    focus(&mut app);
    app.press_key("up").unwrap();
    app.wait_for("text:Value 6").unwrap();
    assert_eq!(field(&app), "6");
    app.press_key("down").unwrap();
    app.wait_for("text:Value 5").unwrap();
    app.press_key("pageup").unwrap();
    app.wait_for("text:Value 15").unwrap();
    app.press_key("pagedown").unwrap();
    app.wait_for("text:Value 5").unwrap();
    assert!(app.shows("Changes 6, 5, 15, 5"));
    // The focus stayed in the field all along.
    assert!(app.shows("Events focus"));
}

#[test]
fn steps_keep_the_decimals_and_stop_at_the_bounds() {
    let mut props = controlled(Some(99.5));
    props.max = Some(100.0);
    props.min = Some(99.0);
    let mut app = start(props);
    focus(&mut app);
    app.press_key("up").unwrap();
    app.wait_for("text:Value 100").unwrap();
    // The text's decimal stays (`gpui-base`'s `step_value`).
    assert_eq!(field(&app), "100.0");
    // At the maximum: nothing, nothing reported; the button is disabled.
    app.press_key("up").unwrap();
    app.idle(std::time::Duration::from_millis(50)).unwrap();
    assert!(app.shows("Changes 100"));
    assert_eq!(app.screen().press_target("More").unwrap(), None);
    // A page down stops at the minimum, with its decimals.
    app.press_key("pagedown").unwrap();
    app.wait_for("text:Value 99").unwrap();
    assert_eq!(field(&app), "99.0");
    assert_eq!(app.screen().press_target("Less").unwrap(), None);
    assert!(app.screen().press_target("More").unwrap().is_some());
}

#[test]
fn small_steps_add_up_without_float_noise() {
    let mut props = controlled(Some(0.1));
    props.step = 0.2;
    let mut app = start(props);
    app.press("More").unwrap();
    app.wait_for("text:Value 0.3").unwrap();
    assert_eq!(field(&app), "0.3");
    app.press("Less").unwrap();
    app.press("Less").unwrap();
    app.wait_for("text:Value -0.1").unwrap();
    assert_eq!(field(&app), "-0.1");
}

#[test]
fn the_buttons_step_and_leave_the_focus_in_the_field() {
    let mut app = start(controlled(Some(1.0)));
    focus(&mut app);
    app.press("More").unwrap();
    app.wait_for("text:Value 2").unwrap();
    app.press("Less").unwrap();
    app.press("Less").unwrap();
    app.wait_for("text:Value 0").unwrap();
    assert_eq!(field(&app), "0");
    // No blur: the buttons never took the focus, and the keys still step.
    assert!(app.shows("Events focus"));
    app.press_key("up").unwrap();
    app.wait_for("text:Value 1").unwrap();
    // Nor are they stops of Tab: it goes from the field to `Done`.
    app.press_key("tab").unwrap();
    app.wait_for("text:Events focus, blur").unwrap();
}

#[test]
fn controls_on_the_right_step_the_same() {
    let mut props = controlled(Some(1.0));
    props.controls_right = true;
    let mut app = start(props);
    app.press("More").unwrap();
    app.wait_for("text:Value 2").unwrap();
    app.press("Less").unwrap();
    app.wait_for("text:Value 1").unwrap();
}

#[test]
fn the_prefix_and_the_suffix_go_around_the_field_inside_the_buttons() {
    for right in [false, true] {
        let mut props = controlled(Some(1.0));
        props.affixes = true;
        props.controls_right = right;
        let app = start(props);
        let parts: Vec<&str> = app
            .screen()
            .texts()
            .into_iter()
            .filter(|t| ["Less", "More", "about", "kg"].contains(t))
            .collect();
        let expected = if right {
            ["about", "kg", "More", "Less"]
        } else {
            ["Less", "about", "kg", "More"]
        };
        assert_eq!(parts, expected, "controlsRight {right}");
    }
}

#[test]
fn leaving_the_field_holds_a_typed_value_to_the_range() {
    let mut props = controlled(None);
    props.min = Some(10.0);
    props.max = Some(100.0);
    let mut app = start(props);
    // Out of range while typing (1 is on the way to 15): reported as typed.
    app.type_text("label:Quantity", "1000").unwrap();
    app.wait_for("text:Changes 1, 10, 100, 1000").unwrap();
    assert_eq!(field(&app), "1000");
    app.press_key("tab").unwrap();
    app.wait_for("text:Value 100").unwrap();
    assert_eq!(field(&app), "100");
    app.clear("label:Quantity").unwrap();
    app.type_text("label:Quantity", "5").unwrap();
    app.press_key("tab").unwrap();
    app.wait_for("text:Value 10").unwrap();
    assert_eq!(field(&app), "10");
    assert!(app.shows("Changes 1, 10, 100, 1000, 100, none, 5, 10"));
}

#[test]
fn enter_holds_the_value_to_the_range_and_submits_it() {
    let mut props = controlled(None);
    props.max = Some(100.0);
    let mut app = start(props);
    app.type_text("label:Quantity", "250").unwrap();
    app.submit("label:Quantity").unwrap();
    app.wait_for("text:Value 100").unwrap();
    assert_eq!(field(&app), "100");
    let events = app
        .screen()
        .texts()
        .into_iter()
        .find(|t| t.starts_with("Events"))
        .unwrap()
        .to_owned();
    assert!(events.contains("submit 100"), "{events}");
}

#[test]
fn text_that_reads_as_no_number_stays_when_the_field_is_left() {
    let mut props = controlled(None);
    props.min = Some(0.0);
    let mut app = start(props);
    app.type_text("label:Quantity", "-").unwrap();
    app.press_key("tab").unwrap();
    app.wait_for("text:Events focus, blur").unwrap();
    assert_eq!(field(&app), "-");
    assert!(app.shows("Changes"));
    // A step from it starts at 0, held to the minimum.
    app.press("More").unwrap();
    app.wait_for("text:Value 1").unwrap();
}

#[test]
fn a_controlled_input_shows_the_apps_value() {
    let mut props = controlled(Some(5.0));
    props.refusing = true;
    let mut app = start(props);
    focus(&mut app);
    // A step the app does not take leaves the field as it is.
    app.press("More").unwrap();
    app.wait_for("text:Changes 6").unwrap();
    assert_eq!(field(&app), "5");
    // Typing shows in the field while it edits; leaving it shows the
    // app's value again.
    app.type_text("label:Quantity", "7").unwrap();
    app.wait_for("text:Changes 6, 57").unwrap();
    assert_eq!(field(&app), "57");
    app.press_key("tab").unwrap();
    app.wait_for("text:Events focus, blur").unwrap();
    assert_eq!(field(&app), "5");
    // What the app sets shows; its none empties the field.
    app.press("Reset").unwrap();
    app.wait_for("text:Value 42").unwrap();
    assert_eq!(field(&app), "42");
    app.press("Clear").unwrap();
    app.wait_for("text:Value none").unwrap();
    assert_eq!(field(&app), "");
}

#[test]
fn a_following_app_keeps_what_the_user_types() {
    let mut app = start(controlled(Some(2.0)));
    // `2.` and `2.50` read as the app's 2 and 2.5: the text stays as typed.
    app.type_text("label:Quantity", ".").unwrap();
    assert_eq!(field(&app), "2.");
    app.type_text("label:Quantity", "50").unwrap();
    app.wait_for("text:Value 2.5").unwrap();
    assert_eq!(field(&app), "2.50");
    assert!(app.shows("Changes 2.5"));
}

#[test]
fn an_uncontrolled_input_keeps_its_own_value() {
    let mut props = controlled(Some(5.0));
    props.uncontrolled = true;
    let mut app = start(props);
    assert_eq!(field(&app), "5");
    app.press("More").unwrap();
    app.wait_for("text:Changes 6").unwrap();
    assert_eq!(field(&app), "6");
    app.press("More").unwrap();
    app.wait_for("text:Changes 6, 7").unwrap();
    assert_eq!(field(&app), "7");
    // The app's value is not the input's.
    assert!(app.shows("Value 5"));
    app.press("Reset").unwrap();
    app.wait_for("text:Value 42").unwrap();
    assert_eq!(field(&app), "7");
}

#[test]
fn a_disabled_input_takes_no_typing_or_step() {
    let mut props = controlled(Some(5.0));
    props.disabled = true;
    let mut app = start(props);
    assert!(!app.screen().enabled("label:Quantity").unwrap());
    assert_eq!(app.screen().press_target("More").unwrap(), None);
    assert_eq!(app.screen().press_target("Less").unwrap(), None);
    assert!(app.type_text("label:Quantity", "1").is_err());
    assert_eq!(field(&app), "5");
    assert!(app.shows("Changes"));
}

#[test]
fn a_readonly_input_takes_no_typing_or_step() {
    let mut props = controlled(Some(5.0));
    props.readonly = true;
    let mut app = start(props);
    assert_eq!(app.screen().press_target("More").unwrap(), None);
    assert_eq!(app.screen().press_target("Less").unwrap(), None);
    assert!(app.type_text("label:Quantity", "1").is_err());
    assert_eq!(field(&app), "5");
    assert!(app.shows("Changes"));
}
