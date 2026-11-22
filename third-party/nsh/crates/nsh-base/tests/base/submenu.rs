//! `Submenu`'s `onOpenChange`: each opening and closing the user asks for
//! is reported once, with why: the trigger hovered or pressed, the pointer
//! over another item or the keyboard focus moved to one, Escape or the
//! sheet's back row, the whole menu closing with an item chosen. Not when the app closes the menu itself.
//! On a Mac (cascading popups) and on a phone (the sheet's items).

use nsh_base::{MenuEvent, SubmenuEvent, menu, menu_item, submenu};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn start(os: Os, idiom: Idiom) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<Menus>())
    };
    config.environment.os = os;
    config.environment.idiom = idiom;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app
}

/// A File menu the app keeps open (`open`), with a plain item and two
/// submenus, Share and Export, that write what they report to the log; a
/// Share item that closes the menu from the app's own code; `New` writes
/// to the log when it is chosen.
#[component]
fn Menus() -> impl IntoElement {
    let open = signal(false);
    let log = signal(Vec::<String>::new());
    let report = move |name: &'static str| {
        move |e: &SubmenuEvent| {
            let SubmenuEvent::OpenChange(on, reason) = e;
            let line = format!("{name} {} {reason:?}", if *on { "open" } else { "close" });
            log.update(|l| l.push(line));
        }
    };
    let row =
        |id: &'static str, label: &'static str| view().test_id(id).h(px(30.0)).child(text(label));
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .open(move || Some(open.get()))
                .on_open_change(move |e: &MenuEvent| {
                    if let MenuEvent::OpenChange(on, _) = e {
                        open.set(*on);
                    }
                })
                .trigger(row("file", "File").w(px(80.0)))
                .child(
                    menu_item()
                        .on_select(move || log.update(|l| l.push("chose new".into())))
                        .child(row("new", "New")),
                )
                .child(
                    submenu()
                        .trigger(row("share", "Share"))
                        .back(row("back", "Back"))
                        .on_open_change(report("share"))
                        .child(menu_item().child(row("mail", "Mail")))
                        .child(
                            menu_item()
                                .close_on_select(false)
                                .on_select(move || open.set(false))
                                .child(row("dismiss", "Dismiss")),
                        ),
                )
                .child(
                    submenu()
                        .trigger(row("export", "Export"))
                        .on_open_change(report("export"))
                        .child(menu_item().child(row("pdf", "PDF"))),
                ),
        )
        .child(text(move || format!("Log: {}", log.with(|l| l.join(", ")))))
}

fn shows_log(app: &mut Headless, log: &str) {
    app.wait_for(&format!("Log: {log}")).unwrap();
}

#[test]
fn a_desktop_submenu_reports_hovers_presses_and_the_menu_closing() {
    let mut app = start(Os::MacOs, Idiom::Desktop);
    app.press("id:file").unwrap();
    app.wait_for("Share").unwrap();
    app.hover("id:share").unwrap();
    shows_log(&mut app, "share open Hover");
    // Another submenu's trigger: one closes, the other opens.
    app.hover("id:export").unwrap();
    shows_log(
        &mut app,
        "share open Hover, share close Hover, export open Hover",
    );
    // A plain item of the menu closes the submenu of its level.
    app.hover("id:new").unwrap();
    shows_log(
        &mut app,
        "share open Hover, share close Hover, export open Hover, export close Hover",
    );
    app.press("id:share").unwrap();
    app.wait_for("Mail").unwrap();
    // Choosing an item closes the menu, and the submenu with it.
    app.press("id:mail").unwrap();
    shows_log(
        &mut app,
        "share open Hover, share close Hover, export open Hover, export close Hover, share open \
         TriggerPress, share close Select",
    );
}

#[test]
fn the_keyboard_on_another_item_closes_a_submenu_the_pointer_opened() {
    let mut app = start(Os::MacOs, Idiom::Desktop);
    app.press("id:file").unwrap();
    app.wait_for("Share").unwrap();
    app.hover("id:share").unwrap();
    app.wait_for("Mail").unwrap();
    // Down goes on from `Share`, under the pointer, to `Export`: the
    // submenu closes, so one item is highlighted, and Return opens
    // `Export`.
    app.press_key("down").unwrap();
    shows_log(&mut app, "share open Hover, share close Focus");
    app.wait_for_gone("Mail", WAIT).unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("PDF").unwrap();
    shows_log(
        &mut app,
        "share open Hover, share close Focus, export open TriggerPress",
    );
}

#[test]
fn the_keyboard_on_a_submenus_own_trigger_keeps_it_open() {
    let mut app = start(Os::MacOs, Idiom::Desktop);
    app.press("id:file").unwrap();
    app.wait_for("Share").unwrap();
    // The focus on `Share`, then the pointer opens `Export` and moves the
    // focus to its trigger, which keeps it open; Up to `Share` closes it.
    app.press_key("down").unwrap();
    app.press_key("down").unwrap();
    app.hover("id:export").unwrap();
    app.wait_for("PDF").unwrap();
    shows_log(&mut app, "export open Hover");
    app.press_key("up").unwrap();
    shows_log(&mut app, "export open Hover, export close Focus");
    // Right on `Share` opens it at `Mail`, Left closes it with the focus
    // back on `Share`, which Return opens again.
    app.press_key("right").unwrap();
    app.wait_for("Mail").unwrap();
    app.press_key("left").unwrap();
    app.wait_for_gone("Mail", WAIT).unwrap();
    app.press_key("enter").unwrap();
    shows_log(
        &mut app,
        "export open Hover, export close Focus, share open TriggerPress, share close Cancel, share \
         open TriggerPress",
    );
}

