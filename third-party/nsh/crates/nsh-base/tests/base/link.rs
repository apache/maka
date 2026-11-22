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

/// `hitSlop` widens where presses count past its bounds, as a view's
/// does: the platforms get it on the link's pressable view, it follows a
/// binding, and a link without one gets none.
mod hit_slop {
    use std::sync::{Arc, Mutex};

    use nsh_base::{LinkOpenWith, link};
    use nsh_core::{EdgeInsets, MountBatch, MountItem, NodeId, Size, element::Root, prelude::*};
    use nsh_engine::EngineConfig;
    use nsh_testing::Headless;

    /// Every batch's items.
    type Seen = Arc<Mutex<Vec<MountItem>>>;

    fn start<C: Component<Props = ()>>() -> (Headless, Seen) {
        let config = EngineConfig {
            viewport: Size::new(px(390.0), px(844.0)),
            ..EngineConfig::new(Root::of::<C>())
        };
        let mut app = Headless::start(config).unwrap();
        let seen = Seen::default();
        let log = seen.clone();
        app.observe(move |_: &str, batch: &MountBatch| {
            log.lock().unwrap().extend(batch.items.iter().cloned());
        });
        app.first_render().unwrap();
        (app, seen)
    }

    /// The hit slop the platforms last got for view `id` (none: zero).
    fn hit_slop(seen: &Seen, id: NodeId) -> EdgeInsets {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|item| match item {
                MountItem::ViewProps { id: of, props } if *of == id => Some(props.hit_slop),
                _ => None,
            })
            .next_back()
            .unwrap_or_default()
    }

    fn target(app: &Headless, selector: &str) -> NodeId {
        app.screen()
            .press_target(selector)
            .unwrap()
            .unwrap_or_else(|| panic!("no pressable {selector}"))
    }

    /// A small link with a slop on every side, a link whose slop the app
    /// widens, and a link with none.
    #[component]
    fn SmallLinks() -> impl IntoElement {
        let opened = signal(0u32);
        let wide = signal(false);
        view()
            .child(
                link()
                    .href("/help")
                    .open_with(LinkOpenWith::App)
                    .hit_slop(EdgeInsets::all(px(12.0)))
                    .accessibility_label("Help")
                    .on_open(move |_: &SharedString| opened.update(|n| *n += 1))
                    .child(text("?")),
            )
            .child(
                link()
                    .hit_slop(Prop::bind(move || match wide.get() {
                        true => EdgeInsets {
                            top: px(4.0),
                            left: px(2.0),
                            ..EdgeInsets::default()
                        },
                        false => EdgeInsets::default(),
                    }))
                    .child(text("Grows")),
            )
            .child(link().on_press(move || wide.set(true)).child(text("Widen")))
            .child(text(move || format!("opened:{}", opened.get())))
    }

    #[test]
    fn hit_slop_reaches_the_pressable_view() {
        let (mut app, seen) = start::<SmallLinks>();
        let small = target(&app, "label:Help");
        assert_eq!(hit_slop(&seen, small), EdgeInsets::all(px(12.0)));
        // The slop changes nothing of what a press does.
        app.press("label:Help").unwrap();
        app.wait_for("text:opened:1").unwrap();
    }

    #[test]
    fn hit_slop_follows_a_binding_and_is_none_by_default() {
        let (mut app, seen) = start::<SmallLinks>();
        let grows = target(&app, "text:Grows");
        let widen = target(&app, "text:Widen");
        assert_eq!(hit_slop(&seen, grows), EdgeInsets::default());
        app.press("text:Widen").unwrap();
        let expected = EdgeInsets {
            top: px(4.0),
            left: px(2.0),
            ..EdgeInsets::default()
        };
        assert_eq!(hit_slop(&seen, grows), expected);
        // A link without `hitSlop` never gets one.
        assert_eq!(hit_slop(&seen, widen), EdgeInsets::default());
    }
}

/// `href` reaches the platforms as data on the link's view (a terminal
/// links the text inside it): it follows the prop, and a disabled link
/// carries none.
mod href {
    use std::sync::{Arc, Mutex};

    use nsh_base::link;
    use nsh_core::{MountBatch, MountItem, NodeId, Size, element::Root, prelude::*};
    use nsh_engine::EngineConfig;
    use nsh_testing::Headless;

    type Seen = Arc<Mutex<Vec<MountItem>>>;

    fn start<C: Component<Props = ()>>() -> (Headless, Seen) {
        let config = EngineConfig {
            viewport: Size::new(px(390.0), px(844.0)),
            ..EngineConfig::new(Root::of::<C>())
        };
        let mut app = Headless::start(config).unwrap();
        let seen = Seen::default();
        let log = seen.clone();
        app.observe(move |_: &str, batch: &MountBatch| {
            log.lock().unwrap().extend(batch.items.iter().cloned());
        });
        app.first_render().unwrap();
        (app, seen)
    }

