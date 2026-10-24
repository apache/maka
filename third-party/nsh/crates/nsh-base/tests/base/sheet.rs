//! `Sheet`: it comes in when opened and goes once its slide-out ends, also
//! on a manual clock that only the test moves (its end is the motion's,
//! not a timer of the app's clock).

use nsh_base::sheet;
use nsh_core::{
    Size,
    ui::{Root, prelude::*},
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

fn start<C: Component<Props = ()>>() -> Headless {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    })
    .unwrap();
    app.first_render().unwrap();
    app
}

#[component]
fn SwipeScreen() -> impl IntoElement {
    let open = signal(true);
    let permitted = signal(true);
    let decline = signal(false);
    let requests = signal(0);
    view()
        .child(text(move || format!("requests:{}", requests.get())))
        .child(
            sheet()
                .open(move || Some(open.get()))
                .close_on_swipe(permitted)
                .on_open_change(move |_: &nsh_base::SheetEvent| {
                    requests.update(|n| *n += 1);
                    if !decline.get_untracked() {
                        open.set(false);
                    }
                })
                .child(
                    view()
                        .h(px(260.0))
                        .child(
                            view()
                                .test_id("handle")
                                .h(px(44.0))
                                .child(text("Sheet body")),
                        )
                        .child(
                            view()
                                .test_id("lock")
                                .h(px(44.0))
                                .on_press(move || permitted.set(false)),
                        )
                        .child(
                            view()
                                .test_id("decline")
                                .h(px(44.0))
                                .on_press(move || decline.set(true)),
                        )
                        .child(
                            view()
                                .test_id("close")
                                .h(px(44.0))
                                .on_press(move || open.set(false)),
                        ),
                ),
        )
}

#[test]
fn a_bottom_sheet_can_be_swiped_closed() {
    let mut app = start::<SwipeScreen>();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.drag("id:handle", point(px(0.0), px(100.0))).unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(2))
        .unwrap();
    app.wait_for("requests:1").unwrap();
}

#[test]
fn a_short_drag_returns_without_a_close_request() {
    let mut app = start::<SwipeScreen>();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.drag("id:handle", point(px(0.0), px(20.0))).unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("requests:0").unwrap();
    app.press("id:close").unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(2))
        .unwrap();
}

#[test]
fn a_cancelled_drag_does_not_close_even_past_the_release_threshold() {
    use std::sync::{Arc, Mutex};

    use nsh_core::{EventKind, EventPayload, MountItem};

    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<SwipeScreen>())
    })
    .unwrap();
    let panel = Arc::new(Mutex::new(None));
    let seen = panel.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::Events { id, events } = item
                && events.contains(EventKind::PanEnd)
            {
                *seen.lock().unwrap() = Some(*id);
            }
        }
    });
    app.first_render().unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    let id = panel
        .lock()
        .unwrap()
        .expect("the sheet listens for release");
    app.engine().control().dispatch_event(
        id,
        EventKind::PanEnd,
        EventPayload::PanCancelled {
            translation: point(px(0.0), px(150.0)),
            velocity_x: 0.0,
            velocity_y: 2000.0,
            value_x: None,
            value_y: Some(px(150.0)),
        },
    );
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("requests:0").unwrap();
    app.press("id:close").unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(2))
        .unwrap();
}

#[test]
fn a_permission_change_keeps_the_existing_content_and_stops_swiping() {
    let mut app = start::<SwipeScreen>();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.press("id:lock").unwrap();
    app.drag("id:handle", point(px(0.0), px(100.0))).unwrap();
    app.wait_for("requests:0").unwrap();
    app.wait_for("Sheet body").unwrap();
}

#[test]
fn declining_a_controlled_request_returns_the_sheet() {
    let mut app = start::<SwipeScreen>();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.press("id:decline").unwrap();
    app.drag("id:handle", point(px(0.0), px(100.0))).unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("requests:1").unwrap();
    app.press("id:close").unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(2))
        .unwrap();
}

#[test]
fn swiping_is_opt_in() {
    let mut app = start::<Screen>();
    app.press("id:toggle").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.drag("Sheet body", point(px(0.0), px(120.0))).unwrap();
    app.wait_for("Sheet body").unwrap();
    app.press("id:toggle").unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(2))
        .unwrap();
}

/// A button that opens and closes a sheet holding `Sheet body`.
#[component]
fn Screen() -> impl IntoElement {
    let open = signal(false);
    view()
        .child(
            view()
                .test_id("toggle")
                .w(px(40.0))
                .h(px(40.0))
                .on_press(move || open.set(!open.get_untracked())),
        )
        .child(
            sheet()
                .open(move || Some(open.get()))
                .child(view().h(px(200.0)).child(text("Sheet body"))),
        )
}

