//! `nsh/base`'s popups used from Rust: a `Popover` filled with a trigger
//! and content shows its content in an overlay of the surface's root view,
//! placed against the trigger, outside the box that clips it; a
//! `ToastStack` of `Toast`s lays them out as layers.

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use nsh_base::{Anchor, ToastStackState, ToastTransitionStatus, popover, toast, toast_stack};
use nsh_core::{
    ApproxTextEngine, Bounds, MountBatch, MountItem, NodeId, Points, ROOT_ID, Size, element::Root,
    prelude::*,
};
use nsh_engine::{App, Engine, EngineConfig, Environment};

use crate::ChannelSink;

#[derive(Clone, PartialEq, Props)]
struct ScreenProps {}

#[component]
fn Screen(_props: ScreenProps) -> impl IntoElement {
    view().pt(px(100.0)).pl(px(40.0)).child(
        view().w(px(200.0)).h(px(30.0)).overflow_hidden().child(
            popover()
                .default_open(true)
                .placement(Placement::Bottom)
                .align(Align::Start)
                .offset(px(4.0))
                .trigger(view().h(px(30.0)).child(text("Trigger")))
                .child(view().w(px(120.0)).h(px(50.0)).child(text("Body"))),
        ),
    )
}

fn config(app: App) -> EngineConfig {
    EngineConfig {
        app,
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment::default(),
        header_heights: (Points(44.0), Points(96.0)),
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
    }
}

fn start() -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = config(App::Rust(Root::new::<Screen>(|| ScreenProps {})));
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

#[test]
fn a_popover_shows_its_content_over_the_box_that_clips_its_trigger() {
    let (_engine, rx) = start();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut parents: Vec<(NodeId, NodeId)> = Vec::new();
    let mut frames: Vec<(NodeId, Bounds<Points>)> = Vec::new();
    let mut focus_parents = Vec::new();
    let mut body = None;
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in &batch.items {
            match item {
                MountItem::Insert { parent, child, .. }
                | MountItem::ProjectRoot {
                    parent, id: child, ..
                } => parents.push((*parent, *child)),
                MountItem::Frame { id, frame } => frames.push((*id, *frame)),
                MountItem::ViewProps { id, props } if props.focus_return_parent.is_some() => {
                    focus_parents.push((*id, props.focus_return_parent));
                }
                MountItem::Text { id, text, .. } if &*text.text == "Body" => body = Some(*id),
                _ => {}
            }
        }
        if body.is_some() {
            break;
        }
    }
    let body = body.expect("the content is shown");
    let parent = |id: NodeId| {
        parents
            .iter()
            .rev()
            .find(|(_, c)| *c == id)
            .map(|(p, _)| *p)
    };
    // The text, in its 120 × 50 box, in the overlay, in the root view.
    let content = parent(body).unwrap();
    let overlay = parent(content).unwrap();
    assert_eq!(parent(overlay), Some(ROOT_ID));
    assert!(focus_parents.contains(&(overlay, Some(ROOT_ID))));
    let frame = frames
        .iter()
        .rev()
        .find(|(id, _)| *id == overlay)
        .unwrap()
        .1;
    // Below the trigger (40, 100, 200 × 30), 4 points away, from its start.
    assert_eq!(frame.origin, point(px(40.0), px(134.0)));
    assert_eq!(frame.size, Size::new(px(120.0), px(50.0)));
}

#[derive(Clone, PartialEq, Props)]
struct ToastScreenProps {}

/// Two toasts in a stack anchored to the bottom, from Rust: each a `Toast`
/// read by the screen reader, the newest at the bottom and the older one a
/// collapsed layer above it.
#[component]
fn ToastScreen(_props: ToastScreenProps) -> impl IntoElement {
    let state = ToastStackState::new();
    let toasts = signal(vec![("Older", 40.0), ("Saved", 60.0)]);
    view().pt(px(400.0)).child(
        toast_stack()
            .placement(Anchor::BottomCenter)
            .state(state)
            .w(px(300.0))
            // A region of toasts, keyed: each is an item of the stack.
            .child(each(
                toasts,
                |(label, _)| *label,
                |item, _| {
                    let (label, height) = item.get_untracked();
                    toast()
                        .transition_status(ToastTransitionStatus::Present)
                        .accessibility_label(label)
                        .h(px(height))
                        .child(text(label))
                },
            )),
    )
}

#[test]
fn a_toast_stack_from_rust_lays_its_toasts_out_as_layers() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = config(App::Rust(Root::new::<ToastScreen>(|| ToastScreenProps {})));
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut announced = Vec::new();
    let mut parents: Vec<(NodeId, NodeId)> = Vec::new();
    let mut frames: Vec<(NodeId, Bounds<Points>)> = Vec::new();
    let mut texts: Vec<(NodeId, String)> = Vec::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in &batch.items {
            match item {
                MountItem::Command {
                    command: nsh_core::Command::Announce(m),
                    ..
                } => announced.push(m.clone()),
                MountItem::Insert { parent, child, .. }
                | MountItem::ProjectRoot {
                    parent, id: child, ..
                } => parents.push((*parent, *child)),
                MountItem::Frame { id, frame } => frames.push((*id, *frame)),
                MountItem::Text { id, text, .. } => texts.push((*id, text.text.to_string())),
                _ => {}
            }
        }
        if announced.len() == 2 && texts.len() >= 2 {
            break;
        }
    }
    announced.sort();
    assert_eq!(
        announced,
        ["Older", "Saved"],
        "each toast is read as it shows"
    );
    let parent = |id: NodeId| {
        parents
            .iter()
            .rev()
            .find(|(_, c)| *c == id)
            .map(|(p, _)| *p)
    };
    let frame = |id: NodeId| frames.iter().rev().find(|(i, _)| *i == id).map(|(_, f)| *f);
    let text = |t: &str| {
        texts
            .iter()
            .find(|(_, s)| s == t)
            .map(|(id, _)| *id)
            .unwrap()
    };
    // Text → toast → the stack's wrapper → the stack.
    let wrapper = |t: &str| parent(parent(text(t)).unwrap()).unwrap();
    let (older, saved) = (wrapper("Older"), wrapper("Saved"));
    let stack = parent(saved).unwrap();
    assert_eq!(
        parent(older),
        Some(stack),
        "the toasts are items of one stack"
    );
    // Anchored to the bottom: both wrappers end at the stack's bottom (their
    // layers are translations), and collapsed it is as tall as the front
    // toast plus a peek.
    let (o, s) = (frame(older).unwrap(), frame(saved).unwrap());
    assert_eq!(o.size.height, px(40.0));
    assert_eq!(s.size.height, px(60.0));
    assert_eq!(s.origin.y + s.size.height, o.origin.y + o.size.height);
    assert_eq!(frame(stack).unwrap().size.height, px(74.0));
}
