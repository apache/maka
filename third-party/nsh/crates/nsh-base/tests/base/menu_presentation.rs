//! How a menu presents itself on a tablet: on an iPad whose horizontal
//! size class is regular, a popup at its trigger as on the desktops (it
//! reports where it went); in a compact width, on a phone and on the other
//! tablets, the sheet (which reports no position). Resizing an iPad's
//! window across its size class presents the next opening the other way,
//! and an open menu stays open in its new presentation. A press outside the
//! iPad's popup only closes it, as a popover's on a touch screen, and a
//! finger held on a context menu's trigger opens its popup at the finger.

use std::time::Duration;

use nsh_base::{ContextMenuEvents, MenuEvent, context_menu, menu, menu_item};
use nsh_core::{
    NodeId, ROOT_ID, Size, TouchEvent, TouchPhase, TouchPoint,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const GONE: Duration = Duration::from_secs(5);

/// The menus in an 834 by 1194 window (an 11-inch iPad's, portrait) on
/// `os` in `idiom`, its horizontal size class `width` as the platform
/// reports it (`None`: from the window's width).
fn start(os: Os, idiom: Idiom, width: Option<SizeClass>) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(834.0), px(1194.0)),
        ..EngineConfig::new(nsh_testing::windowed_root::<Menus>())
    };
    config.environment.os = os;
    config.environment.idiom = idiom;
    config.environment.horizontal_size_class = width;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app
}

fn ipad(width: SizeClass) -> Headless {
    start(Os::Ios, Idiom::Pad, Some(width))
}

/// A File menu at (40, 100) and a photo's context menu below it, each
/// saying where its popup went (`onPosition`, which a sheet never
/// reports), and a row further down that counts its presses.
#[component]
fn Menus() -> impl IntoElement {
    let side = signal(None::<Placement>);
    let at = signal(None::<Point<Points>>);
    let presses = signal(0);
    let row =
        |id: &'static str, label: &'static str| view().test_id(id).h(px(30.0)).child(text(label));
    view()
        .pt(px(100.0))
        .pl(px(40.0))
        .child(
            menu()
                .on_position(move |e: &MenuEvent| {
                    if let MenuEvent::Position(placement, ..) = e {
                        side.set(Some(*placement));
                    }
                })
                .trigger(row("file", "File").w(px(80.0)))
                .child(menu_item().child(row("new", "New"))),
        )
        .child(
            context_menu()
                .on_position(move |e: &ContextMenuEvents| {
                    if let ContextMenuEvents::Position(_, bounds, _) = e {
                        at.set(Some(bounds.origin));
                    }
                })
                .trigger(row("photo", "Photo").w(px(200.0)))
                .child(menu_item().child(row("share", "Share"))),
        )
        .child(
            view()
                .test_id("other")
                .mt(px(400.0))
                .w(px(200.0))
                .h(px(40.0))
                .on_press(move || presses.update(|n| *n += 1))
                .child(text("Other")),
        )
        .child(text(move || format!("Side: {:?}", side.get())))
        .child(text(move || match at.get() {
            Some(p) => format!("At: {},{}", p.x.0, p.y.0),
            None => "At: none".into(),
        }))
        .child(text(move || format!("Presses: {}", presses.get())))
}

/// Opens the File menu and waits for its item.
fn open_file(app: &mut Headless) {
    app.press("id:file").unwrap();
    app.wait_for("New").unwrap();
    // A popup reports where it went in the frames after it is made.
    app.wait(Duration::from_millis(100)).unwrap();
}

#[test]
fn an_ipad_in_a_regular_width_opens_a_popup_at_the_trigger() {
    let mut app = ipad(SizeClass::Regular);
    open_file(&mut app);
    app.wait_for("Side: Some(Bottom)").unwrap();
}

