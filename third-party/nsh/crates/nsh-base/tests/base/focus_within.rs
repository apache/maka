//! `focus-within` on a Mac, run headless: a frame's `.focus_within(..)`
//! follows the keyboard focus into an input and onto a focusable view
//! inside it that read no state of their own (no `focus:`), and leaves
//! with it; a ref's `on_focus_in` / `on_focus_out` hear the focus come into
//! an element and leave it, a `Popover`'s content counting as inside the
//! view that holds the popover, and the focus in a popover that closes
//! goes back to its trigger. A press on a field that listens to presses
//! focuses it first.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use nsh_base::{input, popover};
use nsh_core::{
    MountItem, NodeId, Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// The views the platform was sent by test id, and the opacities each was
/// last styled with.
#[derive(Default)]
struct Seen {
    test_ids: HashMap<String, NodeId>,
    opacity: HashMap<NodeId, f32>,
}

struct App {
    app: Headless,
    seen: Arc<Mutex<Seen>>,
}

impl App {
    /// The opacity the view with test id `id` was last sent.
    fn opacity(&self, id: &str) -> f32 {
        let seen = self.seen.lock().unwrap();
        *seen.opacity.get(&seen.test_ids[id]).expect("styled")
    }
}

/// `root` on a Mac (Tab stops at views), recording what the platform is
/// sent.
fn start(root: Root) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props } => {
                    if let Some(test_id) = &props.test_id {
                        seen.test_ids.insert(test_id.to_string(), *id);
                    }
                }
                MountItem::ViewStyle { id, style } => {
                    seen.opacity.insert(*id, style.opacity);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    App { app, seen }
}

/// A frame around a view Tab stops at, a frame around an input, and a stop
/// after them: nothing inside the frames reads `focus:`.
#[component]
fn Frames() -> impl IntoElement {
    let frame = |id: &'static str| {
        view()
            .test_id(id)
            .p(px(4.0))
            .opacity(0.5)
            .focus_within(|s| s.opacity(1.0))
    };
    view()
        .child(frame("view-frame").child(view().test_id("stop").focusable(true).h(px(30.0))))
        .child(frame("input-frame").child(input().test_id("field").h(px(30.0))))
        .child(view().test_id("after").focusable(true).h(px(30.0)))
}

#[test]
fn a_frame_follows_the_focus_onto_a_view_without_focus_classes() {
    let mut app = start(Root::new::<Frames>(|| ()));
    assert_eq!(app.opacity("view-frame"), 0.5);
    // Tab: onto the focusable view in the first frame.
    app.app.press_key("tab").unwrap();
    assert_eq!(app.opacity("view-frame"), 1.0);
    assert_eq!(app.opacity("input-frame"), 0.5);
    // On to the input in the second: the first frame lets go.
    app.app.press_key("tab").unwrap();
    assert_eq!(app.opacity("view-frame"), 0.5);
    assert_eq!(app.opacity("input-frame"), 1.0);
    // Out of both.
    app.app.press_key("tab").unwrap();
    assert_eq!(app.opacity("input-frame"), 0.5);
    assert_eq!(app.opacity("view-frame"), 0.5);
}

#[test]
fn a_frame_follows_the_focus_into_an_input_without_focus_classes() {
    let mut app = start(Root::new::<Frames>(|| ()));
    assert_eq!(app.opacity("input-frame"), 0.5);
    // Typing focuses the input, as a click in it does.
    app.app.type_text("id:field", "a").unwrap();
    assert_eq!(app.opacity("input-frame"), 1.0);
    // Tab leaves it for the stop after the frames.
    app.app.press_key("tab").unwrap();
    assert_eq!(app.opacity("input-frame"), 0.5);
}

