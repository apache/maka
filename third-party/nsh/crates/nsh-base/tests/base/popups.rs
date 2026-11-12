//! The presence of `Popover`, a desktop `Menu` with its `Submenu` and
//! `Tooltip`: opened, a popup has its starting look in its first frame;
//! closed, it stays with its ending look for as long as its transitions
//! then run, and `onClose` comes after; opened again on its way out it is
//! taken back; with reduced motion, or no ending look, it goes at once and
//! nothing more is sent. On its way out it takes no keys: the focus is the
//! trigger's again as a menu or popover closes, so Return during its exit
//! chooses nothing in it and opens it again, its keys working as before. A tooltip's `delay` of `Infinity` never ends and
//! one of `NaN` is none; the focus the keyboard moves to its trigger shows
//! a tooltip in every idiom until it leaves or Escape is pressed, while a
//! press or a tap that gives the trigger the focus leaves it to the
//! pointer. Escape or a choice closes a menu
//! whose `open` the app controls every time, also when the app opened it itself. On a manual clock: time moves only as the test
//! says.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{
    MenuEvent, PopoverEvent, TooltipEvent, button, menu, menu_item, popover, submenu, tooltip,
};
use nsh_core::{
    MountItem, NodeId, Size,
    element::{Root, input},
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// What the platform was sent: each view's parent and test id, the
/// opacities of its styles in order, whether it takes presses, and the
/// views put in each view in order (the last one on top).
#[derive(Default)]
struct Seen {
    parents: HashMap<NodeId, NodeId>,
    stacks: HashMap<NodeId, Vec<NodeId>>,
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
    start_on(root, reduce_motion, Os::MacOs, Idiom::Desktop)
}

/// [`start`] on `os` and `idiom`.
fn start_on(root: Root, reduce_motion: bool, os: Os, idiom: Idiom) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(root)
    };
    config.environment.os = os;
    config.environment.idiom = idiom;
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
                MountItem::Insert {
                    parent,
                    child,
                    before,
                } => {
                    seen.parents.insert(*child, *parent);
                    let stack = seen.stacks.entry(*parent).or_default();
                    stack.retain(|id| id != child);
                    let at = before
                        .and_then(|b| stack.iter().position(|id| *id == b))
                        .unwrap_or(stack.len());
                    stack.insert(at, *child);
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

#[test]
fn on_a_phone_a_popover_is_above_its_backdrop() {
    let mut app = start_on(
        Root::new::<PopoverScreen>(|| PopoverProps {
            looks: false,
            low: false,
        }),
        false,
        Os::Ios,
        Idiom::Phone,
    );
    app.app.press("id:trigger").unwrap();
    app.app.wait_for("Body").unwrap();
    let seen = app.seen.lock().unwrap();
    let popup = seen.popup("body");
    let stack = &seen.stacks[&seen.parents[&popup]];
    assert!(stack.len() >= 2, "the backdrop and the popup: {stack:?}");
    assert_eq!(
        stack.last(),
        Some(&popup),
        "the popup on top, taking the presses on it"
    );
    let backdrop = stack[stack.len() - 2];
    assert!(
        !seen.inert.get(&backdrop).copied().unwrap_or(false),
        "the backdrop under it takes the presses outside"
    );
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

/// A desktop menu fading for 120 ms on its way out, with the items chosen
/// on screen in order.
#[component]
fn KeyMenuScreen() -> impl IntoElement {
    let chose = signal(Vec::<&'static str>::new());
    let item = move |label: &'static str| {
        menu_item()
            .accessibility_label(label)
            .on_select(move || chose.update(|c| c.push(label)))
            .child(text(label))
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .popup_class("transition-opacity duration-120")
                .popup_ending_class("opacity-0")
                .trigger(
                    view()
                        .test_id("file")
                        .w(px(80.0))
                        .h(px(30.0))
                        .child(text("File")),
                )
                .child(item("Open"))
                .child(item("Save")),
        )
        .child(text(move || {
            chose.with(|c| format!("chose:[{}]", c.join(",")))
        }))
}

/// The menu opened from the keyboard on its focused trigger (the focus
/// on Open), past its entrance.
fn key_menu_app() -> App {
    let mut app = start(Root::of::<KeyMenuScreen>(), false);
    app.app.press_key("tab").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.wait_for("Save").unwrap();
    app
}

#[test]
fn a_menu_on_its_way_out_does_not_choose_again() {
    let mut app = key_menu_app();
    app.app.press_key("down").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("text:chose:[Save]").unwrap();
    app.app.run_for(Duration::from_millis(16)).unwrap();
    assert!(app.app.shows("Save"), "kept while it goes");
    app.app.press_key("enter").unwrap();
    app.app.run_for(Duration::from_millis(300)).unwrap();
    assert!(
        app.app.shows("chose:[Save]"),
        "chosen once, not again by the key while it goes"
    );
}

#[test]
fn a_menu_closed_with_escape_takes_no_return_on_its_way_out() {
    let mut app = key_menu_app();
    app.app.press_key("down").unwrap();
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(16)).unwrap();
    assert!(app.app.shows("Save"), "kept while it goes");
    app.app.press_key("enter").unwrap();
    app.app.run_for(Duration::from_millis(300)).unwrap();
    assert!(app.app.shows("chose:[]"), "nothing chosen");
}

#[test]
fn a_menu_opened_again_on_its_way_out_takes_its_keys_again() {
    let mut app = key_menu_app();
    app.app.press_key("down").unwrap();
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(16)).unwrap();
    // Return on the trigger, which has the focus again, takes it back,
    // focused on its first item as an opening from the keyboard is.
    app.app.press_key("enter").unwrap();
    app.app.run_for(Duration::from_millis(300)).unwrap();
    assert!(app.app.shows("Save"), "taken back");
    assert!(app.app.shows("chose:[]"), "nothing chosen yet");
    app.app.press_key("down").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("text:chose:[Save]").unwrap();
}

