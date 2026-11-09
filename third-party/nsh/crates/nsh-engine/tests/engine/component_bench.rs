//! Benchmark of Rust components against the same component written in TSX:
//! the first frame of 200 Buttons, one update of all their titles, and
//! scrolling a recycled list with a Button per row. The Rust Button is the
//! tests' own (`test/ui`), `TsButton.tsx` draws the same with the default
//! theme; the screens are written into a temporary directory.
//!
//! Run with `cargo test --release -p nsh-engine --test engine bench_components -- --ignored --nocapture`;
//! the numbers are in `docs/dev/performance.md`. `profile_components` loops
//! the Rust Grid for a profiler (`samply record <test binary>
//! component_bench::profile_components --ignored --exact`).

use std::time::{Duration, Instant};

use nsh_core::{
    ApproxTextEngine, Core, EventKind, EventPayload, ListBind, MountItem, Size, ViewKind,
    geometry::{point, px},
};
use nsh_js::Host;

struct App {
    host: Host,
    core: Core<ApproxTextEngine>,
    ops: Vec<nsh_core::Op>,
    binds: Vec<ListBind>,
    /// JS time and core time of the last `turn`.
    js: Duration,
    native: Duration,
    ops_applied: usize,
    items: usize,
}

/// The two benchmark screens, parameterized by the Button under test.
const BUTTONS: &str = r#"import { type Component, Scroll, signal, Text, View } from "nsh";
import { List } from "nsh";

export interface BenchButtonProps {
  title: string;
  variant?: "primary" | "secondary" | "plain";
  onPress?: () => void;
}

const rows = Array.from({ length: 200 }, (_, i) => i);

/** 200 Buttons in a scroll view. The first press target bumps a counter
 * that every title shows: one tap updates all 200 titles. */
export function Grid(props: { Button: Component<BenchButtonProps> }) {
  const count = signal(0);
  const Button = props.Button;
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ padding: 16, gap: 8 }}>
        <View onPress={() => count.update((c) => c + 1)} style={{ padding: 12 }}>
          <Text>Bump</Text>
        </View>
        <Each of={rows}>
          {(i) => <Button title={`Row ${i()} · ${count()}`} variant={i() % 3 === 0 ? "primary" : i() % 3 === 1 ? "secondary" : "plain"} />}
        </Each>
      </View>
    </Scroll>
  );
}

const items = Array.from({ length: 1000 }, (_, i) => i);

/** A recycled list of 1000 rows with a Button each: scrolling rebinds rows. */
export function Rows(props: { Button: Component<BenchButtonProps> }) {
  const Button = props.Button;
  return (
    <List each={items} estimatedItemSize={64} style={{ flex: 1 }}>
      {(i) => (
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, gap: 12 }}>
          <Text style={{ flex: 1 }}>{`Item ${i()}`}</Text>
          <Button title={`Open ${i()}`} variant={i() % 2 === 0 ? "primary" : "secondary"} />
        </View>
      )}
    </List>
  );
}
"#;

/// The Rust Button written in TSX: drawn exactly like it with the default
/// theme.
const TS_BUTTON: &str = r#"import type { JSX, StyleProp, ViewStyle } from "nsh";
import { Text, View } from "nsh";

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger" | "plain";
  disabled?: boolean;
  class?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

const base = "flex-row items-center justify-center rounded-xl px-4 py-3 disabled:opacity-50";

// The default theme's colors (`nsh_base::Theme`).
const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-neutral-900 active:bg-neutral-950 text-neutral-50 dark:bg-neutral-50 dark:active:bg-neutral-200 dark:text-neutral-900",
  secondary:
    "bg-neutral-200 active:bg-neutral-300 text-neutral-900 dark:bg-neutral-800 dark:active:bg-[#212121] dark:text-neutral-50",
  danger: "bg-red-500 active:bg-red-600 text-neutral-50 dark:bg-red-400 dark:active:bg-red-500 dark:text-red-600",
  plain: "active:bg-neutral-100 text-neutral-950 dark:active:bg-neutral-800 dark:text-neutral-50",
};

