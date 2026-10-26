//! Rust components' lists on the engine: a list's own header, footer,
//! empty view and separators, viewable rows, a `ListView` with rows of a
//! Rust component (`ComponentElement::items`) or of the app, and the
//! methods of a nested component called through a `ComponentRef`.

use std::{collections::HashMap, time::Duration};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountBatch, MountItem, PayloadValue, Size,
    element::Root, prelude::*,
};
use nsh_engine::{App, Engine, EngineConfig, EngineControl, Environment};

use crate::{
    ChannelSink,
    test_ui::{Stepper, StepperApi, list_view, stepper},
};

fn start(root: Root) -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(root),
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
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// What the batches built: texts, parents, kinds, and the list cells'
/// slots.
#[derive(Default)]
struct Tree {
    texts: Vec<(u32, String)>,
    parents: HashMap<u32, u32>,
    kinds: HashMap<u32, String>,
    /// Every text shown, in order.
    history: Vec<String>,
    commands: Vec<(u32, nsh_core::Command)>,
    creates: usize,
}

impl Tree {
    fn apply(&mut self, batch: &MountBatch, control: &EngineControl) {
        let mut retired = Vec::new();
        for item in &batch.items {
            match item {
                MountItem::Text { id, text, .. } => {
                    self.history.push(text.text.clone());
                    self.texts.retain(|t| t.0 != *id);
                    self.texts.push((*id, text.text.clone()));
                }
                MountItem::Insert { parent, child, .. } => {
                    self.parents.insert(*child, *parent);
                }
                MountItem::ProjectRoot { parent, id, .. } => {
                    // This projection records attachment, not sibling order;
                    // `following` changes no state used by these assertions.
                    self.parents.insert(*id, *parent);
                }
                MountItem::Create { id, kind, .. } => {
                    self.kinds.insert(*id, format!("{kind:?}"));
                    self.creates += 1;
                }
                MountItem::Remove { id } => {
                    self.parents.remove(id);
                }
                MountItem::RetireListCell { id, request, roots } => {
                    // This fixture has no focus. Detach every native root,
                    // keeping its owner and descendants alive, before one ACK.
                    for root in roots {
                        self.parents.remove(root);
                    }
                    retired.push((*id, *request));
                }
                // Native applied the detach before sending its ACK.
                MountItem::ListCellRetired { .. } => {}
                MountItem::Delete { id } => {
                    self.texts.retain(|t| t.0 != *id);
                    self.parents.remove(id);
                    self.kinds.remove(id);
                }
                MountItem::Command { id, command } => self.commands.push((*id, command.clone())),
                _ => {}
            }
        }
        for (id, request) in retired {
            control.retire_list_cell(id, request, true);
        }
    }

    fn drain(&mut self, rx: &Receiver<MountBatch>, control: &EngineControl) {
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            self.apply(&batch, control);
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

    fn find(&self, label: &str) -> Option<u32> {
        self.texts
            .iter()
            .find(|t| t.1 == label && self.attached(t.0))
            .map(|t| t.0)
    }

    fn shows(&self, label: &str) -> bool {
        self.find(label).is_some()
    }

    /// The list `id` is in (its nearest scroll view) and its cell there.
    fn cell(&self, mut id: u32) -> Option<(u32, u32)> {
        loop {
            let parent = *self.parents.get(&id)?;
            if self.kinds.get(&parent).is_some_and(|k| k == "Scroll") {
                return Some((parent, id));
            }
            id = parent;
        }
    }

    /// The depth of `id` below `ancestor` (`None`: not below it).
    fn depth(&self, mut id: u32, ancestor: u32) -> Option<usize> {
        let mut depth = 0;
        while id != ancestor {
            id = *self.parents.get(&id)?;
            depth += 1;
        }
        Some(depth)
    }
}

/// A list of its own rows with a header, a footer, an empty view and
/// separators.
#[component]
fn Own() -> impl IntoElement {
    let count = signal(50_usize);
    let header_taps = signal(0);
    let visible = signal(String::new());
    // Emptied once at the end.
    let emptied = stored(false);
    view()
        .flex_1()
        .child(
            virtual_list(
                move || count.get(),
                |at| text(move || format!("row {}", at.index())).h(px(40.0)),
            )
            .estimated_item_size(px(40.0))
            .flex_1()
            .header(
                text(move || format!("header {}", header_taps.get()))
                    .on_press(move |_: &()| header_taps.update(|t| *t += 1)),
            )
            .footer(text("footer"))
            .empty(text("nothing").on_press(move |_: &()| count.set(3)))
            .separator(|| view().h(px(1.0)).bg(rgb(0xeeeeee)))
            .sticky_header_indices([0])
            .keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)
            .load_more_threshold(0.5)
            .initial_scroll_index(2)
            .minimum_view_time(Duration::from_millis(100))
            .on_viewable_items_change(move |rows: &ViewableItems| {
                let rows = rows.indices();
                visible.set(format!("{}-{}", rows.start(), rows.end()));
            })
            .on_load_more(move |_: &()| {
                if !emptied.replace(true) {
                    count.set(0);
                }
            }),
        )
        .child(text(move || format!("visible {}", visible.get())))
}

