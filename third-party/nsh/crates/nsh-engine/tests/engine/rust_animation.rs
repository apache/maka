//! A Rust component's composed animations on a headless engine, with the
//! platform's part played by an animation graph here: a composite goes out
//! as one operation and runs step after step in the graph (no engine round
//! trips between steps); its end, its stop and its reset come back to the
//! component's task, and so does a value read where it moves. A drag let go
//! moves on natively with its velocity.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountBatch, MountItem, NodeId, Size,
    animation::{AnimationOp, AnimationProp, Driver, Finished, Graph},
    ui::{Root, prelude::*},
};
use nsh_engine::{App, Engine, EngineConfig, Environment};

use crate::ChannelSink;

/// A value, a jump (a delayed timing, a wait, a timing back) and a pulse
/// looping until stopped.
#[component]
fn Jumper() -> impl IntoElement {
    let x = animated_value(0.0);
    let linear = |ms| Timing::new(ms, Easing::Linear);
    let jump = Animation::sequence([
        Animation::timing(
            &x,
            100.0,
            Timing {
                delay_ms: 50.0,
                ..linear(200.0)
            },
        ),
        Animation::delay(100.0),
        Animation::timing(&x, 0.0, linear(200.0)),
    ]);
    let pulse = Animation::sequence([
        Animation::timing(&x, 50.0, linear(100.0)),
        Animation::timing(&x, 0.0, linear(100.0)),
    ])
    .looped(None);
    let state = signal(SharedString::from("idle"));
    // Runs `animation` (`jump` or `pulse`), reporting how it ended.
    let run = move |name: &'static str, animation: &Animation| {
        let end = animation.start();
        spawn(async move {
            let how = if end.await { "finished" } else { "stopped" };
            state.set(format!("{name}: {how}").into());
        });
        state.set(format!("{name}…").into());
    };
    let both = [jump.clone(), pulse.clone()];
    let (stop, reset) = (both.clone(), both);
    view()
        .flex_1()
        .bind_translate_x(&x)
        .bind_shadow_radius(&x)
        .child(text(state))
        .child(text("Jump").on_press(move |_: &()| run("jump", &jump)))
        .child(text("Pulse").on_press(move |_: &()| run("pulse", &pulse)))
        .child(text("Stop").on_press(move |_: &()| stop.iter().for_each(Animation::stop)))
        .child(text("Reset").on_press(move |_: &()| reset.iter().for_each(Animation::reset)))
        .child(text("Where").on_press(move |_: &()| {
            // Stopped, then read: where it stopped (TS: `stop()`'s promise).
            x.stop();
            let value = x.value();
            spawn(async move {
                let value = value.await;
                state.set(format!("at {value:.2}").into());
            });
        }))
}

/// The engine, and the platform's part: what it shows and its graph.
struct Platform {
    engine: Engine,
    rx: Receiver<MountBatch>,
    texts: Vec<(NodeId, String)>,
    graph: Graph,
    finished: Vec<Finished>,
    /// The graph's clock, in seconds.
    now: f64,
    /// The graph operations received.
    ops: Vec<AnimationOp>,
    /// The value moved (bound to the root view's translation).
    x: Option<u32>,
    /// The properties bound on the root view.
    bound: Vec<AnimationProp>,
}

