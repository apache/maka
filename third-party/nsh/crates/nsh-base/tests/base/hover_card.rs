//! `HoverCard` on a Mac: it opens once the pointer rested on the trigger
//! for its open delay (or the keyboard focus came to it), stays open while
//! the pointer moves into the card, closes its close delay after the
//! pointer left both, and at once on Escape; the pointer back on either
//! within the close delay, or on the trigger while the card goes, keeps
//! it, and so does the keyboard focus on the trigger or in the card; a delay of `Infinity` never ends and one of `NaN` is none; a
//! controlled card shows what the app says; a hover sends the platform
//! nothing until the card opens; what the card shows is no part of a
//! toolbar its trigger is in. On a phone a press opens and closes it, and
//! the trigger says whether it is open. On a manual clock: time moves only
//! as the test says.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{HoverCardEvent, button, hover_card, toolbar};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct ScreenProps {
    /// The app owns `open`, changed only by pressing "Toggle".
    controlled: bool,
    /// The card's `openDelay`.
    #[prop(default = 600.0)]
    open_delay: f64,
    /// The card's `closeDelay`.
    #[prop(default = 300.0)]
    close_delay: f64,
    /// The card fades out for a second once closed.
    exit: bool,
    /// The card holds a link the keyboard focus can reach.
    link: bool,
}

/// A mention whose card previews a profile, a place away from it, and
/// what `onOpenChange` reported on screen.
#[component]
fn HoverScreen(props: ScreenProps) -> impl IntoElement {
    let changes = signal(Vec::<String>::new());
    let life = signal(Vec::<&str>::new());
    let shown = signal(false);
    let link_focused = signal(false);
    // The focus coming into the card's place and leaving it, as the view
    // around the card hears it.
    let within = signal(Vec::<&str>::new());
    let place = element_ref();
    place.on_focus_in(move || within.update(|w| w.push("in")));
    place.on_focus_out(move || within.update(|w| w.push("out")));
    let card = hover_card()
        .offset(px(4.0))
        .open_delay(props.open_delay)
        .close_delay(props.close_delay)
        .popup_class("transition-opacity duration-1000")
        .popup_ending_class(props.exit.then(|| SharedString::from("opacity-0")))
        .on_open(move || life.update(|l| l.push("open")))
        .on_close(move || life.update(|l| l.push("close")))
        .on_open_change(move |e: &HoverCardEvent| {
            if let HoverCardEvent::OpenChange(open, reason) = e {
                let change = format!("{open}:{reason:?}");
                changes.update(|c| c.push(change));
            }
        })
        .trigger(
            view()
                .test_id("trigger")
                .focusable(true)
                .w(px(100.0))
                .h(px(30.0))
                .child(text("@ada")),
        )
        .child(
            view()
                .test_id("card")
                .w(px(200.0))
                .h(px(80.0))
                .child(text("Ada Lovelace"))
                .when(props.link, |card| {
                    card.child(
                        view()
                            .test_id("profile")
                            .focusable(true)
                            .on_focus(move || link_focused.set(true))
                            .on_blur(move || link_focused.set(false))
                            .child(text("Profile")),
                    )
                }),
        );
    let card = if props.controlled {
        card.open(move || Some(shown.get()))
    } else {
        card
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(view().element_ref(&place).child(card))
        .child(view().test_id("away").h(px(200.0)).child(text("Away")))
        .child(
            view()
                .test_id("toggle")
                .w(px(100.0))
                .h(px(30.0))
                .on_press(move || shown.set(!shown.get_untracked()))
                .child(text("Toggle")),
        )
        .child(text(move || {
            format!("Changes: {}", changes.get().join(" "))
        }))
        .child(text(move || format!("Life: {}", life.get().join(" "))))
        .child(text(move || {
            format!("Profile focused: {}", link_focused.get())
        }))
        .child(text(move || format!("Within: {}", within.get().join(" "))))
}

/// The screen on a Mac (or an iPhone) on a manual clock, counting the
/// mount items the platform is sent.
fn start(controlled: bool, desktop: bool) -> (Headless, Arc<AtomicUsize>) {
    start_with(
        ScreenProps {
            controlled,
            ..ScreenProps::default()
        },
        desktop,
    )
}

/// [`start`] with `props`.
fn start_with(props: ScreenProps, desktop: bool) -> (Headless, Arc<AtomicUsize>) {
    start_root(Root::new::<HoverScreen>(move || props.clone()), desktop)
}

/// `root` on a Mac (or an iPhone) on a manual clock, counting the mount
/// items the platform is sent.
fn start_root(root: Root, desktop: bool) -> (Headless, Arc<AtomicUsize>) {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(root)
    };
    if desktop {
        config.environment.os = Os::MacOs;
        config.environment.idiom = Idiom::Desktop;
    } else {
        config.environment.os = Os::Ios;
        config.environment.idiom = Idiom::Phone;
    }
    let mut app = Headless::start(config).expect("the engine starts");
    let items = Arc::new(AtomicUsize::new(0));
    let seen = items.clone();
    app.observe(move |_, batch| {
        seen.fetch_add(batch.items.len(), Ordering::Relaxed);
    });
    app.first_render().unwrap();
    (app, items)
}

