//! Scroll benchmark of the gallery example's list: cost of the frames that
//! rebind a row (JS + core), back to back and with an idle gap.
//!
//! Run with `cargo test --release -p nsh-engine --test engine bench_gallery_scroll -- --ignored --nocapture`.
//!
//! Finding (Apple Silicon): ~20µs hot, ~40µs when the caches are flushed
//! between frames, but ~150µs after sleeping 10ms. The difference is the CPU
//! clocking down while the thread sleeps, not the code path; QoS classes and
//! the Mach time-constraint policy do not change it.

use std::time::{Duration, Instant};

use nsh_core::{
    ApproxTextEngine, Core, ListBind, MountItem, Size, ViewKind,
    geometry::{point, px},
};
use nsh_js::Host;

enum Gap {
    None,
    Sleep,
    /// Busy for the gap while streaming through 32MB: clock stays up, caches
    /// do not.
    Evict,
}

#[test]
#[ignore]
fn bench_gallery_scroll() {
    let entry =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/gallery/Bench.tsx");
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let bytecode =
        nsh_js::compile_bytecode_with(&bundle.code, true, &[nsh_base::registry().into()]).unwrap();
    let host = Host::with_options(nsh_js::HostOptions {
        ui_sets: vec![nsh_base::registry()],
        ..Default::default()
    })
    .unwrap();
    // The runtime reads the environment while it loads.
    host.set_environment(&nsh_js::Environment {
        window: Size::new(px(390.0), px(844.0)),
        ..Default::default()
    });
    host.eval_bytecode(&bytecode).unwrap();
    let mut core = Core::new(ApproxTextEngine, Size::new(px(390.0), px(844.0)));
    core.set_components(nsh_base::registry());
    let mut ops = Vec::new();
    let mut binds: Vec<ListBind> = Vec::new();
    let list = std::cell::Cell::new(None);

    // Mirrors the engine's frame: bind rounds until the lists are satisfied.
    // Returns (frame time, JS time) if the frame rebound anything.
    let mut frame = |core: &mut Core<ApproxTextEngine>, binds: &mut Vec<ListBind>| {
        let start = Instant::now();
        let (mut js, mut rebound) = (Duration::ZERO, false);
        for _ in 0..8 {
            rebound |= !binds.is_empty();
            let t = Instant::now();
            for b in binds.drain(..) {
                host.bind_list(b.list, &b.binds);
            }
            js += t.elapsed();
            host.take_ops(&mut ops);
            for op in ops.drain(..) {
                core.apply(op).unwrap();
            }
            if let Some(batch) = core.commit() {
                for item in &batch.items {
                    if let MountItem::Create {
                        id,
                        kind: ViewKind::Scroll,
                    } = item
                        && list.get().is_none()
                    {
                        list.set(Some(*id));
                    }
                }
            }
            core.take_list_binds(binds);
            // The overscan the engine paces over frames, all in this one.
            if binds.is_empty() {
                core.take_paced_list_binds(usize::MAX, binds);
            }
            if binds.is_empty() {
                break;
            }
        }
        rebound.then(|| (start.elapsed(), js))
    };
    frame(&mut core, &mut binds);
    let list = list.get().expect("the gallery has a list");

    let gap = Duration::from_millis(10);
    let mut junk = vec![0u8; 32 << 20];
    for (label, mode) in [
        ("back to back", Gap::None),
        ("sleep 10ms", Gap::Sleep),
        ("evict caches 10ms", Gap::Evict),
    ] {
        let (mut total, mut js, mut n) = (Duration::ZERO, Duration::ZERO, 0u32);
        let mut y = 0.0;
        for _ in 0..2000 {
            y += 8.0;
            core.set_scroll_offset(list, point(px(0.0), px(y)), u32::MAX);
            let Some((t, j)) = frame(&mut core, &mut binds) else {
                continue;
            };
            total += t;
            js += j;
            n += 1;
            match mode {
                Gap::None => {}
                Gap::Sleep => std::thread::sleep(gap),
                Gap::Evict => {
                    let t = Instant::now();
                    while t.elapsed() < gap {
                        for i in (0..junk.len()).step_by(64) {
                            junk[i] = junk[i].wrapping_add(1);
                        }
                    }
                }
            }
        }
        // Scroll back to the top for the next run.
        core.set_scroll_offset(list, point(px(0.0), px(0.0)), u32::MAX);
        frame(&mut core, &mut binds);
        println!(
            "{label}: {n} rebinding frames, {:?}/frame (js {:?})",
            total / n,
            js / n
        );
    }
    std::hint::black_box(&junk);
}