#[test]
fn a_sheet_goes_once_its_motion_ends_on_a_manual_clock() {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(Root::of::<Screen>())
    })
    .expect("the engine starts");
    app.first_render().unwrap();
    app.press("id:toggle").unwrap();
    app.wait_for("Sheet body").unwrap();
    app.press("id:toggle").unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(5))
        .unwrap();
}

#[derive(Clone, PartialEq, Props)]
struct GrowingProps {
    swipe: bool,
    side: Placement,
    menu: bool,
    grow_later: bool,
}

/// The first layout contains only padding. Content fills in during the
/// next layout round, like JS lazy children, and optionally grows later.
#[component]
fn GrowingScreen(props: GrowingProps) -> impl IntoElement {
    let open = signal(false);
    let extent = signal(px(0.0));
    let horizontal = matches!(props.side, Placement::Left | Placement::Right);
    let body = view()
        .style_with(move |s| {
            if horizontal {
                s.w(extent.get())
            } else {
                s.h(extent.get())
            }
        })
        .on_layout(move |_: &Bounds<Points>| {
            if extent.get_untracked() == px(0.0) {
                extent.set(px(300.0));
                if props.grow_later {
                    set_timeout(std::time::Duration::from_millis(80), move || {
                        extent.set(px(500.0));
                    });
                }
            }
        })
        .child(
            view()
                .test_id("grow-close")
                .h(px(44.0))
                .on_press(move || open.set(false)),
        );
    let panel = if props.menu {
        nsh_base::menu()
            .open(move || Some(open.get()))
            .popup_style(|s| s.pt(px(8.0)).pb(px(46.0)))
            .child(body)
            .into_element()
    } else {
        sheet()
            .open(move || Some(open.get()))
            .side(props.side)
            .close_on_swipe(props.swipe)
            .popup_style(move |s| {
                if horizontal {
                    s.pl(px(8.0)).pr(px(46.0))
                } else {
                    s.pt(px(8.0)).pb(px(46.0))
                }
            })
            .child(body)
            .into_element()
    };
    view()
        .child(
            view()
                .test_id("grow-open")
                .w(px(44.0))
                .h(px(44.0))
                .on_press(move || {
                    extent.set(px(0.0));
                    open.set(true);
                }),
        )
        .child(panel)
}

#[derive(Debug)]
struct Presented {
    extent: f32,
    translation: f32,
    fraction: f32,
}

type Presentations = std::sync::Arc<std::sync::Mutex<Vec<Presented>>>;

/// Replay the platform's complete native batches, including derived
/// animation bindings. No display tick occurs in the middle of a batch.
fn observe_entrance(
    app: &mut Headless,
    side: Placement,
    menu: bool,
    advance: bool,
) -> Presentations {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use nsh_core::{
        MountItem,
        animation::{AnimationProp, Graph},
    };

    let horizontal = matches!(side, Placement::Left | Placement::Right);
    let index = if horizontal || menu { 0 } else { 1 };
    let sign = if matches!(side, Placement::Left | Placement::Top) {
        -1.0
    } else {
        1.0
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let result = seen.clone();
    let mut graph = Graph::default();
    let mut bindings = HashMap::new();
    let mut finished = Vec::new();
    let mut fraction = 1.0;
    let mut advanced = false;
    app.observe(move |_, batch| {
        let mut frames = Vec::new();
        for item in &batch.items {
            match item {
                MountItem::Animation(op) => graph.apply(op.clone(), &mut finished),
                MountItem::AnimationBindings {
                    id,
                    bindings: values,
                } => {
                    for (prop, node) in values {
                        if *prop == AnimationProp::Transform(index) {
                            bindings.insert(*id, *node);
                        }
                    }
                }
                MountItem::Frame { id, frame } => {
                    let extent = if horizontal {
                        frame.size.width.0
                    } else {
                        frame.size.height.0
                    };
                    frames.push((*id, extent));
                }
                _ => {}
            }
        }
        if let Some((node, extent)) = frames
            .into_iter()
            .rev()
            .find_map(|(id, extent)| bindings.get(&id).map(|n| (*n, extent)))
        {
            seen.lock().unwrap().push(Presented {
                extent,
                translation: sign * graph.eval(node).number(),
                fraction,
            });
            if advance && !advanced {
                graph.tick(0.0, &mut finished);
                graph.tick(0.08, &mut finished);
                fraction = sign * graph.eval(node).number() / extent;
                advanced = true;
            }
        }
    });
    result
}

fn growing_app(props: GrowingProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::new::<GrowingScreen>(move || props.clone()))
    };
    config.environment.os = nsh_core::platform::Os::Ios;
    config.environment.idiom = nsh_core::platform::Idiom::Phone;
    Headless::start(config).unwrap()
}