/// A menu whose `open` the app controls, its trigger a view around a
/// button that flips `open` itself, with another button beside it; the
/// reports of `onOpenChange` on screen (`o` open, `c` closed).
#[component]
fn FlippedMenuScreen() -> impl IntoElement {
    let open = signal(false);
    let changes = signal(String::new());
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .open(move || Some(open.get()))
                .on_open_change(move |e: &MenuEvent| {
                    if let MenuEvent::OpenChange(next, _) = e {
                        changes.update(|c| c.push(if *next { 'o' } else { 'c' }));
                        open.set(*next);
                    }
                })
                .trigger(
                    view().focusable(false).child(
                        button()
                            .on_press(move || open.set(!open.get_untracked()))
                            .child(
                                view()
                                    .test_id("trigger")
                                    .w(px(80.0))
                                    .h(px(30.0))
                                    .child(text("View")),
                            ),
                    ),
                )
                .child(
                    menu_item()
                        .accessibility_label("About")
                        .child(view().test_id("about").child(text("About"))),
                ),
        )
        .child(
            button().on_press(|| {}).child(
                view()
                    .test_id("other")
                    .w(px(80.0))
                    .h(px(30.0))
                    .child(text("Other")),
            ),
        )
        .child(text(move || format!("changes:{}", changes.get())))
}

/// Opens [`FlippedMenuScreen`]'s menu with its button and closes it with
/// `close`, three times, pressing the other button in between.
fn flipped_menu_closes(how: &str, close: impl Fn(&mut Headless)) {
    let mut app = start(Root::of::<FlippedMenuScreen>(), false);
    for round in 0..3 {
        app.app.press("id:trigger").unwrap();
        app.app.run_for(Duration::from_millis(300)).unwrap();
        assert!(app.app.shows("About"), "round {round}: open");
        close(&mut app.app);
        app.app.run_for(Duration::from_millis(300)).unwrap();
        assert!(
            !app.app.shows("About"),
            "round {round}: closed by {how} ({})",
            app.app
                .screen()
                .texts()
                .into_iter()
                .find(|t| t.starts_with("changes:"))
                .unwrap_or_default()
        );
        app.app.press("id:other").unwrap();
        app.app.run_for(Duration::from_millis(50)).unwrap();
    }
}

#[test]
fn escape_closes_a_controlled_menu_the_app_opened_itself_each_time() {
    flipped_menu_closes("Escape", |app| app.press_key("escape").unwrap());
}

#[test]
fn choosing_an_item_closes_a_controlled_menu_the_app_opened_itself_each_time() {
    flipped_menu_closes("a choice", |app| app.press("id:about").unwrap());
}

/// A popover fading for 120 ms on its way out, with a button inside whose
/// presses are counted.
#[component]
fn KeyPopoverScreen() -> impl IntoElement {
    let applied = signal(0u32);
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            popover()
                .popup_class("transition-opacity duration-120")
                .popup_ending_class("opacity-0")
                .trigger(
                    view()
                        .test_id("trigger")
                        .w(px(100.0))
                        .h(px(30.0))
                        .child(text("Details")),
                )
                .child(
                    view()
                        .test_id("apply")
                        .h(px(30.0))
                        .on_press(move || applied.update(|n| *n += 1))
                        .child(text("Apply")),
                ),
        )
        .child(text(move || format!("applied:{}", applied.get())))
}

