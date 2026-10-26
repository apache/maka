//! Benchmark of the handles Rust components keep: what one use of an
//! `AnimatedValue` or an `ElementRef` costs in a listener (setting the
//! value, setting up a timing, deriving a node made before, reading the
//! ref's node, sending it a command). Each is called 1000 times in one
//! press; the minimum of the presses, per call.
//!
//! Run with `cargo test --release -p nsh-engine --test engine bench_handles
//! -- --ignored --nocapture --test-threads=1`; the numbers are in
//! `docs/dev/performance.md`.

use std::{
    cell::{Cell, RefCell},
    hint::black_box,
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::{
    ApproxTextEngine, Core, EventKind, EventPayload, MountItem, ROOT_ID, Size,
    element::{Root, create_root},
    prelude::*,
};

/// Calls per press.
const CALLS: u32 = 1000;
/// Presses per operation.
const ROUNDS: usize = 200;

const OPS: [&str; 5] = [
    "AnimatedValue::set",
    "AnimatedValue::timing",
    "AnimatedValue::interpolate (made before)",
    "ElementRef::node",
    "ElementRef::focus",
];

thread_local! {
    /// The view's handles, for the listener (no closure captures them, so
    /// the same code measures them as `Rc`s and as `Copy` handles).
    static HANDLES: RefCell<Option<(AnimatedValue, ElementRef)>> = const { RefCell::new(None) };
    /// The operation the next press measures, and what it took.
    static OP: Cell<usize> = const { Cell::new(0) };
    static TOOK: Cell<Duration> = const { Cell::new(Duration::ZERO) };
}

/// A value bound to its opacity and an input carrying a ref; a press runs
/// the operation `OP` names.
#[component]
fn Handles() -> impl IntoElement {
    let value = animated_value(0.0);
    let field = element_ref();
    let root = view()
        .flex_1()
        .bind_opacity(&value.interpolate(&[0.0, 1.0], &[0.0, 1.0]))
        .child(input().element_ref(&field))
        .on_press(run);
    HANDLES.with(|h| *h.borrow_mut() = Some((value, field)));
    root
}

fn run(_: &()) {
    HANDLES.with(|h| {
        let h = h.borrow();
        let (value, field) = h.as_ref().expect("the view ran");
        // Under an owner of their own, as in a region: what they make goes
        // with it (listeners run under none).
        let (owner, took) = create_root(|| {
            let start = Instant::now();
            match OP.get() {
                0 => (0..CALLS).for_each(|i| value.set(i as f32)),
                1 => (0..CALLS).for_each(|i| drop(value.timing(i as f32, 100.0, Easing::Linear))),
                2 => (0..CALLS)
                    .for_each(|_| _ = black_box(value.interpolate(&[0.0, 1.0], &[0.0, 1.0]))),
                3 => (0..CALLS).for_each(|_| _ = black_box(field.node())),
                _ => (0..CALLS).for_each(|_| field.focus()),
            }
            start.elapsed()
        });
        owner.dispose();
        TOOK.set(took);
    });
}

#[test]
#[ignore]
fn bench_handles() {
    let mut core = Core::new(ApproxTextEngine, Size::new(px(390.0), px(844.0)));
    core.mount_root(&Root::new::<Handles>(|| ()));
    let batch = core.commit().expect("the first frame");
    let host = batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Insert {
                parent: ROOT_ID,
                child,
                ..
            } => Some(*child),
            _ => None,
        })
        .expect("the root's host");
    for (op, name) in OPS.iter().enumerate() {
        OP.set(op);
        let mut best = Duration::MAX;
        for _ in 0..ROUNDS {
            assert!(core.component_event(host, EventKind::Press, &EventPayload::None));
            best = best.min(TOOK.get());
            // What the calls asked for goes out, so queues start empty.
            let _ = core.commit();
        }
        eprintln!(
            "{name}: {:.1}ns per call",
            best.as_secs_f64() * 1e9 / f64::from(CALLS)
        );
    }
}
