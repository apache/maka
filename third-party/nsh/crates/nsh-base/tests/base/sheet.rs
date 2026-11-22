//! `Sheet`: it comes in when opened and goes once its slide-out ends, also
//! on a manual clock that only the test moves (its end is the motion's,
//! not a timer of the app's clock). A bottom sheet, and a menu a phone
//! shows as one, stays above the software keyboard. On every platform it
//! is a modal dialog named by its `accessibilityLabel`: where the keyboard
//! moves between views, the focus leaves what is under it, Tab goes round
//! its stops and the focus goes back as it closes.

use nsh_base::sheet;
use nsh_core::{Size, element::Root, prelude::*};
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
    app.wait_for("text:requests:1").unwrap();
}

#[test]
fn a_short_drag_returns_without_a_close_request() {
    let mut app = start::<SwipeScreen>();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.drag("id:handle", point(px(0.0), px(20.0))).unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("text:requests:0").unwrap();
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
    app.wait_for("text:requests:0").unwrap();
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
    app.wait_for("text:requests:0").unwrap();
    app.wait_for("Sheet body").unwrap();
}

#[test]
fn declining_a_controlled_request_returns_the_sheet() {
    let mut app = start::<SwipeScreen>();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.press("id:decline").unwrap();
    app.drag("id:handle", point(px(0.0), px(100.0))).unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("text:requests:1").unwrap();
    app.press("id:close").unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(2))
        .unwrap();
}

/// A swipeable sheet holding an input over its handle.
#[component]
fn EditingScreen() -> impl IntoElement {
    let editing = signal(false);
    sheet().open(Some(true)).close_on_swipe(true).child(
        view()
            .h(px(200.0))
            .child(text(move || format!("editing:{}", editing.get())))
            .child(
                nsh_base::input()
                    .test_id("field")
                    .h(px(40.0))
                    .on_focus(move || editing.set(true))
                    .on_blur(move || editing.set(false)),
            )
            .child(
                view()
                    .test_id("handle")
                    .h(px(44.0))
                    .child(text("Sheet body")),
            ),
    )
}

