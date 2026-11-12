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
