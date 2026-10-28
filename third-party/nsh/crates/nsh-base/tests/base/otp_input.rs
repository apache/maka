//! `OtpInput`: typing, Backspace, paste and the length on the native field
//! over its cells, digits only, the code the app owns or its own, the
//! events, masked cells and the disabled state.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{OtpInputCompleteEvent, input, otp_input};
use nsh_core::{
    AutoFill, Command, EventKind, EventPayload, MountItem, NodeId, PasteEvent, PayloadValue, Size,
    element::Root, prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// The inputs made: their ids, whether each is secure, and whether it is
/// a one-time code's field.
type Inputs = Arc<Mutex<Vec<(NodeId, bool, bool)>>>;

fn start<C: Component<Props = ()>>() -> Headless {
    start_observing::<C>().0
}

/// [`start`], with the inputs made: whether each is secure, and whether
/// it is a one-time code's field.
fn start_observing<C: Component<Props = ()>>() -> (Headless, Inputs) {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    })
    .unwrap();
    let inputs: Inputs = Arc::new(Mutex::new(Vec::new()));
    let seen = inputs.clone();
    app.observe(move |_, batch| {
        let mut seen = seen.lock().unwrap();
        for item in &batch.items {
            if let MountItem::Input { id, config } = item {
                let code = config.auto_fill == AutoFill::OneTimeCode;
                match seen.iter_mut().find(|(i, ..)| i == id) {
                    Some(input) => (input.1, input.2) = (config.secure, code),
                    None => seen.push((*id, config.secure, code)),
                }
            }
        }
    });
    app.first_render().unwrap();
    (app, inputs)
}

/// The cells' size: an `OtpInput` has no look of its own, so without one
/// its cells, and the field over them, have no size, and the screen (as a
/// user) finds nothing to type into.
fn sized(input: nsh_base::OtpInputElement) -> nsh_base::OtpInputElement {
    input.cell_style(|s| s.w(px(30.0)).h(px(40.0)))
}

/// What the app heard, as texts on screen.
#[derive(Clone, Copy)]
struct Log {
    changes: Signal<Vec<String>>,
    completes: Signal<Vec<String>>,
    focus: Signal<(u32, u32)>,
}

impl Log {
    fn new() -> Self {
        Self {
            changes: signal(Vec::new()),
            completes: signal(Vec::new()),
            focus: signal((0, 0)),
        }
    }

    fn view(self) -> impl IntoElement {
        view()
            .child(text(move || {
                format!("Changes [{}]", self.changes.get().join(","))
            }))
            .child(text(move || {
                format!("Completes [{}]", self.completes.get().join(","))
            }))
            .child(text(move || {
                let (focus, blur) = self.focus.get();
                format!("Focus {focus} Blur {blur}")
            }))
    }

    fn change(self, value: &SharedString) {
        self.changes.update(|c| c.push(value.to_string()));
    }

    fn complete(self, event: &OtpInputCompleteEvent) {
        self.completes.update(|c| c.push(event.value.to_string()));
    }
}

/// Six digits of its own, a field to move the focus to.
#[component]
fn Uncontrolled() -> impl IntoElement {
    let log = Log::new();
    view()
        .child(
            view().test_id("otp").child(
                sized(otp_input())
                    .length(6u32)
                    .accessibility_label("Code")
                    .on_change(move |v: &SharedString| log.change(v))
                    .on_complete(move |e: &OtpInputCompleteEvent| log.complete(e))
                    .on_focus(move || log.focus.update(|f| f.0 += 1))
                    .on_blur(move || log.focus.update(|f| f.1 += 1)),
            ),
        )
        .child(view().test_id("other").child(input()))
        .child(log.view())
}

/// The code the app owns, kept when `locked`; a default value.
#[component]
fn Controlled() -> impl IntoElement {
    let log = Log::new();
    let code = signal(SharedString::from("12"));
    let locked = signal(false);
    view()
        .child(
            view().test_id("otp").child(
                sized(otp_input())
                    .length(4u32)
                    .groups(2u32)
                    .value(move || Some(code.get()))
                    .on_change(move |v: &SharedString| {
                        log.change(v);
                        if !locked.get_untracked() {
                            code.set(v.clone());
                        }
                    }),
            ),
        )
        .child(
            view()
                .test_id("defaulted")
                .child(sized(otp_input()).length(4u32).default_value("98")),
        )
        .child(
            view()
                .test_id("clear")
                .on_press(move || code.set(SharedString::default()))
                .child(text("Clear")),
        )
        .child(
            view()
                .test_id("lock")
                .on_press(move || locked.set(true))
                .child(text("Lock")),
        )
        .child(text(move || format!("Code [{}]", code.get())))
        .child(log.view())
}

