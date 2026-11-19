//! `SplitView` outside iOS: its columns are a dock area's, the sidebar
//! beside the content and the detail at fixed widths; which show is the
//! app's `columnVisibility`; at compact width one column shows, the first
//! the visibility shows, and every column's stack keeps its pages and its
//! state across both presentations.

use std::time::Duration;

use nsh_base::{ColumnVisibility, h_resizable, nav_page, nav_stack, resizable_panel, split_view};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct MailProps {
    /// With a content column (three columns).
    triple: bool,
}

/// A page titled `title` showing it.
fn page(title: &'static str) -> impl IntoElement {
    nav_page()
        .title(title)
        .child(view().flex_1().child(text(title)))
}

/// A button setting the visibility, `id:<name>`.
fn show(name: &str, visibility: Signal<ColumnVisibility>, next: ColumnVisibility) -> View {
    view()
        .test_id(name)
        .w(px(20.0))
        .h(px(20.0))
        .on_press(move || visibility.set(next))
}

/// A split view of mailboxes, (an inbox) and a message, whose detail stack
/// can push a reply page and counts presses: what the visibility shows,
/// and that a column keeps its state.
#[component]
fn Mail(props: MailProps) -> impl IntoElement {
    let visibility = signal(ColumnVisibility::All);
    let replies = signal(Vec::<u32>::new());
    let presses = signal(0_u32);
    let detail = nav_stack()
        .child(
            nav_page().title("Message").child(
                view()
                    .flex_1()
                    .child(text("Message"))
                    .child(text(move || format!("Presses {}", presses.get())))
                    .child(
                        view()
                            .test_id("press")
                            .w(px(20.0))
                            .h(px(20.0))
                            .on_press(move || presses.update(|n| *n += 1)),
                    )
                    .child(
                        view()
                            .test_id("reply")
                            .w(px(20.0))
                            .h(px(20.0))
                            .on_press(move || replies.update(|r| r.push(1))),
                    ),
            ),
        )
        .child(each(
            move || replies.get(),
            |&reply: &u32| reply,
            move |_, _| {
                nav_page()
                    .title("Reply")
                    .on_dismiss(move |_: &()| replies.set(Vec::new()))
                    .child(view().flex_1().child(text("Reply")))
            },
        ));
    let mut split = split_view()
        .flex_1()
        .column_visibility(move || Some(visibility.get()))
        .on_column_visibility_change(move |next: &ColumnVisibility| visibility.set(*next))
        .sidebar(nav_stack().child(page("Mailboxes")))
        .detail(detail);
    if props.triple {
        split = split.content(nav_stack().child(page("Inbox")));
    }
    view()
        .size_full()
        .child(
            view()
                .flex_row()
                .child(show("all", visibility, ColumnVisibility::All))
                .child(show("double", visibility, ColumnVisibility::DoubleColumn))
                .child(show("detail", visibility, ColumnVisibility::DetailOnly))
                .child(show("automatic", visibility, ColumnVisibility::Automatic)),
        )
        .child(split)
}

/// Three columns whose detail page holds panels of the app's own, which
/// the user resizes.
#[component]
fn Panes() -> impl IntoElement {
    view().size_full().child(
        split_view()
            .flex_1()
            .sidebar(nav_stack().child(page("Mailboxes")))
            .content(nav_stack().child(page("Inbox")))
            .detail(
                nav_stack().child(
                    nav_page().title("Message").child(
                        h_resizable()
                            .child(resizable_panel().child(text("Source")))
                            .child(resizable_panel().child(text("Preview"))),
                    ),
                ),
            ),
    )
}

/// The mail on a desktop's headless surface, `width` wide.
fn start(triple: bool, width: f32) -> Headless {
    on_desktop(Root::new::<Mail>(move || MailProps { triple }), width)
}

/// `root` on a desktop's headless surface, `width` wide.
fn on_desktop(root: Root, width: f32) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(width), px(800.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app
}

/// The columns' titles that show, of the three.
fn shown(app: &Headless) -> Vec<&'static str> {
    ["Mailboxes", "Inbox", "Message"]
        .into_iter()
        .filter(|title| app.shows(title))
        .collect()
}

