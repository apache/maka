//! End-to-end: bundle the counter example, run it on the engine thread and
//! tap a button after the idle GC has run.

use std::{path::PathBuf, time::Duration};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, EventKind, MountBatch, MountItem, Points, Size, geometry::px};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

fn start() -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    (
        Engine::start(config(), || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// The counter example, bundled and compiled.
fn config() -> EngineConfig {
    let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/counter/App.tsx");
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        content_culling: false,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Default::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        support_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
        audio: None,
        windows: None,
        login_item: None,
        data_dir: None,
    }
}

fn texts(batch: &MountBatch) -> Vec<String> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn tap_after_idle_gc_updates_the_ui() {
    let (engine, rx) = start();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(texts(&first).contains(&"0".to_owned()));
    let buttons: Vec<_> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .collect();
    assert_eq!(buttons.len(), 2, "two buttons");

    // Let the idle collector run: the app must stay reachable from JS.
    while rx.recv_timeout(Duration::from_millis(1300)).is_ok() {}

    let plus = buttons[1];
    engine
        .control()
        .dispatch_event(plus, EventKind::Press, nsh_core::EventPayload::None);
    let batch = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("update after tap");
    let texts = texts(&batch);
    assert!(texts.contains(&"1".to_owned()), "{texts:?}");
    assert!(texts.contains(&"• 1".to_owned()), "{texts:?}");
}

#[test]
fn queued_presses_follow_js_rebinding_in_fifo_order() {
    use nsh_core::{EventPayload, NodeId};

    let registry = nsh_base::registry();
    let source = nsh_bundler::compile_module(
        "queued-input.tsx",
        r#"import { inputAction, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
const owner = signal("A"), background = signal(0), log = signal("");
const record = args => log.set(`${log()}${args.owner},`);
mount(() => <View>
  <Button testID="row" onPress={inputAction(record, {owner: owner()})} />
  <View testID="background" onPress={() => background.set(background() + 1)} />
  <View testID="rebind" onPress={() => owner.set("B")} />
  <View testID="fence" onPress={() => log.set(`${log()}fence,`)} />
  <Text>{`background ${background()}`}</Text>
  <Text>{`log ${log()}`}</Text>
</View>);"#,
        &[(&registry).into()],
    )
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(
        EngineConfig {
            ui_sets: vec![registry],
            clock: nsh_core::time::Clock::manual(std::time::SystemTime::UNIX_EPOCH),
            ..EngineConfig::new(Bundle::source(source))
        },
        || ApproxTextEngine,
        ChannelSink(tx),
    )
    .unwrap();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let node = |name| {
        first
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(name) => {
                    Some(*id)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing {name}"))
    };
    let row = node("row");
    let control = engine.control();
    let press = |id: NodeId| control.dispatch_event(id, EventKind::Press, EventPayload::None);
    let frame = || {
        // A FIFO fence commits the messages before it without sleeping or
        // depending on which engine turn took each input.
        let (done, finished) = crossbeam_channel::bounded(1);
        control.advance_clock(Duration::ZERO, move || done.send(()).unwrap());
        finished.recv_timeout(Duration::from_secs(5)).unwrap();
        rx.try_iter().collect::<Vec<_>>()
    };
    let log = |frames: &[MountBatch]| {
        frames
            .iter()
            .flat_map(texts)
            .rfind(|text| text.starts_with("log "))
            .expect("the rendered log changed")
    };

    press(node("background"));
    press(row);
    assert_eq!(log(&frame()), "log A,");

    // Earlier queued input updates the action before the next press runs.
    press(node("rebind"));
    press(row);
    press(node("fence"));
    assert_eq!(log(&frame()), "log A,B,fence,");

    press(row);
    assert_eq!(log(&frame()), "log A,B,fence,B,");
}

/// What the engine handed a [`ResizeSink`].
#[derive(Debug)]
enum Sent {
    Batch(MountBatch),
    Resized(Size<Points>),
}

/// Hands batches and resize reports to the test, in order.
struct ResizeSink(crossbeam_channel::Sender<Sent>);

impl nsh_engine::MountSink for ResizeSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(Sent::Batch(batch));
    }

    fn resized(&self, size: Size<Points>) {
        let _ = self.0.send(Sent::Resized(size));
    }
}