#[test]
fn dragging_a_sheet_ends_editing_in_it() {
    let mut app = start::<EditingScreen>();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.type_text("id:field", "hi").unwrap();
    app.wait_for("text:editing:true").unwrap();
    app.drag("id:handle", point(px(0.0), px(20.0))).unwrap();
    app.wait_for("text:editing:false").unwrap();
    app.wait_for("Sheet body").unwrap();
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

#[test]
fn a_web_sheet_uses_the_presented_surface_size_and_keeps_its_close_lifecycle() {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use nsh_core::{EdgeInsets, MountItem, ViewKind};

    let mut config = EngineConfig {
        viewport: Size::new(px(320.0), px(240.0)),
        ..EngineConfig::new(Root::of::<SwipeScreen>())
    };
    config.environment.os = nsh_core::platform::Os::Web;
    let mut app = Headless::start(config).unwrap();
    let state = Arc::new(Mutex::new((None, HashMap::new())));
    let observed = state.clone();
    app.observe(move |_, batch| {
        let mut state = observed.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Create {
                    id,
                    kind: ViewKind::Modal,
                } => state.0 = Some(*id),
                MountItem::Frame { id, frame } => {
                    state.1.insert(*id, *frame);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    let modal = state
        .lock()
        .unwrap()
        .0
        .expect("the web sheet has a presentation surface");
    let viewport = Size::new(px(1280.0), px(720.0));
    app.engine()
        .control()
        .set_root_size(modal, viewport, EdgeInsets::default());
    app.wait(Duration::from_millis(400)).unwrap();
    {
        let state = state.lock().unwrap();
        assert!(
            state
                .1
                .iter()
                .any(|(id, frame)| *id != modal && frame.size == viewport),
            "the sheet backdrop fills the presented viewport"
        );
    }
    app.press_key("Escape").unwrap();
    app.wait_for_gone("Sheet body", Duration::from_secs(2))
        .unwrap();
    app.wait_for("text:requests:1").unwrap();
}

/// A phone's surface (390 × 844, 47 points of safe area at the top and 34
/// at the bottom) on a manual clock showing `C`.
fn start_on_a_phone<C: Component<Props = ()>>() -> Headless {
    use nsh_core::platform::{Idiom, Os};

    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(Root::of::<C>())
    };
    config.environment.os = Os::Ios;
    config.environment.idiom = Idiom::Phone;
    config.environment.safe_area.top = px(47.0);
    config.environment.safe_area.bottom = px(34.0);
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

/// The bounds of the view with `test_id`, in the surface.
fn bounds_of(app: &Headless, test_id: &str) -> nsh_core::Bounds<Points> {
    app.screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.test_id.as_deref() == Some(test_id))
        .unwrap_or_else(|| panic!("a view {test_id}"))
        .bounds
}

/// The software keyboard comes up `height` points high (the bottom safe
/// area under it included), moving for 250 ms, and the frames settle.
fn keyboard(app: &mut Headless, height: f32) {
    start_keyboard(app, height);
    app.run_for(std::time::Duration::from_millis(400)).unwrap();
}

/// [`keyboard`] without waiting: the keyboard starts to move.
fn start_keyboard(app: &mut Headless, height: f32) {
    app.set_environment("keyboard", |e| {
        e.keyboard_height = px(height);
        e.keyboard_duration = 250.0;
    })
    .unwrap();
}

/// A bottom sheet padded by the safe area, open at first.
#[component]
fn KeyboardSheet() -> impl IntoElement {
    sheet().default_open(true).child(
        view()
            .pb_safe_area()
            .child(view().test_id("first").h(px(44.0)).child(text("First")))
            .child(view().test_id("last").h(px(44.0)).child(text("Last"))),
    )
}

#[test]
fn a_bottom_sheet_stays_above_the_keyboard() {
    use std::sync::{Arc, Mutex};

    use nsh_core::{LayoutAnimation, LayoutCurve, MountItem};

    let mut app = start_on_a_phone::<KeyboardSheet>();
    app.run_for(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("Last").unwrap();
    assert_eq!(
        bounds_of(&app, "last").bottom(),
        px(844.0 - 34.0),
        "above the home indicator"
    );
    // Whether the batches that move views lead with the keyboard's motion.
    let moves = Arc::new(Mutex::new(Vec::new()));
    let seen = moves.clone();
    app.observe(move |_, batch| {
        if batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Frame { .. }))
        {
            seen.lock().unwrap().push(matches!(
                batch.items.first(),
                Some(MountItem::LayoutAnimation(LayoutAnimation { update: Some(t), .. }))
                    if t.curve == LayoutCurve::Keyboard
            ));
        }
    });
    keyboard(&mut app, 336.0);
    assert_eq!(
        bounds_of(&app, "last").bottom(),
        px(844.0 - 336.0),
        "right above the keyboard, the safe area's padding behind it"
    );
    assert_eq!(
        *moves.lock().unwrap(),
        [true],
        "moved once, with the keyboard"
    );
    keyboard(&mut app, 0.0);
    assert_eq!(
        bounds_of(&app, "last").bottom(),
        px(844.0 - 34.0),
        "back down with the keyboard gone"
    );
}

/// A sheet taller than the room above the keyboard.
#[component]
fn TallKeyboardSheet() -> impl IntoElement {
    sheet().default_open(true).child(
        view()
            .test_id("panel")
            .h(px(700.0))
            .pb_safe_area()
            .child(text("Tall")),
    )
}

#[test]
fn a_bottom_sheet_above_the_keyboard_stays_below_the_status_bar() {
    let mut app = start_on_a_phone::<TallKeyboardSheet>();
    app.run_for(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("Tall").unwrap();
    keyboard(&mut app, 336.0);
    // The sheet's panel: the view around the app's content.
    let nodes = app.screen().layout_nodes();
    let content = nodes
        .iter()
        .find(|n| n.test_id.as_deref() == Some("panel"))
        .expect("the content");
    let panel = nodes
        .iter()
        .find(|n| n.id == content.parent)
        .expect("the panel")
        .bounds;
    assert_eq!(
        panel.bottom(),
        px(844.0 - (336.0 - 34.0)),
        "above the keyboard, past the home indicator: {panel:?}"
    );
    assert_eq!(
        panel.origin.y,
        px(47.0),
        "held below the status bar: {panel:?}"
    );
}

/// A menu, which a phone shows as a sheet at the bottom, padded by the
/// safe area.
#[component]
fn KeyboardMenu() -> impl IntoElement {
    use nsh_base::{menu, menu_item};

    view().pt(px(100.0)).child(
        menu()
            .popup_class("pb-[env(safe-area-inset-bottom)]")
            .trigger(view().test_id("plus").h(px(44.0)).child(text("Plus")))
            .child(menu_item().child(view().h(px(44.0)).child(text("Photo"))))
            .child(menu_item().child(view().test_id("file").h(px(44.0)).child(text("File")))),
    )
}

#[test]
fn a_menu_sheet_opened_with_the_keyboard_up_is_above_it() {
    let mut app = start_on_a_phone::<KeyboardMenu>();
    keyboard(&mut app, 336.0);
    app.press("id:plus").unwrap();
    app.run_for(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("File").unwrap();
    assert_eq!(
        bounds_of(&app, "file").bottom(),
        px(844.0 - 336.0),
        "the last item right above the keyboard"
    );
}

/// A Settings sheet the app opens with a button, two buttons in its panel
/// and a stop after it all, logging the focus they take.
#[component]
fn FocusSheet() -> impl IntoElement {
    let open = signal(false);
    let closes = signal(0);
    let log = signal(String::from("focus"));
    let note = move |what: &'static str| log.update(|log| *log = format!("{log} {what}"));
    let stop = move |id: &'static str| {
        view()
            .test_id(id)
            .focusable(true)
            .h(px(44.0))
            .on_focus(move |_: &()| note(id))
            .child(text(id))
    };
    view()
        .child(text(move || log.get()))
        .child(text(move || format!("closes:{}", closes.get())))
        .child(stop("open").on_press(move || open.set(true)))
        .child(
            sheet()
                .open(move || Some(open.get()))
                .accessibility_label("Settings")
                .on_open_change(move |e: &nsh_base::SheetEvent| {
                    if let nsh_base::SheetEvent::OpenChange(next, _) = e {
                        open.set(*next);
                        closes.update(|n| *n += 1);
                    }
                })
                .child(
                    view()
                        .h(px(200.0))
                        .child(stop("first"))
                        .child(stop("second")),
                ),
        )
        .child(stop("after"))
}

fn start_on<C: Component<Props = ()>>(os: nsh_core::platform::Os) -> Headless {
    use nsh_core::platform::Idiom;

    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    config.environment.os = os;
    config.environment.idiom = if matches!(os, nsh_core::platform::Os::Ios) {
        Idiom::Phone
    } else {
        Idiom::Desktop
    };
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

#[test]
fn a_sheet_is_a_dialog_named_by_its_label_everywhere() {
    use nsh_core::platform::Os;

    for os in [
        Os::Ios,
        Os::Android,
        Os::MacOs,
        Os::Windows,
        Os::Linux,
        Os::Web,
    ] {
        let mut app = start_on::<FocusSheet>(os);
        app.press("id:open").unwrap();
        app.wait_for("first").unwrap();
        let screen = app.screen();
        assert_eq!(screen.count("role:dialog[Settings]"), Ok(1), "{os:?}");
        assert_eq!(screen.count("role:dialog >> id:second"), Ok(1), "{os:?}");
    }
}

#[test]
fn a_sheet_keeps_the_keyboard_focus_while_it_shows_and_gives_it_back() {
    use nsh_core::platform::Os;

    for os in [Os::MacOs, Os::Windows, Os::Linux, Os::Web] {
        let mut app = start_on::<FocusSheet>(os);
        app.press_key("tab").unwrap();
        app.wait_for("text:focus open").unwrap();
        // Opened from the keyboard: the focus leaves the button under it,
        // and Tab goes round the panel's stops, never out to the rest.
        app.press_key("enter").unwrap();
        app.wait_for("first").unwrap();
        app.wait(std::time::Duration::from_millis(400)).unwrap();
        for _ in 0..3 {
            app.press_key("tab").unwrap();
        }
        app.wait_for("text:focus open first second first")
            .unwrap_or_else(|e| panic!("{os:?}: {e}"));
        // Escape closes it, and the focus is the button's again.
        app.press_key("escape").unwrap();
        app.wait_for_gone("first", std::time::Duration::from_secs(2))
            .unwrap();
        app.wait_for("text:focus open first second first open")
            .unwrap_or_else(|e| panic!("{os:?}: {e}"));
        // Escape asked to close it once.
        app.wait_for("text:closes:1")
            .unwrap_or_else(|e| panic!("{os:?}: {e}"));
    }
}

/// What a platform shows of a sheet with detents, replayed from its
/// native batches: the panel's laid-out height and translation.
#[derive(Default)]
struct Replica {
    graph: nsh_core::animation::Graph,
    /// The panel: the view that drags.
    panel: Option<nsh_core::NodeId>,
    translations: std::collections::HashMap<nsh_core::NodeId, nsh_core::NodeId>,
    heights: std::collections::HashMap<nsh_core::NodeId, f32>,
    /// Each view's laid-out frame, its parent, and the translation of
    /// those with only a vertical one bound (the footer).
    frames: std::collections::HashMap<nsh_core::NodeId, nsh_core::Bounds<Points>>,
    parents: std::collections::HashMap<nsh_core::NodeId, nsh_core::NodeId>,
    lifts: std::collections::HashMap<nsh_core::NodeId, nsh_core::NodeId>,
    clock: f64,
    /// Graph nodes made, and made less those released since.
    made: usize,
    live: isize,
}

impl Replica {
    /// Runs the animations to their end: where the panel stands below its
    /// top at rest, and its height.
    fn rest(&mut self) -> (f32, f32) {
        let mut finished = Vec::new();
        for _ in 0..240 {
            self.clock += 1.0 / 60.0;
            self.graph.tick(self.clock, &mut finished);
        }
        self.now()
    }

    /// Where the panel stands below its top now, and its height.
    fn now(&self) -> (f32, f32) {
        let panel = self.panel.expect("the panel drags");
        let node = self.translations[&panel];
        (self.graph.eval(node).number(), self.heights[&panel])
    }

    /// Moves the animations on by a frame.
    fn frame(&mut self) {
        self.clock += 1.0 / 60.0;
        self.graph.tick(self.clock, &mut Vec::new());
    }

    /// Where the bottom of the footer around `content` is on the screen
    /// now: the panel's place, translation and the footer's own.
    fn footer_bottom(&self, content: nsh_core::NodeId) -> f32 {
        let panel = self.panel.expect("the panel drags");
        let footer = self.parents[&content];
        assert_eq!(self.parents[&footer], panel, "the footer is the panel's");
        let lift = self
            .lifts
            .get(&footer)
            .map_or(0.0, |&n| self.graph.eval(n).number());
        self.frames[&panel].origin.y.0 + self.now().0 + self.frames[&footer].bottom().0 + lift
    }
}

type Replicated = std::sync::Arc<std::sync::Mutex<Replica>>;

/// How many graph nodes `op` adds (1), releases (-1) or neither.
fn live_change(op: &nsh_core::animation::AnimationOp) -> isize {
    use nsh_core::animation::AnimationOp::*;
    match op {
        CreateValue { .. }
        | CreateInterpolate { .. }
        | CreateDiffClamp { .. }
        | CreateMath { .. } => 1,
        Release { .. } => -1,
        _ => 0,
    }
}

fn replicate(app: &mut Headless) -> Replicated {
    use nsh_core::{MountItem, animation::AnimationProp};

    let replica = Replicated::default();
    let seen = replica.clone();
    app.observe(move |_, batch| {
        let mut replica = seen.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Animation(op) => {
                    replica.live += live_change(op);
                    replica.made += usize::from(live_change(op) > 0);
                    replica.graph.apply(op.clone(), &mut Vec::new());
                }
                MountItem::Gestures { id, values } if values.pan_y.is_some() => {
                    replica.panel = Some(*id);
                }
                MountItem::AnimationBindings { id, bindings } => {
                    for (prop, node) in bindings {
                        if *prop == AnimationProp::Transform(1) {
                            replica.translations.insert(*id, *node);
                        }
                    }
                    if let [(AnimationProp::Transform(0), node)] = bindings[..] {
                        replica.lifts.insert(*id, node);
                    }
                }
                MountItem::Frame { id, frame } => {
                    replica.heights.insert(*id, frame.size.height.0);
                    replica.frames.insert(*id, *frame);
                }
                MountItem::Insert { parent, child, .. } => {
                    replica.parents.insert(*child, *parent);
                }
                _ => {}
            }
        }
    });
    replica
}

#[derive(Clone, PartialEq, Props)]
struct DetentProps {
    swipe: bool,
    controlled: bool,
    start: Option<nsh_base::SheetDetent>,
    footer: bool,
}

/// A bottom sheet resting at half the screen or all of it, open, with a
/// grabber, reporting the detents the user picks.
#[component]
fn DetentScreen(props: DetentProps) -> impl IntoElement {
    use nsh_base::{SheetDetent, SheetEvent};

    let open = signal(true);
    let picked = signal(String::from("none"));
    let controlled = props.controlled;
    let footer = props.footer;
    let sheet = sheet();
    let sheet = if footer {
        sheet.footer(view().test_id("footer").h(px(50.0)).child(text("Reply")))
    } else {
        sheet
    };
    view()
        .child(text(move || format!("picked:{}", picked.get())))
        .child(
            sheet
                .open(move || Some(open.get()))
                .on_open_change(move |_: &SheetEvent| open.set(false))
                .close_on_swipe(props.swipe)
                .detents(vec![SheetDetent::Medium, SheetDetent::Large])
                .detent(controlled.then_some(SheetDetent::Medium))
                .default_detent(props.start)
                .on_detent_change(move |detent: &SheetDetent| picked.set(format!("{detent:?}")))
                .grabber(true)
                .grabber_style(|s| s.h(px(20.0)))
                .grabber_accessibility_label("Resize")
                .child(
                    view()
                        .test_id("handle")
                        .h(px(60.0))
                        .child(text("Sheet body")),
                ),
        )
}

/// A 390 × 844 surface (no safe area) showing a [`DetentScreen`].
fn detent_app(props: DetentProps) -> (Headless, Replicated) {
    detent_app_on(props, nsh_engine::Clock::system())
}

/// [`detent_app`] on `clock`.
fn detent_app_on(props: DetentProps, clock: nsh_engine::Clock) -> (Headless, Replicated) {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock,
        ..EngineConfig::new(Root::new::<DetentScreen>(move || props.clone()))
    })
    .unwrap();
    let replica = replicate(&mut app);
    app.first_render().unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    (app, replica)
}