#[test]
fn escape_closes_a_desktop_submenu_as_a_cancel() {
    let mut app = start(Os::MacOs, Idiom::Desktop);
    app.press("id:file").unwrap();
    app.wait_for("Share").unwrap();
    app.press("id:share").unwrap();
    app.wait_for("Mail").unwrap();
    app.press_key("escape").unwrap();
    shows_log(&mut app, "share open TriggerPress, share close Cancel");
    app.wait_for_gone("Mail", WAIT).unwrap();
    assert!(app.shows("New"), "the menu stays open");
}

#[test]
fn a_menu_the_app_closes_itself_reports_no_submenu_closing() {
    let mut app = start(Os::MacOs, Idiom::Desktop);
    app.press("id:file").unwrap();
    app.wait_for("Share").unwrap();
    app.press("id:share").unwrap();
    app.wait_for("Dismiss").unwrap();
    app.press("id:dismiss").unwrap();
    app.wait_for_gone("Dismiss", WAIT).unwrap();
    assert!(
        app.shows("Log: share open TriggerPress"),
        "only the opening: the app closed the menu"
    );
}

#[test]
fn a_sheet_submenu_reports_its_items_shown_and_the_back_row() {
    let mut app = start(Os::Ios, Idiom::Phone);
    app.press("id:file").unwrap();
    app.wait_for("Share").unwrap();
    app.press("id:share").unwrap();
    shows_log(&mut app, "share open TriggerPress");
    app.press("id:back").unwrap();
    shows_log(&mut app, "share open TriggerPress, share close Cancel");
    app.press("id:share").unwrap();
    app.wait_for("Mail").unwrap();
    app.press("id:mail").unwrap();
    shows_log(
        &mut app,
        "share open TriggerPress, share close Cancel, share open TriggerPress, share close Select",
    );
}

#[derive(Clone, PartialEq, Props)]
struct PaddedProps {
    /// Where the menu's trigger is, down the window.
    top: f32,
    /// The submenu's items.
    rows: usize,
}

/// A menu whose popups have padding and a border, as apps draw theirs,
/// with its trigger `top` points down the window: a submenu, More, with
/// `rows` items.
#[component]
fn Padded(props: PaddedProps) -> impl IntoElement {
    let row = |id: String, label: String| view().test_id(&id).h(px(30.0)).child(text(label));
    let rows = props.rows;
    view().pt(px(props.top)).pl(px(40.0)).child(
        menu()
            .popup_style(|s| s.p(px(4.0)).border_1())
            .trigger(row("file".into(), "File".into()).w(px(80.0)))
            .child(menu_item().child(row("new".into(), "New".into())))
            .child(
                submenu()
                    .trigger(row("more".into(), "More".into()))
                    .children((0..rows).map(move |i| {
                        menu_item().child(row(format!("item{i}"), format!("Item {i}")))
                    })),
            ),
    )
}

/// [`Padded`] in a 390 × 600 desktop window, its submenu open.
fn open_padded(top: f32, rows: usize) -> Headless {
    let props = PaddedProps { top, rows };
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(600.0)),
        ..EngineConfig::new(Root::new::<Padded>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app.press("id:file").unwrap();
    app.wait_for("More").unwrap();
    app.hover("id:more").unwrap();
    app.wait_for("Item 0").unwrap();
    app
}

/// The bounds of the view with `test_id`, in the window.
fn bounds_of(app: &Headless, test_id: &str) -> nsh_core::Bounds<Points> {
    app.screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.test_id.as_deref() == Some(test_id))
        .unwrap_or_else(|| panic!("a view {test_id}"))
        .bounds
}

#[test]
fn a_desktop_submenus_first_item_lines_up_with_its_trigger() {
    let app = open_padded(100.0, 3);
    let (trigger, first) = (bounds_of(&app, "more"), bounds_of(&app, "item0"));
    assert_eq!(
        first.origin.y, trigger.origin.y,
        "{first:?} beside {trigger:?}"
    );
    // Beside the menu, outside its border.
    assert!(
        first.origin.x > trigger.right(),
        "{first:?} beside {trigger:?}"
    );
}

#[test]
fn a_desktop_submenu_near_the_bottom_stays_in_the_window() {
    let app = open_padded(440.0, 6);
    let (trigger, last) = (bounds_of(&app, "more"), bounds_of(&app, "item5"));
    // Six rows do not fit below the trigger: the popup moves up, its last
    // row and the padding and border under it inside the window.
    assert!(last.bottom() + px(5.0) <= px(600.0), "{last:?}");
    assert!(bounds_of(&app, "item0").origin.y < trigger.origin.y);
}