#[test]
fn an_entrance_uses_the_complete_height_in_its_first_native_batch() {
    for (side, menu) in [
        (Placement::Bottom, false),
        (Placement::Top, false),
        (Placement::Left, false),
        (Placement::Right, false),
        (Placement::Bottom, true),
    ] {
        for swipe in [false, true] {
            let mut app = growing_app(GrowingProps {
                swipe,
                side,
                menu,
                grow_later: false,
            });
            let starts = observe_entrance(&mut app, side, menu, false);
            app.first_render().unwrap();
            for opening in 0..2 {
                app.press("id:grow-open").unwrap();
                app.wait(std::time::Duration::from_millis(350)).unwrap();
                let starts = starts.lock().unwrap();
                assert_eq!(
                    starts.len(),
                    opening + 1,
                    "side={side:?}, menu={menu}, swipe={swipe}: {starts:?}"
                );
                assert!(
                    (starts[opening].translation - 354.0).abs() < 0.01,
                    "side={side:?}, menu={menu}, swipe={swipe}, opening={opening}: {starts:?}"
                );
                drop(starts);
                app.press("id:grow-close").unwrap();
                app.wait(std::time::Duration::from_millis(250)).unwrap();
            }
        }
    }
}

#[test]
fn asynchronous_growth_preserves_the_native_entrance_fraction() {
    for menu in [false, true] {
        let mut app = growing_app(GrowingProps {
            swipe: true,
            side: Placement::Bottom,
            menu,
            grow_later: true,
        });
        let samples = observe_entrance(&mut app, Placement::Bottom, menu, true);
        app.first_render().unwrap();
        app.press("id:grow-open").unwrap();
        app.wait(std::time::Duration::from_millis(400)).unwrap();
        let samples = samples.lock().unwrap();
        let grown = samples
            .iter()
            .find(|s| s.extent == 554.0)
            .unwrap_or_else(|| {
                panic!("menu={menu}: the later content was not laid out: {samples:?}")
            });
        assert!(grown.fraction > 0.0 && grown.fraction < 1.0);
        assert!(
            (grown.translation / grown.extent - grown.fraction).abs() < 0.001,
            "menu={menu}: growth restarted or lost the entrance fraction: {samples:?}"
        );
    }
}

#[test]
fn a_long_swipe_exit_keeps_fading_the_backdrop() {
    use std::sync::{Arc, Mutex};

    use nsh_core::{
        EventKind, EventPayload, MountItem,
        animation::{AnimationProp, Graph},
    };

    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<SwipeScreen>())
    })
    .unwrap();
    let native = Arc::new(Mutex::new((Graph::default(), None, None)));
    let observed = native.clone();
    app.observe(move |_, batch| {
        let mut native = observed.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Animation(op) => native.0.apply(op.clone(), &mut Vec::new()),
                MountItem::Gestures { id, values } if values.pan_y.is_some() => {
                    native.1 = Some((*id, values.pan_y.unwrap()));
                }
                MountItem::AnimationBindings { bindings, .. } => {
                    for (prop, node) in bindings {
                        if *prop == AnimationProp::Opacity {
                            native.2 = Some(*node);
                        }
                    }
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    let (panel, opacity) = {
        let mut native = native.lock().unwrap();
        native.0.tick(0.0, &mut Vec::new());
        native.0.tick(1.0, &mut Vec::new());
        let (panel, pan) = native.1.expect("the settled sheet mounts native dragging");
        let opacity = native.2.expect("the backdrop binds native opacity");
        native.0.set(pan, 200.0, &mut Vec::new());
        assert!((native.0.eval(opacity).number() - 60.0 / 260.0).abs() < 0.001);
        (panel, opacity)
    };
    app.engine().control().dispatch_event(
        panel,
        EventKind::PanEnd,
        EventPayload::Pan {
            translation: point(px(0.0), px(200.0)),
            velocity_x: 0.0,
            velocity_y: 0.0,
            value_x: None,
            value_y: Some(px(200.0)),
        },
    );
    app.wait(std::time::Duration::from_millis(20)).unwrap();
    let mut native = native.lock().unwrap();
    let mut before = native.0.eval(opacity).number();
    for frame in 0..=20 {
        native
            .0
            .tick(1.0 + f64::from(frame) / 100.0, &mut Vec::new());
        let after = native.0.eval(opacity).number();
        assert!(
            after <= before + 0.0001,
            "the backdrop darkened: {before} -> {after}"
        );
        before = after;
    }
    assert!(before < 0.001, "the exit finishes transparent: {before}");
}
