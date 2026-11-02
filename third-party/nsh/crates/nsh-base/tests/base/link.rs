//! `Link`: a press, a click, Return or Space opens its `href` (the system
//! for a URL of another app or site, the app's `onOpen` with
//! `openWith="app"`), reports it, then the press; a disabled link takes no
//! press, none reaches the view around it, and the focus passes it by. On
//! macOS, where Tab stops at views that take presses.

use std::time::Duration;

use nsh_base::{LinkOpenWith, link};
use nsh_core::{AccessibilityCurrent, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

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

/// A site the system opens, a route the app opens itself, a path of the
/// app's left to the system (only reported), a disabled link inside a
/// pressable card, and the link to the page shown. The text logs what the
/// links reported, in order.
#[component]
fn Links() -> impl IntoElement {
    let log = signal(Vec::<String>::new());
    let say = move |s: String| log.update(|l| l.push(s));
    let card = signal(0u32);
    let reporting = move |el: nsh_base::LinkElement, name: &'static str| {
        el.on_open(move |href: &SharedString| say(format!("{name} open {href}")))
            .on_press(move || say(format!("{name} press")))
    };
    view()
        .child(reporting(link().href("https://example.com/docs"), "docs").child(text("Docs")))
        .child(
            reporting(
                link()
                    .href("/orders/42")
                    .open_with(LinkOpenWith::App)
                    .accessibility_label("Order 42"),
                "order",
            )
            .child(text("#42")),
        )
        .child(reporting(link().href("/help"), "help").child(text("Help")))
        .child(
            view()
                .on_press(move || card.update(|n| *n += 1))
                .child(text("Card"))
                .child(
                    reporting(link().href("https://example.com/old").disabled(true), "old")
                        .child(text("Archived")),
                ),
        )
        .child(link().current(true).child(text("Home")))
        .child(text(move || format!("log:{}", log.get().join(","))))
        .child(text(move || format!("card:{}", card.get())))
}

#[test]
fn a_press_opens_a_site_through_the_system_and_reports_open_then_press() {
    let mut app = start::<Links>();
    app.press("role:link[Docs]").unwrap();
    app.wait_for("text:log:docs open https://example.com/docs,docs press")
        .unwrap();
    assert_eq!(app.screen().opened_urls(), ["https://example.com/docs"]);
}

#[test]
fn with_open_with_app_the_app_opens_it_and_nothing_else_does() {
    let mut app = start::<Links>();
    app.press("role:link[Order 42]").unwrap();
    app.wait_for("text:log:order open /orders/42,order press")
        .unwrap();
    assert!(app.screen().opened_urls().is_empty());
}

#[test]
fn a_path_of_the_apps_is_only_reported() {
    let mut app = start::<Links>();
    app.press("role:link[Help]").unwrap();
    app.wait_for("text:log:help open /help,help press").unwrap();
    assert!(app.screen().opened_urls().is_empty());
}

#[test]
fn return_and_space_each_open_the_focused_link() {
    let mut app = start::<Links>();
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:log:docs open https://example.com/docs,docs press")
        .unwrap();
    app.press_key("space").unwrap();
    app.wait_for(
        "text:log:docs open https://example.com/docs,docs press,docs open https://example.com/docs,docs press",
    )
    .unwrap();
    assert_eq!(app.screen().opened_urls().len(), 2);
}

#[test]
fn a_disabled_link_is_inert_and_keeps_presses_from_what_is_around_it() {
    let mut app = start::<Links>();
    assert!(!app.screen().enabled("role:link[Archived]").unwrap());
    assert!(app.press("role:link[Archived]").is_err());
    app.wait(Duration::from_millis(50)).unwrap();
    app.wait_for("text:log:").unwrap();
    app.wait_for("text:card:0").unwrap();
    assert!(app.screen().opened_urls().is_empty());
    assert!(
        app.screen()
            .accessibility_state("role:link[Archived]")
            .unwrap()
            .disabled
    );
    // The focus passes it by: four Tabs go over the three links to the
    // card, a stop of its own; the disabled link inside it is none.
    for _ in 0..4 {
        app.press_key("tab").unwrap();
    }
    app.press_key("enter").unwrap();
    app.wait_for("text:card:1").unwrap();
}

#[test]
fn the_link_role_its_label_and_the_current_page_reach_screen_readers() {
    let app = start::<Links>();
    let screen = app.screen();
    assert_eq!(screen.count("role:link").unwrap(), 5);
    assert!(screen.matches("role:link[Order 42]").unwrap());
    assert_eq!(
        screen
            .accessibility_state("role:link[Home]")
            .unwrap()
            .current,
        Some(AccessibilityCurrent::Page)
    );
    assert_eq!(
        screen
            .accessibility_state("role:link[Docs]")
            .unwrap()
            .current,
        None
    );
}