#[test]
fn a_popover_closed_with_escape_takes_no_return_on_its_way_out() {
    let mut app = start(Root::of::<KeyPopoverScreen>(), false);
    app.app.press_key("tab").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.wait_for("Apply").unwrap();
    app.app.press_key("tab").unwrap();
    app.app.press_key("enter").unwrap();
    app.app.wait_for("text:applied:1").unwrap();
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(16)).unwrap();
    assert!(app.app.shows("Apply"), "kept while it goes");
    app.app.press_key("enter").unwrap();
    app.app.run_for(Duration::from_millis(300)).unwrap();
    assert!(
        app.app.shows("applied:1"),
        "not pressed again while it goes"
    );
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

#[derive(Clone, PartialEq, Props)]
struct DelayProps {
    /// The tooltip's `delay`.
    delay: f64,
}

/// A trigger whose tooltip shows after `delay`, and a place away from it.
#[component]
fn DelayScreen(props: DelayProps) -> impl IntoElement {
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            view()
                .test_id("trigger")
                .w(px(80.0))
                .h(px(30.0))
                .tooltip(tooltip().delay(props.delay).child(text("Tip")))
                .child(text("Trigger")),
        )
        .child(view().test_id("away").h(px(200.0)).child(text("Away")))
}

fn delay_app(delay: f64) -> App {
    start(
        Root::new::<DelayScreen>(move || DelayProps { delay }),
        false,
    )
}

#[test]
fn a_tooltip_delay_of_infinity_never_shows_it() {
    let mut app = delay_app(f64::INFINITY);
    app.app.hover("id:trigger").unwrap();
    app.app.run_for(Duration::from_secs(10)).unwrap();
    assert!(!app.app.shows("Tip"));
    app.app.hover("id:away").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert!(!app.app.shows("Tip"));
}

#[test]
fn a_tooltip_delay_of_nan_is_none() {
    let mut app = delay_app(f64::NAN);
    app.app.hover("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.app.shows("Tip"), "shown at once");
}

#[test]
fn a_tooltip_shows_once_the_pointer_rested_for_its_delay() {
    let mut app = delay_app(300.0);
    app.app.hover("id:trigger").unwrap();
    app.app.run_for(Duration::from_millis(250)).unwrap();
    assert!(!app.app.shows("Tip"), "not before 300 ms");
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(app.app.shows("Tip"));
}

#[derive(Clone, PartialEq, Props)]
struct FocusProps {
    /// The trigger is a text field the app focuses and blurs with two
    /// buttons, and focuses with F5 too (a phone's headless driver moves no
    /// focus with Tab), not a view Tab stops at.
    fields: bool,
}

/// Two stops, the first with a tooltip whose open changes are written
/// down with their reasons, and how often it took the focus (`Focused:
/// …`). A press on the first view gives it the focus, as AppKit gives a
/// clicked stop the focus.
#[component]
fn FocusScreen(props: FocusProps) -> impl IntoElement {
    let changes = signal(Vec::<String>::new());
    let focused = signal(0u32);
    let tip = move || {
        tooltip()
            .on_open_change(move |e: &TooltipEvent| {
                if let TooltipEvent::OpenChange(open, reason) = e {
                    let change = format!("{open}:{reason:?}");
                    changes.update(|c| c.push(change));
                }
            })
            .child(text("Tip"))
    };
    let field = element_ref();
    let (trigger, next) = if props.fields {
        // A shortcut that focuses the field: the app's `focus()` after a
        // key, a move of the keyboard's.
        on_key("f5", move |_| field.focus());
        (
            input()
                .element_ref(&field)
                .test_id("trigger")
                .w(px(80.0))
                .h(px(30.0))
                .on_focus(move || focused.update(|n| *n += 1))
                .tooltip(tip())
                .into_element(),
            view()
                .flex_row()
                .child(
                    view()
                        .test_id("focus")
                        .on_press(move || field.focus())
                        .child(text("Focus")),
                )
                .child(
                    view()
                        .test_id("blur")
                        .on_press(move || field.blur())
                        .child(text("Blur")),
                )
                .into_element(),
        )
    } else {
        let own = element_ref();
        (
            view()
                .element_ref(&own)
                .test_id("trigger")
                .w(px(80.0))
                .h(px(30.0))
                .focusable(true)
                .on_press(move || own.focus())
                .on_focus(move || focused.update(|n| *n += 1))
                .tooltip(tip())
                .child(text("Trigger"))
                .into_element(),
            view()
                .test_id("next")
                .focusable(true)
                .child(text("Next"))
                .into_element(),
        )
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(trigger)
        .child(next)
        .child(text(move || {
            format!("Changes: {}", changes.get().join(" "))
        }))
        .child(text(move || format!("Focused: {}", focused.get())))
}

/// A tooltip shows for the focus the keyboard moves to its trigger at once
/// (Tab), hides when the focus leaves and on Escape, in `idiom`.
fn the_focus_shows_a_tooltip_in(os: Os, idiom: Idiom) {
    let root = Root::new::<FocusScreen>(|| FocusProps { fields: false });
    let mut app = start_on(root, false, os, idiom).app;
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.shows("Tip"), "shown at once for the focus");
    app.wait_for("Changes: true:Focus").unwrap();
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(!app.shows("Tip"), "hidden with the focus gone");
    app.wait_for("Changes: true:Focus false:Focus").unwrap();
    app.press_key("shift+tab").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.shows("Tip"), "shown again");
    app.press_key("escape").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(!app.shows("Tip"), "Escape hides it");
    app.wait_for("Changes: true:Focus false:Focus true:Focus false:Cancel")
        .unwrap();
    // The focus stayed: it shows again only once the focus comes back.
    app.press_key("tab").unwrap();
    app.press_key("shift+tab").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.shows("Tip"));
}