const MEDIUM: DetentProps = DetentProps {
    swipe: false,
    controlled: false,
    start: None,
    footer: false,
};

fn assert_rests(replica: &Replicated, at: f32) {
    let (translation, height) = replica.lock().unwrap().rest();
    assert_eq!(height, 844.0, "as tall as the largest detent");
    assert!(
        (translation - at).abs() < 0.5,
        "rests {at} below its top, not {translation}"
    );
}

#[test]
fn a_sheet_with_detents_rests_at_the_smallest_as_tall_as_the_largest() {
    let (_app, replica) = detent_app(MEDIUM);
    assert_rests(&replica, 422.0);
}

#[test]
fn a_drag_up_moves_the_sheet_to_the_larger_detent() {
    let (mut app, replica) = detent_app(MEDIUM);
    app.drag("id:handle", point(px(0.0), px(-300.0))).unwrap();
    app.wait_for("text:picked:Large").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 0.0);
}

#[test]
fn a_drag_down_moves_the_sheet_to_the_smaller_detent() {
    let (mut app, replica) = detent_app(DetentProps {
        start: Some(nsh_base::SheetDetent::Large),
        ..MEDIUM
    });
    assert_rests(&replica, 0.0);
    app.drag("id:handle", point(px(0.0), px(250.0))).unwrap();
    app.wait_for("text:picked:Medium").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 422.0);
}