#[test]
fn rust_lists_have_headers_footers_separators_and_empty_views() {
    let (engine, rx) = start(Root::of::<Own>());
    let mut tree = Tree::default();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // Their own props, set as JS sets them.
    let list = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Create { id, kind, .. } if format!("{kind:?}") == "Scroll" => Some(*id),
            _ => None,
        })
        .expect("a list");
    tree.apply(&first, &engine.control());
    tree.drain(&rx, &engine.control());
    for label in ["header 0", "footer", "row 0", "row 1"] {
        assert!(tree.shows(label), "{label}: {:?}", tree.texts);
    }
    assert!(!tree.shows("nothing"), "the empty view waits for no rows");
    assert!(
        tree.commands
            .iter()
            .any(|(id, c)| *id == list && matches!(c, nsh_core::Command::ScrollTo { .. })),
        "the initial row is scrolled to: {:?}",
        tree.commands
    );
    // The header and the footer are cells of the list, not rows.
    let header = tree.find("header 0").unwrap();
    let (header_list, header_cell) = tree.cell(header).expect("in a cell");
    assert_eq!(header_list, list);
    // A row and its separator share the cell.
    let row = tree.find("row 0").unwrap();
    let (_, cell) = tree.cell(row).unwrap();
    assert_ne!(cell, header_cell);
    // The header is the component's: its state changes, its node stays.
    engine
        .control()
        .dispatch_event(header, EventKind::Press, EventPayload::None);
    tree.drain(&rx, &engine.control());
    assert_eq!(tree.find("header 1"), Some(header), "{:?}", tree.texts);
    // Rows and their separators share the cells, but the last row's.
    let children = |cell: u32| tree.parents.values().filter(|&&p| p == cell).count();
    assert_eq!(children(cell), 2, "a row and its separator");
    // Viewable rows reach the component once they stayed long enough.
    let viewable = |first: f64, last: f64| {
        engine.control().dispatch_event(
            list,
            EventKind::ViewableItemsChange,
            EventPayload::Map(vec![
                ("first", PayloadValue::Number(first)),
                ("last", PayloadValue::Number(last)),
            ]),
        );
    };
    viewable(2.0, 9.0);
    viewable(3.0, 10.0);
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("visible 3-10"), "{:?}", tree.texts);
    assert!(
        !tree.history.iter().any(|t| t == "visible 2-9"),
        "a range left within the minimum view time is not reported"
    );
    // The end reached empties it: the empty view shows, and is the
    // component's.
    engine
        .control()
        .dispatch_event(list, EventKind::LoadMore, EventPayload::None);
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("nothing"), "{:?}", tree.texts);
    let nothing = tree.find("nothing").unwrap();
    engine
        .control()
        .dispatch_event(nothing, EventKind::Press, EventPayload::None);
    tree.drain(&rx, &engine.control());
    assert!(
        tree.shows("row 2") && !tree.shows("nothing"),
        "{:?}",
        tree.texts
    );
}

