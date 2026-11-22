//! `<Each>` in a scroll view that culls its content: the rows far from the
//! viewport are rendered as they come near, and changes of the array
//! reach rows rendered and rows waiting alike.

use std::{collections::HashMap, sync::mpsc, time::Duration};

use nsh_core::{ApproxTextEngine, MountBatch, MountItem, NodeId, Size, ViewKind, geometry::px};
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};

/// Sends batches to the test, and answers a request for a display frame
/// at once.
struct Sink(
    mpsc::Sender<MountBatch>,
    std::sync::Arc<std::sync::OnceLock<nsh_engine::EngineControl>>,
);

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(batch);
    }

    fn request_frame(&self) {
        if let Some(control) = self.1.get() {
            control.frame();
        }
    }
}

/// 2000 rows of 50 counting their renders; scrolled past 20 005 the first
/// time, the array loses item 402, gains `fresh` at 401 and swaps items
/// 1500 and 1501 (not rendered yet).
const APP: &str = r#"
import { mount, Scroll, signal, Text, View } from "nsh";
const items = signal(Array.from({ length: 2000 }, (_, i) => `item ${i}`));
const rendered = signal(0);
let updated = false;
function App() {
  return (
    <View style={{ flex: 1 }}>
      <Text>{`rendered ${rendered()}`}</Text>
      <Scroll
        style={{ flex: 1 }}
        onScroll={(e) => {
          if (updated || e.offset.y < 20005) return;
          updated = true;
          items.update((a) => {
            const b = a.slice();
            b.splice(402, 1);
            b.splice(401, 0, "fresh");
            [b[1500], b[1501]] = [b[1501], b[1500]];
            return b;
          });
        }}
      >
        <Each of={items()}>
          {(item) => {
            rendered.update((n) => n + 1);
            return <Text style={{ height: 50 }}>{item()}</Text>;
          }}
        </Each>
      </Scroll>
    </View>
  );
}
mount(App);
"#;

/// What the batches so far showed: each text view's text and frame, the
/// views taken out or deleted, and the last count of renders.
#[derive(Default)]
struct Seen {
    texts: HashMap<NodeId, String>,
    frames: HashMap<NodeId, f32>,
    deleted: Vec<NodeId>,
    rendered: usize,
    scroll: Option<NodeId>,
}

impl Seen {
    fn take(&mut self, rx: &mpsc::Receiver<MountBatch>) {
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
            for item in batch.items {
                match item {
                    MountItem::Create {
                        id,
                        kind: ViewKind::Scroll,
                    } => {
                        self.scroll.get_or_insert(id);
                    }
                    MountItem::Text { id, text, .. } => {
                        if let Some(n) = text.text.strip_prefix("rendered ") {
                            self.rendered = n.parse().unwrap();
                        } else {
                            self.texts.insert(id, text.text.clone());
                        }
                    }
                    MountItem::Frame { id, frame } => {
                        self.frames.insert(id, frame.origin.y.0);
                    }
                    MountItem::Delete { id } | MountItem::Remove { id } => self.deleted.push(id),
                    _ => {}
                }
            }
        }
    }

    /// The text view showing `text`.
    fn view(&self, text: &str) -> Option<NodeId> {
        self.texts
            .iter()
            .find_map(|(&id, t)| (t == text).then_some(id))
    }

    /// Where the text view showing `text` is in the content.
    fn y(&self, text: &str) -> Option<f32> {
        self.view(text).and_then(|id| self.frames.get(&id).copied())
    }
}

fn start() -> (Engine, mpsc::Receiver<MountBatch>, std::path::PathBuf) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = crate::temporary_root().join(format!(
        "nsh-lazy-each-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    let mut config = EngineConfig::new(nsh_engine::App::Js(
        // SAFETY: compiled just now by this runtime.
        unsafe { Bundle::bytecode(bytecode) },
    ));
    config.viewport = Size::new(px(320.0), px(500.0));
    config.content_culling = true;
    let (tx, rx) = mpsc::channel();
    let control = std::sync::Arc::new(std::sync::OnceLock::new());
    let engine = Engine::start(config, || ApproxTextEngine, Sink(tx, control.clone())).unwrap();
    let _ = control.set(engine.control());
    engine.control().frame();
    (engine, rx, dir)
}

#[test]
fn each_in_a_culling_scroll_view_renders_rows_as_they_come_near() {
    let (engine, rx, dir) = start();
    let mut seen = Seen::default();
    seen.take(&rx);
    // The first rows only, not 2000.
    assert!(
        seen.rendered >= 10 && seen.rendered <= 64,
        "{}",
        seen.rendered
    );
    assert_eq!(seen.y("item 0"), Some(0.0));
    assert!(seen.view("item 9").is_some());
    assert!(seen.view("item 400").is_none());
    let scroll = seen.scroll.expect("a scroll view");

    // Down to row 400: the rows there are rendered, a window of them.
    let before = seen.rendered;
    let to = |y: f32| nsh_core::geometry::point(px(0.0), px(y));
    engine.control().scroll(scroll, to(20_000.0), u32::MAX);
    seen.take(&rx);
    assert!(
        seen.rendered > before && seen.rendered < before + 100,
        "{before} then {}",
        seen.rendered
    );
    let removed = seen.view("item 402").expect("item 402 is shown");
    assert!(seen.view("fresh").is_none());

    // A little further, the array changes: the new row is rendered in its
    // place, the one removed goes.
    engine.control().scroll(scroll, to(20_010.0), u32::MAX);
    seen.take(&rx);
    assert_eq!(seen.y("fresh"), Some(401.0 * 50.0));
    assert_eq!(seen.y("item 401"), Some(402.0 * 50.0));
    assert!(seen.deleted.contains(&removed));
    assert_eq!(seen.y("item 403"), Some(403.0 * 50.0));

    // Far down, the two rows swapped before they were rendered come in
    // the array's order.
    engine.control().scroll(scroll, to(1499.0 * 50.0), u32::MAX);
    seen.take(&rx);
    assert_eq!(seen.y("item 1501"), Some(1500.0 * 50.0));
    assert_eq!(seen.y("item 1500"), Some(1501.0 * 50.0));
    assert!(seen.rendered < 300, "{}", seen.rendered);
    let _ = std::fs::remove_dir_all(&dir);
}
