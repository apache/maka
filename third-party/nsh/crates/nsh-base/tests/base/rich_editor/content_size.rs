//! `onContentSizeChange` reports the intrinsic extent, independent of the
//! viewport; it stops once layout settles and when the view is removed.
//! Page queries follow a move of what is around the editor.

use std::sync::Mutex;

use nsh_base::rich_editor::view::{RichEditorClasses, RichEditorEvent};
use nsh_core::element::{EngineContext, engine_context};

use super::*;

struct Probe {
    editor: EditorSession,
    events: Mutex<Vec<Size<Points>>>,
    caret: Mutex<Option<Bounds<Points>>>,
    tail: Mutex<Option<Bounds<Points>>>,
}

#[component]
fn SizeProbe() -> impl IntoElement {
    let probe = engine_context::<Arc<Probe>>().unwrap().as_ref().clone();
    let shown = signal(true);
    let tall = signal(false);
    let big = signal(false);
    let reports = signal(0_u64);
    let moved = signal(false);
    let close = probe.editor.clone();
    let query = probe.clone();
    view()
        .size_full()
        .child(
            view()
                .test_id("tall")
                .on_press(move || tall.set(true))
                .child(text("Tall viewport")),
        )
        .child(
            view()
                .test_id("large-font")
                .on_press(move || big.set(true))
                .child(text("Large font")),
        )
        .child(
            view()
                .test_id("close")
                .on_press(move || {
                    // Queue a document update and remove its view in the same
                    // turn: pending geometry notifications belong to that view.
                    let state = close.state();
                    let mut tr = state.tr();
                    tr.insert_text("changed", Some(1), Some(1));
                    close.dispatch(tr).unwrap();
                    shown.set(false);
                })
                .child(text("Close")),
        )
        .child(
            view()
                .test_id("move-parent")
                .on_press(move || moved.set(true))
                .child(text("Move enclosing layout")),
        )
        .child(
            view()
                .test_id("query-page")
                .on_press(move || {
                    // Geometry answers on the engine thread only.
                    *query.caret.lock().unwrap() = query.editor.page_coords_at_pos(1);
                })
                .child(text("Query page coordinates")),
        )
        .child(
            view()
                .flex_shrink_0()
                .h(move || px(if moved.get() { 75.0 } else { 0.0 })),
        )
        .child(when(
            move || shown.get(),
            move || {
                let events = probe.clone();
                view()
                    .test_id("geometry-editor")
                    .flex_shrink_0()
                    .h(move || px(if tall.get() { 100_000.0 } else { 120.0 }))
                    .child(
                        rich_editor()
                            .editor(probe.editor.clone())
                            .size_full()
                            .classes(move || {
                                let mut classes = RichEditorClasses::default();
                                classes.content = Some("p-4".into());
                                classes.nodes = Some(
                                    [(
                                        "paragraph".into(),
                                        if big.get() {
                                            "text-[24px]"
                                        } else {
                                            "text-[16px]"
                                        }
                                        .into(),
                                    )]
                                    .into(),
                                );
                                classes
                            })
                            .on_content_size_change(move |event: &RichEditorEvent| {
                                let RichEditorEvent::ContentSizeChange { content_size } = event
                                else {
                                    return;
                                };
                                *events.caret.lock().unwrap() = events.editor.page_coords_at_pos(1);
                                let state = events.editor.state();
                                let last = state.doc().last_child().unwrap();
                                *events.tail.lock().unwrap() = events.editor.page_node_rect(
                                    state.doc().content().size() - last.node_size(),
                                );
                                events.events.lock().unwrap().push(*content_size);
                                // A UI witness wakes Headless::wait_until even
                                // when the event itself changes no native frame.
                                reports.update(|count| *count += 1);
                            }),
                    )
            },
        ))
        .child(text(move || format!("Size reports {}", reports.get())))
}