#[derive(Clone, PartialEq, Props)]
struct OwnedProps {
    /// The app sets `open` to what the submenu asks for.
    follow: bool,
}

/// A File menu whose items the app makes again each time `Refresh` is
/// chosen (as items made from the app's data are when the data changes):
/// `New`, `Show share` (which opens Share from the app's own code), and
/// Share, whose `open` the app owns, with `Mail`, `Refresh` and `Print`.
/// The log has what Share asked for and what was chosen.
#[component]
fn Owned(props: OwnedProps) -> impl IntoElement {
    let (made, share) = (signal(0u32), signal(false));
    let log = signal(Vec::<String>::new());
    let note = move |line: String| log.update(|l| l.push(line));
    let follow = props.follow;
    let row =
        |id: &'static str, label: &'static str| view().test_id(id).h(px(30.0)).child(text(label));
    let item = move |id: &'static str, label: &'static str| {
        menu_item()
            .on_select(move || note(format!("chose {id}")))
            .child(row(id, label))
    };
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .trigger(row("file", "File").w(px(80.0)))
                .child(dynamic(move || {
                    made.get();
                    vec![
                        item("new", "New").into_element(),
                        menu_item()
                            .close_on_select(false)
                            .on_select(move || share.set(true))
                            .child(row("show", "Show share"))
                            .into_element(),
                        submenu()
                            .open(move || Some(share.get()))
                            .on_open_change(move |e: &SubmenuEvent| {
                                let SubmenuEvent::OpenChange(on, reason) = e;
                                let state = if *on { "open" } else { "close" };
                                note(format!("share {state} {reason:?}"));
                                if follow {
                                    share.set(*on);
                                }
                            })
                            .trigger(row("share", "Share"))
                            .child(item("mail", "Mail"))
                            .child(
                                menu_item()
                                    .close_on_select(false)
                                    .on_select(move || made.update(|n| *n += 1))
                                    .child(row("refresh", "Refresh")),
                            )
                            .child(item("print", "Print"))
                            .into_element(),
                    ]
                })),
        )
        .child(text(move || format!("Made: {}", made.get())))
        .child(text(move || format!("Log: {}", log.with(|l| l.join(", ")))))
}

fn start_owned(follow: bool) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Owned>(move || OwnedProps { follow }))
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app.press("id:file").unwrap();
    app.wait_for("Share").unwrap();
    app
}

#[test]
fn a_controlled_submenu_asks_and_shows_what_the_app_keeps() {
    let mut app = start_owned(false);
    // The user asks, again on a press; the app keeps it closed.
    app.hover("id:share").unwrap();
    shows_log(&mut app, "share open Hover");
    app.press("id:share").unwrap();
    shows_log(&mut app, "share open Hover, share open TriggerPress");
    assert!(!app.shows("Mail"), "closed, as the app keeps it");
    // The app opens it itself: shown, no request reported.
    app.press("id:show").unwrap();
    app.wait_for("Mail").unwrap();
    // The pointer over another item asks it to close, and the keyboard
    // focus it gives that item asks again; the app keeps it open.
    app.hover("id:new").unwrap();
    shows_log(
        &mut app,
        "share open Hover, share open TriggerPress, share close Hover, share close Focus",
    );
    assert!(app.shows("Mail"), "open, as the app keeps it");
}

#[test]
fn a_controlled_submenu_follows_the_app() {
    let mut app = start_owned(true);
    app.hover("id:share").unwrap();
    app.wait_for("Mail").unwrap();
    app.hover("id:new").unwrap();
    app.wait_for_gone("Mail", WAIT).unwrap();
    shows_log(&mut app, "share open Hover, share close Hover");
    // Escape asks to close it.
    app.press("id:share").unwrap();
    app.wait_for("Mail").unwrap();
    app.press_key("escape").unwrap();
    app.wait_for_gone("Mail", WAIT).unwrap();
    shows_log(
        &mut app,
        "share open Hover, share close Hover, share open TriggerPress, share close Cancel",
    );
    assert!(app.shows("New"), "the menu stays open");
}

#[test]
fn a_controlled_submenu_stays_open_with_the_focus_as_the_app_makes_its_row_again() {
    let mut app = start_owned(true);
    // The keyboard: Down to `Share` (past `New` and `Show share`), Right
    // opens it at `Mail`, Down to `Refresh`, Space chooses it: the app
    // makes the items again.
    for key in ["down", "down", "down", "right"] {
        app.press_key(key).unwrap();
    }
    app.wait_for("Mail").unwrap();
    app.press_key("down").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("Made: 1").unwrap();
    // Open still, with the focus on `Refresh` in it: Space chooses it
    // again, Down then reaches `Print`.
    assert!(app.shows("Mail"), "open in the items made again");
    app.press_key("space").unwrap();
    app.wait_for("Made: 2").unwrap();
    app.press_key("down").unwrap();
    app.press_key("space").unwrap();
    shows_log(
        &mut app,
        "share open TriggerPress, chose print, share close Select",
    );
}