/// Hovers the trigger and waits out the open delay (600 ms).
fn open_by_hover(app: &mut Headless) {
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(650)).unwrap();
    assert!(app.shows("Ada Lovelace"), "open after its delay");
}

#[test]
fn a_hover_card_opens_once_the_pointer_rested_for_its_delay() {
    let (mut app, _) = start(false, true);
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(500)).unwrap();
    assert!(!app.shows("Ada Lovelace"), "not before 600 ms");
    app.run_for(Duration::from_millis(150)).unwrap();
    assert!(app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover").unwrap();
}

#[test]
fn leaving_the_trigger_before_the_delay_never_opens_it() {
    let (mut app, _) = start(false, true);
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(300)).unwrap();
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    assert!(app.shows("Changes:"), "nothing asked");
}

#[test]
fn a_hover_card_stays_open_while_the_pointer_moves_into_it() {
    let (mut app, _) = start(false, true);
    open_by_hover(&mut app);
    // Off the trigger, onto the card: within the close delay.
    app.hover("id:card").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(app.shows("Ada Lovelace"), "kept while the pointer is on it");
    // And back to the trigger.
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover").unwrap();
}

#[test]
fn a_hover_card_closes_its_delay_after_the_pointer_left_both() {
    let (mut app, _) = start(false, true);
    open_by_hover(&mut app);
    app.hover("id:card").unwrap();
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(250)).unwrap();
    assert!(app.shows("Ada Lovelace"), "not before 300 ms");
    app.run_for(Duration::from_millis(100)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover false:Hover").unwrap();
}

#[test]
fn escape_closes_a_hover_card_at_once() {
    let (mut app, _) = start(false, true);
    open_by_hover(&mut app);
    app.press_key("escape").unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover false:Cancel").unwrap();
    // The pointer still on the trigger opens it only once it comes again.
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
}

#[test]
fn the_keyboard_focus_opens_a_hover_card_and_leaving_closes_it() {
    let (mut app, _) = start(false, true);
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(650)).unwrap();
    assert!(app.shows("Ada Lovelace"), "open after its delay");
    app.wait_for("Changes: true:Focus").unwrap();
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(350)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Focus false:Focus").unwrap();
}

#[test]
fn a_blur_of_the_trigger_leaves_the_card_open_while_the_pointer_is_on_it() {
    let (mut app, _) = start(false, true);
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(650)).unwrap();
    assert!(app.shows("Ada Lovelace"));
    app.hover("id:card").unwrap();
    // The focus leaves the trigger for the next stop.
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(app.shows("Ada Lovelace"), "the pointer keeps it");
    app.wait_for("Changes: true:Focus").unwrap();
    // Off the card: now it closes.
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(350)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Focus false:Hover").unwrap();
}

/// The screen with a link in the card, on a Mac.
fn start_with_link() -> Headless {
    start_with(
        ScreenProps {
            link: true,
            ..ScreenProps::default()
        },
        true,
    )
    .0
}

#[test]
fn the_focus_moving_from_the_trigger_into_the_card_keeps_it_open() {
    let mut app = start_with_link();
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(650)).unwrap();
    assert!(app.shows("Ada Lovelace"), "open after its delay");
    app.wait_for("Within: in").unwrap();
    // Back from the trigger, around to the last stop: the card's link. The
    // card's overlay is inside the hover card's view, so the focus never
    // leaves it: no `on_focus_out` (the pointer is not on the card, so one
    // would close it).
    app.press_key("shift+tab").unwrap();
    app.wait_for("Profile focused: true").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(app.shows("Ada Lovelace"), "the focus in the card keeps it");
    assert!(app.shows("Within: in"), "never out");
    // From the card to the trigger: still in one of them.
    app.press_key("tab").unwrap();
    app.wait_for("Profile focused: false").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(
        app.shows("Ada Lovelace"),
        "the focus on the trigger keeps it"
    );
    assert!(app.shows("Within: in"), "never out");
    app.wait_for("Changes: true:Focus").unwrap();
    // Out of both: it closes after its close delay.
    app.press_key("tab").unwrap();
    app.wait_for("Within: in out").unwrap();
    app.run_for(Duration::from_millis(250)).unwrap();
    assert!(app.shows("Ada Lovelace"), "not before 300 ms");
    app.run_for(Duration::from_millis(100)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Focus false:Focus").unwrap();
}

