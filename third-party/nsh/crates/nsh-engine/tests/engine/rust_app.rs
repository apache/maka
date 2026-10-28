//! A Rust app: the engine mounts its root component with no bundle and no
//! VM; it renders, handles presses and runs its tasks.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_base::{nav_page, nav_stack};
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountBatch, MountItem, Size, element::Root,
    prelude::*,
};
use nsh_engine::{App, Engine, EngineConfig, Environment};

use crate::ChannelSink;

#[derive(Clone, PartialEq, Props)]
struct CounterProps {
    #[prop(default = "Count".into())]
    label: Prop<SharedString>,
}

#[component]
fn Counter(props: CounterProps) -> impl IntoElement {
    let count = signal(0);
    let ticks = signal(0);
    set_timeout(Duration::from_millis(10), move || ticks.update(|t| *t += 1));
    view()
        .flex_1()
        .on_press(move |_: &()| count.update(|c| *c += 1))
        .child(text(move || {
            format!(
                "{} {} ({} ticks)",
                props.label.get(),
                count.get(),
                ticks.get()
            )
        }))
}

fn start() -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::new::<Counter>(|| CounterProps {
            label: "Taps".into(),
        })),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        // Nothing registered: Rust renders its components by type.
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// The text shown after the batches received within `wait`, and the view
/// it is in.
fn shown(rx: &Receiver<MountBatch>, wait: Duration, until: &str) -> Option<(String, u32)> {
    let deadline = std::time::Instant::now() + wait;
    let mut last = None;
    let mut host = None;
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in &batch.items {
            match item {
                MountItem::Text { text, .. } => last = Some(text.text.clone()),
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child,
                    ..
                }
                | MountItem::ProjectRoot {
                    parent: nsh_core::ROOT_ID,
                    id: child,
                    ..
                } => host = Some(*child),
                _ => {}
            }
        }
        if last.as_deref() == Some(until) {
            break;
        }
    }
    Some((last?, host.unwrap_or(0)))
}

#[test]
fn a_rust_app_renders_handles_presses_and_runs_tasks() {
    let (engine, rx) = start();
    let (text, host) = shown(&rx, Duration::from_secs(5), "Taps 0 (0 ticks)").unwrap();
    assert_eq!(text, "Taps 0 (0 ticks)");
    assert_ne!(host, 0, "the root component is in the root view");
    // The timer task wakes the engine and renders again.
    let (text, _) = shown(&rx, Duration::from_secs(5), "Taps 0 (1 ticks)").unwrap();
    assert_eq!(text, "Taps 0 (1 ticks)");
    engine
        .control()
        .dispatch_event(host, EventKind::Press, EventPayload::None);
    let (text, _) = shown(&rx, Duration::from_secs(5), "Taps 1 (1 ticks)").unwrap();
    assert_eq!(text, "Taps 1 (1 ticks)");
}

#[test]
fn a_rust_app_starts_in_its_appearance() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // `nsh.json` `"appearance": "dark"` of a Rust app (`nsh.json` "root").
        app: App::Rust(Root::of::<WithCard>().appearance(nsh_core::platform::Appearance::Dark)),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        first.items.iter().any(|item| matches!(
            item,
            MountItem::Appearance {
                appearance: nsh_core::platform::Appearance::Dark
            }
        )),
        "the first frame sets the appearance"
    );
}

/// A Rust navigation stack: a screen per route, keyed by it.
#[component]
fn Navigation() -> impl IntoElement {
    let routes = signal(vec![0_u32, 1]);
    nav_stack().flex_1().child(each(
        move || routes.get(),
        |&route: &u32| route,
        move |route, _| {
            let route = route.get_untracked();
            nav_page()
                .title(format!("page {route}"))
                .header_right(text("more"))
                .on_dismiss(move |_: &()| routes.update(|r| r.retain(|r| *r < route)))
                .child(text(format!("content {route}")))
        },
    ))
}