#[test]
fn a_compact_ipad_a_phone_and_other_tablets_open_the_sheet() {
    for (os, idiom, width) in [
        (Os::Ios, Idiom::Pad, Some(SizeClass::Compact)),
        // A large phone in landscape is regular in width: still a phone.
        (Os::Ios, Idiom::Phone, Some(SizeClass::Regular)),
        (Os::Android, Idiom::Pad, None),
    ] {
        let mut app = start(os, idiom, width);
        open_file(&mut app);
        assert!(
            app.shows("Side: None"),
            "{os:?} {idiom:?} {width:?}: a sheet, placed by no anchor"
        );
    }
}

#[test]
fn resizing_an_ipads_window_across_its_size_class_switches_the_presentation() {
    let mut app = ipad(SizeClass::Compact);
    open_file(&mut app);
    assert!(app.shows("Side: None"), "compact: the sheet");
    app.press_key("escape").unwrap();
    app.wait_for_gone("New", GONE).unwrap();
    app.set_environment("regular width", |e| {
        e.horizontal_size_class = Some(SizeClass::Regular)
    })
    .unwrap();
    open_file(&mut app);
    app.wait_for("Side: Some(Bottom)").unwrap();
    // Open while the window narrows: it stays open, as the sheet.
    app.set_environment("compact width", |e| {
        e.horizontal_size_class = Some(SizeClass::Compact)
    })
    .unwrap();
    app.wait(Duration::from_millis(500)).unwrap();
    assert!(app.shows("New"), "still open, in the sheet");
}

/// The overlay over the whole window that takes a press outside the
/// popup: a view at the top with nothing in it.
fn backdrop(app: &Headless) -> Option<NodeId> {
    let nodes = app.screen().layout_nodes();
    let window = Size::new(px(834.0), px(1194.0));
    nodes
        .iter()
        .find(|n| {
            n.parent == ROOT_ID
                && n.bounds.origin == Point::default()
                && n.bounds.size == window
                && !nodes.iter().any(|c| c.parent == n.id)
        })
        .map(|n| n.id)
}

#[test]
fn a_press_outside_an_ipads_popup_only_closes_it() {
    let mut app = ipad(SizeClass::Regular);
    open_file(&mut app);
    app.wait_for("Side: Some(Bottom)").unwrap();
    // The popup's own press outside goes on to what is under it on the
    // desktops; here it closes nothing.
    app.press("id:other").unwrap();
    app.wait(Duration::from_millis(100)).unwrap();
    assert!(
        app.shows("New"),
        "a touch screen's press outside is the backdrop's"
    );
    let cover = backdrop(&app).expect("an overlay over the window under the popup");
    app.press(&format!("view:{cover}")).unwrap();
    app.wait_for_gone("New", GONE).unwrap();
    assert!(backdrop(&app).is_none(), "it goes with the menu");
}

#[test]
fn a_held_finger_opens_an_ipads_context_menu_at_the_finger() {
    let mut app = ipad(SizeClass::Regular);
    // The photo is at (40, 130), 200 by 30; the finger on it at (140, 145),
    // held still past the hold, as the platform reports it.
    let photo = app.screen().id("id:photo").unwrap();
    let touch = TouchEvent {
        phase: TouchPhase::Start,
        timestamp: 0.0,
        points: vec![TouchPoint {
            id: 1,
            target: photo,
            path: vec![photo],
            page: point(px(140.0), px(145.0)),
            location: point(px(100.0), px(15.0)),
            changed: true,
            pointer_type: PointerType::Touch,
            pressure: 0.5,
            tilt_x: 0.0,
            tilt_y: 0.0,
        }],
        modifiers: Default::default(),
        activated: None,
    };
    app.engine().control().dispatch_event(
        ROOT_ID,
        EventKind::Touch,
        EventPayload::Touch(Box::new(touch)),
    );
    app.wait(Duration::from_millis(600)).unwrap();
    app.wait_for("Share").unwrap();
    app.wait_for("At: 140,145").unwrap();
}