#[test]
fn page_queries_follow_an_enclosing_move() {
    let (mut app, probe) = start_probe();
    let before = probe.caret.lock().unwrap().unwrap();
    let revision = probe.editor.state().revision();
    let reports = probe.events.lock().unwrap().len();
    app.press("id:move-parent").unwrap();
    // Nothing in the editor lays out again: the page query itself measures
    // the placement, and a later one answers by it.
    app.wait(Duration::from_millis(100)).unwrap();
    // The first query answers by the old placement and measures it again.
    app.press("id:query-page").unwrap();
    app.wait(Duration::from_millis(100)).unwrap();
    app.press("id:query-page").unwrap();
    let after = probe.caret.lock().unwrap().unwrap();
    assert!(
        (after.origin.y.0 - before.origin.y.0 - 75.0).abs() < 1.0,
        "{before:?} -> {after:?}"
    );
    assert_eq!(
        probe.events.lock().unwrap().len(),
        reports,
        "a move alone does not change the content size"
    );
    assert_eq!(
        probe.editor.state().revision(),
        revision,
        "placement is not an editor transaction"
    );
}

fn start_probe() -> (Headless, Arc<Probe>) {
    let content: Vec<Value> = (0..80).map(|i| json!({"type":"paragraph","content":[{"type":"text","text":format!("Paragraph {i}: {}", "wrapping text ".repeat(8))}]})).collect();
    let probe = Arc::new(Probe {
        editor: session(json!({"type":"doc","content":content})),
        events: Mutex::new(Vec::new()),
        caret: Mutex::new(None),
        tail: Mutex::new(None),
    });
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(600.0), px(500.0)),
        context: EngineContext::default().with(probe.clone()),
        ..EngineConfig::new(Root::of::<SizeProbe>())
    })
    .unwrap();
    app.wait_until(
        "full offscreen extent and block geometry",
        Duration::from_secs(5),
        |_| {
            probe
                .events
                .lock()
                .unwrap()
                .last()
                .is_some_and(|event| event.height.0 > 1_000.0)
                && probe.caret.lock().unwrap().is_some()
                && probe.tail.lock().unwrap().is_some()
        },
    )
    .unwrap_or_else(|error| {
        let layout = app
            .screen()
            .layout_nodes()
            .into_iter()
            .filter(|node| {
                node.test_id.is_some()
                    || node.scroll.is_some()
                    || node.text.as_ref().is_some_and(|text| {
                        text.text.text.starts_with("Paragraph 0:")
                            || text.text.text.starts_with("Paragraph 79:")
                    })
            })
            .map(|node| (node.id, node.test_id, node.bounds, node.scroll))
            .collect::<Vec<_>>();
        panic!(
            "{error}; size_events={:?}; caret={:?}; tail={:?}; selected_layout={layout:?}",
            probe.events.lock().unwrap(),
            probe.caret.lock().unwrap(),
            probe.tail.lock().unwrap()
        );
    });
    (app, probe)
}

#[test]
fn content_size_exposes_offscreen_content_and_shrinks_an_overestimated_viewport() {
    let (mut app, probe) = start_probe();
    let height = probe.events.lock().unwrap().last().unwrap().height.0;
    assert!(
        height > 120.0,
        "the complete document is measured, not the visible part"
    );
    // The wrapper's origin is included in coordinate queries even when
    // Part::Content has padding.
    let page = probe.caret.lock().unwrap().unwrap();
    let tail = probe.tail.lock().unwrap().unwrap();
    assert!(
        tail.origin.y.0 - page.origin.y.0 > 120.0,
        "the final block lies beyond the initial viewport"
    );
    assert!(
        tail.origin.y.0 - page.origin.y.0 + tail.size.height.0 <= height + 1.0,
        "the complete final block fits the intrinsic extent"
    );
    let first = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|node| {
            node.text
                .as_ref()
                .is_some_and(|text| text.text.text.starts_with("Paragraph 0:"))
        })
        .unwrap();
    assert!((page.origin.x.0 - first.bounds.origin.x.0).abs() < 1.0);
    assert!((page.origin.y.0 - first.bounds.origin.y.0).abs() < 1.0);
    app.press("id:tall").unwrap();
    app.wait_until(
        "overestimated viewport laid out",
        Duration::from_secs(5),
        |screen| {
            screen.layout_nodes().into_iter().any(|node| {
                node.test_id.as_deref() == Some("geometry-editor")
                    && node.bounds.size.height.0 > 90_000.0
            })
        },
    )
    .unwrap();
    let measured = probe.events.lock().unwrap().last().unwrap().height.0;
    assert!(
        (measured - height).abs() < 1.0,
        "intrinsic {measured}, previous {height}; viewport minimum must not become document height"
    );
}