    /// The `href` the platforms last got for view `id`.
    fn href(seen: &Seen, id: NodeId) -> Option<String> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|item| match item {
                MountItem::ViewProps { id: of, props } if *of == id => {
                    Some(props.href.as_deref().map(str::to_owned))
                }
                _ => None,
            })
            .next_back()
            .flatten()
    }

    fn target(app: &Headless, selector: &str) -> NodeId {
        app.screen()
            .press_target(selector)
            .unwrap()
            .unwrap_or_else(|| panic!("no pressable {selector}"))
    }

    #[component]
    fn Links() -> impl IntoElement {
        let page = signal(1u32);
        let off = signal(false);
        view()
            .child(
                link()
                    .href(Prop::bind(move || {
                        Some(SharedString::from(format!(
                            "https://example.com/{}",
                            page.get()
                        )))
                    }))
                    .child(text("Docs")),
            )
            .child(
                link()
                    .href("https://example.com/old")
                    .disabled(Prop::bind(move || off.get()))
                    .child(text("Old")),
            )
            .child(link().child(text("None")))
            .child(
                view()
                    .on_press(move |_: &()| {
                        page.set(2);
                        off.set(true);
                    })
                    .child(text("Change")),
            )
    }

    #[test]
    fn href_reaches_the_links_view_and_follows_it() {
        let (mut app, seen) = start::<Links>();
        let docs = target(&app, "text:Docs");
        let old = target(&app, "text:Old");
        assert_eq!(href(&seen, docs).as_deref(), Some("https://example.com/1"));
        assert_eq!(href(&seen, old).as_deref(), Some("https://example.com/old"));
        assert_eq!(href(&seen, target(&app, "text:None")), None);
        app.press("text:Change").unwrap();
        app.wait_for("text:Change").unwrap();
        assert_eq!(href(&seen, docs).as_deref(), Some("https://example.com/2"));
        // A disabled link goes nowhere.
        assert_eq!(href(&seen, old), None);
    }
}

/// Where a link goes shows while the pointer rests on it (its URL, the
/// host whole, or its path as written), on the desktops and the web:
/// inside a text too, never for a disabled link, and never on touch
/// screens.
mod url_hint {
    use std::time::Duration;

    use nsh_base::link;
    use nsh_core::{
        Size,
        element::Root,
        platform::{Idiom, Os},
        prelude::*,
    };
    use nsh_engine::EngineConfig;
    use nsh_testing::Headless;