#[test]
fn every_column_shows_beside_the_others_where_there_is_room() {
    let mut app = start(true, 1200.0);
    app.wait_for("Message").unwrap();
    assert_eq!(shown(&app), ["Mailboxes", "Inbox", "Message"]);
    app.press("id:double").unwrap();
    app.wait_for_gone("Mailboxes", Duration::from_secs(2))
        .unwrap();
    assert_eq!(shown(&app), ["Inbox", "Message"]);
    app.press("id:detail").unwrap();
    app.wait_for_gone("Inbox", Duration::from_secs(2)).unwrap();
    assert_eq!(shown(&app), ["Message"]);
    // `automatic` shows them all where there is room.
    app.press("id:automatic").unwrap();
    app.wait_for("Mailboxes").unwrap();
    assert_eq!(shown(&app), ["Mailboxes", "Inbox", "Message"]);
}

#[test]
fn nothing_resizes_the_columns() {
    // Neither the sidebar's edge nor the boundary between the content and
    // the detail is a handle: nothing a pointer drags, a screen reader
    // adjusts or the keyboard focuses.
    for triple in [true, false] {
        let mut app = start(triple, 1200.0);
        app.wait_for("Message").unwrap();
        app.idle(Duration::from_millis(100)).unwrap();
        assert_eq!(
            app.screen().count("role:adjustable").unwrap(),
            0,
            "triple: {triple}"
        );
    }
    // Panels of the app's in a column keep their handle.
    let mut app = on_desktop(Root::of::<Panes>(), 1200.0);
    app.wait_for("role:adjustable").unwrap();
    app.idle(Duration::from_millis(100)).unwrap();
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 1);
}

#[test]
fn two_columns_keep_the_sidebar_for_double_column() {
    let mut app = start(false, 1200.0);
    app.wait_for("Message").unwrap();
    assert_eq!(shown(&app), ["Mailboxes", "Message"]);
    app.press("id:double").unwrap();
    app.idle(Duration::from_millis(100)).unwrap();
    assert_eq!(shown(&app), ["Mailboxes", "Message"]);
    app.press("id:detail").unwrap();
    app.wait_for_gone("Mailboxes", Duration::from_secs(2))
        .unwrap();
    assert_eq!(shown(&app), ["Message"]);
}

#[test]
fn one_column_shows_at_compact_width_the_first_the_visibility_shows() {
    let mut app = start(true, 390.0);
    app.wait_for("Mailboxes").unwrap();
    assert_eq!(shown(&app), ["Mailboxes"]);
    app.press("id:double").unwrap();
    app.wait_for("Inbox").unwrap();
    assert_eq!(shown(&app), ["Inbox"]);
    app.press("id:detail").unwrap();
    app.wait_for("Message").unwrap();
    assert_eq!(shown(&app), ["Message"]);
    app.press("id:automatic").unwrap();
    app.wait_for("Mailboxes").unwrap();
    assert_eq!(shown(&app), ["Mailboxes"]);
}

#[test]
fn a_column_keeps_its_pages_and_state_across_the_presentations() {
    let mut app = start(true, 1200.0);
    app.wait_for("Presses 0").unwrap();
    app.press("id:press").unwrap();
    app.wait_for("Presses 1").unwrap();
    app.press("id:reply").unwrap();
    app.wait_for("Reply").unwrap();
    // Narrow: the detail shows alone, its reply still on top.
    app.set_viewport(Size::new(px(390.0), px(800.0))).unwrap();
    app.press("id:detail").unwrap();
    app.wait_for("Reply").unwrap();
    assert!(!app.shows("Mailboxes"));
    // Wide again, and back to the message: its count stayed.
    app.set_viewport(Size::new(px(1200.0), px(800.0))).unwrap();
    app.press("id:all").unwrap();
    app.wait_for("Mailboxes").unwrap();
    assert!(app.shows("Reply"), "the reply page is still pushed");
    app.back().unwrap();
    app.wait_for("Presses 1").unwrap();
}
