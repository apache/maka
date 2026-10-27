//! Render functions of Rust components (`Option<Renderer<T>>` props)
//! through an engine: the app's TSX function renders each key the view
//! places, under the component's context; a new value renders it again, a
//! key that leaves and the component going release what was rendered.

use std::{collections::HashSet, time::Duration};

use crossbeam_channel::Receiver;
use nsh_core::{
    MountBatch, MountItem,
    element::{Registry, Rendered, Renderer, dynamic},
    prelude::*,
};

/// Renders each item (`key:label`) with the app's function, keyed by its
/// key.
#[derive(Default)]
pub(crate) struct Shelf;

#[derive(Clone, PartialEq, Props)]
pub(crate) struct ShelfProps {
    /// The items, `key:label`.
    #[prop(default)]
    items: nsh_core::element::Prop<Vec<String>>,
    /// Renders an item's label.
    render_item: nsh_core::element::Prop<Option<Renderer<String>>>,
}

fn split(item: &str) -> (String, String) {
    let (key, label) = item.split_once(':').unwrap_or((item, item));
    (key.to_owned(), label.to_owned())
}

impl Component for Shelf {
    type Props = ShelfProps;
    type Event = NoEvent;

    fn view(props: ShelfProps, _: Scope<NoEvent>) -> impl IntoElement {
        view().child(each(
            props.items,
            |item: &String| split(item).0,
            move |item, _| {
                view().child(dynamic(move || -> Option<Rendered> {
                    let (key, label) = split(&item.get());
                    props.render_item.get().map(|r| r.render(key, label).p_1())
                }))
            },
        ))
    }
}

/// A popup's list: a scroll view as long as its rows (up to 300 pt), the
/// rows in its viewport, each drawn by the app's function.
#[derive(Default)]
pub(crate) struct Picker;

#[derive(Clone, PartialEq, Props)]
pub(crate) struct PickerProps {
    /// The items, `key:label`.
    #[prop(default)]
    items: nsh_core::element::Prop<Vec<String>>,
    /// Renders an item's label.
    render_item: nsh_core::element::Prop<Option<Renderer<String>>>,
}

impl Component for Picker {
    type Props = PickerProps;
    type Event = NoEvent;

    fn view(props: PickerProps, _: Scope<NoEvent>) -> impl IntoElement {
        let (items, render) = (props.items, props.render_item);
        view().max_h(px(300.0)).child(
            scroll().flex_shrink(1.0).min_h(px(0.0)).child(
                virtual_list(
                    move || items.with(Vec::len),
                    move |at| {
                        view().child(dynamic(move || -> Option<Rendered> {
                            let (key, label) = items.with(|i| split(&i[at.index()]));
                            render.get().map(|r| r.render(key, label))
                        }))
                    },
                )
                .viewport(ListViewport::Parent),
            ),
        )
    }
}

fn registry() -> Registry {
    let mut r = Registry::ui_set("test/renders");
    r.register::<Shelf>();
    r.register::<Picker>();
    r
}

const APP: &str = r#"import { context, mount, signal, Text, View } from "nsh";
import { Shelf } from "test/renders";

const Label = context("plain");
const items = signal(["a:Apple", "b:Banana"]);
const shown = signal(true);
const done = signal(false);
const steps = [
  () => items.set(["a:Avocado", "b:Banana"]),
  () => items.set(["b:Banana"]),
  () => shown.set(false),
  () => done.set(true),
];
steps.forEach((step, i) => setTimeout(step, 150 * (i + 1)));

mount(() => (
  <Label.Provider value="ctx">
    <View>
      <If when={shown()}>
        <Shelf items={items()} renderItem={(label) => <Text>{`${Label()} ${label}`}</Text>} />
      </If>
      <If when={done()}>
        <Text>end</Text>
      </If>
    </View>
  </Label.Provider>
));
"#;

/// The batches until one shows `wanted` (or 5 s).
fn until_text(rx: &Receiver<MountBatch>, wanted: &str) -> Vec<MountBatch> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut out = Vec::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        let found = batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Text { text, .. } if text.text == wanted));
        out.push(batch);
        if found {
            break;
        }
    }
    out
}

#[test]
fn the_apps_function_renders_each_key_and_lets_it_go() {
    let (_engine, rx) = crate::rust_classes::start(APP, vec![registry()]);
    let batches = until_text(&rx, "end");
    let items = || batches.iter().flat_map(|b| &b.items);
    let texts: Vec<&str> = items()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.as_str()),
            _ => None,
        })
        .collect();
    // Under the component's context.
    for wanted in ["ctx Apple", "ctx Banana", "ctx Avocado", "end"] {
        assert!(texts.contains(&wanted), "{wanted}: {texts:?}");
    }
    // Holders: JS's views (even ids) placed in the core's placeholders
    // (odd ids, the root's aside).
    let holders: HashSet<u32> = items()
        .filter_map(|i| match i {
            MountItem::Insert { parent, child, .. }
                if *parent != nsh_core::ROOT_ID && parent % 2 == 1 && child % 2 == 0 =>
            {
                Some(*child)
            }
            _ => None,
        })
        .collect();
    // Each value rendered once.
    assert_eq!(holders.len(), 3, "Apple, Banana, Avocado");
    // Nothing of them is left: every view made is deleted but the end's.
    let mut live = HashSet::new();
    for item in items() {
        match item {
            MountItem::Create { id, .. } => {
                live.insert(*id);
            }
            MountItem::Delete { id } => {
                live.remove(id);
            }
            _ => {}
        }
    }
    assert!(
        holders.iter().all(|h| !live.contains(h)),
        "holders left: {live:?}"
    );
    let shown: Vec<_> = items()
        .filter_map(|i| match i {
            MountItem::Text { id, .. } if live.contains(id) => Some(*id),
            _ => None,
        })
        .collect();
    assert_eq!(shown.len(), 1, "only the end is left: {live:?}");
}

const PICKER: &str = r#"import { mount, Text } from "nsh";
import { Picker } from "test/renders";

mount(() => (
  <Picker items={["a:Apple", "b:Banana"]} renderItem={(label) => <Text>{`R ${label}`}</Text>} />
));
"#;

#[test]
fn a_lists_rows_drawn_by_the_app_show_in_a_view_sized_by_them() {
    let (_engine, rx) = crate::rust_classes::start(PICKER, vec![registry()]);
    let mut batches = until_text(&rx, "R Banana");
    // And whatever the commits after it settle.
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
        batches.push(batch);
    }
    let items = || batches.iter().flat_map(|b| &b.items);
    let scroll = items()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: nsh_core::ViewKind::Scroll,
            } => Some(*id),
            _ => None,
        })
        .expect("the scroll view");
    let height = |id: u32| {
        items().fold(None, |last, i| match i {
            MountItem::Frame { id: f, frame } if *f == id => Some(frame.size.height.0),
            _ => last,
        })
    };
    // The rows are laid out with what the app drew, and the scroll view
    // around them is as long as they are.
    let mut rows = 0.0;
    for wanted in ["R Apple", "R Banana"] {
        let text = items()
            .find_map(|i| match i {
                MountItem::Text { id, text, .. } if text.text == wanted => Some(*id),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{wanted} is shown"));
        let h = height(text).unwrap_or_else(|| panic!("{wanted} is placed"));
        assert!(h > 0.0, "{wanted}: {h}");
        rows += h;
    }
    let scroll = height(scroll).expect("the scroll view is placed");
    assert!(
        scroll >= rows,
        "the scroll view: {scroll}, the rows: {rows}"
    );
}
