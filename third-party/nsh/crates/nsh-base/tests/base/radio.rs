//! `RadioGroup`: one stop of the keyboard focus, at the checked radio (else
//! the first enabled one); the arrow keys move between the radios past
//! disabled ones, around the ends, and check the radio they reach. On
//! macOS, where Tab stops at views that take presses.

use nsh_base::{radio, radio_group};
use nsh_core::{Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const PLANS: [&str; 4] = ["Free", "Plus", "Team", "Enterprise"];

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

/// Four plans, the third disabled, none checked at first; a button after
/// the group. The texts say which plan is checked, how many changes the
/// radios reported, and whether the button was pressed.
#[component]
fn Plans() -> impl IntoElement {
    let plan = signal(None::<usize>);
    let changes = signal(0u32);
    let after = signal(false);
    let option = move |i: usize| {
        radio()
            .checked(move || plan.get() == Some(i))
            .disabled(i == 2)
            .on_change(move |checked: &bool| {
                assert!(*checked, "a radio asks to be checked");
                changes.update(|n| *n += 1);
                plan.set(Some(i));
            })
            .child(text(PLANS[i]))
    };
    view()
        .child(
            radio_group()
                .child(option(0))
                .child(option(1))
                .child(option(2))
                .child(option(3)),
        )
        .child(
            view()
                .on_press(move || after.set(true))
                .child(text("Continue")),
        )
        .child(text(move || {
            format!("plan:{}", plan.get().map_or("none", |i| PLANS[i]))
        }))
        .child(text(move || format!("changes:{}", changes.get())))
        .child(text(move || format!("after:{}", after.get())))
}

#[test]
fn with_none_checked_tab_enters_at_the_first_radio_and_space_checks_it() {
    let mut app = start::<Plans>();
    app.press_key("tab").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("plan:Free").unwrap();
    app.wait_for("changes:1").unwrap();
    // A checked radio reports nothing.
    app.press_key("space").unwrap();
    app.wait(std::time::Duration::from_millis(50)).unwrap();
    app.wait_for("changes:1").unwrap();
}

#[test]
fn arrows_move_and_check_wrapping_and_skipping_disabled_radios() {
    let mut app = start::<Plans>();
    app.press_key("tab").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("plan:Plus").unwrap();
    // Team is disabled: Down goes on to Enterprise.
    app.press_key("down").unwrap();
    app.wait_for("plan:Enterprise").unwrap();
    // Past the end, around to the first.
    app.press_key("right").unwrap();
    app.wait_for("plan:Free").unwrap();
    app.press_key("up").unwrap();
    app.wait_for("plan:Enterprise").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("plan:Plus").unwrap();
    app.wait_for("changes:5").unwrap();
}

#[test]
fn the_group_is_one_stop_at_the_checked_radio() {
    let mut app = start::<Plans>();
    app.press_key("tab").unwrap();
    app.press_key("down").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("plan:Enterprise").unwrap();
    // One Tab leaves the group, whatever radio the focus is on.
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("after:true").unwrap();
    // Shift+Tab comes back to the checked radio: Down from there wraps.
    app.press_key("shift+tab").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("plan:Free").unwrap();
}