#[test]
fn rust_components_navigate_with_native_stacks() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::of::<Navigation>()),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let screens: Vec<(u32, String, Option<u32>)> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ScreenConfig { id, config } => Some((
                *id,
                config.title.as_deref().unwrap_or_default().to_owned(),
                config.right,
            )),
            _ => None,
        })
        .collect();
    let titles: Vec<&str> = screens.iter().map(|s| s.1.as_str()).collect();
    assert!(
        titles.contains(&"page 0") && titles.contains(&"page 1"),
        "{titles:?}"
    );
    assert!(
        screens.iter().all(|s| s.2.is_some()),
        "a header item each: {screens:?}"
    );
    let kinds: Vec<_> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Create { kind, .. } => Some(format!("{kind:?}")),
            _ => None,
        })
        .collect();
    assert!(kinds.iter().any(|k| k == "Stack"), "{kinds:?}");
    // The user pops the top screen natively: its route goes.
    let top = screens.iter().find(|s| s.1 == "page 1").unwrap().0;
    engine
        .control()
        .dispatch_event(top, EventKind::Dismiss, EventPayload::None);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut deleted = false;
    while let Ok(batch) = rx.recv_deadline(deadline) {
        if batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Delete { id } if *id == top))
        {
            deleted = true;
            break;
        }
    }
    assert!(deleted, "the popped screen goes");
}

/// Rust content in a Rust component of a UI set: a card's header and
/// body.
#[component]
fn WithCard() -> impl IntoElement {
    let taps = signal(0);
    view().flex_1().child(
        crate::test_ui::card().header(text("card header")).child(
            text(move || format!("card body {}", taps.get()))
                .on_press(move |_: &()| taps.update(|t| *t += 1)),
        ),
    )
}

#[test]
fn rust_components_pass_content_to_rust_components() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::of::<WithCard>()),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let texts: Vec<(u32, String)> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { id, text, .. } => Some((*id, text.text.clone())),
            _ => None,
        })
        .collect();
    let names: Vec<&str> = texts.iter().map(|t| t.1.as_str()).collect();
    assert!(
        names.contains(&"card header") && names.contains(&"card body 0"),
        "{names:?}"
    );
    // Both are in the tree (placed by the card), not left aside.
    let parents: std::collections::HashMap<u32, u32> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Insert { parent, child, .. }
            | MountItem::ProjectRoot {
                parent, id: child, ..
            } => Some((*child, *parent)),
            _ => None,
        })
        .collect();
    let attached = |mut id: u32| loop {
        if id == nsh_core::ROOT_ID {
            return true;
        }
        match parents.get(&id) {
            Some(&p) => id = p,
            None => return false,
        }
    };
    for (id, name) in &texts {
        assert!(attached(*id), "{name} is in the tree");
    }
    // Where the card's render places them: the header in its slot's
    // holder, the body in the card's padded box (not in the host).
    let id_of = |name: &str| texts.iter().find(|t| t.1 == name).unwrap().0;
    let card = parents[&parents[&id_of("card header")]];
    let body_box = parents[&id_of("card body 0")];
    assert_ne!(body_box, card, "the body is in the card's box");
    assert_eq!(parents[&body_box], card);
    // The body follows the parent's state.
    let body = texts.iter().find(|t| t.1 == "card body 0").unwrap().0;
    engine
        .control()
        .dispatch_event(body, EventKind::Press, EventPayload::None);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut updated = false;
    while let Ok(batch) = rx.recv_deadline(deadline) {
        if batch.items.iter().any(|i| {
            matches!(i, MountItem::Text { id, text, .. } if *id == body && text.text == "card body 1")
        }) {
            updated = true;
            break;
        }
    }
    assert!(updated, "the same text node shows the new count");
}

/// A Rust component takes the Android back button while it listens; when
/// it no longer handles it, the platform goes back.
#[component]
fn BackCounter() -> impl IntoElement {
    let presses = signal(0);
    on_back_press(move || {
        presses.update(|p| *p += 1);
        presses.get_untracked() < 2
    });
    view()
        .flex_1()
        .child(text(move || format!("presses {}", presses.get())))
}