#[test]
fn a_drag_below_the_smallest_detent_closes_only_when_allowed() {
    let (mut app, replica) = detent_app(MEDIUM);
    app.drag("id:handle", point(px(0.0), px(300.0))).unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("Sheet body").unwrap();
    app.wait_for("text:picked:none").unwrap();
    assert_rests(&replica, 422.0);

    let (mut app, _) = detent_app(DetentProps {
        swipe: true,
        ..MEDIUM
    });
    app.drag("id:handle", point(px(0.0), px(300.0))).unwrap();
    app.wait_for_gone("Sheet body", std::time::Duration::from_secs(2))
        .unwrap();
    app.wait_for("text:picked:none").unwrap();
}

#[test]
fn a_controlled_detent_the_app_keeps_brings_the_sheet_back() {
    let (mut app, replica) = detent_app(DetentProps {
        controlled: true,
        ..MEDIUM
    });
    app.drag("id:handle", point(px(0.0), px(-300.0))).unwrap();
    app.wait_for("text:picked:Large").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 422.0);
}

#[test]
fn the_grabber_changes_the_detent_for_screen_readers_and_presses() {
    use nsh_core::{EventKind, EventPayload, PayloadValue};

    let (mut app, replica) = detent_app(MEDIUM);
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 1);
    let act = |app: &mut Headless, action: &str| {
        let grabber = app
            .screen()
            .press_target("label:Resize")
            .unwrap()
            .expect("the grabber");
        app.engine().control().dispatch_event(
            grabber,
            EventKind::AccessibilityAction,
            EventPayload::Map(vec![("actionName", PayloadValue::Str(action.into()))]),
        );
    };
    act(&mut app, "increment");
    app.wait_for("text:picked:Large").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 0.0);
    act(&mut app, "decrement");
    app.wait_for("text:picked:Medium").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 422.0);
    // A press goes to the next larger detent, round to the smallest.
    app.press("label:Resize").unwrap();
    app.wait_for("text:picked:Large").unwrap();
    app.press("label:Resize").unwrap();
    app.wait_for("text:picked:Medium").unwrap();
}