export function Button(props: ButtonProps): JSX.Element {
  return (
    <View
      onPress={() => props.onPress?.()}
      disabled={props.disabled}
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      accessibilityState={{ disabled: !!props.disabled }}
      testID={props.testID}
      class={`${base} ${variants[props.variant ?? "primary"]} ${props.class ?? ""}`}
      style={props.style}
    >
      <Text class="text-[16px] font-semibold">{props.title}</Text>
    </View>
  );
}
"#;

/// The entries: a screen (`Grid`, `Rows`) with a Button (`Rust`, `Ts`).
const ENTRIES: [(&str, &str); 4] = [
    (
        "GridRust.tsx",
        "import { Button } from \"test/ui\";\nimport { Grid as Screen } from \"./buttons\";",
    ),
    (
        "GridTs.tsx",
        "import { Button } from \"./TsButton\";\nimport { Grid as Screen } from \"./buttons\";",
    ),
    (
        "RowsRust.tsx",
        "import { Button } from \"test/ui\";\nimport { Rows as Screen } from \"./buttons\";",
    ),
    (
        "RowsTs.tsx",
        "import { Button } from \"./TsButton\";\nimport { Rows as Screen } from \"./buttons\";",
    ),
];

/// The benchmark app `entry` (one of [`ENTRIES`]), compiled to bytecode.
fn bytecode(entry: &str) -> Vec<u8> {
    let dir = std::env::temp_dir().join(format!("nsh-component-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("buttons.tsx"), BUTTONS).unwrap();
    std::fs::write(dir.join("TsButton.tsx"), TS_BUTTON).unwrap();
    for (name, imports) in ENTRIES {
        let app = format!(
            "import {{ mount }} from \"nsh\";\n{imports}\n\nmount(() => <Screen Button={{Button}} />);\n"
        );
        std::fs::write(dir.join(name), app).unwrap();
    }
    let ui_sets = [crate::test_ui::registry()];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: dir.join(entry),
        minify: false,
        split: false,
        ui_sets: ui_sets.iter().map(Into::into).collect(),
    })
    .unwrap();
    nsh_js::compile_bytecode_with(
        &bundle.code,
        true,
        &ui_sets.iter().map(Into::into).collect::<Vec<_>>(),
    )
    .unwrap()
}

impl App {
    fn new() -> Self {
        let host = Host::with_options(nsh_js::HostOptions {
            ui_sets: vec![crate::test_ui::registry()],
            ..Default::default()
        })
        .unwrap();
        // The runtime reads the environment while it loads.
        host.set_environment(&nsh_js::Environment {
            window: Size::new(px(390.0), px(844.0)),
            ..Default::default()
        });
        let mut core = Core::new(ApproxTextEngine, Size::new(px(390.0), px(844.0)));
        core.set_components(crate::test_ui::registry());
        Self {
            host,
            core,
            ops: Vec::new(),
            binds: Vec::new(),
            js: Duration::ZERO,
            native: Duration::ZERO,
            ops_applied: 0,
            items: 0,
        }
    }

    /// Runs `js`, then applies its ops and commits, with bind rounds like the
    /// engine's frame. Returns the mount items of the turn.
    fn turn(&mut self, js: impl FnOnce(&Host)) -> Vec<MountItem> {
        let t = Instant::now();
        js(&self.host);
        self.host.run_jobs();
        self.js = t.elapsed();
        self.native = Duration::ZERO;
        self.ops_applied = 0;
        let mut items = Vec::new();
        for _ in 0..8 {
            let t = Instant::now();
            self.host.take_ops(&mut self.ops);
            self.ops_applied += self.ops.len();
            for op in self.ops.drain(..) {
                self.core.apply(op).unwrap();
            }
            if let Some(batch) = self.core.commit() {
                items.extend(batch.items);
            }
            self.core.take_list_binds(&mut self.binds);
            self.native += t.elapsed();
            if self.binds.is_empty() {
                break;
            }
            let t = Instant::now();
            for b in self.binds.drain(..) {
                self.host.bind_list(b.list, &b.binds);
            }
            self.js += t.elapsed();
        }
        self.items = items.len();
        items
    }
}