#[test]
fn the_focus_in_the_card_keeps_it_open_after_the_pointer_left() {
    let mut app = start_with_link();
    open_by_hover(&mut app);
    app.hover("id:card").unwrap();
    // With no focus, Shift+Tab goes to the last stop: the card's link.
    app.press_key("shift+tab").unwrap();
    app.wait_for("Profile focused: true").unwrap();
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(app.shows("Ada Lovelace"), "the focus keeps it");
    app.wait_for("Changes: true:Hover").unwrap();
    // Around to the trigger, then out: closed once the focus left both.
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_millis(350)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover false:Focus").unwrap();
}

#[test]
fn escape_closes_a_hover_card_with_the_focus_in_it() {
    let mut app = start_with_link();
    open_by_hover(&mut app);
    app.hover("id:card").unwrap();
    app.press_key("shift+tab").unwrap();
    app.wait_for("Profile focused: true").unwrap();
    app.press_key("escape").unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover false:Cancel").unwrap();
    // The focus gone with the card asks nothing more.
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover false:Cancel").unwrap();
}

#[test]
fn a_controlled_hover_card_shows_what_the_app_says() {
    let (mut app, _) = start(true, true);
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(650)).unwrap();
    app.wait_for("Changes: true:Hover").unwrap();
    assert!(!app.shows("Ada Lovelace"), "asked, the app keeps it closed");
    app.press("id:toggle").unwrap();
    app.wait_for("Ada Lovelace").unwrap();
    app.press("id:toggle").unwrap();
    app.wait_for_gone("Ada Lovelace", Duration::from_secs(2))
        .unwrap();
}

#[test]
fn a_hover_sends_nothing_until_the_card_opens() {
    let (mut app, items) = start(false, true);
    let before = items.load(Ordering::Relaxed);
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(500)).unwrap();
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(500)).unwrap();
    assert_eq!(
        items.load(Ordering::Relaxed),
        before,
        "resting and leaving before the delay send nothing"
    );
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(650)).unwrap();
    let opened = items.load(Ordering::Relaxed);
    assert!(app.shows("Ada Lovelace"));
    // The card, its content and the report on screen.
    assert!(
        opened - before <= 40,
        "{} items to open the card",
        opened - before
    );
    // Moving between the trigger and the card sends nothing.
    app.hover("id:card").unwrap();
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert_eq!(items.load(Ordering::Relaxed), opened);
}

#[test]
fn on_a_phone_a_press_opens_and_closes_a_hover_card() {
    let (mut app, _) = start(false, false);
    app.press("id:trigger").unwrap();
    app.wait_for("Ada Lovelace").unwrap();
    app.press("id:trigger").unwrap();
    app.wait_for_gone("Ada Lovelace", Duration::from_secs(2))
        .unwrap();
    app.press("id:trigger").unwrap();
    app.wait_for("Ada Lovelace").unwrap();
    app.press("id:toggle").unwrap();
    app.wait_for_gone("Ada Lovelace", Duration::from_secs(2))
        .unwrap();
    app.wait_for(
        "Changes: true:TriggerPress false:TriggerPress true:TriggerPress false:PressOutside",
    )
    .unwrap();
}

#[test]
fn the_pointer_back_within_the_close_delay_keeps_a_hover_card_open() {
    let (mut app, _) = start(false, true);
    open_by_hover(&mut app);
    // Off the trigger, then back before the close delay ran out.
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(200)).unwrap();
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(app.shows("Ada Lovelace"), "back on the trigger in time");
    // Onto the card, away, and back onto the card in time.
    app.hover("id:card").unwrap();
    app.run_for(Duration::from_millis(200)).unwrap();
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(200)).unwrap();
    app.hover("id:card").unwrap();
    app.run_for(Duration::from_millis(1000)).unwrap();
    assert!(app.shows("Ada Lovelace"), "back on the card in time");
    app.wait_for("Changes: true:Hover").unwrap();
    app.wait_for("Life: open").unwrap();
}