#[derive(Clone, PartialEq, Props)]
struct PlainProps {
    open: bool,
    footer: bool,
}

/// A bottom sheet with none of the detents' props, as sheets were before
/// them (with a footer or not).
#[component]
fn PlainScreen(props: PlainProps) -> impl IntoElement {
    let sheet = sheet();
    let sheet = if props.footer {
        sheet.footer(text("Reply"))
    } else {
        sheet
    };
    view().child(
        sheet.default_open(props.open).close_on_swipe(true).child(
            view()
                .test_id("handle")
                .h(px(60.0))
                .child(text("Sheet body")),
        ),
    )
}

/// The graph nodes a sheet without detents makes and the animation
/// operations of its first render, open or closed: no more than before
/// detents existed (19 nodes: the motion's and the sheet's own drag and
/// fade), so the detents' graph costs nothing where it is not used.
#[test]
fn a_sheet_without_detents_makes_no_graph_of_theirs() {
    use nsh_core::MountItem;

    for (open, footer) in [(true, false), (false, false), (true, true), (false, true)] {
        let mut app = Headless::start(EngineConfig {
            viewport: Size::new(px(390.0), px(844.0)),
            ..EngineConfig::new(Root::new::<PlainScreen>(move || PlainProps {
                open,
                footer,
            }))
        })
        .unwrap();
        let ops = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = ops.clone();
        app.observe(move |_, batch| {
            let mut ops = seen.lock().unwrap();
            for item in &batch.items {
                if let MountItem::Animation(op) = item {
                    ops.push(op.clone());
                }
            }
        });
        app.first_render().unwrap();
        let first = ops.lock().unwrap().clone();
        let made = |ops: &[nsh_core::animation::AnimationOp]| {
            ops.iter().filter(|op| live_change(op) > 0).count()
        };
        assert_eq!(made(&first), 19, "open: {open}, {first:#?}");
        if open {
            assert_eq!(first.len(), 27, "{first:#?}");
        }
        // Coming in and resting, it makes no more.
        app.wait(std::time::Duration::from_millis(400)).unwrap();
        let all = ops.lock().unwrap().clone();
        assert_eq!(made(&all), 19, "open: {open}, {all:#?}");
    }
}