#[test]
fn the_keyboard_focus_shows_a_tooltip_on_a_desktop() {
    the_focus_shows_a_tooltip_in(Os::MacOs, Idiom::Desktop);
}

/// A click that gives the trigger the focus shows no tooltip for that
/// focus: the press hides what the pointer showed, nothing is left once
/// the pointer goes, and the keyboard moving the focus there shows it.
#[test]
fn a_click_that_focuses_the_trigger_leaves_its_tooltip_to_the_pointer() {
    let root = Root::new::<FocusScreen>(|| FocusProps { fields: false });
    let mut app = start(root, false).app;
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(600)).unwrap();
    assert!(app.shows("Tip"), "the pointer rested on it");
    app.press("id:trigger").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    app.wait_for("Focused: 1").unwrap();
    assert!(!app.shows("Tip"), "the press hid it, its focus shows none");
    app.hover("id:next").unwrap();
    app.run_for(Duration::from_millis(600)).unwrap();
    assert!(!app.shows("Tip"), "nothing is left once the pointer went");
    assert!(app.shows("Changes: true:Hover false:Hover"));
    // Tab on and Shift+Tab back: the keyboard's focus shows it at once.
    app.press_key("tab").unwrap();
    app.press_key("shift+tab").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.shows("Tip"), "shown at once for the keyboard's focus");
    app.wait_for("Changes: true:Hover false:Hover true:Focus")
        .unwrap();
}

#[test]
fn the_keyboard_focus_shows_a_tooltip_on_a_phone() {
    let root = Root::new::<FocusScreen>(|| FocusProps { fields: true });
    let mut app = start_on(root, false, Os::Ios, Idiom::Phone).app;
    // A tap focusing the field (the app's `focus()` after it) shows none.
    app.press("id:focus").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    app.wait_for("Focused: 1").unwrap();
    assert!(!app.shows("Tip"), "a tap's focus shows no tooltip");
    assert!(app.shows("Changes:"), "nothing asked");
    app.press("id:blur").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    // A hardware keyboard's shortcut focusing it: shown at once.
    app.press_key("f5").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.shows("Tip"), "shown at once for the keyboard's focus");
    app.wait_for("Changes: true:Focus").unwrap();
    app.press("id:blur").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(!app.shows("Tip"), "hidden with the focus gone");
    app.wait_for("Changes: true:Focus false:Focus").unwrap();
    app.press_key("f5").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.shows("Tip"), "shown again");
    app.press_key("escape").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(!app.shows("Tip"), "Escape hides it");
    app.wait_for("Changes: true:Focus false:Focus true:Focus false:Cancel")
        .unwrap();
}

#[test]
fn the_keyboard_focus_shows_a_tooltip_in_a_terminal() {
    the_focus_shows_a_tooltip_in(Os::Linux, Idiom::Terminal);
}

#[test]
fn a_tooltip_delay_of_infinity_is_not_shown_by_the_focus_either() {
    let mut app = delay_app(f64::INFINITY);
    app.app.press_key("tab").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert!(!app.app.shows("Tip"));
}