#[test]
fn resize_is_reported_after_its_layout() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(config(), || ApproxTextEngine, ResizeSink(tx)).unwrap();
    let next = || rx.recv_timeout(Duration::from_secs(5)).expect("a message");
    assert!(matches!(next(), Sent::Batch(_)), "first frame");

    // The layout at the new size comes first, then the report.
    let size = Size::new(px(500.0), px(700.0));
    engine.control().resize(size);
    let Sent::Batch(batch) = next() else {
        panic!("the layout at the new size first");
    };
    assert!(
        batch.items.iter().any(|i| matches!(
            i,
            MountItem::Frame { frame, .. } if frame.size.width.0 == 500.0 && frame.size.height.0 == 700.0
        )),
        "the app's root view takes the size"
    );
    assert!(matches!(next(), Sent::Resized(s) if s == size));

    // Reported even when nothing changes.
    engine.control().resize(size);
    assert!(matches!(next(), Sent::Resized(s) if s == size));
}

#[test]
fn idle_gc_skips_text_updates_in_standalone_and_collects_unparented_or_quota() {
    use nsh_core::EventPayload;

    let source = nsh_bundler::compile_module(
        "idle-gc.tsx",
        r#"import { mount, signal, Text, View } from "nsh";
const ticks = signal(0);
const showDetached = signal(true);
const showA = signal(true);
const showB = signal(false);
const status = signal("idle");

let detachedRef: WeakRef<object> | undefined;
let neverMountedRef: WeakRef<object> | undefined;
let cachedRef: unknown = null;
let cachedBox: unknown = null;
let probes = 0;

function makeCyclicView(onCreated: (el: object) => void) {
  const el = <View />;
  const box: { el?: unknown; self?: unknown } = { el };
  box.self = box;
  (el as { __cycle?: unknown }).__cycle = box;
  onCreated(el as object);
  return el;
}

mount(() => <View>
  <Text>{`tick ${ticks()}`}</Text>
  <Text>{status()}</Text>
  {() => (showDetached() ? makeCyclicView((el) => { detachedRef = new WeakRef(el); }) : null)}
  {() => (showA() ? (cachedBox ??= <View />) : null)}
  {() => (showB() ? makeCyclicView(() => {}) : null)}
  <View testID="tick" onPress={() => ticks.set(ticks() + 1)} />
  <View testID="detach" onPress={() => showDetached.set(false)} />
  <View testID="never-mount" onPress={() => {
    makeCyclicView((el) => { neverMountedRef = new WeakRef(el); });
  }} />
  <View testID="cache" onPress={() => {
    cachedRef = cachedBox;
    showA.set(false);
    showB.set(true);
  }} />
  <View testID="swap" onPress={() => {
    // Reattach cachedA and detach B in the same commit: unparented_nodes stays 1,
    // but unparented_seq advances and resets backoff back to ~1s.
    showA.set(true);
    cachedRef = null;
    showB.set(false);
  }} />
  <View testID="probe" onPress={() => {
    probes += 1;
    status.set([
      "p" + probes,
      "detached=" + (detachedRef?.deref() !== undefined),
      "orphan=" + (neverMountedRef?.deref() !== undefined),
    ].join(","));
  }} />
</View>);"#,
        &[],
    )
    .unwrap();

    // Standalone mode (Maka desktop): no hard memory/node quota.
    let mut cfg = EngineConfig::new(Bundle::source(source));
    cfg.limits = nsh_engine::Limits::standalone();

    let (tx, rx) = crossbeam_channel::unbounded();
    let perf = std::sync::Arc::new(nsh_engine::perf::PerfMonitor::new());
    let mut engine =
        nsh_engine::LocalEngine::start_with(cfg, ApproxTextEngine, ChannelSink(tx), |ctrl| {
            ctrl.set_perf_monitor(Some(perf.clone()))
        })
        .unwrap();

    let first = rx.try_recv().expect("first frame");
    assert!(
        perf.snapshot()
            .memory
            .expect("startup PerfMonitor sample")
            .nodes
            > 0
    );
    // Detach the monitor before asserting GC-only deadlines (nsh 0.6 schedules
    // a 1 Hz perfStats timer while a PerfMonitor is attached).
    engine.control().set_perf_monitor(None);
    let _ = engine.pump();

    let btn_of = |name: &str| {
        first
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(name) => {
                    Some(*id)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing {name}"))
    };
    let press = |eng: &mut nsh_engine::LocalEngine<ApproxTextEngine>, id: u32| {
        eng.control()
            .dispatch_event(id, EventKind::Press, EventPayload::None);
        eng.pump()
    };
    let last_status = || {
        rx.try_iter()
            .flat_map(|b| texts(&b))
            .filter(|t| t.starts_with("p1,") || t.starts_with("p2,"))
            .last()
            .unwrap_or_default()
    };

    // 1. Plain text updates schedule no idle GC at all.
    let d_tick = press(&mut engine, btn_of("tick"));
    assert!(
        d_tick.is_none(),
        "text update must not schedule idle GC, got {d_tick:?}"
    );
    let _ = rx.try_iter().count();

    // 2. Detached cyclic node + never-mounted cyclic node both schedule ~1s GC and get reclaimed.
    let d_detach = press(&mut engine, btn_of("detach"));
    assert!(d_detach.is_some(), "detached node must schedule idle GC");
    let d_orphan = press(&mut engine, btn_of("never-mount"));
    assert!(
        d_orphan.is_some(),
        "never-mounted node must schedule idle GC"
    );

    let wait_until = d_orphan.unwrap();
    let now = std::time::Instant::now();
    if wait_until > now {
        std::thread::sleep(wait_until - now + Duration::from_millis(20));
    }
    let after_gc_deadline = engine.pump();
    assert!(
        after_gc_deadline.is_none(),
        "once unparented nodes are reclaimed, no further GC is scheduled: {after_gc_deadline:?}"
    );
    let _ = press(&mut engine, btn_of("probe"));
    assert_eq!(last_status(), "p1,detached=false,orphan=false");

    // 3. Cached unparented node backs off after a no-progress pass, and swapping it
    // for a newly detached node in the same commit resets back to ~1s.
    let d_cache = press(&mut engine, btn_of("cache")).expect("cached detached schedules GC");
    let now = std::time::Instant::now();
    if d_cache > now {
        std::thread::sleep(d_cache - now + Duration::from_millis(20));
    }
    let d_backoff = engine.pump().expect("cached detached keeps backed-off GC");
    let backoff_wait = d_backoff.saturating_duration_since(std::time::Instant::now());
    assert!(
        backoff_wait >= Duration::from_secs(3),
        "no-progress detached GC should back off to >= 4s, got {backoff_wait:?}"
    );
    let d_swap = press(&mut engine, btn_of("swap")).expect("swapped detached schedules GC");
    let swap_wait = d_swap.saturating_duration_since(std::time::Instant::now());
    assert!(
        swap_wait <= Duration::from_secs(2),
        "newly detached node in same-count swap must reset backoff to ~1s, got {swap_wait:?}"
    );
    let now = std::time::Instant::now();
    if d_swap > now {
        std::thread::sleep(d_swap - now + Duration::from_millis(20));
    }
    let after_swap_gc = engine.pump();
    assert!(
        after_swap_gc.is_none(),
        "swapped detached node should be reclaimed cleanly, got {after_swap_gc:?}"
    );

    // 4. In quota-enforced sandbox mode, post-commit idle GC stays active so
    // cyclic buffers below automatic GC threshold are still reclaimed promptly.
    let sandbox_source = nsh_bundler::compile_module(
        "idle-gc-sandbox.tsx",
        r#"import { mount, signal, Text, View } from "nsh";
const ticks = signal(0);
const status = signal("idle");
let cycleRef: WeakRef<object> | undefined;
mount(() => <View>
  <Text>{`t=${ticks()}`}</Text>
  <Text>{status()}</Text>
  <View testID="alloc" onPress={() => {
    const garbage: { buf: ArrayBuffer; self?: unknown } = { buf: new ArrayBuffer(1024 * 1024) };
    garbage.self = garbage;
    cycleRef = new WeakRef(garbage);
    ticks.set(ticks() + 1);
  }} />
  <View testID="probe" onPress={() => {
    status.set("alive=" + (cycleRef?.deref() !== undefined));
  }} />
</View>);"#,
        &[],
    )
    .unwrap();
    let mut sandbox_cfg = EngineConfig::new(Bundle::source(sandbox_source));
    sandbox_cfg.limits.memory_bytes = 12 * 1024 * 1024;
    let (stx, srx) = crossbeam_channel::unbounded();
    let mut sandbox =
        nsh_engine::LocalEngine::start(sandbox_cfg, ApproxTextEngine, ChannelSink(stx)).unwrap();
    let sfirst = srx.try_recv().expect("sandbox first frame");
    let sbtn = |name: &str| {
        sfirst
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(name) => {
                    Some(*id)
                }
                _ => None,
            })
            .unwrap()
    };
    sandbox
        .control()
        .dispatch_event(sbtn("alloc"), EventKind::Press, EventPayload::None);
    let sd = sandbox
        .pump()
        .expect("quota-enforced sandbox must schedule idle GC after commit");
    let now = std::time::Instant::now();
    if sd > now {
        std::thread::sleep(sd - now + Duration::from_millis(20));
    }
    let _ = sandbox.pump();
    sandbox
        .control()
        .dispatch_event(sbtn("probe"), EventKind::Press, EventPayload::None);
    let _ = sandbox.pump();
    let sstatus = srx
        .try_iter()
        .flat_map(|b| texts(&b))
        .filter(|t| t.starts_with("alive="))
        .last()
        .unwrap_or_default();
    assert_eq!(sstatus, "alive=false");
}