    fn start<C: Component<Props = ()>>(os: Os, idiom: Idiom) -> Headless {
        let mut config = EngineConfig {
            viewport: Size::new(px(390.0), px(844.0)),
            clock: nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH),
            ..EngineConfig::new(Root::of::<C>())
        };
        config.environment.os = os;
        config.environment.idiom = idiom;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        // Inline attachments publish their hint listeners after their first layout.
        app.wait(Duration::from_millis(32)).unwrap();
        app
    }

    /// A link inside a sentence, a path of the app's and a disabled link.
    #[component]
    fn Hinted() -> impl IntoElement {
        view()
            .child(
                text("Read ")
                    .child(
                        link()
                            .href("https://example.com/pricing")
                            .child(text("pricing")),
                    )
                    .child(" first."),
            )
            .child(link().href("/settings").child(text("Settings")))
            .child(
                link()
                    .href("https://example.com/old")
                    .disabled(true)
                    .child(text("Old")),
            )
    }

    #[test]
    fn resting_on_a_link_in_a_text_shows_its_url_until_the_pointer_leaves() {
        let mut app = start::<Hinted>(Os::MacOs, Idiom::Desktop);
        app.hover("text:pricing").unwrap();
        app.wait(Duration::from_millis(600)).unwrap();
        // One line of two parts: the scheme and host, then the rest. A URL
        // is written with `text:` (its `https:` would be read as a
        // selector's prefix); `shows` compares texts as written.
        app.wait_for("text:https://example.com").unwrap();
        assert!(app.shows("/pricing"));
        app.hover("text:Settings").unwrap();
        app.wait(Duration::from_millis(1000)).unwrap();
        // A path of the app's shows as written.
        app.wait_for("text:/settings").unwrap();
        assert!(!app.shows("https://example.com"), "it left");
        assert!(!app.shows("/pricing"), "it left");
    }

    /// A link whose title and destination follow the layout direction, so
    /// switching the environment's direction changes both while the
    /// pointer rests on it (no press, which would hide the hint).
    #[component]
    fn Changing() -> impl IntoElement {
        let rtl = nsh_core::element::layout_rtl;
        view().child(
            link()
                .href(Prop::bind(move || {
                    Some(SharedString::from(if rtl() {
                        "https://example.org/after"
                    } else {
                        "https://example.com/before"
                    }))
                }))
                .title(Prop::bind(move || {
                    Some(SharedString::from(if rtl() { "After" } else { "Before" }))
                }))
                .child(text("Moving")),
        )
    }

    /// The text views showing `want`, as layout placed them.
    fn laid_out(app: &Headless, want: &str) -> nsh_testing::LayoutNode {
        let nodes = app.screen().layout_nodes();
        let found: Vec<_> = nodes
            .into_iter()
            .filter(|n| n.text.as_ref().is_some_and(|t| t.text.text == want))
            .collect();
        assert_eq!(found.len(), 1, "one text reading {want}");
        found.into_iter().next().unwrap()
    }

    #[test]
    fn a_links_title_and_url_follow_their_props_while_it_shows() {
        let mut app = start::<Changing>(Os::MacOs, Idiom::Desktop);
        app.hover("text:Moving").unwrap();
        app.wait(Duration::from_millis(600)).unwrap();
        app.wait_for("text:https://example.com").unwrap();
        assert!(app.shows("/before"));
        // The title is in the same bubble, above the URL.
        assert!(app.shows("Before"));
        let title = laid_out(&app, "Before");
        let head = laid_out(&app, "https://example.com");
        assert!(
            title.bounds.origin.y.0 < head.bounds.origin.y.0,
            "the title above the URL"
        );
        app.set_environment("rtl", |env| env.rtl = true).unwrap();
        app.wait_for("text:https://example.org").unwrap();
        assert!(app.shows("/after"));
        assert!(app.shows("After"));
        assert!(!app.shows("https://example.com"), "no stale URL");
        assert!(!app.shows("Before"), "no stale title");
    }

    #[test]
    fn a_urls_host_comes_first_and_only_its_path_is_cut_in_the_middle_in_rtl() {
        let mut config = EngineConfig {
            viewport: Size::new(px(390.0), px(844.0)),
            clock: nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH),
            ..EngineConfig::new(Root::of::<Hinted>())
        };
        config.environment.os = Os::MacOs;
        config.environment.idiom = Idiom::Desktop;
        config.environment.rtl = true;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        // Inline attachments publish their hint listeners after their first layout.
        app.wait(Duration::from_millis(32)).unwrap();
        app.hover("text:pricing").unwrap();
        app.wait(Duration::from_millis(600)).unwrap();
        app.wait_for("text:https://example.com").unwrap();
        let head = laid_out(&app, "https://example.com");
        let rest = laid_out(&app, "/pricing");
        // Left to right in a right-to-left app: scheme and host, then the
        // path.
        assert!(
            head.bounds.origin.x.0 < rest.bounds.origin.x.0,
            "head {:?} before rest {:?}",
            head.bounds,
            rest.bounds
        );
        // The host: one line, never cut. The rest: one line, cut in its
        // middle.
        let head_text = &head.text.as_ref().unwrap().text;
        assert_eq!(head_text.max_lines, 1);
        let rest_text = &rest.text.as_ref().unwrap().text;
        assert_eq!(rest_text.max_lines, 1);
        assert_eq!(rest_text.ellipsize, nsh_core::EllipsizeMode::Middle);
    }

    #[test]
    fn a_disabled_link_shows_no_url() {
        let mut app = start::<Hinted>(Os::MacOs, Idiom::Desktop);
        app.hover("text:Old").unwrap();
        app.wait(Duration::from_millis(1000)).unwrap();
        assert!(!app.shows("https://example.com"));
        assert!(!app.shows("/old"));
    }

    #[test]
    fn a_touch_screen_shows_no_url_on_hover() {
        // The web on a phone: a pointer may pass, nothing follows it.
        let mut app = start::<Hinted>(Os::Web, Idiom::Phone);
        app.hover("text:pricing").unwrap();
        app.wait(Duration::from_millis(1000)).unwrap();
        assert!(!app.shows("https://example.com"));
    }
}

/// An enabled link, a disabled one, and one whose app class sets its own
/// cursor.
#[component]
fn Cursors() -> impl IntoElement {
    view()
        .child(link().href("https://example.com").child(text("On")))
        .child(
            link()
                .href("https://example.com")
                .disabled(true)
                .child(text("Off")),
        )
        .child(
            link()
                .href("https://example.com")
                .app_class("cursor-default")
                .child(text("Plain")),
        )
}

#[test]
fn a_link_shows_the_pointing_hand_unless_disabled_or_the_app_says_otherwise() {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use nsh_core::{Cursor, MountItem};

    let config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH),
        ..EngineConfig::new(Root::of::<Cursors>())
    };
    let mut app = Headless::start(config).unwrap();
    let seen = Arc::new(Mutex::new(HashMap::new()));
    let log = seen.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item {
                log.lock().unwrap().insert(*id, style.cursor);
            }
        }
    });
    app.first_render().unwrap();
    // Inline attachments publish their hint listeners after their first layout.
    app.wait(Duration::from_millis(32)).unwrap();
    let cursor = |app: &Headless, label: &str| {
        let id = app
            .screen()
            .press_target(&format!("text:{label}"))
            .unwrap()
            .unwrap();
        seen.lock().unwrap().get(&id).copied().unwrap_or_default()
    };
    assert_eq!(cursor(&app, "On"), Cursor::Pointer);
    assert_eq!(cursor(&app, "Plain"), Cursor::Default);
    // The disabled link takes no press: the one hand is the enabled link's.
    let hands = seen
        .lock()
        .unwrap()
        .values()
        .filter(|c| **c == Cursor::Pointer)
        .count();
    assert_eq!(hands, 1);
}