#[test]
fn content_size_follows_width_and_font_not_scroll_and_stops_at_idle_and_unmount() {
    let (mut app, probe) = start_probe();
    let document_revision = probe.editor.state().revision();
    let initial = *probe.events.lock().unwrap().last().unwrap();
    let selected = (
        probe.editor.state().selection().anchor(),
        probe.editor.state().selection().head(),
    );
    app.set_viewport(Size::new(px(300.0), px(500.0))).unwrap();
    app.wait_until(
        "wrapped extent at new width",
        Duration::from_secs(5),
        |_| {
            probe
                .events
                .lock()
                .unwrap()
                .last()
                .is_some_and(|event| event.width < initial.width && event.height > initial.height)
        },
    )
    .unwrap();
    let narrow = *probe.events.lock().unwrap().last().unwrap();
    app.press("id:large-font").unwrap();
    app.wait_until("font-only extent change", Duration::from_secs(5), |_| {
        probe
            .events
            .lock()
            .unwrap()
            .last()
            .is_some_and(|event| event.height > narrow.height)
    })
    .unwrap();
    let larger = *probe.events.lock().unwrap().last().unwrap();
    app.set_environment("system text scale", |environment| {
        environment.font_scale = 1.5
    })
    .unwrap();
    app.wait_until(
        "system font scale extent change",
        Duration::from_secs(5),
        |_| {
            probe
                .events
                .lock()
                .unwrap()
                .last()
                .is_some_and(|event| event.height > larger.height)
        },
    )
    .unwrap();
    assert_eq!(
        probe.editor.state().revision(),
        document_revision,
        "typography need not edit the document"
    );
    app.wait(Duration::from_millis(100)).unwrap();
    let before_scroll = probe.events.lock().unwrap().len();
    app.scroll("id:geometry-editor", px(200.0)).unwrap();
    app.wait(Duration::from_millis(300)).unwrap();
    assert_eq!(
        probe.events.lock().unwrap().len(),
        before_scroll,
        "scrolling does not change the content size"
    );
    app.wait(Duration::from_millis(100)).unwrap();
    let settled = probe.events.lock().unwrap().len();
    app.wait(Duration::from_secs(1)).unwrap();
    assert_eq!(
        probe.events.lock().unwrap().len(),
        settled,
        "no periodic geometry work at idle"
    );
    assert_eq!(
        (
            probe.editor.state().selection().anchor(),
            probe.editor.state().selection().head()
        ),
        selected,
        "layout and scroll retain the text selection"
    );
    app.press("id:close").unwrap();
    let removed = probe.events.lock().unwrap().len();
    app.wait(Duration::from_secs(1)).unwrap();
    assert_eq!(
        probe.events.lock().unwrap().len(),
        removed,
        "unmount cancels pending geometry work"
    );
}

#[test]
fn content_size_event_declares_only_content_size() {
    let mut registry = nsh_core::element::Registry::new();
    registry.register::<nsh_base::rich_editor::view::RichEditor>();
    let declarations = nsh_core::element::declarations(&registry, &[]);
    assert!(
        declarations.contains("onContentSizeChange?: (event: { contentSize: Size }) => void;"),
        "{declarations}",
    );
}
