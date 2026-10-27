//! The runtime's `List` with the engine: rows render, scrolling rebinds
//! recycled cells and `onLoadMore` reaches JS.

use std::{
    collections::{HashMap, HashSet},
    sync::mpsc,
    time::Duration,
};

use nsh_core::{ApproxTextEngine, MountBatch, MountItem, Size, ViewKind, geometry::px};
use nsh_engine::{Bundle, Engine, EngineConfig, EngineControl, MountSink};

/// Sends batches to the test, and answers a request for a display frame
/// at once, as a display would at its next refresh.
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

/// `List`, made in place by the compiler.
const APP: &str = r#"
import { List, mount, signal, Text, View } from "nsh";
const rows = signal(Array.from({ length: 100 }, (_, i) => i));
function App() {
  return (
    <List each={rows()} estimatedItemSize={50} style={{ flex: 1 }}
          onLoadMore={() => rows.update((r) => [...r, ...Array.from({ length: 100 }, (_, i) => r.length + i)])}>
      {(row) => <View style={{ height: 50 }}><Text>{`row ${row()}`}</Text></View>}
    </List>
  );
}
mount(App);
"#;

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

fn cells_created(batch: &MountBatch) -> usize {
    // Each cell is a View whose child is the row View: count rows via text views.
    batch
        .items
        .iter()
        .filter(|i| {
            matches!(
                i,
                MountItem::Create {
                    kind: ViewKind::Text,
                    ..
                }
            )
        })
        .count()
}

/// A focusless native tree. Detached cells keep their nodes and row owners;
/// only their connection to the displayed tree ends before the native ACK.
#[derive(Default)]
struct NativeTree {
    parents: HashMap<u32, u32>,
    nodes: HashSet<u32>,
    texts: HashMap<u32, String>,
    creates: usize,
}

impl NativeTree {
    fn apply(&mut self, batch: &MountBatch, control: &EngineControl) {
        let mut retired = Vec::new();
        for item in &batch.items {
            match item {
                MountItem::Create { id, .. } => {
                    assert!(self.nodes.insert(*id), "node {id} created twice");
                    self.creates += 1;
                }
                MountItem::Text { id, text, .. } => {
                    self.texts.insert(*id, text.text.clone());
                }
                MountItem::Insert { parent, child, .. } => {
                    self.parents.insert(*child, *parent);
                }
                MountItem::ProjectRoot { parent, id, .. } => {
                    // This projection records attachment, not sibling order;
                    // `following` changes no state used by these assertions.
                    self.parents.insert(*id, *parent);
                }
                MountItem::Remove { id } => {
                    self.parents.remove(id);
                }
                MountItem::RetireListCell { id, request, roots } => {
                    for root in roots {
                        self.parents.remove(root);
                    }
                    retired.push((*id, *request));
                }
                // Native applied the detach before sending its ACK.
                MountItem::ListCellRetired { .. } => {}
                MountItem::Delete { id } => {
                    self.parents.remove(id);
                    self.nodes.remove(id);
                    self.texts.remove(id);
                }
                _ => {}
            }
        }
        for (id, request) in retired {
            control.retire_list_cell(id, request, true);
        }
    }

    fn attached(&self, mut id: u32) -> bool {
        while id != nsh_core::ROOT_ID {
            let Some(parent) = self.parents.get(&id) else {
                return false;
            };
            id = *parent;
        }
        true
    }

    fn row_owners(&self) -> usize {
        self.texts
            .values()
            .filter(|t| t.starts_with("row "))
            .count()
    }

    fn assert_rows(&self, first: u32, last: u32) {
        let mut rows: Vec<u32> = self
            .texts
            .iter()
            .filter(|(id, _)| self.attached(**id))
            .filter_map(|(_, t)| t.strip_prefix("row ")?.parse().ok())
            .collect();
        rows.sort_unstable();
        assert_eq!(rows, (first..=last).collect::<Vec<_>>());
    }

