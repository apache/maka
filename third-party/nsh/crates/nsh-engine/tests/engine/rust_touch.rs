//! Touches in a Rust app: an element inside a scroll view claims a
//! gesture's touches (native scrolling stops around it), follows it with
//! the responder's events and lets go.

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, MountBatch, MountItem, ROOT_ID, Size,
    TouchEvent, TouchPhase, TouchPoint,
    canvas::{CanvasOp, Num, PathOp},
    element::Root,
    geometry::px,
    prelude::*,
};
use nsh_engine::{App, Engine, EngineConfig, Environment};

use crate::ChannelSink;

/// A sketch pad in a scroll view: each stroke drawn from the responder's
/// events.
#[component]
fn Sketch() -> impl IntoElement {
    let strokes = signal(Vec::<Vec<(f32, f32)>>::new());
    let released = signal(false);
    view().flex_1().child(
        scroll().flex_1().child(
            canvas(move || {
                strokes.with(|strokes| {
                    let mut p = Painter::new();
                    for stroke in strokes {
                        p = p.begin_path();
                        for (i, &(x, y)) in stroke.iter().enumerate() {
                            p = if i == 0 {
                                p.move_to(x, y)
                            } else {
                                p.line_to(x, y)
                            };
                        }
                        p = p.stroke();
                    }
                    p
                })
            })
            .h(px(300.0))
            .claim_touches(TouchClaim::on_start())
            .keep_touches(true)
            .on_responder_grant(move |e: &ResponderEvent| {
                strokes.update(|s| s.push(vec![(e.location.x.0, e.location.y.0)]));
            })
            .on_responder_move(move |e: &ResponderEvent| {
                strokes.update(|s| {
                    if let Some(stroke) = s.last_mut() {
                        stroke.push((e.location.x.0, e.location.y.0));
                    }
                });
            })
            .on_responder_release(move |_: &ResponderEvent| released.set(true)),
        ),
    )
}

fn touch(phase: TouchPhase, path: &[u32], x: f32, y: f32, t: f64) -> EventPayload {
    EventPayload::Touch(Box::new(TouchEvent {
        phase,
        timestamp: t,
        activated: None,
        points: vec![TouchPoint {
            id: 1,
            target: path[0],
            path: if phase == TouchPhase::Start {
                path.to_vec()
            } else {
                Vec::new()
            },
            page: nsh_core::geometry::point(px(x), px(y + 100.0)),
            location: nsh_core::geometry::point(px(x), px(y)),
            changed: true,
        }],
    }))
}

/// The batches until one has a command, within a few seconds.
fn until_command(rx: &Receiver<MountBatch>) -> Vec<MountBatch> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut batches = Vec::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        let done = batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Command { .. }));
        batches.push(batch);
        if done {
            break;
        }
    }
    batches
}

fn drawing(batches: &[MountBatch]) -> Option<Vec<CanvasOp>> {
    batches.iter().rev().find_map(|b| {
        b.items.iter().find_map(|i| match i {
            MountItem::Canvas { drawing, .. } => Some(drawing.ops.clone()),
            _ => None,
        })
    })
}

fn command(batches: &[MountBatch]) -> Option<(u32, Command)> {
    batches.iter().find_map(|b| {
        b.items.iter().find_map(|i| match i {
            MountItem::Command { id, command } => Some((*id, command.clone())),
            _ => None,
        })
    })
}

#[test]
fn a_rust_element_claims_touches_in_a_scroll_view() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::of::<Sketch>()),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
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
    let pad = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Touch) => Some(*id),
            _ => None,
        })
        .expect("the canvas listens to touches");
    // The platform reports touches on the root, with the listening views.
    let send = |phase, x, y, t| {
        engine
            .control()
            .dispatch_event(ROOT_ID, EventKind::Touch, touch(phase, &[pad], x, y, t));
    };
    send(TouchPhase::Start, 10.0, 20.0, 0.0);
    let batches = until_command(&rx);
    assert_eq!(
        command(&batches),
        Some((pad, Command::SetJsResponder { block: true })),
        "scroll views around stop taking the touches"
    );
    send(TouchPhase::Move, 30.0, 25.0, 16.0);
    send(TouchPhase::End, 30.0, 25.0, 32.0);
    let batches = until_command(&rx);
    assert_eq!(
        command(&batches),
        Some((ROOT_ID, Command::ClearJsResponder))
    );
    let ops = drawing(&batches).expect("drawn again");
    let path: Vec<_> = ops
        .iter()
        .filter_map(|op| match op {
            CanvasOp::Path(PathOp::MoveTo(Num::Const(x), Num::Const(y)))
            | CanvasOp::Path(PathOp::LineTo(Num::Const(x), Num::Const(y))) => Some((*x, *y)),
            _ => None,
        })
        .collect();
    assert_eq!(path, [(10.0, 20.0), (30.0, 25.0)]);
}