#[test]
fn rust_components_take_the_back_button() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::of::<BackCounter>()),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        first.items.iter().any(|i| matches!(
            i,
            MountItem::Events { id: nsh_core::ROOT_ID, events } if events.contains(EventKind::BackPress)
        )),
        "the root wants the back button"
    );
    let press = |until: &dyn Fn(&MountItem) -> bool| {
        engine.control().dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::BackPress,
            EventPayload::None,
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Ok(batch) = rx.recv_deadline(deadline) {
            if batch.items.iter().any(until) {
                return true;
            }
        }
        false
    };
    // Handled: it does not go back.
    assert!(press(
        &|i| matches!(i, MountItem::Text { text, .. } if text.text == "presses 1")
    ));
    // Not handled, and JS does not listen: the platform goes back.
    assert!(press(&|i| matches!(
        i,
        MountItem::Command {
            command: nsh_core::Command::Back,
            ..
        }
    )));
}

/// Takes the back button while a switch is on: the listener is made in an
/// effect, and goes with it when the switch turns off.
#[component]
fn BackSwitch() -> impl IntoElement {
    let on = signal(false);
    let caught = signal(0);
    effect(move || {
        if on.get() {
            on_back_press(move || {
                caught.update(|c| *c += 1);
                true
            });
        }
    });
    view()
        .flex_1()
        .child(text("Switch").on_press(move |_: &()| on.update(|on| *on = !*on)))
        .child(text(move || format!("caught {}", caught.get())))
}

#[test]
fn a_rust_back_listener_goes_with_its_owner() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(
        EngineConfig::new(Root::of::<BackSwitch>()),
        || ApproxTextEngine,
        ChannelSink(tx),
    )
    .unwrap();
    let mut switch = None;
    // Whether the root listens to the back button after what came.
    let listens = |rx: &Receiver<MountBatch>, switch: &mut Option<u32>| {
        let mut listens = None;
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            for item in &batch.items {
                match item {
                    MountItem::Events {
                        id: nsh_core::ROOT_ID,
                        events,
                    } => listens = Some(events.contains(EventKind::BackPress)),
                    MountItem::Text { id, text, .. } if text.text == "Switch" => {
                        *switch = Some(*id)
                    }
                    _ => {}
                }
            }
        }
        listens
    };
    assert_eq!(listens(&rx, &mut switch), None, "no listener while off");
    let switch = switch.expect("the switch");
    let press = |id| {
        engine
            .control()
            .dispatch_event(id, EventKind::Press, EventPayload::None)
    };
    press(switch);
    assert_eq!(listens(&rx, &mut None), Some(true), "it listens while on");
    engine
        .control()
        .dispatch_event(nsh_core::ROOT_ID, EventKind::BackPress, EventPayload::None);
    let caught = shown(&rx, Duration::from_secs(5), "caught 1").map(|s| s.0);
    assert_eq!(caught.as_deref(), Some("caught 1"), "the listener took it");
    press(switch);
    assert_eq!(
        listens(&rx, &mut None),
        Some(false),
        "the listener goes when switched off"
    );
}

/// The core's events (a layout) and throttled scroll events reach a Rust
/// component with no JS.
#[component]
fn Measured() -> impl IntoElement {
    let width = signal(0.0_f32);
    let scrolled = signal(0.0_f32);
    view()
        .flex_1()
        .on_layout(move |frame: &nsh_core::Bounds<nsh_core::Points>| width.set(frame.size.width.0))
        .child(text(move || {
            format!("width {} scrolled {}", width.get(), scrolled.get())
        }))
        .child(
            scroll()
                .flex_1()
                .on_scroll(move |e: &ScrollEvent| scrolled.set(e.offset.y.0))
                .child(view().h(px(2000.0))),
        )
}

#[test]
fn rust_components_hear_layouts_and_scrolls() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::of::<Measured>()),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    // Until `until` shows; the scroll view's id on the way.
    let wait = |until: &str, scroll: &mut Option<u32>| {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Ok(batch) = rx.recv_deadline(deadline) {
            let mut done = false;
            for item in &batch.items {
                match item {
                    MountItem::Create {
                        id,
                        kind: nsh_core::ViewKind::Scroll,
                    } => *scroll = Some(*id),
                    MountItem::Text { text, .. } if text.text == until => done = true,
                    _ => {}
                }
            }
            if done {
                return true;
            }
        }
        false
    };
    let mut scroll = None;
    assert!(wait("width 390 scrolled 0", &mut scroll), "the layout came");
    let scroll = scroll.expect("a scroll view");
    engine.control().scroll(
        scroll,
        nsh_core::geometry::point(nsh_core::geometry::px(0.0), nsh_core::geometry::px(120.0)),
        0,
    );
    assert!(wait("width 390 scrolled 120", &mut None), "the scroll came");
}