    fn drain(
        &mut self,
        rx: &mpsc::Receiver<MountBatch>,
        control: &EngineControl,
        wait: Duration,
    ) -> Vec<MountBatch> {
        let mut batches = Vec::new();
        while let Ok(batch) = rx.recv_timeout(wait) {
            self.apply(&batch, control);
            batches.push(batch);
        }
        batches
    }
}

#[test]
fn list_scrolls_with_recycled_cells() {
    scrolls_with_recycled_cells(APP);
}

/// `List` as a value (`const L = List; <L>`) is the same component as the
/// tag the compiler makes in place.
#[test]
fn list_as_a_value_scrolls_with_recycled_cells() {
    let app = APP
        .replace("<List ", "<Rows ")
        .replace("</List>", "</Rows>")
        .replace(
            "mount, signal, Text, View } from \"nsh\";",
            "mount, signal, Text, View } from \"nsh\";\nconst Rows = List;",
        );
    assert!(app.contains("<Rows "));
    scrolls_with_recycled_cells(&app);
}

/// Bundles `app` into a config for a 320 x 500 viewport, and the app's
/// directory (the caller removes it).
fn config(app: &str) -> (EngineConfig, std::path::PathBuf) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nsh-list-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }),
        viewport: Size::new(px(320.0), px(500.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
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
    (config, dir)
}

/// Bundles `app` and starts it on a 320 x 500 viewport: the engine, its
/// batches and the app's directory (the caller removes it).
fn start(app: &str) -> (Engine, mpsc::Receiver<MountBatch>, std::path::PathBuf) {
    let (config, dir) = config(app);
    let (tx, rx) = mpsc::channel();
    let control = std::sync::Arc::new(std::sync::OnceLock::new());
    let engine = Engine::start(config, || ApproxTextEngine, Sink(tx, control.clone())).unwrap();
    let _ = control.set(engine.control());
    // A frame asked for before the control was there.
    engine.control().frame();
    (engine, rx, dir)
}

fn scrolls_with_recycled_cells(app: &str) {
    let (engine, rx, dir) = start(app);
    let control = engine.control();
    let mut native = NativeTree::default();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    native.apply(&first, &control);
    // The first frame shows the viewport's rows; the overscan may follow.
    let first_texts = texts(&first);
    assert_eq!(first_texts[0], "row 0");
    for i in 0..10 {
        assert!(first_texts.contains(&format!("row {i}")), "{first_texts:?}");
    }
    let list = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: ViewKind::Scroll,
            } => Some(*id),
            _ => None,
        })
        .unwrap();
    // 500 pt viewport + 500 pt overscan at 50 pt per row = 21 rows.
    let mut window = first_texts;
    for batch in native.drain(&rx, &control, Duration::from_millis(300)) {
        window.extend(texts(&batch));
    }
    assert_eq!(window.len(), 21, "{window:?}");
    native.assert_rows(0, 20);
    assert_eq!(native.row_owners(), 21);

    // Scroll to row 40: rows 30..=60 are reserved while native can still
    // target the old 21 owners. Their detach ACKs release them for later jumps.
    engine.control().scroll(
        list,
        nsh_core::geometry::point(nsh_core::geometry::px(0.0), nsh_core::geometry::px(2000.0)),
        u32::MAX,
    );
    let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    native.apply(&batch, &control);
    let shown = texts(&batch);
    assert!(shown.contains(&"row 40".to_owned()), "{shown:?}");
    let mut created = cells_created(&batch);
    for batch in native.drain(&rx, &control, Duration::from_millis(300)) {
        created += cells_created(&batch);
    }
    native.assert_rows(30, 60);
    assert_eq!(created, 31, "the new window precedes native retirement");
    assert_eq!(native.row_owners(), 21 + 31);

    // Near the end: `onLoadMore` appends rows; the content grows.
    engine.control().scroll(
        list,
        nsh_core::geometry::point(nsh_core::geometry::px(0.0), nsh_core::geometry::px(4600.0)),
        u32::MAX,
    );
    let mut grew = false;
    while let Ok(batch) = rx.recv_timeout(Duration::from_secs(2)) {
        native.apply(&batch, &control);
        grew |= batch.items.iter().any(
            |i| matches!(i, MountItem::ScrollContent { size, .. } if size.height >= px(10_000.0)),
        );
        if grew {
            break;
        }
    }
    assert!(grew, "onLoadMore did not extend the list");
    native.drain(&rx, &control, Duration::from_millis(300));
    native.assert_rows(82, 112);
    // Two disjoint 31-row windows overlap until native has detached the
    // previous one. The append extends this window before its batch is sent.
    assert_eq!(native.row_owners(), 2 * 31);
    let (creates, nodes) = (native.creates, native.nodes.len());
    for y in [0.0, 2000.0, 4600.0, 0.0, 2000.0, 4600.0] {
        control.scroll(list, nsh_core::geometry::point(px(0.0), px(y)), u32::MAX);
        native.drain(&rx, &control, Duration::from_millis(300));
        let (first, last) = match y as u32 {
            0 => (0, 20),
            2000 => (30, 60),
            4600 => (82, 112),
            _ => unreachable!(),
        };
        native.assert_rows(first, last);
        assert_eq!(native.creates, creates, "replay at {y} created views");
        assert_eq!(native.nodes.len(), nodes, "replay at {y} grew the tree");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A `List` in its parent's viewport: no scroll view of its own, its
/// rows follow the page's scroll view around it.
#[test]
fn a_list_in_a_pages_viewport_follows_the_page() {
    let app = r#"
import { List, mount, Scroll, Text, View } from "nsh";
const rows = Array.from({ length: 100 }, (_, i) => i);
function App() {
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ height: 200 }}><Text>header</Text></View>
      <List viewport="parent" each={rows} estimatedItemSize={50}>
        {(row) => <View style={{ height: 50 }}><Text>{`row ${row()}`}</Text></View>}
      </List>
    </Scroll>
  );
}
mount(App);
"#;
    let (engine, rx, dir) = start(app);
    let control = engine.control();
    let mut native = NativeTree::default();
    let mut items = Vec::new();
    for batch in native.drain(&rx, &control, Duration::from_millis(500)) {
        items.extend(batch.items);
    }
    let scrolls: Vec<u32> = items
        .iter()
        .filter_map(|i| match i {
            MountItem::Create {
                id,
                kind: ViewKind::Scroll,
            } => Some(*id),
            _ => None,
        })
        .collect();
    assert_eq!(scrolls.len(), 1, "the page's scroll view only");
    let page = scrolls[0];
    let shown: Vec<String> = items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
        .collect();
    // From the list's start, 200 down, to 500 below the viewport's end:
    // rows 0 to 16.
    assert!(shown.contains(&"row 16".to_owned()), "{shown:?}");
    assert!(!shown.contains(&"row 17".to_owned()), "{shown:?}");
    native.assert_rows(0, 16);
    assert_eq!(native.row_owners(), 17);
    // The page's content covers the whole list.
    assert!(items.iter().any(|i| matches!(
        i,
        MountItem::ScrollContent { id, size } if *id == page && size.height == px(200.0 + 100.0 * 50.0)
    )));
    engine
        .control()
        .scroll(page, nsh_core::geometry::point(px(0.0), px(2000.0)), 0);
    let mut shown = Vec::new();
    let mut created = 0;
    for batch in native.drain(&rx, &control, Duration::from_millis(500)) {
        shown.extend(texts(&batch));
        created += cells_created(&batch);
    }
    // 1800 into the list: rows 26 to 56, in recycled cells.
    assert!(shown.contains(&"row 40".to_owned()), "{shown:?}");
    assert!(shown.contains(&"row 56".to_owned()), "{shown:?}");
    assert!(!shown.contains(&"row 57".to_owned()), "{shown:?}");
    native.assert_rows(26, 56);
    // The old 17 and new 31 owners coexist until native consumes the batch.
    assert_eq!(created, 31);
    assert_eq!(native.row_owners(), 17 + 31);
    let (creates, nodes) = (native.creates, native.nodes.len());
    for y in [0.0, 2000.0, 0.0, 2000.0] {
        control.scroll(page, nsh_core::geometry::point(px(0.0), px(y)), 0);
        native.drain(&rx, &control, Duration::from_millis(500));
        let (first, last) = if y == 0.0 { (0, 16) } else { (26, 56) };
        native.assert_rows(first, last);
        assert_eq!(native.creates, creates, "replay at {y} created views");
        assert_eq!(native.nodes.len(), nodes, "replay at {y} grew the tree");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The props `List` does not use itself reach its scroll view, as they do
/// a `<Scroll>`'s: the test id and accessibility (UI tests find the list),
/// classes, touch props and layout events; and they follow their signals.
/// (Imported from `nsh/list`, where `List` was first: it still is.)
#[test]
fn list_passes_host_props_to_its_scroll_view() {
    let app = r#"
import { mount, signal, Text, View } from "nsh";
import { List } from "nsh";
const label = signal("Feed");
const size = signal("none");
function App() {
  return (
    <View style={{ flex: 1 }}>
      <Text>{`size ${size()}`}</Text>
      <List each={[1, 2, 3]} testID="feed" accessibilityLabel={label()} role="list"
            accessibilityHint="Posts" class="bg-red-500" style={{ pointerEvents: "box-none", flex: 1 }}
            onLayout={(e) => { size.set(`${e.size.width}x${e.size.height}`); label.set("Feed 2"); }}>
        {(row) => <View style={{ height: 50 }}><Text>{`row ${row()}`}</Text></View>}
      </List>
    </View>
  );
}
mount(App);
"#;
    let (engine, rx, dir) = start(app);
    let mut native = NativeTree::default();
    let mut items = Vec::new();
    let mut shown = Vec::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_secs(2)) {
        native.apply(&batch, &engine.control());
        shown.extend(texts(&batch));
        items.extend(batch.items);
        if shown.iter().any(|t| t.starts_with("size 320")) {
            break;
        }
    }
    let list = items
        .iter()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: ViewKind::Scroll,
            } => Some(*id),
            _ => None,
        })
        .expect("a scroll view");
    let props = items
        .iter()
        .filter_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == list => Some(props),
            _ => None,
        })
        .next_back()
        .expect("the list's view props");
    assert_eq!(props.test_id.as_deref(), Some("feed"));
    assert_eq!(props.accessibility.hint.as_deref(), Some("Posts"));
    assert_eq!(props.accessibility.role, nsh_core::AccessibilityRole::List);
    assert_eq!(props.pointer_events, nsh_core::PointerEvents::BoxNone);
    // The label follows its signal (set by `onLayout`).
    let labels: Vec<_> = items
        .iter()
        .filter_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == list => props.accessibility.label.clone(),
            MountItem::AccessibilityLabel { id, label } if *id == list => label.clone(),
            _ => None,
        })
        .collect();
    assert_eq!(labels.first().map(|l| &**l), Some("Feed"), "{labels:?}");
    assert_eq!(labels.last().map(|l| &**l), Some("Feed 2"), "{labels:?}");
    // The class styles the scroll view.
    let red = items.iter().any(|i| {
        matches!(i, MountItem::ViewStyle { id, style }
            if *id == list && style.background_color != nsh_core::Color::TRANSPARENT)
    });
    assert!(red, "the class did not style the list");
    // `onLayout` reached JS with the list's size (under a 17 pt text).
    assert!(shown.iter().any(|t| t == "size 320x483"), "{shown:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// What a [`Paced`] engine's sink saw: its errors and whether a display
/// frame was asked for.
#[derive(Default)]
struct Seen {
    errors: std::sync::Mutex<Vec<String>>,
    frame: std::sync::atomic::AtomicBool,
}

struct PacedSink(mpsc::Sender<MountBatch>, std::sync::Arc<Seen>);

impl MountSink for PacedSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(batch);
    }

    fn report_error(&self, message: &str) {
        self.1.errors.lock().unwrap().push(message.to_owned());
    }

    fn request_frame(&self) {
        self.1
            .frame
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// A list app on a [`nsh_engine::LocalEngine`], so a test sees every
/// turn's batch: [`Paced::turn`] is one pump, [`Paced::frame`] the display
/// frame the engine asked for. Keeps what each text view shows.
struct Paced {
    engine: nsh_engine::LocalEngine<ApproxTextEngine>,
    rx: mpsc::Receiver<MountBatch>,
    seen: std::sync::Arc<Seen>,
    native: NativeTree,
    list: Option<nsh_core::NodeId>,
    pressable: Option<nsh_core::NodeId>,
    dir: std::path::PathBuf,
}

impl Paced {
    fn start(app: &str) -> Self {
        let (config, dir) = config(app);
        let (tx, rx) = mpsc::channel();
        let seen = std::sync::Arc::new(Seen::default());
        let engine =
            nsh_engine::LocalEngine::start(config, ApproxTextEngine, PacedSink(tx, seen.clone()))
                .expect("the app starts");
        let mut paced = Paced {
            engine,
            rx,
            seen,
            native: Default::default(),
            list: None,
            pressable: None,
            dir,
        };
        paced.receive();
        paced
    }

    /// Applies the batches sent so far to the model; one `Vec` of the
    /// texts each batch set, per batch.
    fn receive(&mut self) -> Vec<Vec<String>> {
        let mut batches = Vec::new();
        while let Ok(batch) = self.rx.try_recv() {
            self.native.apply(&batch, &self.engine.control());
            let mut set = Vec::new();
            for item in &batch.items {
                match item {
                    MountItem::Text { text, .. } => {
                        set.push(text.text.clone());
                    }
                    MountItem::Create {
                        id,
                        kind: ViewKind::Scroll,
                    } => self.list = self.list.or(Some(*id)),
                    MountItem::Events { id, events }
                        if events.contains(nsh_core::EventKind::Press) =>
                    {
                        self.pressable = Some(*id);
                    }
                    _ => {}
                }
            }
            batches.push(set);
        }
        batches
    }

    /// One wake-up of the engine: what was sent is handled and committed.
    fn turn(&mut self) -> Vec<Vec<String>> {
        self.engine.pump();
        self.receive()
    }

    /// The display frame the engine asked for, if it did.
    fn frame(&mut self) -> Option<Vec<Vec<String>>> {
        if !self
            .seen
            .frame
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return None;
        }
        self.engine.control().frame();
        Some(self.turn())
    }

    /// Turns and frames until nothing changes, with `check` after each
    /// batch.
    fn settle(&mut self, mut check: impl FnMut(&Self, &[String])) {
        for _ in 0..500 {
            let mut batches = self.turn();
            if let Some(more) = self.frame() {
                batches.extend(more);
            }
            if batches.is_empty() && !self.seen.frame.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            for batch in &batches {
                check(self, batch);
            }
        }
        panic!("the list never settled");
    }

    fn scroll_to(&self, y: f32) {
        self.engine.control().scroll(
            self.list.expect("a list"),
            nsh_core::geometry::point(px(0.0), px(y)),
            u32::MAX,
        );
    }

    fn errors(&self) -> Vec<String> {
        self.seen.errors.lock().unwrap().clone()
    }

    /// Rows `first..=last` are what text views show.
    fn shows(&self, first: u32, last: u32) -> bool {
        (first..=last).all(|i| {
            self.native
                .texts
                .iter()
                .any(|(id, t)| self.native.attached(*id) && *t == format!("row {i}"))
        })
    }
}

