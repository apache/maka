//! How a Rust component's scroll views and lists scroll on the engine:
//! their behavior props reach the platform (and follow what they read),
//! a list's sticky rows, keyboard dismissal, scroll and pull values go
//! with its configuration, its own pull to refresh with its behavior, and
//! the zoom and pulls the platform reports reach the listeners.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, KeyboardDismissMode, MountBatch, MountItem, NodeId,
    ScrollBehavior, SnapAlignment,
    element::{Root, ScrollEvent},
    geometry::point,
    prelude::*,
};
use nsh_engine::{Engine, EngineConfig};

use crate::ChannelSink;

/// Snapping cards, a zooming view and a list with a sticky first row,
/// and a button locking the first two.
#[component]
fn Scrolling() -> impl IntoElement {
    let unlocked = signal(true);
    let offset = animated_value(0.0);
    let pulled = animated_value(0.0);
    let log = signal(String::from("idle"));
    view()
        .flex_1()
        .child(
            scroll()
                .horizontal()
                .h(px(120.0))
                .snap_interval(px(232.0))
                .snap_alignment(SnapAlignment::Center)
                .deceleration(0.99)
                .disable_interval_momentum(true)
                .scrollable(move || unlocked.get())
                .child(view().w(px(2000.0)).h(px(100.0))),
        )
        .child(
            scroll()
                .h(px(200.0))
                .zoom_range(0.5, 5.0)
                .bounces_zoom(move || unlocked.get())
                .on_scroll(move |e: &ScrollEvent| {
                    log.set(format!("{:.2}x at {}", e.zoom_scale, e.offset.x.0))
                })
                .child(view().size(px(400.0))),
        )
        .child(
            virtual_list(
                || 50_usize,
                |at| text(format!("row {}", at.index())).h(px(40.0)),
            )
            .estimated_item_size(px(40.0))
            .h(px(300.0))
            .sticky_header_indices([0])
            .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
            .scroll_value(&offset)
            .pull_value(&pulled)
            .refresh_indicator(Some(px(72.0)))
            .on_refresh(move |_: &()| log.set("refreshing".into())),
        )
        .child(text("Lock").on_press(move |_: &()| unlocked.set(false)))
        .child(text(move || log.get()))
}

/// What the platform was sent about scrolling, by node.
#[derive(Default)]
struct Seen {
    texts: Vec<(NodeId, String)>,
    behaviors: Vec<(NodeId, ScrollBehavior)>,
    configs: Vec<(NodeId, MountItem)>,
    sticky: Vec<NodeId>,
    values: Vec<nsh_core::animation::NodeId>,
}

impl Seen {
    fn drain(&mut self, rx: &Receiver<MountBatch>) {
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            for item in batch.items {
                match item {
                    MountItem::Text { id, ref text, .. } => {
                        self.texts.retain(|t| t.0 != id);
                        self.texts.push((id, text.text.clone()));
                    }
                    MountItem::ScrollBehavior { id, ref behavior } => {
                        self.behaviors.retain(|b| b.0 != id);
                        self.behaviors.push((id, (**behavior).clone()));
                    }
                    MountItem::ScrollConfig { id, .. } => self.configs.push((id, item)),
                    MountItem::StickyCells { id, ref cells } if !cells.is_empty() => {
                        self.sticky.push(id)
                    }
                    MountItem::Animation(nsh_core::animation::AnimationOp::CreateValue {
                        node,
                        ..
                    }) => self.values.push(node),
                    _ => {}
                }
            }
        }
    }

    fn text(&self, text: &str) -> NodeId {
        self.texts
            .iter()
            .find(|t| t.1 == text)
            .unwrap_or_else(|| panic!("no {text}: {:?}", self.texts))
            .0
    }

    fn shows(&self, text: &str) -> bool {
        self.texts.iter().any(|t| t.1 == text)
    }

    /// The scroll views' behaviors, in the order they were made.
    fn behaviors(&self) -> Vec<(NodeId, ScrollBehavior)> {
        let mut all = self.behaviors.clone();
        all.sort_by_key(|b| b.0);
        all
    }
}

fn start() -> (Engine, Receiver<MountBatch>, Seen) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(
        EngineConfig::new(Root::of::<Scrolling>()),
        || ApproxTextEngine,
        ChannelSink(tx),
    )
    .unwrap();
    let mut seen = Seen::default();
    seen.drain(&rx);
    (engine, rx, seen)
}

#[test]
fn rust_scroll_views_and_lists_send_how_they_scroll() {
    let (engine, rx, mut seen) = start();
    let [(cards, snapping), (zoom, zooming), ..] = &seen.behaviors()[..] else {
        panic!("scroll behaviors: {:?}", seen.behaviors);
    };
    let (cards, zoom) = (*cards, *zoom);
    assert_eq!(
        (
            snapping.snap_interval,
            snapping.snap_alignment,
            snapping.deceleration,
            snapping.one_step,
            snapping.enabled
        ),
        (px(232.0), SnapAlignment::Center, 0.99, true, true)
    );
    assert_eq!((zooming.min_zoom, zooming.max_zoom), (0.5, 5.0));
    assert!(zooming.bounces_zoom);

    // The list: its sticky row, how dragging dismisses the keyboard and the
    // value its offset feeds.
    let (list, config) = seen
        .configs
        .iter()
        .find(|(id, _)| seen.sticky.contains(id))
        .expect("the list's configuration and sticky row");
    let MountItem::ScrollConfig {
        keyboard_dismiss,
        scroll_value,
        pull_value,
        ..
    } = config
    else {
        unreachable!()
    };
    assert_eq!(*keyboard_dismiss, KeyboardDismissMode::Interactive);
    assert_eq!(*scroll_value, seen.values.first().copied());
    assert!(scroll_value.is_some());
    assert_eq!(*pull_value, seen.values.get(1).copied());
    assert!(pull_value.is_some());
    let list = *list;
    // It draws its own refresh indicator, 72 tall.
    let behaviors = seen.behaviors();
    let refresh = &behaviors.iter().find(|b| b.0 == list).unwrap().1;
    assert_eq!(refresh.refresh_indicator, Some(px(72.0)));

    // The props follow what they read.
    engine
        .control()
        .dispatch_event(seen.text("Lock"), EventKind::Press, EventPayload::None);
    seen.drain(&rx);
    let behaviors = seen.behaviors();
    let of = |id| &behaviors.iter().find(|b| b.0 == id).unwrap().1;
    assert!(!of(cards).enabled, "scrolling turned off");
    assert!(!of(zoom).bounces_zoom);

    // The zoom the platform reports comes with the next scroll event.
    engine.control().zoom(zoom, 2.0);
    engine
        .control()
        .scroll(zoom, point(px(40.0), px(30.0)), u32::MAX);
    seen.drain(&rx);
    assert!(seen.shows("2.00x at 40"), "{:?}", seen.texts);

    // A pull reaches the list's listener.
    engine
        .control()
        .dispatch_event(list, EventKind::Refresh, EventPayload::None);
    seen.drain(&rx);
    assert!(seen.shows("refreshing"), "{:?}", seen.texts);
}