/// A popover in a view that logs the focus coming in and leaving, a stop
/// after it, and the log on screen.
#[component]
fn PopoverArea() -> impl IntoElement {
    let log = signal(Vec::<&'static str>::new());
    let area = element_ref();
    area.on_focus_in(move || log.update(|l| l.push("in")));
    area.on_focus_out(move || log.update(|l| l.push("out")));
    view()
        .child(text(move || format!("Within: {}", log.get().join(" "))))
        .child(
            view().element_ref(&area).child(
                popover()
                    .trigger(
                        view()
                            .test_id("trigger")
                            .focusable(true)
                            .w(px(100.0))
                            .h(px(30.0))
                            .child(text("Details")),
                    )
                    .child(
                        view()
                            .test_id("inside")
                            .focusable(true)
                            .h(px(30.0))
                            .child(text("Inside")),
                    ),
            ),
        )
        .child(view().test_id("after").focusable(true).h(px(30.0)))
}

#[test]
fn a_popovers_content_is_within_the_view_holding_the_popover() {
    let mut app = start(Root::new::<PopoverArea>(|| ()));
    app.app.press_key("tab").unwrap();
    app.app.wait_for("Within: in").unwrap();
    app.app.press("id:trigger").unwrap();
    app.app.wait_for("Inside").unwrap();
    // Back from the trigger, around to the last stop: the popup's view,
    // shown in the root view but inside the area.
    app.app.press_key("shift+tab").unwrap();
    app.app.press_key("tab").unwrap();
    app.app.press_key("shift+tab").unwrap();
    assert!(app.app.shows("Within: in"), "no leaving while in the popup");
    // From the popup around to the trigger, then to the stop after it:
    // now it leaves.
    app.app.press_key("tab").unwrap();
    assert!(app.app.shows("Within: in"));
    app.app.press_key("tab").unwrap();
    app.app.wait_for("Within: in out").unwrap();
}

/// A popover whose trigger and content log the focus they take.
#[component]
fn PopoverFocus() -> impl IntoElement {
    let log = signal(String::from("focus"));
    let note = move |what: &'static str| log.update(|log| log.push_str(what));
    view()
        .child(text(move || log.get()))
        .child(
            popover()
                .trigger(
                    view()
                        .test_id("trigger")
                        .focusable(true)
                        .w(px(100.0))
                        .h(px(30.0))
                        .on_focus(move |_: &()| note(" trigger"))
                        .child(text("Details")),
                )
                .child(
                    view()
                        .test_id("inside")
                        .focusable(true)
                        .h(px(30.0))
                        .on_focus(move |_: &()| note(" inside"))
                        .child(text("Inside")),
                ),
        )
        .child(view().test_id("after").focusable(true).h(px(30.0)))
}

#[test]
fn escape_in_a_popover_gives_the_focus_back_to_its_trigger() {
    let mut app = start(Root::new::<PopoverFocus>(|| ()));
    app.app.press_key("tab").unwrap();
    app.app.wait_for("focus trigger").unwrap();
    app.app.press("id:trigger").unwrap();
    app.app.wait_for("Inside").unwrap();
    // Back from the trigger, around to the popup's view (the last stop).
    app.app.press_key("shift+tab").unwrap();
    app.app.wait_for("focus trigger inside").unwrap();
    // Escape closes it, and the focus, gone with its view, comes back to
    // the trigger, so Tab goes on from there.
    app.app.press_key("escape").unwrap();
    app.app.wait_for("focus trigger inside trigger").unwrap();
    assert!(!app.app.shows("Inside"));
}

/// A field that listens to presses, as a combobox's does, and a log of
/// what it hears.
#[component]
fn PressedField() -> impl IntoElement {
    let log = signal(String::from("log"));
    let note = move |what: &'static str| log.update(|log| log.push_str(what));
    view()
        .child(
            input()
                .test_id("field")
                .h(px(30.0))
                .on_focus(move |_: &()| note(" focus"))
                .on_press(move |_: &()| note(" press")),
        )
        .child(text(move || log.get()))
}

#[test]
fn a_press_on_a_field_that_listens_to_presses_focuses_it_then_reports_the_press() {
    let mut app = start(Root::new::<PressedField>(|| ()));
    app.app.press("id:field").unwrap();
    assert!(app.app.shows("log focus press"));
    // Focused already: the press alone.
    app.app.press("id:field").unwrap();
    assert!(app.app.shows("log focus press press"));
}