impl Platform {
    fn start() -> Self {
        let (tx, rx) = crossbeam_channel::unbounded();
        let config = EngineConfig {
            app: App::Rust(Root::of::<Jumper>()),
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
        let mut platform = Self {
            engine,
            rx,
            texts: Vec::new(),
            graph: Graph::default(),
            finished: Vec::new(),
            now: 0.0,
            ops: Vec::new(),
            x: None,
            bound: Vec::new(),
        };
        platform.pump();
        platform
    }

    /// Applies the batches until the engine is quiet, reporting the ends of
    /// animations.
    fn pump(&mut self) {
        loop {
            self.report();
            let Ok(batch) = self.rx.recv_timeout(Duration::from_millis(200)) else {
                break;
            };
            for item in batch.items {
                match item {
                    MountItem::Text { id, text, .. } => {
                        self.texts.retain(|t| t.0 != id);
                        self.texts.push((id, text.text.clone()));
                    }
                    MountItem::AnimationBindings { bindings, .. } => {
                        self.x = bindings.first().map(|b| b.1);
                        self.bound = bindings.iter().map(|b| b.0).collect();
                    }
                    MountItem::Animation(op) => {
                        self.ops.push(op.clone());
                        self.graph.apply(op, &mut self.finished);
                    }
                    _ => {}
                }
            }
        }
    }

    fn report(&mut self) {
        if !self.finished.is_empty() {
            let finished = std::mem::take(&mut self.finished);
            self.engine.control().animations_finished(finished);
        }
    }

    /// Runs the graph's frames (60 Hz) for `secs`, then hands the engine
    /// what ended.
    fn advance(&mut self, secs: f64) {
        let end = self.now + secs;
        while self.now < end - 1e-9 {
            self.graph.tick(self.now, &mut self.finished);
            self.now += 1.0 / 60.0;
        }
        self.graph.tick(end, &mut self.finished);
        self.now = end;
        self.pump();
    }

    fn press(&mut self, label: &str) {
        let id = self
            .texts
            .iter()
            .find(|t| t.1 == label)
            .unwrap_or_else(|| panic!("no {label}: {:?}", self.texts))
            .0;
        self.engine
            .control()
            .dispatch_event(id, EventKind::Press, EventPayload::None);
        self.pump();
        // The graph starts what came in at its next frame.
        self.graph.tick(self.now, &mut self.finished);
    }

    fn shows(&self, text: &str) -> bool {
        self.texts.iter().any(|t| t.1 == text)
    }

    fn x(&self) -> f32 {
        self.graph.value(self.x.expect("bound")).unwrap()
    }
}

#[test]
fn rust_composites_run_natively_and_report_their_ends() {
    let mut p = Platform::start();
    assert!(p.shows("idle"), "{:?}", p.texts);
    assert!(p.x.is_some(), "the value is bound");
    assert_eq!(
        p.bound,
        [AnimationProp::Transform(0), AnimationProp::ShadowRadius]
    );

    p.ops.clear();
    p.press("Jump");
    assert!(p.shows("jump…"), "{:?}", p.texts);
    // Its first step waits for its delay.
    p.advance(0.04);
    assert_eq!(p.x(), 0.0);
    p.advance(0.11);
    assert!((p.x() - 50.0).abs() < 1.0, "halfway: {}", p.x());
    p.advance(0.45);
    assert_eq!(p.x(), 0.0, "back");
    assert!(p.shows("jump: finished"), "{:?}", p.texts);
    // One operation started it; its steps ran in the graph.
    let starts = p
        .ops
        .iter()
        .filter(|op| {
            matches!(
                op,
                AnimationOp::StartComposite { .. } | AnimationOp::Start { .. }
            )
        })
        .count();
    assert_eq!(starts, 1, "{:?}", p.ops);

    // Reset: stopped, and back where the run started.
    p.press("Jump");
    p.advance(0.15);
    assert!(p.x() > 10.0, "{}", p.x());
    p.press("Reset");
    assert!(p.shows("jump: stopped"), "{:?}", p.texts);
    assert_eq!(p.x(), 0.0);

    // Stop: stopped where it is.
    p.press("Pulse");
    assert!(p.shows("pulse…"), "{:?}", p.texts);
    p.advance(0.5);
    assert!(p.shows("pulse…"), "it loops: {:?}", p.texts);
    let at = p.x();
    assert!(at > 0.0, "{at}");
    p.press("Stop");
    assert!(p.shows("pulse: stopped"), "{:?}", p.texts);
    p.advance(0.2);
    assert_eq!(p.x(), at, "it stays");

    // A read: the graph answers with the value where it is.
    p.press("Pulse");
    p.advance(0.13);
    p.press("Where");
    let at = p.x();
    assert!(at > 0.0, "{at}");
    assert!(p.shows(&format!("at {at:.2}")), "{:?}", p.texts);
}

/// A card dragged natively: let go, it springs home with the drag's
/// velocity the first time and glides with it after.
#[component]
fn Thrown() -> impl IntoElement {
    let (x, y) = (animated_value(0.0), animated_value(0.0));
    let releases = stored(0_u32);
    view()
        .flex_1()
        .bind_translate_x(&x)
        .bind_translate_y(&y)
        .pan_values(Some(&x), Some(&y))
        .on_pan_end(move |e: &PanEvent| {
            let first = releases.with(|r| {
                *r += 1;
                *r == 1
            });
            let spring = |velocity| Spring {
                velocity: Some(velocity),
                ..Spring::default()
            };
            if first {
                let _ = x.spring(0.0, spring(e.velocity_x));
                let _ = y.spring(0.0, spring(e.velocity_y));
            } else {
                let _ = x.decay(Some(e.velocity_x), 0.998);
                let _ = y.decay(Some(e.velocity_y), 0.998);
            }
        })
}

#[test]
fn a_release_moves_on_with_the_drags_velocity() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(
        EngineConfig::new(Root::of::<Thrown>()),
        || ApproxTextEngine,
        ChannelSink(tx),
    )
    .unwrap();
    // The drivers of the animations started after the batches that came.
    let started = |rx: &Receiver<MountBatch>| {
        let mut drivers = Vec::new();
        let mut card = None;
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            for item in batch.items {
                match item {
                    MountItem::Animation(AnimationOp::Start { driver, .. }) => drivers.push(driver),
                    MountItem::Events { id, events } if events.contains(EventKind::PanEnd) => {
                        card = Some(id)
                    }
                    _ => {}
                }
            }
        }
        (drivers, card)
    };
    let (_, card) = started(&rx);
    let card = card.expect("the card hears its drags end");
    let release = || {
        engine.control().dispatch_event(
            card,
            EventKind::PanEnd,
            EventPayload::Pan {
                translation: nsh_core::geometry::point(px(80.0), px(20.0)),
                velocity_x: 300.0,
                velocity_y: -400.0,
                value_x: Some(px(80.0)),
                value_y: Some(px(20.0)),
            },
        )
    };
    release();
    let spring = |velocity| {
        let Spring {
            stiffness,
            damping,
            mass,
            ..
        } = Spring::default();
        Driver::Spring {
            to: 0.0,
            stiffness,
            damping,
            mass,
            velocity: Some(velocity),
        }
    };
    assert_eq!(started(&rx).0, [spring(300.0), spring(-400.0)]);
    release();
    let decay = |velocity| Driver::Decay {
        velocity: Some(velocity),
        deceleration: 0.998,
        clamp: None,
        bounce: 0.0,
    };
    assert_eq!(started(&rx).0, [decay(300.0), decay(-400.0)]);
}
