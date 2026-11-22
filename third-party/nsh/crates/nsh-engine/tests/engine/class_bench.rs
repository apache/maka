//! Benchmark of calls into Rust from JS: a synchronous class method and
//! module function (run in the JS call, values converted directly) against
//! an op and an `async` module function or member (arguments converted in
//! the JS call into the closure an `Op::Rust` carries, the core's work, the
//! boxed result in the core's events settling a promise), with a JS
//! function as the floor.
//!
//! Run with `cargo test --release -p nsh-engine --test engine bench_calls -- --ignored --nocapture`;
//! the numbers are in `docs/dev/performance.md`.

use std::time::{Duration, Instant};

use nsh_core::{
    ApproxTextEngine, Core, Size,
    element::{JsEvent, Posts, Registry},
    prelude::*,
};
use nsh_js::Host;

/// A point.
#[derive(Clone, Copy, PartialEq, JsObject)]
pub(crate) struct Point {
    x: f64,
    y: f64,
}

/// A running total.
#[class]
pub(crate) struct Meter {
    total: f64,
}

#[class]
impl Meter {
    pub(crate) fn new() -> Self {
        Meter { total: 0.0 }
    }

    /// Adds `by`; the total.
    pub(crate) fn add(&mut self, by: f64) -> f64 {
        self.total += by;
        self.total
    }

    /// Adds a point's coordinates; the total.
    pub(crate) fn add_point(&mut self, p: Point) -> f64 {
        self.total += p.x + p.y;
        self.total
    }

    /// Adds `by` in a task; the total.
    pub(crate) async fn add_later(this: Instance<Self>, by: f64) -> f64 {
        this.with_mut(|m| {
            m.total += by;
            m.total
        })
    }
}

/// Functions of the three kinds.
#[module]
pub(crate) struct Calc;

#[module]
impl Calc {
    /// In the call.
    pub(crate) fn twice(n: f64) -> f64 {
        n * 2.0
    }

    /// An op.
    pub(crate) fn twice_op(n: f64, cx: &mut ModuleCx) -> f64 {
        let _ = cx;
        n * 2.0
    }

    /// A task.
    pub(crate) async fn twice_later(n: f64) -> f64 {
        n * 2.0
    }
}

fn registry() -> Registry {
    let mut r = Registry::ui_set("bench/calls");
    r.class::<Meter>().module::<Calc>();
    r
}

struct App {
    host: Host,
    core: Core<ApproxTextEngine>,
    ops: Vec<nsh_core::Op>,
    events: Vec<JsEvent>,
}

impl App {
    fn new() -> Self {
        let posts = Posts::new();
        let host = Host::with_options(nsh_js::HostOptions {
            ui_sets: vec![registry()],
            posts: posts.clone(),
            ..Default::default()
        })
        .unwrap();
        let mut core = Core::new(ApproxTextEngine, Size::new(px(390.0), px(844.0)));
        core.set_components(registry());
        core.set_posts(posts);
        let app = Self {
            host,
            core,
            ops: Vec::new(),
            events: Vec::new(),
        };
        app.host
            .eval_source(
                r#"
                import { Meter, Calc } from "bench/calls";
                const meter = new Meter();
                const plain = { total: 0, add(by) { this.total += by; return this.total; } };
                globalThis.done = false;
                globalThis.cases = {
                  js: (n) => { for (let i = 0; i < n; i++) plain.add(1); },
                  method: (n) => { for (let i = 0; i < n; i++) meter.add(1); },
                  object: (n) => { for (let i = 0; i < n; i++) meter.addPoint({ x: 1, y: 2 }); },
                  function: (n) => { for (let i = 0; i < n; i++) Calc.twice(i); },
                  op: (n) => { const p = []; for (let i = 0; i < n; i++) p.push(Calc.twiceOp(i)); Promise.all(p).then(() => { done = true; }); },
                  async: (n) => { const p = []; for (let i = 0; i < n; i++) p.push(Calc.twiceLater(i)); Promise.all(p).then(() => { done = true; }); },
                  member: (n) => { const p = []; for (let i = 0; i < n; i++) p.push(meter.addLater(1)); Promise.all(p).then(() => { done = true; }); },
                };
                "#,
            )
            .unwrap();
        app
    }

    /// Runs `cases[name](n)` and, for calls that wait, the core's work and
    /// the replies until all settled: the time per call.
    fn run(&mut self, name: &str, n: usize) -> Duration {
        self.host.eval_script("reset", "done = false;").unwrap();
        let t = Instant::now();
        self.host
            .eval_script("bench", &format!("cases.{name}({n});"))
            .unwrap();
        loop {
            self.host.take_ops(&mut self.ops);
            if self.ops.is_empty() && self.events.is_empty() {
                break;
            }
            for op in self.ops.drain(..) {
                self.core.apply(op).unwrap();
            }
            self.core.run_component_tasks();
            let _ = self.core.commit();
            self.core.take_events(&mut self.events);
            for event in self.events.drain(..) {
                self.host.deliver(event);
            }
        }
        let elapsed = t.elapsed();
        if matches!(name, "op" | "async" | "member") {
            assert!(
                self.host.eval_script("check", "done").unwrap(),
                "{name}: every call settled"
            );
        }
        elapsed / n as u32
    }
}

/// `min / median`: the minimum is the code path's cost, the median shows
/// how noisy the machine was.
fn stats(mut v: Vec<Duration>) -> String {
    v.sort();
    format!("{:?} / {:?}", v[0], v[v.len() / 2])
}

#[test]
#[ignore]
fn bench_calls() {
    let mut app = App::new();
    for (name, label, n) in [
        ("js", "JS method (the floor)", 100_000),
        ("method", "class method, a number", 100_000),
        ("object", "class method, an object", 100_000),
        ("function", "module function in the call", 100_000),
        ("op", "op function (cx), awaited", 2_000),
        ("async", "async function, awaited", 2_000),
        ("member", "async class member, awaited", 2_000),
    ] {
        // Warm up, then 20 runs.
        app.run(name, n / 10);
        let runs: Vec<Duration> = (0..20).map(|_| app.run(name, n)).collect();
        println!("{label:34} {} per call", stats(runs));
    }
}
