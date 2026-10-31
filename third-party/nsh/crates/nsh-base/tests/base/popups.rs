//! The presence of `Popover`, a desktop `Menu` with its `Submenu` and
//! `Tooltip`: opened, a popup has its starting look in its first frame;
//! closed, it stays with its ending look for as long as its transitions
//! then run, and `onClose` comes after; opened again on its way out it is
//! taken back; with reduced motion, or no ending look, it goes at once and
//! nothing more is sent. On a manual clock: time moves only as the test
//! says.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{MenuEvent, PopoverEvent, menu, menu_item, popover, submenu, tooltip};
use nsh_core::{
    MountItem, NodeId, Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// What the platform was sent: each view's parent and test id, the
/// opacities of its styles in order, and whether it takes presses.
#[derive(Default)]
struct Seen {
    parents: HashMap<NodeId, NodeId>,
    test_ids: HashMap<String, NodeId>,
    styles: HashMap<NodeId, Vec<f32>>,
    inert: HashMap<NodeId, bool>,
}

impl Seen {
    /// The view around the one with test id `id` (the popup part around
    /// the app's content).
    fn popup(&self, id: &str) -> NodeId {
        self.parents[&self.test_ids[id]]
    }
}

struct App {
    app: Headless,
    seen: Arc<Mutex<Seen>>,
}

impl App {
    /// The opacities the popup part around `id` was sent.
    fn popup_styles(&self, id: &str) -> Vec<f32> {
        let seen = self.seen.lock().unwrap();
        seen.styles
            .get(&seen.popup(id))
            .cloned()
            .unwrap_or_default()
    }

    /// The opacity the popup part around `id` was last sent.
    fn popup_opacity(&self, id: &str) -> f32 {
        *self.popup_styles(id).last().expect("styled")
    }

    /// Whether the popup part around `id` takes no presses.
    fn popup_inert(&self, id: &str) -> bool {
        let seen = self.seen.lock().unwrap();
        seen.inert.get(&seen.popup(id)).copied().unwrap_or(false)
    }
}

/// `root` on a Mac, on a manual clock; `reduce_motion`: the user asked for
/// less motion.
fn start(root: Root, reduce_motion: bool) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    config.environment.reduce_motion = reduce_motion;
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
                    seen.inert
                        .insert(*id, props.pointer_events == PointerEvents::None);
                }
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                }
                MountItem::ViewStyle { id, style } => {
                    seen.styles.entry(*id).or_default().push(style.opacity);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    App { app, seen }
}

#[derive(Clone, PartialEq, Props)]
struct PopoverProps {
    /// `popupStartingClass` / `popupEndingClass` set.
    looks: bool,
    /// The trigger at the bottom of the window, with no room below it
    /// (what the screen shows stays above it: the driver sees only views
    /// inside the window).
    low: bool,
}

/// A popover whose popup fades for 200 ms between its look and its
/// starting and ending looks, with its lifecycle and the side it went on
/// on screen.
#[component]
fn PopoverScreen(props: PopoverProps) -> impl IntoElement {
    let life = signal(Vec::<&str>::new());
    let side = signal(None::<Placement>);
    let looks = props.looks;
    view()
        .pl(px(40.0))
        .child(text(move || format!("Life: {}", life.get().join(" "))))
        .child(text(move || format!("Side: {:?}", side.get())))
        .child(view().h(px(if props.low { 770.0 } else { 60.0 })))
        .child(
            popover()
                .popup_class("transition-opacity duration-200")
                .popup_starting_class(looks.then(|| SharedString::from("opacity-0")))
                .popup_ending_class(looks.then(|| SharedString::from("opacity-0")))
                .on_open(move || life.update(|l| l.push("open")))
                .on_close(move || life.update(|l| l.push("close")))
                .on_position(move |e: &PopoverEvent| {
                    if let PopoverEvent::Position(placement, ..) = e {
                        side.set(Some(*placement));
                    }
                })
                .trigger(
                    view()
                        .test_id("trigger")
                        .w(px(100.0))
                        .h(px(30.0))
                        .child(text("Details")),
                )
                .child(view().test_id("body").h(px(40.0)).child(text("Body"))),
        )
}

fn popover_app(looks: bool, reduce_motion: bool) -> App {
    start(
        Root::new::<PopoverScreen>(move || PopoverProps { looks, low: false }),
        reduce_motion,
    )
}

#[test]
fn a_popover_has_its_starting_look_in_its_first_frame() {
    let mut app = popover_app(true, false);
    app.app.press("id:trigger").unwrap();
    app.app.wait_for("Body").unwrap();
    assert_eq!(
        app.popup_styles("body").first(),
        Some(&0.0),
        "made with its starting look"
    );
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert_eq!(
        app.popup_opacity("body"),
        1.0,
        "its look from its first frame on"
    );
}