/// A nested component's events in a row of a component's own list reach
/// the component whose list it is.
#[component]
fn ButtonRows() -> impl IntoElement {
    let pressed = signal(None::<usize>);
    view()
        .flex_1()
        .child(text(move || format!("pressed {:?}", pressed.get())))
        .child(
            virtual_list(20, move |at| {
                crate::test_ui::button()
                    .title(move || format!("row {}", at.index()))
                    .on_press(move || pressed.set(Some(at.index())))
            })
            .flex_1(),
        )
}

#[test]
fn nested_components_in_list_rows_reach_the_list_owner() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::of::<ButtonRows>()),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let mut parents = std::collections::HashMap::new();
    let mut texts = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in &batch.items {
            match item {
                MountItem::Insert { parent, child, .. }
                | MountItem::ProjectRoot {
                    parent, id: child, ..
                } => {
                    parents.insert(*child, *parent);
                }
                MountItem::Text { id, text, .. } => texts.push((*id, text.text.clone())),
                _ => {}
            }
        }
        if texts.iter().any(|t| t.1 == "row 3") {
            break;
        }
    }
    let label = texts.iter().find(|t| t.1 == "row 3").expect("row 3").0;
    // The button's root (its pressable) holds the label.
    engine
        .control()
        .dispatch_event(parents[&label], EventKind::Press, EventPayload::None);
    let (text, _) = shown(&rx, Duration::from_secs(5), "pressed Some(3)").unwrap();
    assert_eq!(text, "pressed Some(3)");
}

/// Content a nested component does not place (a closed sheet's) is not on
/// screen; it is once the component places it.
#[component]
fn WithSheet() -> impl IntoElement {
    let open = signal(false);
    view()
        .flex_1()
        .child(text("open").on_press(move |_: &()| open.set(true)))
        .child(crate::test_ui::sheet().open(open).child(text("sheet body")))
}

#[test]
fn content_a_component_does_not_place_is_not_shown() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::of::<WithSheet>()),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let mut parents: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut texts = Vec::new();
    let mut collect = |wait: Duration| {
        let deadline = std::time::Instant::now() + wait;
        while let Ok(batch) = rx.recv_deadline(deadline) {
            for item in &batch.items {
                match item {
                    MountItem::Insert { parent, child, .. }
                    | MountItem::ProjectRoot {
                        parent, id: child, ..
                    } => {
                        parents.insert(*child, *parent);
                    }
                    MountItem::Remove { id } | MountItem::Delete { id } => {
                        parents.remove(id);
                    }
                    MountItem::Text { id, text, .. } => texts.push((*id, text.text.clone())),
                    _ => {}
                }
            }
        }
        (parents.clone(), texts.clone())
    };
    let attached = |parents: &std::collections::HashMap<u32, u32>, mut id: u32| loop {
        if id == nsh_core::ROOT_ID {
            return true;
        }
        match parents.get(&id) {
            Some(&p) => id = p,
            None => return false,
        }
    };
    let (p, t) = collect(Duration::from_millis(300));
    let body = t.iter().find(|t| t.1 == "sheet body").map(|t| t.0);
    assert!(
        body.is_none_or(|b| !attached(&p, b)),
        "a closed sheet shows nothing"
    );
    let open = t.iter().find(|t| t.1 == "open").unwrap().0;
    engine
        .control()
        .dispatch_event(open, EventKind::Press, EventPayload::None);
    let (p, t) = collect(Duration::from_millis(300));
    let body = t.iter().find(|t| t.1 == "sheet body").unwrap().0;
    assert!(attached(&p, body), "the open sheet shows its content");
}