/// The code the app owns, set a turn after `onChange`, as a TSX app's
/// comes back.
#[component]
fn Late() -> impl IntoElement {
    let code = signal(SharedString::default());
    view()
        .child(
            view().test_id("otp").child(
                sized(otp_input())
                    .length(6u32)
                    .value(move || Some(code.get()))
                    .on_change(move |v: &SharedString| {
                        let v = v.clone();
                        set_timeout(Duration::from_millis(1), move || code.set(v));
                    }),
            ),
        )
        .child(text(move || format!("Code [{}]", code.get())))
}

/// Masked and disabled inputs.
#[component]
fn States() -> impl IntoElement {
    view()
        .child(
            view().test_id("masked").child(
                sized(otp_input())
                    .length(4u32)
                    .masked(true)
                    .accessibility_label("Masked"),
            ),
        )
        .child(
            view().test_id("disabled").child(
                sized(otp_input())
                    .length(4u32)
                    .disabled(true)
                    .default_value("12")
                    .accessibility_label("Disabled"),
            ),
        )
}

fn see(app: &mut Headless, text: &str) {
    app.wait_for_within(text, Duration::from_secs(2)).unwrap();
}

/// The field's text, once the input took back what it dropped.
fn field(app: &mut Headless, selector: &str) -> String {
    app.wait(Duration::from_millis(50)).unwrap();
    app.screen()
        .input_text(selector)
        .unwrap()
        .expect("a field")
        .to_owned()
}

#[test]
fn typing_digits_fills_the_cells_and_reports_each_change() {
    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "123").unwrap();
    see(&mut app, "Changes [1,12,123]");
    for digit in ["1", "2", "3"] {
        assert!(app.shows(digit), "{digit}: {:?}", app.screen().texts());
    }
    assert_eq!(field(&mut app, "id:otp"), "123");
    see(&mut app, "Completes []");
}

#[test]
fn other_characters_are_dropped_and_the_field_keeps_the_code() {
    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "1a2-").unwrap();
    see(&mut app, "Changes [1,12]");
    assert_eq!(field(&mut app, "id:otp"), "12");
    assert!(!app.shows("a"));
}

#[test]
fn full_width_digits_are_taken_as_ascii_digits() {
    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "１２").unwrap();
    see(&mut app, "Changes [1,12]");
    assert_eq!(field(&mut app, "id:otp"), "12");
}

#[test]
fn backspace_removes_the_last_digit() {
    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "123").unwrap();
    app.press_key("backspace").unwrap();
    see(&mut app, "Changes [1,12,123,12]");
    assert!(!app.shows("3"));
    assert_eq!(field(&mut app, "id:otp"), "12");
}

#[test]
fn the_length_caps_the_code_and_completes_it_once() {
    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "1234567").unwrap();
    see(&mut app, "Changes [1,12,123,1234,12345,123456]");
    see(&mut app, "Completes [123456]");
    assert_eq!(field(&mut app, "id:otp"), "123456");
    // More keys change nothing and complete nothing.
    app.type_text("id:otp", "8").unwrap();
    see(&mut app, "Completes [123456]");
    assert_eq!(field(&mut app, "id:otp"), "123456");
}

#[test]
fn a_pasted_code_replaces_the_code_and_shorter_text_is_appended() {
    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "1").unwrap();
    app.paste("id:otp", &PasteEvent::new("98-76-54-32"))
        .unwrap();
    see(&mut app, "Changes [1,987654]");
    see(&mut app, "Completes [987654]");
    assert_eq!(field(&mut app, "id:otp"), "987654");

    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "12").unwrap();
    app.paste("id:otp", &PasteEvent::new(" 3 4")).unwrap();
    see(&mut app, "Changes [1,12,1234]");
    assert_eq!(field(&mut app, "id:otp"), "1234");
}

