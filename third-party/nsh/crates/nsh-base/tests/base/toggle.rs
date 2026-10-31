//! `Toggle` and `ToggleGroup`: a toggle reports the value it asks for and
//! shows the one the app passes back, as a button with a pressed state; a
//! group is a toolbar, one stop of the keyboard focus, at the first pressed
//! toggle (else the first enabled one), whose arrow keys, Home and End move
//! the focus past disabled toggles, around the ends, without pressing
//! anything. On macOS, where Tab stops at views that take presses.

use std::time::Duration;

use nsh_base::{toggle, toggle_group};
use nsh_core::{Checked, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const MARKS: [&str; 4] = ["Bold", "Italic", "Strikethrough", "Underline"];

fn start<C: Component<Props = ()>>() -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

fn pressed(app: &Headless, selector: &str) -> Option<Checked> {
    app.screen().accessibility_state(selector).unwrap().pressed
}

/// A favorite toggle alone, then a toolbar of four marks, the third
/// disabled, Italic pressed at first; a button after the toolbar. A switch
/// disables the whole toolbar. The texts say which marks are pressed, how
/// many changes the toggles reported, and whether the button was pressed.
#[component]
fn Formatting() -> impl IntoElement {
    let favorite = signal(false);
    let marks = signal([false, true, false, false]);
    let changes = signal(0u32);
    let locked = signal(false);
    let after = signal(false);
    let mark = move |i: usize| {
        toggle()
            .pressed(move || marks.get()[i])
            .disabled(i == 2)
            .accessibility_label(MARKS[i])
            .on_change(move |next: &bool| {
                changes.update(|n| *n += 1);
                marks.update(|m| m[i] = *next);
            })
            .child(text(&MARKS[i][..1]))
    };
    view()
        .child(
            toggle()
                .pressed(move || favorite.get())
                .accessibility_label("Favorite")
                .on_change(move |next: &bool| favorite.set(*next))
                .child(text("★")),
        )
        .child(
            toggle_group()
                .flex_row()
                .disabled(move || locked.get())
                .child(mark(0))
                .child(mark(1))
                .child(mark(2))
                .child(mark(3)),
        )
        .child(
            view()
                .on_press(move || after.set(true))
                .child(text("Continue")),
        )
        .child(
            view()
                .on_press(move || locked.update(|l| *l = !*l))
                .child(text("Lock")),
        )
        .child(text(move || {
            let on: Vec<_> = (0..4)
                .filter(|&i| marks.get()[i])
                .map(|i| MARKS[i])
                .collect();
            format!(
                "marks:{}",
                if on.is_empty() {
                    "none".into()
                } else {
                    on.join(",")
                }
            )
        }))
        .child(text(move || format!("changes:{}", changes.get())))
        .child(text(move || format!("favorite:{}", favorite.get())))
        .child(text(move || format!("after:{}", after.get())))
}

#[test]
fn a_press_asks_for_the_other_value_and_shows_the_one_passed_back() {
    let mut app = start::<Formatting>();
    assert_eq!(pressed(&app, "role:button[Favorite]"), Some(Checked::False));
    app.press("role:button[Favorite]").unwrap();
    app.wait_for("text:favorite:true").unwrap();
    assert_eq!(pressed(&app, "role:button[Favorite]"), Some(Checked::True));
    app.press("role:button[Favorite]").unwrap();
    app.wait_for("text:favorite:false").unwrap();
    assert_eq!(pressed(&app, "role:button[Favorite]"), Some(Checked::False));
}

#[test]
fn the_group_is_a_toolbar_of_toggle_buttons() {
    let app = start::<Formatting>();
    let screen = app.screen();
    assert_eq!(screen.count("role:toolbar"), Ok(1));
    assert_eq!(screen.count("role:toolbar >> role:button"), Ok(4));
    assert_eq!(pressed(&app, "role:button[Bold]"), Some(Checked::False));
    assert_eq!(pressed(&app, "role:button[Italic]"), Some(Checked::True));
}

#[test]
fn space_and_return_press_the_focused_toggle() {
    let mut app = start::<Formatting>();
    // The favorite, then the toolbar at its pressed toggle: Italic.
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:marks:none").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:marks:Italic").unwrap();
    app.wait_for("text:changes:2").unwrap();
}

#[test]
fn arrows_move_the_focus_without_pressing_wrapping_and_skipping_disabled_toggles() {
    let mut app = start::<Formatting>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    // Italic → Underline: Strikethrough is disabled.
    app.press_key("right").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    app.wait_for("text:changes:0").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:marks:Italic,Underline").unwrap();
    // Past the end, around to Bold; Down moves as Right does.
    app.press_key("down").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:marks:Bold,Italic,Underline").unwrap();
    // Left and Up back around the start.
    app.press_key("left").unwrap();
    app.press_key("up").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:marks:Bold,Underline").unwrap();
    app.wait_for("text:changes:3").unwrap();
}

#[test]
fn home_and_end_go_to_the_first_and_last_enabled_toggle() {
    let mut app = start::<Formatting>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("home").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:marks:Bold,Italic").unwrap();
    app.press_key("end").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:marks:Bold,Italic,Underline").unwrap();
}

#[test]
fn the_group_is_one_stop_at_the_first_pressed_toggle() {
    let mut app = start::<Formatting>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    // One Tab leaves the toolbar, whatever toggle the focus is on.
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:after:true").unwrap();
    // Shift+Tab comes back to Italic, the pressed one.
    app.press_key("shift+tab").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:marks:none").unwrap();
}

#[test]
fn a_disabled_group_disables_its_toggles() {
    let mut app = start::<Formatting>();
    app.press("text:Lock").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    // A press finds no enabled view to press.
    assert!(app.press("role:button[Bold]").is_err());
    app.wait_for("text:changes:0").unwrap();
    // No toggle is a stop: Tab goes from the favorite on to the button.
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:after:true").unwrap();
    // Enabled again, its toggles take presses.
    app.press("text:Lock").unwrap();
    app.press("role:button[Bold]").unwrap();
    app.wait_for("text:marks:Bold,Italic").unwrap();
}