/// A page: a header and a list of 100 rows in the page's viewport.
#[component]
fn Page() -> impl IntoElement {
    scroll().flex_1().child(text("header").h(px(200.0))).child(
        virtual_list(100, |at| {
            text(move || format!("row {}", at.index())).h(px(40.0))
        })
        .viewport(ListViewport::Parent)
        .estimated_item_size(px(40.0)),
    )
}

#[test]
fn rust_lists_in_a_pages_viewport_scroll_with_the_page() {
    let (engine, rx) = start(Root::of::<Page>());
    let mut tree = Tree::default();
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    tree.apply(&first, &engine.control());
    tree.drain(&rx, &engine.control());
    // One scroll view, the page's; the list is a view in it.
    let scrolls: Vec<u32> = tree
        .kinds
        .iter()
        .filter(|(_, k)| *k == "Scroll")
        .map(|(id, _)| *id)
        .collect();
    assert_eq!(scrolls.len(), 1, "{:?}", tree.kinds);
    let page = scrolls[0];
    // The rows from the list's start (200 down) to the viewport's end and
    // a screen more: 0 to 1488 of the list, 38 rows.
    let rows = |tree: &Tree| {
        tree.texts
            .iter()
            .filter(|t| t.1.starts_with("row ") && tree.attached(t.0))
            .count()
    };
    assert!(
        tree.shows("row 0") && tree.shows("row 37"),
        "{:?}",
        tree.texts
    );
    assert!(!tree.shows("row 38"));
    assert_eq!(rows(&tree), 38);
    let row = tree.find("row 0").unwrap();
    let list = tree.parents[&tree.parents[&row]];
    assert_eq!(tree.kinds[&list], "View");
    assert_eq!(tree.parents[&list], page);
    // The page scrolls 2000: the list's rows 23 to 87 render, in the
    // cells there were and a few more.
    engine.control().scroll(page, point(px(0.0), px(2000.0)), 0);
    tree.drain(&rx, &engine.control());
    assert!(
        tree.shows("row 23") && tree.shows("row 87"),
        "{:?}",
        tree.texts
    );
    assert!(!tree.shows("row 88"));
    assert_eq!(rows(&tree), 87 - 23 + 1);
    // Rows 23..37 overlap the first window: the old and new native
    // owners coexist until the detach ACK, so their union is 0..87.
    let owners = |tree: &Tree| {
        tree.texts
            .iter()
            .filter(|t| t.1.starts_with("row "))
            .count()
    };
    assert_eq!(owners(&tree), 88);
    let (creates, nodes) = (tree.creates, tree.kinds.len());
    for y in [0.0, 2000.0, 0.0, 2000.0] {
        engine.control().scroll(page, point(px(0.0), px(y)), 0);
        tree.drain(&rx, &engine.control());
        let (first, last) = if y == 0.0 { (0, 37) } else { (23, 87) };
        for row in first..=last {
            assert!(tree.shows(&format!("row {row}")), "{:?}", tree.texts);
        }
        assert_eq!(rows(&tree), last - first + 1);
        assert_eq!(tree.creates, creates, "replay at {y} created views");
        assert_eq!(tree.kinds.len(), nodes, "replay at {y} grew the tree");
    }
}

/// A `ListView` with rows of this component and a header.
#[component]
fn Stocks() -> impl IntoElement {
    let rows: std::rc::Rc<Vec<String>> =
        std::rc::Rc::new((0..100).map(|i| format!("stock {i}")).collect());
    let pressed = signal(String::new());
    let ended = signal(0);
    view().flex_1().child(
        list_view().items(
            virtual_list(rows.len(), move |at| {
                let rows = rows.clone();
                text(move || rows[at.index()].clone())
                    .on_press(move |_: &()| pressed.set(format!("pressed {}", at.index())))
            })
            .keys(|| 0..100)
            .header(text(move || {
                format!("{} ended {}", pressed.get(), ended.get())
            }))
            .on_load_more(move |_: &()| ended.update(|e| *e += 1)),
        ),
    )
}