#[test]
fn the_focus_is_reported_as_it_comes_and_goes() {
    let mut app = start::<Uncontrolled>();
    app.type_text("id:otp", "").unwrap();
    see(&mut app, "Focus 1 Blur 0");
    app.type_text("id:other", "x").unwrap();
    see(&mut app, "Focus 1 Blur 1");
}

#[test]
fn the_caret_stays_at_the_end() {
    let (mut app, inputs) = start_observing::<Uncontrolled>();
    app.type_text("id:otp", "12").unwrap();
    see(&mut app, "Changes [1,12]");
    // A press into the middle of the field's text moves its caret there,
    // which goes back to the end.
    let field = inputs
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.2)
        .expect("the field")
        .0;
    let at = PayloadValue::Number;
    app.engine().control().dispatch_event(
        field,
        EventKind::SelectionChange,
        EventPayload::Map(vec![("start", at(1.0)), ("end", at(1.0))]),
    );
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(
        app.screen()
            .commands()
            .contains(&(field, Command::SetSelection { start: 2, end: 2 })),
        "{:?}",
        app.screen().commands()
    );
}

#[test]
fn the_apps_code_is_shown_and_only_its_changes_reported() {
    let mut app = start::<Controlled>();
    see(&mut app, "Code [12]");
    assert!(app.shows("1") && app.shows("2"));
    assert_eq!(field(&mut app, "id:otp"), "12");
    // The app takes the user's change.
    app.type_text("id:otp", "3").unwrap();
    see(&mut app, "Code [123]");
    see(&mut app, "Changes [123]");
    // A code the app sets is shown and put in the field, not reported.
    app.press("id:clear").unwrap();
    see(&mut app, "Code []");
    assert!(!app.shows("1"));
    assert_eq!(field(&mut app, "id:otp"), "");
    see(&mut app, "Changes [123]");
    // A change the app keeps out is reported, and the cells keep its code.
    app.press("id:lock").unwrap();
    app.type_text("id:otp", "7").unwrap();
    see(&mut app, "Changes [123,7]");
    see(&mut app, "Code []");
    assert!(!app.shows("7"));
}

#[test]
fn keys_typed_before_the_apps_code_comes_back_build_on_each_other() {
    let mut app = start::<Late>();
    app.type_text("id:otp", "135").unwrap();
    see(&mut app, "Code [135]");
    assert_eq!(field(&mut app, "id:otp"), "135");
    for digit in ["1", "3", "5"] {
        assert!(app.shows(digit), "{digit}: {:?}", app.screen().texts());
    }
    app.press_key("backspace").unwrap();
    see(&mut app, "Code [13]");
    assert_eq!(field(&mut app, "id:otp"), "13");
}

#[test]
fn a_default_value_is_the_first_code() {
    let mut app = start::<Controlled>();
    assert!(app.shows("9") && app.shows("8"));
    assert_eq!(field(&mut app, "id:defaulted"), "98");
    app.type_text("id:defaulted", "7").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(app.shows("7"));
    assert_eq!(field(&mut app, "id:defaulted"), "987");
}

#[test]
fn masked_cells_show_bullets_and_the_field_is_secure() {
    let (mut app, inputs) = start_observing::<States>();
    // The masked field is secure (screen readers do not read it), the
    // other is not.
    let mut secure: Vec<bool> = inputs.lock().unwrap().iter().map(|i| i.1).collect();
    secure.sort();
    assert_eq!(secure, [false, true], "{:?}", inputs.lock().unwrap());
    app.type_text("id:masked", "34").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    let bullets = app
        .screen()
        .texts()
        .iter()
        .filter(|t| t.trim() == "\u{2022}")
        .count();
    assert_eq!(bullets, 2, "{:?}", app.screen().texts());
    assert!(!app.shows("3") && !app.shows("4"));
    assert_eq!(field(&mut app, "id:masked"), "34");
    // The disabled input's code is not masked.
    assert!(app.shows("1") && app.shows("2"));
}

#[test]
fn a_disabled_input_takes_no_input() {
    let app = start::<States>();
    assert!(!app.screen().enabled("label:Disabled").unwrap());
    assert!(app.screen().enabled("label:Masked").unwrap());
}