/// A sheet open with a button in it that gives it detents (medium and
/// large) or takes them away, closed by a swipe.
#[component]
fn ToggleDetentsScreen() -> impl IntoElement {
    use nsh_base::SheetDetent;

    let with = signal(false);
    view().child(
        sheet()
            .default_open(true)
            // A drag moves it either way: the replica finds the panel by
            // its drag.
            .close_on_swipe(true)
            .detents(move || {
                if with.get() {
                    vec![SheetDetent::Medium, SheetDetent::Large]
                } else {
                    Vec::new()
                }
            })
            .child(
                view()
                    .child(
                        view()
                            .test_id("handle")
                            .h(px(60.0))
                            .child(text("Sheet body")),
                    )
                    .child(
                        view()
                            .test_id("toggle")
                            .h(px(44.0))
                            .on_press(move || with.update(|w| *w = !*w)),
                    ),
            ),
    )
}

/// Detents given to an open sheet take effect (as tall as the largest,
/// resting at the smallest), and taken away bring it back to its
/// content's height at the bottom; the nodes made for them go with them.
#[test]
fn detents_given_and_taken_away_while_open_take_effect() {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<ToggleDetentsScreen>())
    })
    .unwrap();
    let replica = replicate(&mut app);
    app.first_render().unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    let rest = |replica: &Replicated| {
        let mut replica = replica.lock().unwrap();
        let (translation, height) = replica.rest();
        (translation, height, replica.live)
    };
    let (translation, height, plain) = rest(&replica);
    assert!(
        translation.abs() < 0.5,
        "rests at the bottom, not {translation}"
    );
    assert_eq!(height, 104.0, "as tall as its content");
    assert_eq!(replica.lock().unwrap().made, 19);

    app.press("id:toggle").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("Sheet body").unwrap();
    let (translation, height, live) = rest(&replica);
    assert_eq!(height, 844.0, "as tall as the largest detent");
    assert!(
        (translation - 422.0).abs() < 0.5,
        "rests at the smallest detent, not {translation}"
    );
    assert!(
        live > plain,
        "the detents' nodes: {live} live, {plain} without"
    );

    app.press("id:toggle").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    app.wait_for("Sheet body").unwrap();
    let (translation, height, live) = rest(&replica);
    assert_eq!(height, 104.0, "as tall as its content again");
    assert!(
        translation.abs() < 0.5,
        "back at the bottom, not {translation}"
    );
    assert_eq!(live, plain, "the detents' nodes went with them");
}