#[test]
fn rust_components_fill_a_list_views_rows() {
    let (engine, rx) = start(Root::of::<Stocks>());
    let mut tree = Tree::default();
    tree.drain(&rx, &engine.control());
    for label in ["stock 0", "stock 1", " ended 0"] {
        assert!(tree.shows(label), "{label}: {:?}", tree.texts);
    }
    // The rows are in the list view's own wrappers (its padding), inside
    // its list: cell > wrapper > the row's node > the text.
    let row = tree.find("stock 1").unwrap();
    let (list, cell) = tree.cell(row).expect("in a cell");
    assert_eq!(tree.depth(row, cell), Some(3), "{:?}", tree.parents);
    // The header is the list's too.
    assert_eq!(
        tree.cell(tree.find(" ended 0").unwrap()).map(|c| c.0),
        Some(list)
    );
    // A row's press is the row component's (the list's owner).
    engine
        .control()
        .dispatch_event(row, EventKind::Press, EventPayload::None);
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("pressed 1 ended 0"), "{:?}", tree.texts);
    // Its list's events are the component's too.
    engine
        .control()
        .dispatch_event(list, EventKind::LoadMore, EventPayload::None);
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("pressed 1 ended 1"), "{:?}", tree.texts);
}

/// The app, compiled by nsh and loaded as bytecode.
fn start_js(app: &str) -> (Engine, Receiver<MountBatch>) {
    let dir = std::env::temp_dir().join(format!("nsh-rust-lists-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let ui_sets = vec![crate::test_ui::registry()];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: ui_sets.iter().map(Into::into).collect(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(
        &bundle.code,
        false,
        &ui_sets.iter().map(Into::into).collect::<Vec<_>>(),
    )
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: App::Js(unsafe { nsh_engine::Bundle::bytecode(bytecode) }),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets,
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
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

const APP_LIST_VIEW: &str = r#"import { mount, signal, Text, View } from "nsh";
import { ListView } from "test/ui";

const ends = signal(0);
const rows = Array.from({ length: 100 }, (_, i) => `row ${i}`);

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`ends ${ends()}`}</Text>
    <ListView each={rows} onLoadMore={() => ends.set(ends() + 1)}>
      {(row) => <Text>{row()}</Text>}
    </ListView>
  </View>
));
"#;

#[test]
fn the_apps_handlers_on_a_list_views_rows_run() {
    let (engine, rx) = start_js(APP_LIST_VIEW);
    let mut tree = Tree::default();
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("ends 0"), "{:?}", tree.texts);
    let row = tree.find("row 1").expect("rows");
    let (list, _) = tree.cell(row).expect("in a list");
    // The list is a slot of the component (its node is JS's): the app's
    // `onLoadMore` gets the event.
    engine
        .control()
        .dispatch_event(list, EventKind::LoadMore, EventPayload::None);
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("ends 1"), "{:?}", tree.texts);
}

/// A stepper it asks for its value, then sets.
#[component]
fn Asker() -> impl IntoElement {
    let asked = signal(String::new());
    let stepper_ref = component_ref::<Stepper>();
    view()
        .flex_1()
        .child(
            text(move || format!("asked {}", asked.get())).on_press(move |_: &()| {
                let value = stepper_ref.api::<StepperApi>().map(|api| {
                    let value = api.value();
                    api.set_value(5.0);
                    value
                });
                asked.set(format!("{value:?}"));
            }),
        )
        .child(stepper().default_value(3.0).component_ref(&stepper_ref))
}

#[test]
fn rust_components_call_the_methods_of_components_they_render() {
    let (engine, rx) = start(Root::of::<Asker>());
    let mut tree = Tree::default();
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("3"), "{:?}", tree.texts);
    let ask = tree.find("asked ").unwrap();
    engine
        .control()
        .dispatch_event(ask, EventKind::Press, EventPayload::None);
    tree.drain(&rx, &engine.control());
    assert!(tree.shows("asked Some(3.0)"), "{:?}", tree.texts);
    assert!(
        tree.shows("5"),
        "the stepper shows its new value: {:?}",
        tree.texts
    );
}