impl Drop for Paced {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Rows of objects (`row().label`), `count` of them, and a pressable view
/// whose press runs `press` on the rows signal.
fn rows_app(count: usize, mount_effect: &str, press: &str) -> String {
    format!(
        r#"
import {{ List, mount, signal, Text, View }} from "nsh";
const rows = signal(Array.from({{ length: {count} }}, (_, i) => ({{ label: `row ${{i}}` }})));
{mount_effect}
function App() {{
  return (
    <View style={{{{ flex: 1 }}}}>
      <View onPress={{() => {{ {press} }}}} style={{{{ height: 0 }}}} />
      <List each={{rows()}} estimatedItemSize={{50}} style={{{{ flex: 1 }}}}>
        {{(row) => <View style={{{{ height: 50 }}}}><Text>{{row().label}}</Text></View>}}
      </List>
    </View>
  );
}}
mount(App);
"#
    )
}

/// The data shrinking while cells of the first window wait to be bound:
/// cells whose items are gone are never asked for (a cell made for an
/// index past the end would read `undefined`).
#[test]
fn shrinking_rows_before_the_window_is_bound_binds_no_missing_item() {
    let app = rows_app(
        100,
        "setTimeout(() => rows.set(rows().slice(0, 3)), 0);",
        "",
    );
    let mut paced = Paced::start(&app);
    paced.settle(|_, _| {});
    assert_eq!(paced.errors(), Vec::<String>::new());
    assert!(paced.shows(0, 2), "{:?}", paced.native.texts);
}

/// Publishing the source after a row binds must not let remaining paced
/// requests read it before the corresponding splice reaches the core.
#[test]
fn source_changes_during_binding_are_applied_before_paced_reads() {
    // The last visible row tests the fence before any paced work (the
    // budget always allows a first cell). The first overscan row tests a
    // source published between two paced binds while budget remains.
    for change_at in [9, 10] {
        let app = format!(
            r#"
import {{ List, mount, signal, Text, View }} from "nsh";
const rows = signal(Array.from({{ length: 100 }}, (_, i) => ({{ label: `row ${{i}}` }})));
function App() {{
  return (
    <View style={{{{ flex: 1 }}}}>
      <View style={{{{ height: 0 }}}}><Text>{{`count ${{rows().length}}`}}</Text></View>
      <List each={{rows()}} estimatedItemSize={{50}} style={{{{ flex: 1 }}}}>
        {{(row, index) => {{
          if (index() === {change_at} && rows().length > 3) rows.set(rows().slice(0, 3));
          return <View style={{{{ height: 50 }}}}><Text>{{row().label}}</Text></View>;
        }}}}
      </List>
    </View>
  );
}}
mount(App);
"#
        );
        let mut paced = Paced::start(&app);
        paced.settle(|_, _| {});
        assert!(
            paced.native.texts.values().any(|text| text == "count 3"),
            "row {change_at} did not shrink the source: {:?}",
            paced.native.texts
        );
        assert_eq!(paced.errors(), Vec::<String>::new(), "row {change_at}");
        assert!(
            paced.shows(0, 2),
            "row {change_at}: {:?}",
            paced.native.texts
        );
    }
}

/// A row added above keeps every cell on its row in every batch: cells
/// whose item moved learn their new index in the commit of the change.
#[test]
fn prepending_a_row_never_shows_a_cell_with_its_neighbours_row() {
    let app = rows_app(100, "", "rows.update((r) => [{ label: \"new\" }, ...r]);");
    let mut paced = Paced::start(&app);
    paced.settle(|_, _| {});
    assert!(paced.shows(0, 20), "{:?}", paced.native.texts);
    let before = paced.native.texts.clone();
    paced.engine.control().dispatch_event(
        paced.pressable.expect("the pressable view"),
        nsh_core::EventKind::Press,
        nsh_core::EventPayload::None,
    );
    let mut wrong = Vec::new();
    paced.settle(|paced, _| {
        for (id, text) in &before {
            if paced.native.texts.get(id) != Some(text) {
                wrong.push((text.clone(), paced.native.texts.get(id).cloned()));
            }
        }
    });
    assert!(wrong.is_empty(), "cells showed another row: {wrong:?}");
    assert!(paced.native.texts.values().any(|t| t == "new"));
    assert_eq!(paced.errors(), Vec::<String>::new());
}

/// A fling that moves the window faster than cells bind: once it stops,
/// only rows of the window it stopped at are bound (requests for windows
/// already left are dropped, not bound late).
#[test]
fn a_fling_binds_no_row_of_a_window_left_behind() {
    let app = rows_app(2000, "", "");
    let mut paced = Paced::start(&app);
    paced.settle(|_, _| {});
    let mut binds = 0;
    for step in 1..=20 {
        paced.scroll_to(step as f32 * 1500.0);
        binds += paced.turn().iter().map(Vec::len).sum::<usize>();
        if let Some(batches) = paced.frame() {
            binds += batches.iter().map(Vec::len).sum::<usize>();
        }
    }
    // The last window: a viewport of overscan on either side of 30000.
    let window = (30_000 - 500) / 50..=(30_000 + 500 + 500) / 50;
    let mut stale = Vec::new();
    paced.settle(|_, batch| {
        binds += batch.len();
        for text in batch {
            let row: u32 = text.trim_start_matches("row ").parse().unwrap();
            if !window.contains(&row) {
                stale.push(row);
            }
        }
    });
    assert!(stale.is_empty(), "bound after the fling: rows {stale:?}");
    assert!(paced.shows(600, 609), "{:?}", paced.native.texts);
    eprintln!("fling: {binds} binds");
    assert_eq!(paced.errors(), Vec::<String>::new());
}

/// A jump binds what it shows first: the batch of the jump holds every
/// visible row; the overscan around it may follow.
#[test]
fn a_jump_binds_the_visible_rows_first() {
    let app = rows_app(2000, "", "");
    let mut paced = Paced::start(&app);
    paced.settle(|_, _| {});
    paced.scroll_to(5000.0);
    let batches = paced.turn();
    let first = batches.first().expect("a batch for the jump");
    for i in 100..=109 {
        assert!(
            first.contains(&format!("row {i}")),
            "row {i} missing from the jump's batch: {first:?}"
        );
    }
    paced.settle(|_, _| {});
    assert!(paced.shows(90, 120), "{:?}", paced.native.texts);
}

/// A list opened at an old page loads the newer one when the user scrolls
/// back to its start (`onLoadMoreAtStart`), not where it opens; the rows
/// on screen keep their place as the page arrives above them.
#[test]
fn list_loads_more_at_its_start_after_the_user_scrolls_there() {
    let app = r#"
import { List, mount, signal, Text, View } from "nsh";
const rows = signal(Array.from({ length: 100 }, (_, i) => 100 + i));
const starts = signal(0);
function App() {
  return (
    <View style={{ flex: 1 }}>
      <Text>{`starts ${starts()}`}</Text>
      <List each={rows()} estimatedItemSize={50} style={{ flex: 1 }}
            onLoadMoreAtStart={() => {
              starts.set(starts() + 1);
              rows.update((r) => [...Array.from({ length: 100 }, (_, i) => r[0] - 100 + i), ...r]);
            }}>
        {(row) => <View style={{ height: 50 }}><Text>{`row ${row()}`}</Text></View>}
      </List>
    </View>
  );
}
mount(App);
"#;
    let (engine, rx, dir) = start(app);
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let shown = texts(&first);
    assert!(shown.contains(&"starts 0".to_owned()), "{shown:?}");
    assert!(shown.contains(&"row 100".to_owned()), "{shown:?}");
    let list = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: ViewKind::Scroll,
            } => Some(*id),
            _ => None,
        })
        .unwrap();
    let scroll = |y: f32| {
        engine
            .control()
            .scroll(list, nsh_core::geometry::point(px(0.0), px(y)), u32::MAX)
    };
    let fired = |batches: &[MountBatch], label: &str| {
        batches.iter().any(|b| texts(b).iter().any(|t| t == label))
    };
    let drain = |wait: u64| {
        std::iter::from_fn(|| rx.recv_timeout(Duration::from_millis(wait)).ok()).collect::<Vec<_>>()
    };
    // Where it opens is not an approach; away from the start, nothing.
    scroll(2000.0);
    assert!(!fired(&drain(300), "starts 1"), "fired away from the start");
    // Back near the start: one load, and the rows on screen stay (the new
    // page is 100 rows of 50 pt above them).
    scroll(100.0);
    let batches = drain(500);
    assert!(fired(&batches, "starts 1"), "onLoadMoreAtStart did not run");
    let kept = batches.iter().flat_map(|b| &b.items).any(
        |i| matches!(i, MountItem::ScrollBy { id, dy, .. } if *id == list && *dy == px(5000.0)),
    );
    assert!(kept, "the visible rows did not keep their place");
    // 5000 pt from the start now: nothing more.
    assert!(!fired(&drain(300), "starts 2"), "fired again");
    let _ = std::fs::remove_dir_all(&dir);
}