#[test]
fn a_popover_stays_with_its_ending_look_until_its_exit_ran() {
    let mut app = popover_app(true, false);
    app.app.press("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.wait_for("Life: open").unwrap();
    app.app.wait_for("Side: Some(Bottom)").unwrap();
    app.app.press("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(app.app.shows("Body"), "kept while it goes");
    assert_eq!(app.popup_opacity("body"), 0.0, "with its ending look");
    assert!(app.popup_inert("body"), "taking no presses");
    assert!(app.app.shows("Life: open"), "not closed yet");
    app.app.run_for(Duration::from_millis(150)).unwrap();
    assert!(!app.app.shows("Body"), "gone once its 200 ms ran");
    app.app.wait_for("Life: open close").unwrap();
}

#[test]
fn reopening_a_popover_on_its_way_out_takes_it_back() {
    let mut app = popover_app(true, false);
    app.app.press("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.press("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.press("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(500)).unwrap();
    assert!(app.app.shows("Body"), "an old exit does not take it away");
    assert_eq!(app.popup_opacity("body"), 1.0, "back to its look");
    assert!(
        app.app.shows("Life: open"),
        "never gone: neither closed nor opened again"
    );
}

#[test]
fn with_reduced_motion_a_popover_goes_at_once() {
    let mut app = popover_app(true, true);
    app.app.press("id:trigger").unwrap();
    app.app.wait_for("Body").unwrap();
    assert_eq!(app.popup_opacity("body"), 1.0, "no starting look");
    app.app.press("id:trigger").unwrap();
    assert!(!app.app.shows("Body"));
    app.app.wait_for("Life: open close").unwrap();
}

#[test]
fn a_popover_without_looks_goes_at_once_and_sends_nothing_more() {
    let mut app = popover_app(false, false);
    app.app.press("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    let styled = app.popup_styles("body").len();
    app.app.press("id:trigger").unwrap();
    assert!(!app.app.shows("Body"), "gone in the turn that closed it");
    app.app.wait_for("Life: open close").unwrap();
    assert_eq!(
        app.popup_styles("body").len(),
        styled,
        "no style sent to the popup as it closes"
    );
}

#[test]
fn a_popover_reports_the_side_it_went_on() {
    let mut app = start(
        Root::new::<PopoverScreen>(|| PopoverProps {
            looks: false,
            low: true,
        }),
        false,
    );
    app.app.press("id:trigger").unwrap();
    app.app.wait_for("Side: Some(Top)").unwrap();
}

/// A desktop menu with a submenu, both fading for 200 ms on their way out.
#[component]
fn MenuScreen() -> impl IntoElement {
    let closed = signal(false);
    let side = signal(None::<Placement>);
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .popup_class("transition-opacity duration-200")
                .popup_ending_class("opacity-0")
                .on_close(move || closed.set(true))
                .on_position(move |e: &MenuEvent| {
                    if let MenuEvent::Position(placement, ..) = e {
                        side.set(Some(*placement));
                    }
                })
                .trigger(
                    view()
                        .test_id("file")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("File")),
                )
                .child(menu_item().child(view().test_id("new").h(px(30.0)).child(text("New"))))
                .child(
                    submenu()
                        .trigger(view().test_id("share").h(px(30.0)).child(text("Share")))
                        .child(
                            menu_item()
                                .child(view().test_id("mail").h(px(30.0)).child(text("Mail"))),
                        ),
                ),
        )
        .child(text(move || format!("Closed: {}", closed.get())))
        .child(text(move || format!("Side: {:?}", side.get())))
}

#[test]
fn a_desktop_menu_and_its_submenu_go_with_their_exit() {
    let mut app = start(Root::of::<MenuScreen>(), false);
    app.app.press("id:file").unwrap();
    app.app.wait_for("Side: Some(Bottom)").unwrap();
    app.app.press("id:share").unwrap();
    app.app.wait_for("Mail").unwrap();
    app.app.press("Mail").unwrap();
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(
        app.app.shows("New") && app.app.shows("Mail"),
        "kept while they go"
    );
    assert!(app.app.shows("Closed: false"), "not closed yet");
    app.app.run_for(Duration::from_millis(150)).unwrap();
    assert!(!app.app.shows("New") && !app.app.shows("Mail"));
    app.app.wait_for("Closed: true").unwrap();
}

#[derive(Clone, PartialEq, Props)]
struct TooltipProps {}

/// A tooltip the app shows and hides, fading for 200 ms on its way out.
#[component]
fn TooltipScreen(_props: TooltipProps) -> impl IntoElement {
    let open = signal(true);
    let closed = signal(false);
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            view()
                .test_id("toggle")
                .w(px(80.0))
                .h(px(30.0))
                .on_press(move || open.set(!open.get_untracked()))
                .tooltip(
                    tooltip()
                        .open(move || Some(open.get()))
                        .ending_class("transition-opacity duration-200 opacity-0")
                        .on_close(move || closed.set(true))
                        .child(text("Tip")),
                )
                .child(text("Toggle")),
        )
        .child(text(move || format!("Closed: {}", closed.get())))
}

#[test]
fn a_tooltip_stays_with_its_ending_look_until_its_exit_ran() {
    let mut app = start(Root::new::<TooltipScreen>(|| TooltipProps {}), false);
    app.app.wait_for("Tip").unwrap();
    app.app.press("id:toggle").unwrap();
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(app.app.shows("Tip"), "kept while it goes");
    assert!(app.app.shows("Closed: false"), "not closed yet");
    app.app.run_for(Duration::from_millis(150)).unwrap();
    assert!(!app.app.shows("Tip"));
    app.app.wait_for("Closed: true").unwrap();
}