/// The bottom of the footer of a [`DetentScreen`] on the screen, now.
fn footer_bottom(app: &Headless, replica: &Replicated) -> f32 {
    let content = app.screen().id("id:footer").unwrap();
    replica.lock().unwrap().footer_bottom(content)
}

fn assert_footer_at(app: &Headless, replica: &Replicated, at: f32) {
    let bottom = footer_bottom(app, replica);
    assert!(
        (bottom - at).abs() < 0.5,
        "the footer ends at {at}, not {bottom}"
    );
}

#[test]
fn the_footer_stays_at_the_bottom_of_what_shows() {
    let (mut app, replica) = detent_app(DetentProps {
        footer: true,
        ..MEDIUM
    });
    assert_rests(&replica, 422.0);
    assert_footer_at(&app, &replica, 844.0);
    app.drag("id:handle", point(px(0.0), px(-300.0))).unwrap();
    // On its way to the large detent, frame by frame, the footer stays at
    // the bottom of the screen.
    for _ in 0..30 {
        replica.lock().unwrap().frame();
        assert_footer_at(&app, &replica, 844.0);
    }
    app.wait_for("text:picked:Large").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 0.0);
    assert_footer_at(&app, &replica, 844.0);
    app.drag("id:handle", point(px(0.0), px(250.0))).unwrap();
    app.wait_for("text:picked:Medium").unwrap();
    app.wait(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 422.0);
    assert_footer_at(&app, &replica, 844.0);
}

#[test]
fn the_keyboard_raises_the_sheet_to_its_largest_detent_and_back() {
    // The keyboard's motion runs on a clock the test moves.
    let (mut app, replica) = detent_app_on(
        DetentProps {
            footer: true,
            ..MEDIUM
        },
        nsh_engine::Clock::manual(std::time::SystemTime::now()),
    );
    app.run_for(std::time::Duration::from_millis(400)).unwrap();
    assert_rests(&replica, 422.0);
    // Frame by frame as the sheet rises, once its panel ends at the
    // keyboard, the footer is above the keyboard: it follows the panel all
    // the way while the keyboard is up, not only to the smallest detent's
    // place (which the shorter panel makes 122).
    start_keyboard(&mut app, 300.0);
    let mut seen = 0;
    for _ in 0..40 {
        app.run_for(std::time::Duration::from_millis(16)).unwrap();
        let lifted = {
            let mut replica = replica.lock().unwrap();
            replica.frame();
            replica.now().1 == 544.0
        };
        if lifted {
            seen += 1;
            let bottom = footer_bottom(&app, &replica);
            assert!(
                bottom <= 544.5,
                "the footer ends at {bottom}, below the keyboard at 544"
            );
        }
    }
    assert!(seen > 0, "the panel ends at the keyboard");
    let (translation, height) = replica.lock().unwrap().rest();
    assert_eq!(height, 544.0, "as tall as the room above the keyboard");
    assert!(translation.abs() < 0.5, "at the largest, not {translation}");
    assert_footer_at(&app, &replica, 544.0);
    // Standing at the largest is no detent the user picked.
    app.wait_for("text:picked:none").unwrap();
    keyboard(&mut app, 0.0);
    assert_rests(&replica, 422.0);
    assert_footer_at(&app, &replica, 844.0);
}