#[test]
fn resting_on_the_trigger_while_a_hover_card_goes_takes_it_back() {
    let (mut app, _) = start_with(
        ScreenProps {
            exit: true,
            ..ScreenProps::default()
        },
        true,
    );
    open_by_hover(&mut app);
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(350)).unwrap();
    app.wait_for("Changes: true:Hover false:Hover").unwrap();
    assert!(app.shows("Ada Lovelace"), "kept while its exit runs");
    // Back on the trigger 50 ms into its second-long exit.
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(650)).unwrap();
    app.wait_for("Changes: true:Hover false:Hover true:Hover")
        .unwrap();
    app.run_for(Duration::from_millis(2000)).unwrap();
    assert!(app.shows("Ada Lovelace"), "open again, not gone");
    assert!(app.shows("Life: open"), "taken back: never closed");
}

#[test]
fn an_open_delay_of_infinity_never_opens_a_hover_card_by_itself() {
    let (mut app, _) = start_with(
        ScreenProps {
            open_delay: f64::INFINITY,
            ..ScreenProps::default()
        },
        true,
    );
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_secs(10)).unwrap();
    app.press_key("tab").unwrap();
    app.run_for(Duration::from_secs(10)).unwrap();
    assert!(!app.shows("Ada Lovelace"));
    assert!(app.shows("Changes:"), "nothing asked");
}

#[test]
fn a_close_delay_of_infinity_leaves_closing_to_escape() {
    let (mut app, _) = start_with(
        ScreenProps {
            close_delay: f64::INFINITY,
            ..ScreenProps::default()
        },
        true,
    );
    open_by_hover(&mut app);
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_secs(10)).unwrap();
    assert!(
        app.shows("Ada Lovelace"),
        "the pointer away does not close it"
    );
    app.press_key("escape").unwrap();
    assert!(!app.shows("Ada Lovelace"));
    app.wait_for("Changes: true:Hover false:Cancel").unwrap();
}

#[test]
fn delays_of_nan_are_none() {
    let (mut app, _) = start_with(
        ScreenProps {
            open_delay: f64::NAN,
            close_delay: f64::NAN,
            ..ScreenProps::default()
        },
        true,
    );
    app.hover("id:trigger").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.shows("Ada Lovelace"), "open at once");
    app.hover("id:away").unwrap();
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(!app.shows("Ada Lovelace"), "closed at once");
    app.wait_for("Changes: true:Hover false:Hover").unwrap();
}

#[test]
fn on_a_phone_the_trigger_says_whether_its_hover_card_is_open() {
    let (mut app, _) = start(false, false);
    let expanded = |app: &mut Headless| {
        app.screen()
            .accessibility_state("id:trigger")
            .unwrap()
            .expanded
    };
    assert_eq!(expanded(&mut app), Some(false));
    app.press("id:trigger").unwrap();
    app.wait_for("Ada Lovelace").unwrap();
    assert_eq!(expanded(&mut app), Some(true));
}

#[derive(Clone, PartialEq, Props)]
struct BarProps {
    /// The toolbar is disabled.
    disabled: bool,
}

/// A toolbar of a button (Bold) and a mention whose hover card is open with
/// a button (Apply) in it, a button after the toolbar, and which of them
/// were pressed.
#[component]
fn InToolbar(props: BarProps) -> impl IntoElement {
    let reached = signal(Vec::<&'static str>::new());
    let note = move |name: &'static str| {
        move || {
            reached.update(|r| {
                if !r.contains(&name) {
                    r.push(name);
                    r.sort_unstable();
                }
            })
        }
    };
    view()
        .child(
            toolbar()
                .disabled(props.disabled)
                .child(button().on_press(note("Bold")).child(text("Bold")))
                .child(
                    hover_card()
                        .open(Some(true))
                        .trigger(text("@ada"))
                        .child(button().on_press(note("Apply")).child(text("Apply"))),
                ),
        )
        .child(button().on_press(note("After")).child(text("After")))
        .child(text(move || format!("reached:{}", reached.get().join(","))))
}

#[test]
fn what_a_hover_card_shows_is_no_part_of_the_toolbar_its_trigger_is_in() {
    let (mut app, _) = start_root(
        Root::new::<InToolbar>(|| BarProps { disabled: false }),
        true,
    );
    app.wait_for("Apply").unwrap();
    // Three stops, whatever their order: the toolbar (at Bold), the card's
    // Apply and After. Had Apply joined the toolbar, Tab would never reach
    // it.
    for _ in 0..3 {
        app.press_key("tab").unwrap();
        app.press_key("enter").unwrap();
    }
    app.wait_for("text:reached:After,Apply,Bold").unwrap();
}

#[test]
fn a_disabled_toolbar_leaves_its_hover_cards_buttons_enabled() {
    let (mut app, _) = start_root(Root::new::<InToolbar>(|| BarProps { disabled: true }), true);
    app.wait_for("Apply").unwrap();
    app.press("text:Apply").unwrap();
    app.wait_for("text:reached:Apply").unwrap();
}