/// `min / median`: the minimum is the code path's cost, the median shows
/// how noisy the machine was.
fn stats(mut v: Vec<Duration>) -> String {
    v.sort();
    format!("{:?} / {:?}", v[0], v[v.len() / 2])
}

fn first_frame(entry: &str) -> (App, Vec<MountItem>) {
    let code = bytecode(entry);
    let mut runs = Vec::new();
    let mut last = None;
    for _ in 0..40 {
        let mut app = App::new();
        let items = app.turn(|h| h.eval_bytecode(&code).unwrap());
        runs.push((app.js, app.native));
        last = Some((app, items));
    }
    let (app, items) = last.unwrap();
    println!(
        "  first frame: js {}, core {} ({} ops, {} mount items)",
        stats(runs.iter().map(|r| r.0).collect()),
        stats(runs.iter().map(|r| r.1).collect()),
        app.ops_applied,
        app.items,
    );
    (app, items)
}

fn grid(entry: &str) {
    println!("{entry}");
    let (mut app, items) = first_frame(entry);
    // The first press target is the "Bump" view: it updates all 200 titles.
    let bump = items
        .iter()
        .find_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .unwrap();
    let (mut js, mut native) = (Vec::new(), Vec::new());
    for _ in 0..300 {
        app.turn(|h| h.dispatch_event(bump, EventKind::Press, &EventPayload::None));
        js.push(app.js);
        native.push(app.native);
    }
    println!(
        "  update 200 titles: js {}, core {} ({} ops, {} mount items)",
        stats(js),
        stats(native),
        app.ops_applied,
        app.items
    );
}

fn rows(entry: &str) {
    println!("{entry}");
    let (mut app, items) = first_frame(entry);
    let list = items
        .iter()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: ViewKind::Scroll,
            } => Some(*id),
            _ => None,
        })
        .unwrap();
    let (mut js, mut native, mut n) = (Duration::ZERO, Duration::ZERO, 0u32);
    let mut y = 0.0;
    for _ in 0..4000 {
        y += 8.0;
        app.core
            .set_scroll_offset(list, point(px(0.0), px(y)), u32::MAX);
        app.turn(|_| {});
        if app.ops_applied > 0 {
            js += app.js;
            native += app.native;
            n += 1;
        }
    }
    println!(
        "  scrolling: {n} rebinding frames, js {:?}/frame, core {:?}/frame",
        js / n,
        native / n
    );
}

#[test]
#[ignore]
fn bench_components() {
    for entry in ["GridRust.tsx", "GridTs.tsx"] {
        grid(entry);
    }
    for entry in ["RowsRust.tsx", "RowsTs.tsx"] {
        rows(entry);
    }
}

/// For profilers: the first frame and the title updates of the Rust Grid in
/// a loop (`NSH_BENCH_ENTRY` picks another entry).
#[test]
#[ignore]
fn profile_components() {
    let entry = std::env::var("NSH_BENCH_ENTRY").unwrap_or_else(|_| "GridRust.tsx".into());
    let code = bytecode(&entry);
    for _ in 0..60 {
        let mut app = App::new();
        let items = app.turn(|h| h.eval_bytecode(&code).unwrap());
        let bump = items.iter().find_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        });
        if let Some(bump) = bump {
            for _ in 0..100 {
                app.turn(|h| h.dispatch_event(bump, EventKind::Press, &EventPayload::None));
            }
        }
    }
}
