//! `Tabs`: one stop of the keyboard focus, at the selected tab; the arrow
//! keys, Home and End move between the tabs past disabled ones, around the
//! ends, and select the tab they reach (automatic activation). On macOS,
//! where Tab stops at views that take presses.

use nsh_base::{tab, tabs};
use nsh_core::{Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const NAMES: [&str; 5] = ["One", "Two", "Three", "Four", "Five"];

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

/// A button before and after a list of five tabs, the fourth disabled; the
/// second starts selected. The texts say which is selected, how many
/// presses the tabs reported, and which button Return pressed.
#[component]
fn TabsScreen() -> impl IntoElement {
    let selected = signal(1usize);
    let presses = signal(0u32);
    let pressed = signal("none");
    let section = move |i: usize| {
        tab()
            .selected(move || selected.get() == i)
            .disabled(i == 3)
            .on_press(move |_: &()| {
                presses.update(|n| *n += 1);
                selected.set(i);
            })
            .child(text(NAMES[i]))
    };
    view()
        .child(
            view()
                .on_press(move || pressed.set("before"))
                .child(text("Before")),
        )
        .child(
            tabs()
                .flex_row()
                .child(section(0))
                .child(section(1))
                .child(section(2))
                .child(section(3))
                .child(section(4)),
        )
        .child(
            view()
                .on_press(move || pressed.set("after"))
                .child(text("After")),
        )
        .child(text(move || format!("selected:{}", NAMES[selected.get()])))
        .child(text(move || format!("presses:{}", presses.get())))
        .child(text(move || format!("pressed:{}", pressed.get())))
}

#[test]
fn tab_enters_the_list_at_the_selected_tab_and_leaves_it_in_one_stop() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    // Return presses the tab the focus is on: the selected one.
    app.press_key("enter").unwrap();
    app.wait_for("presses:1").unwrap();
    app.wait_for("selected:Two").unwrap();
    // One more Tab leaves the list.
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("pressed:after").unwrap();
    // Shift+Tab comes back to the selected tab, not the last one.
    app.press_key("shift+tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("presses:2").unwrap();
    app.wait_for("selected:Two").unwrap();
}

#[test]
fn arrows_move_and_select_wrapping_and_skipping_disabled_tabs() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("selected:Three").unwrap();
    // Four is disabled: Right goes on to Five.
    app.press_key("right").unwrap();
    app.wait_for("selected:Five").unwrap();
    // Past the end, around to the first.
    app.press_key("right").unwrap();
    app.wait_for("selected:One").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("selected:Five").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("selected:Three").unwrap();
    // Up and Down move as Left and Right do.
    app.press_key("down").unwrap();
    app.wait_for("selected:Five").unwrap();
    app.press_key("up").unwrap();
    app.wait_for("selected:Three").unwrap();
    app.wait_for("presses:7").unwrap();
    // The focus moved with the selection: Return presses Three.
    app.press_key("enter").unwrap();
    app.wait_for("presses:8").unwrap();
    app.wait_for("selected:Three").unwrap();
}

#[test]
fn home_and_end_go_to_the_first_and_last_enabled_tab() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("end").unwrap();
    app.wait_for("selected:Five").unwrap();
    app.press_key("home").unwrap();
    app.wait_for("selected:One").unwrap();
    // Home on the first tab moves nothing and reports nothing.
    app.press_key("home").unwrap();
    app.wait_for("presses:2").unwrap();
}

#[test]
fn the_arrows_do_nothing_while_the_focus_is_outside_the_list() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.press_key("end").unwrap();
    app.wait(std::time::Duration::from_millis(50)).unwrap();
    app.wait_for("selected:Two").unwrap();
    app.wait_for("presses:0").unwrap();
    // Leaving the list unbinds its keys again.
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("left").unwrap();
    app.wait(std::time::Duration::from_millis(50)).unwrap();
    app.wait_for("selected:Two").unwrap();
    app.wait_for("presses:0").unwrap();
}

/// Tabs without a list are stops of their own, as before.
#[component]
fn LooseTabs() -> impl IntoElement {
    let pressed = signal("none");
    view()
        .child(
            tab()
                .on_press(move |_: &()| pressed.set("first"))
                .child(text("First")),
        )
        .child(
            tab()
                .on_press(move |_: &()| pressed.set("second"))
                .child(text("Second")),
        )
        .child(text(move || format!("pressed:{}", pressed.get())))
}

#[test]
fn a_tab_outside_a_list_is_a_stop_of_its_own() {
    let mut app = start::<LooseTabs>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("pressed:second").unwrap();
}
